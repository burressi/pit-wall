# Pit wall

A live race-strategy screen, in the spirit of P1TS, built on **Al Kamel live timing**. It was made for the Zenith Racing Series and Cambern Performance (#177 ZR3, #178 ZR2), but works with any series on livetiming.alkamelsystems.com.

The screens show: car ahead and behind, gap and closing rate, gap history, pit window by lap with rejoin position and traffic, a lap ring with the pit-stop rejoin point, class standings, race control, fuel and stint planning, a pit-stop predictor, and a strategy-call log. There is a phone layout for the crew.

**The site:** `https://<github-account>.github.io/<repo-name>/`, for example `https://burressi.github.io/pit-wall/`.

---

## How it gets live data

Al Kamel's timing page doesn't refresh. It keeps one connection open, and Al Kamel sends every change as it happens: line crossings, timing points, pit in/out, flags, race control and weather. The pit wall opens the same kind of connection and recalculates the screens on every update.

There are two ways to run it:

| | **Website** (this repo on GitHub Pages) | **Laptop hub** (`hub\Start Pit Wall.bat`) |
|---|---|---|
| What it is | Open the site on any laptop or phone, go to **Data source → Live → Connect**. That browser connects straight to Al Kamel. | A small program on the strategy laptop holds one connection to Al Kamel and pushes every update to the laptop screen and the crew phones. |
| Install | Nothing | Python on the laptop |
| A screen opened mid-race | Shows the race from that moment on. Fuel shows as *unknown* until the car's next stop, because the earlier laps and stops were missed. | Gets the full race history from the laptop, so lap history, stints and fuel are complete. |
| Phones follow the laptop's settings | No, each device is set up separately | Yes: our car, track, fuel and so on |
| Records the session | In the browser, with **Download recording** | Every message, to a file on the laptop |
| Team pack (fuel numbers + replays) | Load it once per browser | Served to every screen automatically |
| Use it for | Training with replays; a quick look from anywhere; a backup | **Race day** |

On race day: run the hub on the strategy laptop and give the crew its address. Use the website for training and as a backup.

---

## 1. Put it on GitHub

1. **Create the repository** on github.com (**New repository**).
   - GitHub Pages addresses are `https://<account>.github.io/<repo-name>/`. A repository called `pit-wall` on the account `burressi` is served at `https://burressi.github.io/pit-wall/`.
   - A repository called `burressi.pit-wall.io` would be served at `https://<account>.github.io/burressi.pit-wall.io/`. To use an address like `burressi.pit-wall.io` or `pit-wall.io`, you would need to own the domain `pit-wall.io` and add it under **Settings → Pages → Custom domain**.
   - On a free GitHub account, Pages needs a **public** repository, and the site is public on every plan. This is why the team's fuel numbers, the race replays and the recordings are kept out of the repository (see section 2).
2. **Upload the files.** Unzip, then either drag the contents into **Add file → Upload files** on the repository page, or use `git push`. `index.html` must be at the top level of the repository.
3. **Turn on Pages:** **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save.** The site is live within a minute or two.

The page asks search engines not to index it. Even so, treat the address as public.

## 2. The team pack (private, never on GitHub)

`pit-wall-team-pack.json` holds:
- the **fuel burn per track** for #177 and #178, from the team track sheets;
- **replays of the 2026 Zenith races**, built from the official Al Kamel timing. They are for team training only and are not redistributed.

The `.gitignore` already blocks `private/`, `*team-pack*.json` and recordings, so they can't be uploaded by mistake.

- **Laptop hub:** put the file in the `private` folder (`pit-wall\private\pit-wall-team-pack.json`). The hub serves it to the laptop and the phones, and its window prints `Team pack: …` when it finds it.
- **Website:** go to **Data source → Race replays**, drop the file once on each device. The browser keeps it until you click **Remove from this browser**.

Without the team pack, the site uses generic fuel numbers (0.6 gal/lap) and has no built-in replays. You can still replay any session by dropping an official results CSV under **Data source → Official results file**.

**Pick the track in Settings.** Picking a track loads its pit-lane times and, if the team pack is loaded, your burn rate for each car at that track.

## 3. Laptop hub: one-time setup

1. **Python.** Install it from python.org and tick **Add python.exe to PATH**. Your laptop already has it.
2. **Get the files on the laptop:** on the repository page, **Code → Download ZIP**, or `git clone`. Unzip to a local folder such as `C:\PitWall` (not a OneDrive-synced folder, because recordings grow during a race). Put the team pack in `C:\PitWall\private\`.
3. **First test:** in the `hub` folder, double-click **List Zenith sessions.bat**. It connects to Al Kamel and lists the sessions in your local time.
4. **Windows Firewall:** the first time you run **Start Pit Wall**, allow Python on **both Private and Public** networks. Without this, crew phones can't connect.

## 4. Race day

1. Plug the laptop in and connect it to the internet (venue Wi-Fi or a phone hotspot).
2. In the `hub` folder, double-click **Start Pit Wall.bat**. The window shows:
   - `On this laptop: http://localhost:8765/`. The pit wall opens in the browser.
   - `Crew phones: http://192.168.x.x:8765/`. This is the address for the crew.
   - `Team pack: …`, which confirms your fuel numbers and replays were found.
3. The hub follows the session that is running: practice, qualifying, then the race. To choose a session yourself, use **Data source → Session**.
4. On the laptop, open **Settings** and set the track, our car, the team cars and race length (only needed if the feed doesn't give time remaining). Everything is sent to the crew phones.
5. **Leave the black window open.** It keeps the laptop awake. Every 30 seconds it prints a status line.

**Crew phones:** join the same Wi-Fi or hotspot as the laptop and open the crew address. The laptop's own hotspot works best at a track: **Settings → Network & internet → Mobile hotspot**. The address is then usually `http://192.168.137.1:8765/`. Use **Add to Home Screen** so it opens full screen. The phone layout has three buttons: **Gaps**, **Pit window** and **Flags**.

**Crew away from the pit wall:** download Cloudflare's `cloudflared.exe` into the `hub` folder and run **Start Pit Wall + internet link.bat**. It prints an `https://….trycloudflare.com` link. To limit the link to named people, add `--tunnel-allow "a@x.com,b@y.com"` to the .bat file.

## 5. Before relying on it

| Piece | Status |
|---|---|
| Connecting to Al Kamel and receiving live data | Proven on the team laptop with the Ferrari Challenge feed (22 Nov 2026): all 14 data sets arrived and updated live. |
| Exact data-set names for a live session (standings, pits, race control) | Only one is confirmed. The pit wall tries the likely names and remembers the ones that work. |
| Reading positions, laps and pit state | Checked against a finished race, not yet mid-race. |
| The website connecting straight from github.io | **Not yet confirmed.** Al Kamel may refuse connections from another website. If it does, use the laptop hub (not affected), the bridge fallback under **Data source**, or the optional proxy in `worker/`. |
| Screens, phones, catch-up, reconnects, recording | Tested end to end against a stand-in Al Kamel server, in a real browser. |

**Rehearsal: HSR Sebring Classic 12 Hour, 2–6 December.**
1. Run **List HSR sessions.bat** on 1 December.
2. During a live session, run **Rehearsal - HSR Sebring 12 Hour.bat**. Under **Data source**, check that every data set shows *ok* and that laps tick over.
3. Also open the website on a phone and press **Connect** with series `hsr`. This tests the direct connection.
4. If something shows *refused* or stays empty, either:
   - open the session on the Al Kamel page, press F12 → Network → WS → Messages, filter on `params`, and paste the lines into **Data source → Advanced → Learn from capture**; or
   - press **Copy diagnostics** and send that text.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Phone can't open the crew address | Use the same Wi-Fi or hotspot as the laptop. Allow Python through the firewall on Public networks. Try the laptop's own hotspot. |
| `Port 8765 is in use` | The hub is already running in another window. |
| `Al Kamel reconnecting` | The laptop lost internet. The hub retries by itself and keeps recording. |
| "Fuel unknown" on the pit window | That screen or hub joined mid-race. It clears at our next stop, or drop the official results CSV to fill in the missed laps. |
| FUEL CRITICAL far too early | Check **Settings**: is the track picked and the team pack loaded? Without them the burn rate is the generic 0.6 gal/lap. |
| Standings empty in a live session | See section 5, step 4. |

Hub options (`py hub\pitwall_hub.py --help`): `--series`, `--session <id>`, `--champ`, `--list`, `--port`, `--tunnel`, `--tunnel-allow`, `--learn <file>`, `--forget`, `--no-browser`.

## 7. Al Kamel data

Live timing data belongs to Al Kamel Systems, and their notice says it must not be redistributed. The site holds no timing data. Each browser or the team laptop fetches it directly, and the recordings and team pack stay off GitHub. Keep recordings and any internet link inside the team.

---

## For developers

```
index.html            the page (built; GitHub Pages and the hub both serve it)
hub/                  pitwall_hub.py (Python 3.8+, standard library only) + Windows launchers
source/app/           page source: app.html, app.css, js/ (engine, lt2 = Al Kamel feed, hub, live, pitwall, ui, charts, app)
bridge/               bookmark/userscript for the bridge fallback
worker/               optional Cloudflare Worker proxy
tools/build.mjs       build (Node 18+, no packages)
tools/build_replays.py  official Al Kamel CSVs -> private/replays/
test/                 tests (most need private/replays)
private/              git-ignored: team pack, replays
```

```bash
node tools/build.mjs            # index.html (public: no replays, no team fuel; refuses to build if team numbers leak in)
node tools/build.mjs --team     # private/team-pack.json
node tools/build.mjs --dev      # dev/ build for the tests
node test/engine_test.js; node test/lt2_test.js; node test/pitwall_test.js; node test/live_test.js; node test/bridge_test.js
node test/hub_e2e.js            # stand-in Al Kamel server -> hub -> 5 screens, drops, hub restart
node test/ui_hub_smoke.js; node test/hub_catchup_perf.js
ZS_CSV_DIR=<folder with the CSVs> node test/ui_smoke.js
```

The standings `data` string field order is `LT2.DATA_MAP` in `source/app/js/lt2.js`. The subscription list is `DEFAULT_RECIPE` in `hub/pitwall_hub.py` and `LT2.DEFAULT_RECIPE` in `lt2.js`.
