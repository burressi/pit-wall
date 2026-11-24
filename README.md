# Race Strategy — private live-timing section for your portfolio

A password-protected strategist workspace for the Zenith Racing Series, in the spirit of P1TS. It has a pit-wall screen built from your layout draft (car ahead and behind, gap history, pit window, lap ring with the pit-stop rejoin point, race control), a crew view for phones, and the full analysis board. It connects directly to Al Kamel live timing and records each session. It is one static page, so it drops straight into a GitHub Pages portfolio with no server.

---

## 1. Add it to your portfolio (5 minutes)

1. Copy the folder **`1-publish-this/strategy/`** into the root of your portfolio repository, so the site serves `burressi.pit-wall.io`.
   - Plain HTML or Jekyll site: put `strategy/` next to your home `index.html`.
   - React / Vite / Next build: put it in `public/strategy/` so the build copies it as-is.
2. Add a link wherever your navigation lives, for example:
   ```html
   <a href="strategy/">Race Strategy 🔒</a>
   ```
3. Commit and push. Open the link and unlock it with the temporary password you were given.
4. **Change the password before you share the link** (next section).

Only `strategy/index.html` is published. Everything in it — the app, the 2026 race replays and your team's numbers — is encrypted (AES-256-GCM, key derived from the password with PBKDF2-SHA256, 600,000 rounds). Without the password the page is just a login box.

## 2. Change the password

Open **`2-tools/change-password.html`** in your browser (double-click it; it runs offline). Choose your current `strategy/index.html`, type the current password and a new one, and save the downloaded `index.html` over the old file. Push it.

- Use a passphrase of four or more random words. Anyone with the page file can try passwords offline, so length is what protects it.
- "Keep me unlocked on this device" stores the decryption key in that browser. Use **Lock** (top right) to forget it. Changing the password logs every device out.

## 3. Going live at a race weekend

### Option A — Direct connection to Al Kamel live timing (recommended)

