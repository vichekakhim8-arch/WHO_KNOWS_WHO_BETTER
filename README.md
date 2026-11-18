# WHO KNOWS WHO BETTER? ❤️ — Two-Player Couple Quiz

A premium romantic quiz for two. Both of you answer the **same question at the same time**,
answers stay hidden until you've both locked in, then they reveal together — and your
**heart-sync percentage** tells the story.

- 💞 40 built-in romantic questions (EN / ខ្មែរ)
- ✍️ Custom question packs — unlimited personal questions, categories, preferred answers
- 🔐 Private rooms with 6-character codes + invite links
- ⚡ Live sync via **Firebase Realtime Database** (or Local Demo in one browser)
- ⏱️ 20-second answer timer with automatic "time's up" pick
- 💯 Compatibility score, best matches, funny mismatches, share text + PNG score card
- 🌗 Light/Dark themes · 🇬🇧/🇰🇭 English & Khmer · sound effects
- 🎵 Original synthesized music: romantic bed, suspense + heartbeat, synchronized countdown and reveal stings

---

## Play right now — no Firebase

If Firebase environment variables are missing, the game runs in **Local Demo mode**:
rooms, answers, reveals and results sync live between two tabs/windows of the same browser
(`localStorage` + `BroadcastChannel`). Nothing leaves the device.

1. Serve the folder with Live Server (`http://127.0.0.1:5500`) or any static server.
2. Create a room in one window.
3. Open the invite link (or enter the code) in a second window and join.
4. A banner says: **“Demo Mode — Play in two browser windows. Connect Firebase to play remotely.”**

> Local Demo identity is per tab. Opening both players in the *same* tab will not work.

---

## Enable online play (cross-device)

1. Create a free project at <https://console.firebase.google.com>.
2. **Build → Authentication → Sign-in method → Anonymous → Enable.**
3. **Build → Realtime Database → Create Database** (start in locked mode).
4. **Project settings → General → Your apps → Web app** and copy the web config values.
5. Copy `.env.example` to `.env` and fill in every `FIREBASE_*` value, including
   `FIREBASE_DATABASE_URL`:
   ```bash
   cp .env.example .env
   ```
6. Deploy the Realtime Database rules:
   ```bash
   npm install -g firebase-tools
   firebase login
   cp .firebaserc.example .firebaserc   # then put your project id inside
   firebase deploy --only database
   ```
   No CLI? Paste `database.rules.json` into **Realtime Database → Rules → Publish**.
7. Build the production static bundle:
   ```bash
   npm run build
   ```
   The build reads `.env` locally (or Vercel environment variables in production) and writes
   `dist/firebase-config.js`. Your local `firebase-config.js` stays an untracked placeholder fallback.

Firebase Web config values identify the client project; they are not server credentials.
The database rules are the actual access-control boundary. Never commit `.env` or a production
`firebase-config.js`.

For direct local testing without a build, you may paste the web config into the root
`firebase-config.js` instead. Do not commit those values.

If a real config is present but boot fails, the app shows a setup-error screen instead of
pretending online play works.

---

## Deploy to Vercel

The project is a dependency-free static site with a small Node build step. It is ready for
GitHub + Vercel.

### 1. Put the project in GitHub

