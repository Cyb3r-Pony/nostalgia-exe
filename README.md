# NOSTALGIA.EXE

```
██╗░░██╗  ███╗░░██╗░█████╗░░██████╗████████╗░█████╗░██╗░░░░░░██████╗░██╗░█████╗░  ██╗░░██╗
██║░░██║  ████╗░██║██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██║░░░░░██╔════╝░██║██╔══██╗  ██║░░██║
███████║  ██╔██╗██║██║░░██║╚█████╗░░░░██║░░░███████║██║░░░░░██║░░██╗░██║███████║  ███████║
██╔══██║  ██║╚████║██║░░██║░╚═══██╗░░░██║░░░██╔══██║██║░░░░░██║░░╚██╗██║██╔══██║  ██╔══██║
██║░░██║  ██║░╚███║╚█████╔╝██████╔╝░░░██║░░░██║░░██║███████╗╚██████╔╝██║██║░░██║  ██║░░██║
╚═╝░░╚═╝  ╚═╝░░╚══╝░╚════╝░╚═════╝░░░░╚═╝░░░╚═╝░░╚═╝╚══════╝░╚═════╝░╚═╝╚═╝░░╚═╝  ╚═╝░░╚═╝
```

> **Back to the future of gaming.** A cybernetic playground where cassette tapes meet quantum CPUs — boot up nostalgia, rewrite history, and discover games forged from neon memories of tomorrow's yesterday.

A static, dependency-light web hub that pairs retro computing aesthetics with futuristic cyber visuals. Thirteen hand-crafted browser games, a public scoreboard, and Supabase-backed auth — all in plain HTML / CSS / JS, no build step.

---

## Features

- **13 playable browser games** — each one a single self-contained HTML file with inline canvas / DOM rendering. No frameworks, no bundler. Hot-reload by saving the file.
- **Public scoreboard** — per-game leaderboards with each player's personal best, joined to public usernames. Anyone can read; only signed-in users can post.
- **Three sign-in options** — email + password, Google OAuth, GitHub OAuth. Single Supabase client per tab so navigating between hub / game / scoreboard never logs you out.
- **Username-setup gate** — first-time users get a temporary `user_<hex>` placeholder until they pick a real handle. Validated client-side AND in the database.
- **Dark / light theme toggle** — two complete colour palettes, persisted via `localStorage`. Every game respects the theme.
- **Floating shapes, parallax, glitch text, scan lines** — all CSS / SVG, zero asset weight.
- **Responsive** — works at phone width through to ultrawide.
- **Defense-in-depth security** — Row-Level Security on every table, scores append-only from the client, anon key safe to ship, no service-role key anywhere.

---

## Tech stack