The page now connects to the live timing feed itself, the same way the timing website does (SockJS WebSocket, `livetimingFeed` for the series, then the chosen session's standings, pit, flag, race control, weather and entry data). You don't need the timing tab open or any bookmark, and it works on the crew's phones.

1. Unlock the page and open **Data source → 1**.
2. **Series:** `zenith` (the part after `livetiming.alkamelsystems.com/`). Use another series, e.g. `hsr`, for a rehearsal.
3. **Session:** leave **Auto** to follow whichever session is running (it switches from practice to qualifying to the race by itself), or pick one from the list, which shows each session's local start time.
4. Leave **Record the session** ticked on the pit-wall laptop and click **Connect**. The source pill at the top shows *Live · data 0.4 s old*.
5. After the session, click **Download recording** (Data source → 1). It saves every message as a compressed `.jsonl.gz` file on your computer. The page warns you if you try to close it with an unsaved recording.

If **Connect** is refused: in **Advanced**, try **Plain WebSocket**; then **via my proxy** (needs the optional proxy below); then use Option B.

**Which data sets the page asks for.** The feed and session list are confirmed from your captures. The names of the per-session data sets (standings, pit info, status, race control, weather, entry list) were not in the captures, so the page tries the likely names, keeps the ones the server accepts and remembers them. Data source → 1 lists which ones are working. To copy the timing page's own list instead: open the session on the timing page with developer tools → Network → WS → Messages, type **params** in the filter, copy all the lines, paste them into **Advanced** and click **Learn from capture**.

### Test it now with your Ferrari Challenge recording

You already have `ferrarichallenge_…raw.jsonl.gz` from the recorder script. Open **Data source → 2** and drop that file in. It plays through the same screens as live (Play, speed, slider), so you can check the standings decoding before race day. That recording is of a session that had already finished, so expect final standings rather than lap-by-lap racing. If the pit wall stays empty, open **Analysis → Feed inspector → Copy diagnostics** and share that text so the decoding can be adjusted.

Next live chance on the same platform: the HSR Sebring Classic 12 Hour (December 2–6). Connect with series `hsr` and record it; that recording will confirm the live lap-by-lap decoding.

### Option B — Bridge from the timing page (fallback)

If the direct connection is refused, open the Zenith timing page in the same browser and click the **Strategy bridge** bookmark there (copy its code from Data source → 3, or install the userscript). The page then passes what it receives to your dashboard tab. Using the bridge once also teaches the direct connection the page's own data-set list.

### Option C — Official results files (back-fill and near-live)

Al Kamel posts analysis CSVs for each session (hourly during races) on the Zenith results site. Drop a downloaded **23_Analysis…CSV** onto **Data source → 4**. During a live session it fills in full lap history for every car (useful if you joined late or lost the connection); otherwise it opens the file as a replay. To fetch by address and refresh automatically, set up the optional proxy (`3-optional-proxy/README.md`).

### First live session checklist (practice 1)

1. **Data source → 1** should show the feed connected, the session name and, under *Data sets*, `ok` for standings.
2. The pit wall should show the full field in the timing tower, laps ticking over and a sensible time remaining. If it doesn't, check **Analysis → Feed inspector**, then **Copy diagnostics** and share that text.
3. Set **Settings → Track preset** for the event (2026 pace, pit-lane times and fuel burn), and **Pit entry / Pit exit** if you want the pit lane drawn in the right place on the lap ring.

## 4. What is on screen

Two screens, switched at the top: **Pit wall** (your layout draft, the default) and **Analysis** (the full P1TS-style board). On a phone the pit wall becomes the **crew view** automatically.

### Pit wall (laptop)

| Area | What it shows |
|---|---|
| Top bar | Series and session, **Lap N · time left**, flag (a dashed outline means a caution inferred from lap times), our car's overall and class position, air and track temperature from the feed, and how old the data is |
| Car ahead / Car behind | Gap from line-crossing times, closing rate (median change per lap over the last clean laps) and "catch in about N laps". Class neighbours by default; switch to **Overall** above the gap history. The card turns amber when the car behind will reach us within 10 laps |
| Gap history · last 20 laps | Solid blue: gap to the car ahead. Dashed amber: gap to the car behind. Below zero means that car was on the other side of us then; ▼ marks pit laps |
| Last / Best / Last 5 avg / Stint trend | Our car's lap times; stint trend is seconds per lap of fall-off over the current stint, ignoring traffic and incident laps |
| Timing tower | **Around us**, **Our class** or **All**: position, class position, car, class, gap, last lap, pits, Track/Box |
| Pit window | Box this lap, when the window opens, the best lap in the window, the last lap the fuel covers, and under yellow. For each one: class (overall) rejoin position, time lost, and traffic at the rejoin point |
| Lap tracker · pit window | Every car placed round the lap. We are blue, the cars ahead and behind are amber, the sister car is teal, ticks are timing points, the amber arc is the pit lane. The **dashed circle** is where we would rejoin if we boxed now; the dashed outer arc is the stretch of lap the stop costs. Beside it: the window laps and the best lap to stop |
| Race control | Race control messages from the feed when live; flags and our pit stops in replays |

### Crew phone view

Opens automatically on a phone: lap and time left, our positions and flag at the top, and three large buttons along the bottom — **Gaps** (ahead/behind, lap ring with the window, our class order, latest race control), **Pit window** (large lap ring and the stop table) and **Flags** (current flag and all race control messages). Each phone connects to the timing feed itself with Data source → 1 (recording is off by default on phones).

### Analysis

The original board is unchanged: leaderboard, team cards, pit-stop predictor, fuel and stint planner, gap and lap charts, time map, stints and pits, compare, race log, strategy calls and the feed inspector.

**Replays:** Data source → 5 replays any 2026 Zenith race from the official timing at up to 300×. Both screens work exactly as live.

**Settings:** hero, team and follow cars; track preset; race length; pit entry and exit (% of lap) for the lap ring; pit-loss mode and caution factor; fuel tank, burn and reserve per car; yellow-lap fuel factor; stint and drive-time limits; caution detection; proxy. Settings, calls and the learned data-set names stay in that browser — use Export / Import to move them between devices.

## 5. Data and terms

- Al Kamel Systems owns the live timing data, and both its page and the feed itself say it must not be redistributed. This tool doesn't redistribute it: in live mode each browser (yours, or a crew member's phone) reads the public feed for itself, and nothing is stored on or published to your site. Recordings are saved only to the computer that made them; keep them inside the team. A short note to Al Kamel or the series confirming a team may read the public feed for its own strategy is cheap insurance.
- For a fully supported team feed, Al Kamel North America sells the **AKS V2** protocol (cloud or trackside), and P1TS already lists the Zenith classes on V2. The dashboard's strategy engine doesn't depend on where the timing comes from, so a V2 connector could be added later using the protocol documents that come with that subscription.
- The replays inside the page are the series' official timing for every car. They are encrypted, but treat the page as private and check with the series before showing the data publicly.

## 6. Folder guide

| Folder | Publish? | Contents |
|---|---|---|
| `1-publish-this/strategy/` | **Yes** | The encrypted page (`index.html`) |
| `2-tools/` | No | `change-password.html` |
| `3-optional-proxy/` | No | Cloudflare Worker for results-file fetching and the live relay |
| `4-source-keep-private/` | **No — keep private** | Readable source, build script, tests and the unencrypted replays. Don't commit it to a public repository. |