```bash
git init
git add .
git commit -m "Who Knows Who Better v1"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

`.gitignore` excludes `.env`, `.firebaserc`, `dist/` and local build/test artifacts.

### 2. Import the repository in Vercel

1. Open [vercel.com](https://vercel.com) → **Add New → Project**.
2. Import your GitHub repository.
3. Use these settings:
   - **Framework Preset:** Other
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Install Command:** leave blank or use `echo no dependencies`
4. Add the same `FIREBASE_*` variables from `.env.example` under
   **Project → Settings → Environment Variables**.
5. Click **Deploy**.

Every push to the connected branch triggers a new production deployment. Pull requests get preview deployments.

The app is a single-page static application, so no SPA rewrite is required. `vercel.json` provides the
build settings and basic security headers. If Firebase variables are omitted, Vercel builds the Local Demo
fallback and the banner clearly says Demo Mode.

### 3. Production Firebase checklist

- Anonymous Authentication is enabled.
- Realtime Database exists and is in locked mode.
- `database.rules.json` has been published.
- All Vercel `FIREBASE_*` variables are present in Production and Preview.
- The deployed app is tested with two devices/browsers before calling multiplayer production-ready.

---

## How a game works

1. **Host** → *Start a Game*: name, avatar, question source (Built-In / My Questions / Best of Both),
   category filter and length (10 / 20 / 30).
2. A private room code appears. Copy it or tap **Invite Partner** to share the link.
3. **Partner** opens the link (or enters the code), picks a name/avatar and joins the lobby.
4. Host presses **Start Game**.
5. Every round, **both players answer the same question in secret**, with a 20-second timer.
   The partner's choice stays hidden until both have answered.
6. Answers reveal simultaneously with match/mismatch feedback; the host (or either player)
   taps **Next Question** after the reveal.
7. Results: compatibility %, per-player stats, best matches, funny mismatches,
   share/download, **Play Again** or back home.

---

## Music & sound

Everything you hear is **generated live with the Web Audio API** — there are no audio files,
samples or third-party tracks, so there is nothing to license.

- **Romantic bed** on menus, lobby, results and between rounds: warm pads, soft piano and bass.
- **Suspense scene** while you are guessing: a low drone, airy texture, sparse minor piano and a
  heartbeat that speeds up as the timer runs down.
- **Synchronized countdown:** clock ticks from 10s, stronger ticks + rising tension from 5s,
  beeps at 3/2/1 and a dramatic transition at 0.
- **Reveal:** the suspense fades, a swell hits, then a success phrase or a cute "boing" plays
  before the romantic bed returns.
- **Crossfades** (1–2s) keep scene changes smooth; cues are de-duplicated so both screens agree.
- **Timing** uses the shared round deadline (`timerEndsAt`). Online rooms read Firebase server
  time (`/.info/serverTimeOffset`), so both players' cues stay aligned even with clock drift.
- The **mute button** silences music and effects together; the choice is remembered in
  `localStorage`. Browsers require one tap/click before audio can start.

---

## Custom questions & packs

Open **Create Your Own Questions** on the home screen.

- Create, rename and delete **packs** (stored in this browser's `localStorage`).
- Add unlimited questions with exactly four options, a category and an optional
  **preferred answer** (shown as a ♥ and used as a fun insight).
- Edit or delete any question; empty states and confirmations are built in.
- When hosting, choose *My Questions* or *Best of Both* and optionally filter by category.

Built-in questions live in `js/question-bank.js`.

---

## Architecture

```
index.html            screens, dialogs, overlays, import map
script.js             UI controller: screens, timer, results, packs, wiring
style.css             design system + premium layout (light/dark, responsive)
js/question-bank.js   built-in bilingual categorized questions
js/i18n.js            EN + KM strings
js/room-service.js    authoritative room transitions (transactions, sanitize)
js/audio.js           original synthesized music scenes + SFX (no audio assets)
js/share-card.js      share text + 1080×1350 PNG score card
js/backend/index.js   picks Local Demo or Firebase from the config
js/backend/local.js   localStorage + BroadcastChannel transport
js/backend/firebase.js Anonymous Auth + RTDB transport (+ emulator support)
firebase-config.js    placeholder config for local demo; overwritten in dist by build
database.rules.json   RTDB security rules (validated in Firebase emulator)
scripts/build.mjs     dependency-free production build; reads .env/Vercel env vars
scripts/test-emulator.mjs  runs the full game flow against Auth/RTDB emulators
.env.example          required FIREBASE_* variables (no real values)
vercel.json           Vercel build command, output directory and headers
package.json          build/test scripts, no runtime dependencies
```

All mutations go through `RoomService` transactions (submit answer, advance round, rematch)
so both clients converge on the same state. The room model lives at `rooms/{code}`.

### Answer privacy

The UI hides the partner's answer until both have submitted (`RoomService.sanitize`). This is a
friendly couples game, not an anti-cheat exam: a determined player with dev tools could inspect
the room payload. Do not use it for anything competitive or sensitive.

### Traffic

- 20s answer timer (`ANSWER_MS`), 4.5s reveal window (`REVEAL_MS`).
- If a player does not answer in time, their own client auto-picks; after a short grace period
  the partner's client can also fill the missing answer so nobody gets stuck.
- Presence pings every 10s; an "away" banner appears after ~45s of silence.
- Timers use the backend clock (`serverTimeOffset` online) so both players count down together.
- Rooms expire after 12 hours (`ROOM_TTL_MS`).

---

## Security rules (`database.rules.json`)

- Only authenticated players can read a room; a waiting room with an empty guest slot is
  readable so a partner can claim it by code.
- Guests may only claim the empty slot while the room is `waiting`; once claimed, the slot is
  locked to that UID.
- `hostUid` is immutable and only settable by its owner on creation; field types, name/avatar/photo
  lengths, status/phase values and answer indexes are validated.
- No room listing — 6-character codes are unguessable capabilities.
- Everything outside `rooms/{code}` is denied.

---

## Local end-to-end test (no Firebase)

`.test/test_game.py` serves the project on `http://127.0.0.1:8123` and drives two Edge tabs
through the full Local Demo flow: create → invite-link join → 10 rounds → 50% results →
theme/language → rematch → dashboard add/edit/delete + new pack. It fails on any page error.

```bash
pip install playwright
playwright install msedge
python .test/test_game.py
```

## Firebase Emulator Suite (no Google account)

The repository includes a complete Auth + Realtime Database emulator test. It temporarily writes a demo
`firebase-config.js`, starts the emulators, runs the same two-browser game flow against the real
Firebase transport, and restores the placeholder config afterward:

```bash
npm run test:emulator
```

This exercises Anonymous Auth, room creation/joining, RTDB transactions, security rules, synchronization,
rematch and dashboard flows without using a Google account or deploying anything. It is not a substitute
for testing the deployed Vercel URL on two physical devices.

Production build smoke test:

```bash
npm run build
python -m http.server 8124 -d dist
```

Both commands are expected to pass before deployment. Real cross-device play must be tested on two
separate devices with Firebase variables configured; Local Demo passing does not prove Firebase rules or
network access are valid.

---

## FAQ

**Do players need accounts?** No — Firebase Anonymous Auth when online, no account locally.
**Are answers hidden from my partner?** In the UI, yes until both answer. See *Answer privacy*.
**Does it cost anything?** The Firebase Spark free tier is plenty for two-player rooms.
**Can we play offline?** Local Demo works in one browser. Cross-device play needs internet.
**Where do I change colours?** CSS variables at the top of `style.css`.
