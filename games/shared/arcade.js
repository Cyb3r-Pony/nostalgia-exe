/* =============================================================
   NOSTALGIA.EXE — Shared Arcade Runtime
   Exposes a single global `Arcade` with:
     • math / format utilities
     • a cached CSS palette lookup (fixes the getComputedStyle-per-frame trap)
     • theme toggle (synced with index.html via 'nostalgia.theme')
     • web audio helpers (beep + white noise, shared mute state)
     • overlay show/hide helpers
     • responsive canvas fitting
     • a tiny offscreen-canvas sprite cache

   Nothing in here is game-specific — each game still owns its own
   game loop, entity model, and HUD wiring.
   ============================================================= */
(function (global) {
  'use strict';

  // ---------- Math / format utilities ----------
  const clamp   = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand    = (a, b)    => a + Math.random() * (b - a);
  const randInt = (a, b)    => Math.floor(rand(a, b + 1));
  const pad     = (n, len)  => String(n).padStart(len, '0');

  // ---------- Palette (cached CSS custom properties) ----------
  // Every game was calling getComputedStyle(...) every frame per object.
  // That triggers a style recalc each time and was the single biggest
  // perf drain. This cache reads once and only invalidates when the
  // theme actually changes.
  const paletteCache = new Map();
  const paletteListeners = new Set();

  function color(varName) {
    let c = paletteCache.get(varName);
    if (c === undefined) {
      c = getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
      paletteCache.set(varName, c);
    }
    return c;
  }

  function invalidatePalette() {
    paletteCache.clear();
    paletteListeners.forEach(fn => { try { fn(); } catch (_) {} });
  }

  function onPaletteChange(fn) {
    paletteListeners.add(fn);
    return () => paletteListeners.delete(fn);
  }

  // ---------- Theme ----------
  const THEME_KEY = 'nostalgia.theme';
  const root = document.documentElement;

  function applySavedTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) root.setAttribute('data-theme', saved);
  }

  function wireThemeToggle(btnId = 'themeToggle') {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem(THEME_KEY, next);
      invalidatePalette();
    });
  }

  // ---------- Audio ----------
  // Each game passes its own storageKey so mute state lives alongside
  // the game's other localStorage ("bb.muted", "na.muted", etc).
  function createAudio(storageKey) {
    let ctx = null;
    let muted = localStorage.getItem(storageKey) === '1';

    const init = () => {
      if (!ctx) ctx = new (global.AudioContext || global.webkitAudioContext)();
    };

    const beep = (freq = 440, dur = 0.06, type = 'square', vol = 0.12, slideTo = null) => {
      if (muted) return;
      init();
      const t    = ctx.currentTime;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t + dur);
    };

    const noise = (dur = 0.1, vol = 0.18) => {
      if (muted) return;
      init();
      const t   = ctx.currentTime;
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d   = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src  = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buf;
      src.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.start(t); src.stop(t + dur);
    };

    const setMuted = (m) => {
      muted = !!m;
      localStorage.setItem(storageKey, muted ? '1' : '0');
    };

    return {
      init,
      beep,
      noise,
      get muted() { return muted; },
      set muted(v) { setMuted(v); },
      toggle: () => { setMuted(!muted); return muted; },
    };
  }

  // ---------- Overlays ----------
  function createOverlayManager(ids) {
    const show = (id) => ids.forEach(o => {
      const el = document.getElementById(o);
      if (el) el.classList.toggle('hidden', o !== id);
    });
    const hideAll = () => ids.forEach(o => {
      const el = document.getElementById(o);
      if (el) el.classList.add('hidden');
    });
    return { show, hideAll };
  }

  // ---------- Responsive canvas fit ----------
  function fitCanvas(canvas, stageSelector = '.stage', padding = 16) {
    const fit = () => {
      const stage = document.querySelector(stageSelector);
      if (!stage) return;
      const rect   = stage.getBoundingClientRect();
      const availW = Math.max(240, rect.width  - padding);
      const availH = Math.max(240, rect.height - padding);
      const aspect = canvas.width / canvas.height;
      let dispW = availW;
      let dispH = dispW / aspect;
      if (dispH > availH) { dispH = availH; dispW = dispH * aspect; }
      canvas.style.width  = Math.floor(dispW) + 'px';
      canvas.style.height = Math.floor(dispH) + 'px';
    };
    global.addEventListener('resize', fit);
    global.addEventListener('orientationchange', fit);
    fit();
    return fit;
  }

  // ---------- Sprite cache ----------
  // For pixel-sprite games (Neon Abyss): pre-render each
  // (sprite, scale, color-key) combination to an offscreen canvas and
  // draw the cached image each frame instead of per-pixel fillRect
  // calls with per-pixel shadowBlur.
  function createSpriteCache() {
    const cache = new Map();
    const spriteIds = new WeakMap();
    let nextId = 0;

    // Invalidate colored entries whenever the theme changes — keeps
    // the cache fresh without letting old colors leak through.
    onPaletteChange(() => cache.clear());

    function idOf(sprite) {
      let id = spriteIds.get(sprite);
      if (id === undefined) { id = nextId++; spriteIds.set(sprite, id); }
      return id;
    }

    function getCanvas(sprite, scale, cssVar) {
      const key = idOf(sprite) + '|' + scale + '|' + cssVar;
      let canvas = cache.get(key);
      if (canvas) return canvas;

      const rows = sprite.length;
      const cols = sprite[0].length;
      canvas = document.createElement('canvas');
      canvas.width  = cols * scale;
      canvas.height = rows * scale;
      const cx = canvas.getContext('2d');
      cx.fillStyle = color(cssVar);
      for (let r = 0; r < rows; r++) {
        const row = sprite[r];
        for (let c = 0; c < cols; c++) {
          if (row[c]) cx.fillRect(c * scale, r * scale, scale - 1, scale - 1);
        }
      }
      cache.set(key, canvas);
      return canvas;
    }

    return { getCanvas };
  }

  // ---------- Expose ----------
  global.Arcade = {
    clamp, rand, randInt, pad,
    color, invalidatePalette, onPaletteChange,
    applySavedTheme, wireThemeToggle,
    createAudio,
    createOverlayManager,
    fitCanvas,
    createSpriteCache,
  };

  // Run on load so games don't have to remember.
  applySavedTheme();
})(window);
