/* =============================================================
   NOSTALGIA.EXE — Auth / Profile module
   -------------------------------------------------------------
   Thin wrapper around supabase-js v2 that implements:

     • Sign-up (email + password, email-confirmation required)
     • Sign-in / sign-out (uses Supabase session handling)
     • Profile fetch (relies on DB trigger having created the row)
     • Temporary-username detection + validation
     • Username update with normalized error messages
     • A single `onChange` event so UI can react to state

   Relies on two globals:
     • window.supabase        — loaded from @supabase/supabase-js@2 UMD
     • window.SUPABASE_CONFIG — { url, anonKey }, from supabase-config.js

   Exposed as window.NostalgiaAuth.
   ============================================================= */
(() => {
  'use strict';

  // ---------- Config ----------
  const cfg = window.SUPABASE_CONFIG || { url: '', anonKey: '' };
  const PLACEHOLDER = '__FILL_ME_IN__';
  const configured = cfg.url && cfg.anonKey &&
    cfg.url !== PLACEHOLDER && cfg.anonKey !== PLACEHOLDER;

  // Supabase requires an http(s) origin for its fetch calls to work
  // reliably. On file:// URLs `window.location.origin` is the literal
  // string "null", which causes CORS preflight weirdness and silent
  // fetch stalls. Flag it loudly so the UI can warn the user.
  const isFileProtocol = typeof window !== 'undefined' &&
    window.location && window.location.protocol === 'file:';
  if (isFileProtocol) {
    console.warn(
      '[auth] You are loading this page over file:// — Supabase auth will not work reliably.\n' +
      'Serve the folder over http instead, e.g.:\n' +
      '  cd /path/to/nostalgia-games && python3 -m http.server 5173\n' +
      'then open http://localhost:5173'
    );
  }

  // ---------- Client ----------
  // We deliberately keep ONE Supabase client per tab and share it with
  // sibling modules (scores.js, etc.) via window.NostalgiaSupabase.
  // Running multiple GoTrueClient instances against the same storage
  // slot races on token refresh — see supabase/supabase-js#489 — and
  // surfaces as "I'm randomly signed-out after navigating between
  // pages". Sharing the instance kills that class of bug entirely.
  //
  // The explicit `storageKey` namespaces our auth tokens under a
  // stable name we control, instead of relying on Supabase's hashed
  // default (which can drift if the project URL ever changes).
  let client = null;
  if (configured && window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession:   true,
        autoRefreshToken: true,
        detectSessionInUrl: true,    // handles #access_token=... after email confirm
        storageKey:        'nostalgia.auth',
      },
    });
    window.NostalgiaSupabase = client;
  }

  // ---------- Internal state ----------
  const listeners = new Set();
  const state = {
    session: null,
    profile: null,
    status:  'loading',           // 'loading' | 'signed-out' | 'signed-in' | 'needs-username'
    error:   null,
  };

  function emit() {
    // Defensive copy so listeners can't mutate our state object.
    const snap = {
      status:          state.status,
      session:         state.session,
      profile:         state.profile ? { ...state.profile } : null,
      isAuthenticated: !!state.session,
      needsUsername:   state.status === 'needs-username',
      configured,
    };
    for (const fn of listeners) {
      try { fn(snap); } catch (err) { console.error('[auth] listener error', err); }
    }
  }

  // ---------- Helpers ----------
  const USERNAME_RE    = /^[A-Za-z0-9_]+$/;
  const TEMP_USERNAME_RE = /^user_[0-9a-fA-F]+$/;

  function validateUsername(raw) {
    const username = String(raw || '').trim();
    if (username.length < 3)            return { ok: false, error: 'Username must be at least 3 characters.' };
    if (username.length > 24)           return { ok: false, error: 'Username must be 24 characters or fewer.' };
    if (!USERNAME_RE.test(username))    return { ok: false, error: 'Only letters, numbers, and underscores are allowed.' };
    return { ok: true, username };
  }

  function isTemporaryUsername(username) {
    if (!username) return true;
    return TEMP_USERNAME_RE.test(username);
  }

  function validateEmail(raw) {
    const email = String(raw || '').trim();
    // RFC-5322-lite: good enough for UX-level validation. Real check is server-side.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
    return { ok: true, email };
  }

  function validatePassword(raw) {
    const pw = String(raw || '');
    if (pw.length < 6)  return { ok: false, error: 'Password must be at least 6 characters.' };
    if (pw.length > 72) return { ok: false, error: 'Password must be 72 characters or fewer.' };
    return { ok: true, password: pw };
  }

  // Normalize Supabase / PostgREST errors into friendly UI strings without
  // leaking internal details. Prefers error CODES over message text
  // (text matching breaks across Postgres locales).
  // See: https://www.postgresql.org/docs/current/errcodes-appendix.html
  function normalizeError(err, context) {
    if (!err) return null;
    const raw = err.message || String(err);
    const code = err.code || (err.status && String(err.status)) || '';
    // Log the raw error for debugging — do NOT surface it to the UI.
    try { console.warn(`[auth] ${context || 'error'} (${code || '?'}):`, raw); } catch {}

    // ----- Postgres error codes (authoritative) -----
    if (code === '23505') return 'Username already taken.';           // unique_violation
    if (code === '23514') return 'Invalid username format.';          // check_violation
    if (code === '23503') return 'Profile not found.';                // foreign_key_violation

    // ----- Supabase Auth error codes / status -----
    if (err.status === 400 && context === 'signin')
      return 'Invalid email or password.';
    if (err.status === 422 && context === 'signup')
      return 'An account with that email already exists.';

    // ----- Message-based fallback (last resort; may miss in non-English locales) -----
    const m = raw.toLowerCase();
    if (context === 'signin') {
      if (m.includes('invalid login'))            return 'Invalid email or password.';
      if (m.includes('email not confirmed'))      return 'Please confirm your email before signing in. Check your inbox.';
    }
    if (context === 'signup') {
      if (m.includes('already registered') ||
          m.includes('user already registered') ||
          m.includes('already been registered'))  return 'An account with that email already exists.';
      if (m.includes('password'))                 return 'Password does not meet the minimum requirements.';
    }
    if (context === 'username') {
      if (m.includes('duplicate') || m.includes('unique'))   return 'Username already taken.';
      if (m.includes('check'))                               return 'Invalid username format.';
    }
    if (context === 'oauth') {
      if (m.includes('popup'))                               return 'Popup blocked. Allow popups for this site and try again.';
      if (m.includes('redirect'))                            return 'OAuth redirect URL not allowed. Add it to your Supabase project’s URL allow-list.';
      if (m.includes('provider') && m.includes('not enabled'))
        return 'Google sign-in is not enabled on the Supabase project.';
    }
    if (m.includes('network') || m.includes('failed to fetch'))
      return 'Network error. Check your connection and try again.';

    // Generic fallback — never surfaces the raw DB text.
    return 'Something went wrong. Please try again.';
  }

  // ---------- Debounce / rate-limit gate ----------
  // Prevents double-submits and rapid replays. Keyed per action.
  const pendingActions = new Map();
  function guard(key, fn) {
    if (pendingActions.get(key)) {
      return Promise.resolve({ ok: false, error: 'Please wait…' });
    }
    pendingActions.set(key, true);
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        // Small cooldown so the user can't replay the request while the UI
        // is mid-transition. Shorter than a typical network round-trip so it
        // doesn't get in the way of honest retries.
        setTimeout(() => pendingActions.delete(key), 400);
      });
  }

  // ---------- Timeout helper ----------
  // Wraps a promise so it rejects after `ms` milliseconds with a labeled error.
  // Used to prevent init() / hydrateProfile() from hanging indefinitely when
  // the underlying fetch silently stalls (classic failure mode on file://
  // URLs where `window.location.origin` becomes the literal string "null").
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`[auth] ${label || 'operation'} timed out after ${ms}ms`));
      }, ms);
    });
    return Promise.race([promise, timeout])
      .finally(() => clearTimeout(timer));
  }

  // ---------- Profile ----------
  async function fetchProfile(userId) {
    if (!client || !userId) return null;
    try {
      const { data, error } = await withTimeout(
        client
          .from('profiles')
          .select('id, username, created_at')
          .eq('id', userId)
          .maybeSingle(),
        4000,
        'profile fetch'
      );
      if (error) {
        console.warn('[auth] profile fetch error:', error.message);
        return null;
      }
      return data;
    } catch (err) {
      // Timeout or network failure. Don't block boot — surface null so
      // hydrateProfile can move on to a non-loading status.
      console.warn('[auth] profile fetch failed:', err && err.message);
      return null;
    }
  }

  // The DB trigger that creates the profile row runs in the same transaction
  // as auth.users INSERT, but replication / PostgREST cache can briefly lag.
  // Retry a few times with backoff if the row isn't visible yet so the user
  // never sees a hard "Profile not found" state right after signup.
  async function fetchProfileWithRetry(userId, attempts = 4) {
    let delay = 150;
    for (let i = 0; i < attempts; i++) {
      const p = await fetchProfile(userId);
      if (p) return p;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
    return null;
  }

  async function hydrateProfile() {
    if (!state.session) {
      state.profile = null;
      state.status  = 'signed-out';
      return;
    }
    try {
      const profile = await fetchProfileWithRetry(state.session.user.id);
      state.profile = profile;
      if (!profile || isTemporaryUsername(profile.username)) {
        state.status = 'needs-username';
      } else {
        state.status = 'signed-in';
      }
    } catch (err) {
      // Defensive: never leave status at 'loading'. If the profile query
      // blows up unexpectedly, treat the session as needing username setup
      // so the user can at least try to recover.
      console.warn('[auth] hydrateProfile error:', err && err.message);
      state.profile = null;
      state.status  = 'needs-username';
    }
  }

  // ---------- Public: actions ----------
  async function signUp({ email, password }) {
    return guard('signup', async () => {
      if (!client) return { ok: false, error: 'Auth is not configured yet.' };
      const e = validateEmail(email);
      if (!e.ok) return { ok: false, error: e.error };
      const p = validatePassword(password);
      if (!p.ok) return { ok: false, error: p.error };

      const { data, error } = await client.auth.signUp({
        email: e.email,
        password: p.password,
        options: {
          // Supabase will redirect the user back here after they click the
          // confirmation link. Keep them in-app so we can pick up the
          // session via detectSessionInUrl above.
          emailRedirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) return { ok: false, error: normalizeError(error, 'signup') };

      // Duplicate-email detection.
      //
      // Supabase intentionally does NOT return an error when you sign up
      // with an email that's already registered — that would let an
      // attacker enumerate which addresses exist on the platform. Instead
      // it returns "success" with a synthetic user whose `identities`
      // array is empty (a real new user always has ≥1 identity attached
      // for the email provider). That's the documented signal we hook
      // into here so the second sign-up doesn't silently look like the
      // first.
      //
      // Without this guard the UI shows "Check your email to confirm…"
      // even though Supabase never sent another email — surfacing a
      // proper error is what the player actually needs to see.
      if (data && data.user &&
          Array.isArray(data.user.identities) &&
          data.user.identities.length === 0) {
        return {
          ok: false,
          error: 'An account with that email is already registered. Try signing in instead.',
        };
      }

      // When email-confirmation is required, `data.session` will be null —
      // that's the expected, happy path.
      return {
        ok: true,
        needsConfirmation: !data.session,
        message: !data.session
          ? 'Check your email to confirm your account.'
          : 'Account created.',
      };
    });
  }

  async function signIn({ email, password }) {
    return guard('signin', async () => {
      if (!client) return { ok: false, error: 'Auth is not configured yet.' };
      const e = validateEmail(email);
      if (!e.ok) return { ok: false, error: e.error };
      const p = validatePassword(password);
      if (!p.ok) return { ok: false, error: p.error };

      const { data, error } = await client.auth.signInWithPassword({
        email: e.email, password: p.password,
      });
      if (error) return { ok: false, error: normalizeError(error, 'signin') };
      // onAuthStateChange will hydrate profile + emit.
      return { ok: true };
    });
  }

  async function signOut() {
    return guard('signout', async () => {
      if (!client) return { ok: false };
      const { error } = await client.auth.signOut();
      if (error) return { ok: false, error: normalizeError(error, 'signout') };
      return { ok: true };
    });
  }

  // ---------- OAuth (generic) ----------
  // Kicks off an OAuth redirect for any provider Supabase supports
  // (google, github, discord, gitlab, …). supabase-js performs the
  // redirect itself; the provider bounces the user back to `redirectTo`
  // with credentials in the URL. Because we set `detectSessionInUrl:
  // true` on the client, supabase-js picks them up automatically, hands
  // them to GoTrue, and emits a SIGNED_IN event — which our existing
  // onAuthStateChange handler turns into a hydrateProfile() + emit().
  // No custom token parsing on our side, per the spec.
  //
  // Returning { ok:true, redirecting:true } communicates "we successfully
  // started the flow" — the page is about to navigate away. The caller
  // shouldn't try to clean up UI on success because we won't be here when
  // the response comes back. On failure the call returns synchronously
  // and the caller can re-enable its button.
  //
  // First-time users land in 'needs-username' status because the
  // `handle_new_user` trigger seeds a temporary `user_<hex>` username
  // that NostalgiaAuth.isTemporaryUsername() detects, regardless of
  // which provider they signed in with.
  //
  // Whitelist of providers we've actually wired in the UI. Keeping the
  // list explicit prevents typos like 'githhub' from silently kicking
  // off a no-op redirect, and gives the caller a friendlier error
  // when somebody asks for a provider we haven't enabled in Supabase.
  const SUPPORTED_OAUTH_PROVIDERS = new Set(['google', 'github']);

  async function signInWithOAuth(provider) {
    const p = String(provider || '').toLowerCase();
    if (!SUPPORTED_OAUTH_PROVIDERS.has(p)) {
      return { ok: false, error: `Unsupported OAuth provider: ${provider}` };
    }
    // Per-provider key so two clicks on different providers don't
    // collide on the same guard slot.
    return guard('signin-oauth-' + p, async () => {
      if (!client) return { ok: false, error: 'Auth is not configured yet.' };

      // file:// can't host an OAuth redirect target. Fail loud instead
      // of silently sending the user to a provider page that can't return.
      if (isFileProtocol) {
        return {
          ok: false,
          error: 'Social sign-in needs http(s). Serve the folder over a local server (e.g. python3 -m http.server 5173) and try again.',
        };
      }

      // Bounce back to the same URL the user is on (typically the hub).
      // Whatever path you land on must be in your Supabase project's
      // "Redirect URLs" allow-list (Auth → URL Configuration), otherwise
      // Supabase rejects the callback.
      const redirectTo = window.location.origin + window.location.pathname;

      const { error } = await client.auth.signInWithOAuth({
        provider: p,
        options: { redirectTo },
      });

      if (error) return { ok: false, error: normalizeError(error, 'oauth') };

      // We do NOT hit `data.url` manually — supabase-js (with the
      // default skipBrowserRedirect: false) has already navigated the
      // page to the provider by this point. Return a flag so the caller
      // knows a redirect is imminent and not to "restore" UI state.
      return { ok: true, redirecting: true };
    });
  }

  // Convenience wrappers — keep the public names friendly. Both delegate
  // to signInWithOAuth above so adding a new provider only needs a new
  // entry in SUPPORTED_OAUTH_PROVIDERS plus (optionally) a wrapper.
  function signInWithGoogle() { return signInWithOAuth('google'); }
  function signInWithGitHub() { return signInWithOAuth('github'); }

  async function setUsername(raw) {
    return guard('setusername', async () => {
      if (!client) return { ok: false, error: 'Auth is not configured yet.' };
      if (!state.session) return { ok: false, error: 'You need to be signed in.' };
      const v = validateUsername(raw);
      if (!v.ok) return { ok: false, error: v.error };

      // Shortcut: if the submitted value equals the current username, no-op.
      if (state.profile && state.profile.username === v.username) {
        state.status = isTemporaryUsername(v.username) ? 'needs-username' : 'signed-in';
        emit();
        return { ok: true };
      }

      // RLS enforces that a user can only update their own row; no need to
      // send the id in the update payload — the `.eq('id', ...)` filter is a
      // defense-in-depth check.
      const { data, error } = await client
        .from('profiles')
        .update({ username: v.username })
        .eq('id', state.session.user.id)
        .select('id, username, created_at')
        .maybeSingle();

      if (error)   return { ok: false, error: normalizeError(error, 'username') };
      if (!data)   return { ok: false, error: 'Profile not found. Try refreshing.' };

      state.profile = data;
      state.status  = isTemporaryUsername(data.username) ? 'needs-username' : 'signed-in';
      emit();
      return { ok: true, profile: { ...data } };
    });
  }

  async function refreshProfile() {
    await hydrateProfile();
    emit();
    return state.profile ? { ...state.profile } : null;
  }

  // Nuclear option: clear every Supabase token from localStorage and force
  // a fresh signed-out state. Useful when the session is corrupt or the
  // fetch is hanging (e.g., stale tokens on file://). Safe to call anytime.
  async function reset() {
    try {
      if (client) {
        try { await withTimeout(client.auth.signOut(), 1500, 'signOut'); }
        catch (_) { /* ignore — we're clearing anyway */ }
      }
    } finally {
      try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith('sb-'));
        keys.forEach(k => localStorage.removeItem(k));
      } catch (_) {}
      state.session = null;
      state.profile = null;
      state.status  = 'signed-out';
      state.error   = null;
      emit();
    }
    return { ok: true };
  }

  // ---------- Public: subscriptions ----------
  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    // Fire immediately with the current snapshot so late subscribers
    // don't have to poll.
    try {
      fn({
        status:          state.status,
        session:         state.session,
        profile:         state.profile ? { ...state.profile } : null,
        isAuthenticated: !!state.session,
        needsUsername:   state.status === 'needs-username',
        configured,
      });
    } catch (err) { console.error('[auth] listener error', err); }
    return () => listeners.delete(fn);
  }

  // ---------- Boot ----------
  async function init() {
    if (!client) {
      state.status = 'signed-out';
      state.error  = !configured
        ? 'Supabase is not configured. Fill in shared/supabase-config.js.'
        : 'supabase-js failed to load.';
      emit();
      return;
    }

    // Subscribe to Supabase's own auth events so we stay in sync across
    // tabs and after email confirmation redirects.
    client.auth.onAuthStateChange(async (_event, session) => {
      state.session = session || null;
      await hydrateProfile();
      emit();
    });

    // Initial session load, with a hard timeout so a stalled fetch
    // (common on file:// URLs) can never leave the UI in 'loading' forever.
    try {
      const { data } = await withTimeout(
        client.auth.getSession(), 4000, 'getSession'
      );
      state.session = data && data.session ? data.session : null;
    } catch (err) {
      console.warn('[auth] getSession failed:', err && err.message);
      state.session = null;
    }
    await hydrateProfile();
    emit();
  }

  // ---------- Export ----------
  window.NostalgiaAuth = {
    // lifecycle
    init,
    // reactive
    onChange,
    // queries
    isConfigured()   { return configured; },
    isFileProtocol() { return isFileProtocol; },
    isAuthenticated(){ return !!state.session; },
    getSession()     { return state.session; },
    getProfile()     { return state.profile ? { ...state.profile } : null; },
    getStatus()      { return state.status; },
    needsUsername()  { return state.status === 'needs-username'; },
    // actions
    signUp, signIn, signOut,
    signInWithOAuth, signInWithGoogle, signInWithGitHub,
    setUsername, refreshProfile,
    reset,
    // validation utilities
    validateUsername, validateEmail, validatePassword,
    isTemporaryUsername,
  };

  // Auto-init on DOM ready so pages only need to include the scripts.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