| Layer | What |
|---|---|
| Frontend | Plain HTML5, CSS3, vanilla JavaScript |
| Auth + DB | [Supabase](https://supabase.com) (Postgres + GoTrue + PostgREST) |
| OAuth | Google, GitHub (via Supabase) |
| Client lib | [`@supabase/supabase-js`](https://www.npmjs.com/package/@supabase/supabase-js) `2.105.1` (pinned, served from jsDelivr) |
| Build step | None |

---

## Project structure

```
nostalgia-games/
├── index.html                          # Hub: games grid, hero, auth modal
├── scoreboard.html                     # Public leaderboard page
├── favicon.svg
├── .gitignore
├── shared/                             # Site-wide modules (loaded by every page)
│   ├── auth.css                        # Modal + OAuth button styling
│   ├── auth.js                         # NostalgiaAuth — email + OAuth, profile, hooks
│   ├── scores.js                       # NostalgiaScores — read/write to scoreboard
│   └── supabase-config.js              # Project URL + anon key
└── games/
    ├── shared/                         # Per-game runtime utilities
    │   ├── arcade.css                  # Common game-page styling
    │   └── arcade.js                   # Cached palette, audio, theme, fitCanvas, sprite cache
    ├── pixel-runner.html
    ├── neon-abyss.html
    ├── vapor-valley.html
    ├── bit-breaker.html
    ├── gridwave-2049.html
    ├── circuit-coil.html
    ├── byte-jet.html
    ├── flux.html
    ├── overdrive.html
    ├── denial-of-service.html
    ├── overheat-arena.html
    ├── quantum-superposition.html
    ├── echo-split.html
    └── signal-jam.html                 # Currently disabled in the hub grid
```

---

## Run it locally

The site is fully static. Anything that serves files over HTTP works.

```bash
git clone https://github.com/Cyb3r-Pony/nostalgia-exe.git
cd nostalgia-exe
python3 -m http.server 3000
# open http://localhost:3000
```

You **must** serve over `http(s)` rather than `file://` — Supabase's auth flow needs a real origin, and OAuth redirects won't work with a local file path. Any port works as long as it matches what's in your Supabase project's *Site URL* and *Redirect URLs* allow-list.

---

## Backend setup

The Supabase project is already wired up for the hosted instance. To run against your own:

1. Create a new Supabase project.
2. Replace the values in `shared/supabase-config.js` with your project's `URL` and **publishable anon key**. Never paste the service-role key here.
3. In the Supabase SQL editor, run the schema scripts (kept offline by the project owner) to create:
   - `profiles` table with auto-trigger on `auth.users`
   - `games` table seeded with the 14 live titles
   - `scores` table with RLS policies (`select` public, `insert` requires `auth.uid() = user_id`)
   - `top_scores` and `public_profiles` views (both `security_invoker = on`)
4. Under **Authentication → URL Configuration**, set:
   - *Site URL*: `http://localhost:3000` (or wherever you serve)
   - *Redirect URLs*: `http://localhost:3000/**` plus your production origin
5. Under **Authentication → Providers**, enable Google + GitHub if you want OAuth. Each needs a client ID + client secret from Google Cloud / GitHub OAuth Apps; Supabase prints the callback URL to register on those services' sides.

---

## Games

### Playable

| Title | Genre | Year | Aesthetic |
|---|---|---|---|
| Pixel Runner | arcade | 1992 | Endless runner |
| Neon Abyss | arcade | 1994 | UFO descent |
| Vapor Valley | arcade | 1993 | Rolling vista |
| Bit Breaker | arcade | 1991 | Block breaker |
| Gridwave 2049 | puzzle | 1988 | Falling tiles |
| Circuit Coil | arcade | 1996 | Snake-circuit |
| ByteJet | arcade | 1990 | Side-scroller |
| FLUX | arcade | 1995 | Cube survival |
| OverDrive | arcade | 1989 | Highway dodge |
| Denial-of-Service | arcade | 1997 | Orbit defender |
| Overheat Arena | arcade | 1999 | Twin-stick combat |
| Quantum SuperPosition | arcade | 2001 | Twin-state physics |
| Echo Split | arcade | 2002 | Echoing input |

### Upcoming

| Title | Genre | Year |
|---|---|---|
| Spin Grid | puzzle | 1996 |
| Compression | puzzle | 1992 |
| Circuit Flow | puzzle | 2000 |
| Mirror Logic | puzzle | 2003 |
| Signal Jam | puzzle | 1998 |

To promote an upcoming game to live: build `games/<slug>.html`, add the slug to `LIVE_GAMES` in `shared/scores.js`, seed the row in `public.games`, and add `live: true` + `url: "games/<slug>.html"` to the entry in `index.html`.

---

## Architecture notes

- **One Supabase client per tab.** `auth.js` constructs the `supabase-js` client and exposes it as `window.NostalgiaSupabase`. `scores.js` reuses that exact instance instead of building its own. Two clients against the same `localStorage` storage slot would race on token refresh and cause silent sign-outs.
- **Username-setup gate.** A Postgres trigger (`handle_new_user`) creates a profile row with `user_<8hex>` whenever `auth.users` gets an INSERT. The frontend detects that pattern via `isTemporaryUsername()` and forces the username modal until the user picks something real. This works identically for email, Google, and GitHub sign-ups.
- **Append-only scoreboard.** No UPDATE or DELETE policies exist on `public.scores`. The `top_scores` view does the deduplication (each user's personal best per game) at read time.
- **Anti-enumeration on signup.** Supabase's signup endpoint deliberately doesn't return errors for already-registered emails (it would leak which emails exist). The client detects the empty `identities` array Supabase returns in that case and surfaces a real error to the user.

---

## Author

Built by **Cyb3r-Pony**

- GitHub: [@Cyb3r-Pony](https://github.com/Cyb3r-Pony)
- Tip jar: [Buy me a coffee](https://buymeacoffee.com/cyb3rpony)
