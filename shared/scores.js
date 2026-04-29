/* =============================================================
   NOSTALGIA.EXE — Public Scoreboard module
   -------------------------------------------------------------
   Thin wrapper around Supabase's `scores` table + `top_scores`
   view. Pairs with shared/auth.js — inserts require a live
   session; reads are fully public.

   Exposed as window.NostalgiaScores with:

     isReady()                              — Supabase client available?
     getAllTopScores(limit = 10)            — top-N per game, all live games
     getTopScoresForGame(slug, limit = 10)  — one game's top-N
     submit(slug, score)                    — post current user's score
     submitAndReport(slug, score, statusEl) — submit + render DOM status
     onChange(fn)                           — called when a submit succeeds
     LIVE_GAMES                             — array of { slug, title, url, suffix }

   Depends on window.supabase + window.SUPABASE_CONFIG + window.NostalgiaAuth,
   same as the auth module. Safe to load before any of them exist — calls
   just return { ok: false, error: ... } until the dependencies show up.

   SCHEMA NOTE:
     This module targets a NORMALIZED schema where `scores` references
     `games` by uuid (game_id), not by text slug:
       games(id uuid pk, name text)
       scores(id uuid pk, user_id uuid, game_id uuid fk→games.id,
              score numeric(14,2), created_at timestamptz)
       top_scores view: distinct on (user_id, game_id)
     The module's public API still speaks in slugs — it looks up the
     game_id internally from the `games` table on first use and caches
     the mapping for the session.
   ============================================================= */
(() => {
  'use strict';

  // ---------- Catalogue of live games ----------
  // `title` must match the `name` column in public.games exactly —
  // that's how we look up game_id for inserts and reads. Whenever you
  // add a title here, seed a matching row in public.games (the project
  // owner has the SQL for this offline).
  const LIVE_GAMES = [
    { slug: 'pixel-runner',   title: 'Pixel Runner',   url: 'games/pixel-runner.html',   suffix: ''  },
    { slug: 'neon-abyss',     title: 'Neon Abyss',     url: 'games/neon-abyss.html',     suffix: ''  },
    { slug: 'vapor-valley',   title: 'Vapor Valley',   url: 'games/vapor-valley.html',   suffix: '%' },
    { slug: 'bit-breaker',    title: 'Bit Breaker',    url: 'games/bit-breaker.html',    suffix: ''  },
    { slug: 'gridwave-2049',  title: 'Gridwave 2049',  url: 'games/gridwave-2049.html',  suffix: ''  },
    { slug: 'circuit-coil',   title: 'Circuit Coil',   url: 'games/circuit-coil.html',   suffix: ''  },
    { slug: 'byte-jet',       title: 'ByteJet',        url: 'games/byte-jet.html',       suffix: ''  },
    { slug: 'flux',           title: 'FLUX',           url: 'games/flux.html',           suffix: 'm' },
    { slug: 'overdrive',      title: 'OverDrive',      url: 'games/overdrive.html',      suffix: 'm' },
    { slug: 'denial-of-service', title: 'Denial-of-Service', url: 'games/denial-of-service.html', suffix: '' },
    { slug: 'signal-jam',     title: 'Signal Jam',     url: 'games/signal-jam.html',     suffix: ''  },
    { slug: 'overheat-arena', title: 'Overheat Arena', url: 'games/overheat-arena.html', suffix: ''  },
    { slug: 'quantum-superposition', title: 'Quantum SuperPosition', url: 'games/quantum-superposition.html', suffix: 'ψ' },
    { slug: 'echo-split',     title: 'Echo Split',     url: 'games/echo-split.html',     suffix: ''  },
  ];
  const VALID_SLUGS = new Set(LIVE_GAMES.map(g => g.slug));

  // ---------- Config / client lookup ----------
  // We REUSE the supabase client that auth.js already instantiated
  // (exposed as window.NostalgiaSupabase). Creating a second client
  // per tab would spin up a parallel GoTrueClient against the same
  // storage slot — supabase-js#489 — and that race causes silent
  // sign-outs whenever the user navigates between hub / game pages
  // and a token refresh is in flight. One client per tab fixes it.
  //
  // We still keep a fallback path: if scores.js is somehow loaded
  // without auth.js (e.g. on a page that opted not to include the
  // auth modal), we lazily create our own minimal client so reads
  // still work. That fallback intentionally does NOT manage the
  // auth session.
  const cfg = window.SUPABASE_CONFIG || { url: '', anonKey: '' };
  const PLACEHOLDER = '__FILL_ME_IN__';
  const configured = !!cfg.url && !!cfg.anonKey &&
    cfg.url !== PLACEHOLDER && cfg.anonKey !== PLACEHOLDER;

  let client = null;
  if (configured) {
    if (window.NostalgiaSupabase) {
      client = window.NostalgiaSupabase;        // shared instance — preferred path
    } else if (window.supabase && typeof window.supabase.createClient === 'function') {
      // Fallback only — same storageKey so we never end up with two
      // unrelated session slots in localStorage.
      client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: {
          persistSession:   true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey:        'nostalgia.auth',
        },
      });
    }
  }

  function isReady() {
    return !!client;
  }

  // ---------- Timeout helper ----------
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[scores] ${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ---------- Games lookup (slug → uuid) ----------
  // Lazily fetched on first use, then cached for the session. If the
  // request fails we clear the cached promise so the next call retries
  // rather than locking us into a broken state.
  //
  // Rationale: the `games` table is authored in the Supabase dashboard
  // (normalized schema — scores.game_id references games.id). We could
  // hardcode the UUIDs client-side but that makes the module project-
  // specific and fragile across envs. One extra round-trip per session
  // is the right trade-off.
  let gamesPromise = null;
  function ensureGames() {
    if (gamesPromise) return gamesPromise;
    if (!client) return Promise.resolve(null);
    gamesPromise = (async () => {
      try {
        const names = LIVE_GAMES.map(g => g.title);
        const { data, error } = await withTimeout(
          client.from('games').select('id, name').in('name', names),
          5000, 'games lookup'
        );
        if (error) {
          console.warn('[scores] games lookup error:', error.message);
          gamesPromise = null; // allow retry
          return null;
        }
        if (!data) { gamesPromise = null; return null; }
        const idByName = new Map();
        for (const row of data) idByName.set(row.name, row.id);
        const bySlug = new Map();
        const missing = [];
        for (const g of LIVE_GAMES) {
          const id = idByName.get(g.title);
          if (id) bySlug.set(g.slug, id);
          else missing.push(g.title);
        }
        if (missing.length) {
          console.warn(
            '[scores] missing rows in public.games:',
            missing.join(', '),
            '— seed them in the Supabase dashboard before scores can post.'
          );
        }
        return bySlug;
      } catch (err) {
        console.warn('[scores] games lookup failed:', err && err.message);
        gamesPromise = null;
        return null;
      }
    })();
    return gamesPromise;
  }

  // ---------- Listeners (fired after a successful submit) ----------
  const listeners = new Set();
  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function emit(ev) {
    for (const fn of listeners) {
      try { fn(ev); } catch (err) { console.error('[scores] listener error', err); }
    }
  }

  // ---------- READ: top scores for a single game ----------
  // Returns [] on any failure so callers can render an empty board without
  // gating on success. We do console.warn so debugging isn't impossible.
  async function getTopScoresForGame(slug, limit = 10) {
    if (!client)               { console.warn('[scores] not configured'); return []; }
    if (!VALID_SLUGS.has(slug)) { console.warn('[scores] unknown slug:', slug); return []; }

    const idBySlug = await ensureGames();
    if (!idBySlug) return [];
    const gameId = idBySlug.get(slug);
    if (!gameId) {
      // Game not seeded in DB yet — render empty board rather than error.
      return [];
    }

    try {
      // Pull each user's personal best from the `top_scores` view, then
      // join to `public_profiles` to get the username. Two round-trips
      // but keeps the DB-side code simple and testable.
      const { data: rows, error } = await withTimeout(
        client
          .from('top_scores')
          .select('user_id, score, created_at')
          .eq('game_id', gameId)
          .order('score', { ascending: false })
          .order('created_at', { ascending: true })
          .limit(limit),
        5000, 'top_scores fetch'
      );
      if (error) { console.warn('[scores] fetch error:', error.message); return []; }
      if (!rows || rows.length === 0) return [];

      const ids = rows.map(r => r.user_id);
      const { data: profiles, error: pErr } = await withTimeout(
        client
          .from('public_profiles')
          .select('id, username')
          .in('id', ids),
        5000, 'public_profiles fetch'
      );
      if (pErr) { console.warn('[scores] profiles error:', pErr.message); /* fall through */ }

      const nameById = new Map();
      if (profiles) for (const p of profiles) nameById.set(p.id, p.username);

      return rows.map((r, i) => ({
        rank:       i + 1,
        user_id:    r.user_id,
        username:   nameById.get(r.user_id) || '—',
        score:      Number(r.score),
        created_at: r.created_at,
      }));
    } catch (err) {
      console.warn('[scores] fetch failed:', err && err.message);
      return [];
    }
  }

  // ---------- READ: top scores for every live game ----------
  // Fetches in parallel so the scoreboard page paints roughly as fast
  // as the slowest single request.
  async function getAllTopScores(limit = 10) {
    const pairs = await Promise.all(LIVE_GAMES.map(async (g) => {
      const rows = await getTopScoresForGame(g.slug, limit);
      return [g.slug, rows];
    }));
    const out = {};
    for (const [slug, rows] of pairs) out[slug] = rows;
    return out;
  }

  // ---------- WRITE: submit a score for the signed-in user ----------
  // Returns { ok, ... } — never throws. Callers typically just log on
  // failure (we don't want to disrupt the game-over flow for network
  // flakes). Rejects gracefully if the user isn't signed in.
  async function submit(slug, score) {
    if (!client) return { ok: false, error: 'Scoreboard offline.' };
    if (!VALID_SLUGS.has(slug)) return { ok: false, error: 'Unknown game slug.' };

    const num = Number(score);
    if (!Number.isFinite(num) || num < 0) {
      return { ok: false, error: 'Invalid score value.' };
    }

    const Auth = window.NostalgiaAuth;
    if (!Auth || !Auth.isAuthenticated()) {
      return { ok: false, error: 'Sign in to post to the public scoreboard.', signedOut: true };
    }
    // If the profile still has a placeholder "user_xxxxxxxx" username
    // (email confirmed but no username chosen yet), don't publish —
    // the board would look like garbage. Nudge them to set one first.
    if (Auth.needsUsername && Auth.needsUsername()) {
      return { ok: false, error: 'Pick a username before posting.', needsUsername: true };
    }
    const session = Auth.getSession();
    if (!session || !session.user) {
      return { ok: false, error: 'Your session expired. Sign in again.' };
    }

    // Resolve slug → uuid before the write.
    const idBySlug = await ensureGames();
    if (!idBySlug) {
      return { ok: false, error: 'Could not reach the games table. Try again.' };
    }
    const gameId = idBySlug.get(slug);
    if (!gameId) {
      return { ok: false, error: `Game "${slug}" not registered in DB. Run the migration.` };
    }

    try {
      const { data, error } = await withTimeout(
        client
          .from('scores')
          .insert({
            user_id:  session.user.id,
            game_id:  gameId,
            // Round to two decimal places so the DB numeric(14,2) doesn't
            // throw on floats like 42.666666.
            score:    Math.round(num * 100) / 100,
          })
          .select('id, score, created_at')
          .single(),
        5000, 'score insert'
      );
      if (error) {
        console.warn('[scores] insert error:', error.message || error);
        return { ok: false, error: 'Could not post score. Try again.' };
      }
      emit({ type: 'submitted', slug, score: num, row: data });
      return { ok: true, row: data };
    } catch (err) {
      console.warn('[scores] insert failed:', err && err.message);
      return { ok: false, error: 'Network error posting score.' };
    }
  }

  // ---------- Convenience: submit + render a status line ----------
  // Each game's game-over card shows a small status element that reflects
  // the outcome of the post. Centralising the copy here keeps all six
  // games visually consistent and means fixes land in one place.
  function applyStatus(el, kind, text) {
    if (!el) return;
    el.dataset.state = kind;
    el.textContent = text;
    const inline = {
      ok:       '#5ff07a',   // electric green
      info:     '',
      warn:     '#ffcc33',   // amber
      error:    '#ff4f7a',   // red
      loading:  '',
    };
    el.style.color = inline[kind] || '';
  }

  // Submit a score AND update a DOM element to reflect the outcome.
  // Non-throwing, fire-and-forget: safe to call from game-over handlers
  // without awaiting. Returns the same shape as submit().
  async function submitAndReport(slug, score, statusEl) {
    // Show an immediate "posting" state so the user sees something
    // happening even before the network request comes back.
    if (statusEl) applyStatus(statusEl, 'loading', 'Posting to scoreboard…');

    // Short-circuits before any network hop:
    if (!client) {
      applyStatus(statusEl, 'warn', 'Scoreboard offline — your local best still saved.');
      return { ok: false, error: 'offline' };
    }
    const Auth = window.NostalgiaAuth;
    const notAuthed = !Auth || !Auth.isAuthenticated();
    if (notAuthed) {
      applyStatus(statusEl, 'info', 'Sign in on the hub to post to the public scoreboard.');
      return { ok: false, error: 'signed-out', signedOut: true };
    }
    if (Auth.needsUsername && Auth.needsUsername()) {
      applyStatus(statusEl, 'warn', 'Pick a username on the hub to post publicly.');
      return { ok: false, error: 'needs-username', needsUsername: true };
    }

    const res = await submit(slug, score);
    if (res.ok) {
      applyStatus(statusEl, 'ok', '✓ Posted to the public scoreboard.');
    } else {
      applyStatus(statusEl, 'error', res.error || 'Could not post score.');
    }
    return res;
  }

  // ---------- Export ----------
  window.NostalgiaScores = {
    isReady,
    LIVE_GAMES,
    getTopScoresForGame,
    getAllTopScores,
    submit,
    submitAndReport,
    onChange,
  };
})();
