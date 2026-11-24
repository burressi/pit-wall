// Build the pit wall.  Node 18+, no packages.
//   node tools/build.mjs           -> index.html          the page GitHub Pages serves and the laptop hub serves.
//                                                          Public-safe: no race replays, no team fuel numbers.
//   node tools/build.mjs --team    -> private/team-pack.json   race replays + team fuel numbers (never commit it;
//                                                          load it on the page, or put it in private/ and the hub serves it)
//   node tools/build.mjs --dev     -> dev/index.html + dev/app.js  (used by the tests; includes the private replays)
// Race replays live in private/replays/ (built by tools/build_replays.py from the official Al Kamel CSVs).
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));
const mode = process.argv.includes('--dev') ? 'dev' : process.argv.includes('--team') ? 'team' : 'public';
const BUILT = new Date().toISOString();

const JS = ['util.js', 'engine.js', 'replay.js', 'live.js', 'lt2.js', 'hub.js', 'proxy.js', 'charts.js', 'ui.js', 'pitwall.js', 'app.js'];
const NAMES = { 'daytona': 'Daytona', 'homestead-miami': 'Homestead-Miami', 'vir': 'VIR', 'road-america': 'Road America', 'watkins-glen': 'Watkins Glen', 'barber': 'Barber' };
const REP = 'private/replays';
const idx = has(REP + '/index.json') ? JSON.parse(r(REP + '/index.json')) : null;
// track presets: pace, pit-lane and transit times are class statistics from the official results (public);
// the fuel burn per car comes from the team's track sheets (private) and only goes in the team pack
const TRACKS = {}, TRACK_FUEL = {};
if (idx) for (const race of idx.races) {
  if (TRACKS[race.event]) continue;
  TRACKS[race.event] = { name: NAMES[race.event] || race.track, refLapMs: race.refLapMs, pitLaneMs: race.pitLaneMs, transitDeltaMs: race.transitDeltaMs };
  const f = {}; Object.keys(race.fuelGalPerLap || {}).forEach(n => { if (race.fuelGalPerLap[n]) f[n] = race.fuelGalPerLap[n]; });
  if (Object.keys(f).length) TRACK_FUEL[race.event] = f;
}
if (mode !== 'team' && !idx && has('index.html')) {
  // no private data on this machine: keep the track presets that are already in the published page
  const m = r('index.html').match(/RS\.TRACKS = (\{.*?\});\n/);
  if (m) Object.assign(TRACKS, JSON.parse(m[1]));
}
const REPLAY_INDEX = idx ? idx.races.map(({ id, name, track, event, laps, cars, durationMs }) => ({ id, name, track, event, laps, cars, durationMs })) : [];
const replays = idx ? Object.fromEntries(idx.races.map(x => [x.id, JSON.parse(r(REP + '/' + x.id + '.json'))])) : {};

const TEAM = (process.env.PW_TEAM_CARS || '177,178').split(',').map(x => x.trim()).filter(Boolean);
if (mode === 'team') {
  if (!idx) { console.error('No race replays in ' + REP + ' — run tools/build_replays.py first.'); process.exit(1); }
  const pack = {
    kind: 'pit-wall-team-pack', v: 1, built: BUILT, team: 'Cambern Performance',
    note: 'Private team data for the pit wall: fuel burn per track and car (from the team track sheets) and 2026 race replays (official Al Kamel timing, for the team only). Do not publish.',
    settings: { teamCars: TEAM, trackFuel: TRACK_FUEL, fuel: Object.fromEntries(TEAM.map(n => [n, { tank: 18.0, burn: (TRACK_FUEL[idx.races[0].event] || {})[n] || 0.6, reserve: 0.5 }])) },
    replayIndex: REPLAY_INDEX, replays
  };
  const out = path.join(ROOT, 'private/team-pack.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(pack));
  console.log('team pack', fs.statSync(out).size, 'bytes ->', out, '(' + REPLAY_INDEX.length + ' races, fuel for ' + Object.keys(TRACK_FUEL).length + ' tracks)');
  process.exit(0);
}

const safe = (t) => t.replace(/<\/(script)/gi, '<\\/$1');
const data = (tracks, index) => `RS.BRIDGE_SRC = ${JSON.stringify(r('bridge/bridge.src.js'))};\nRS.REPLAY_INDEX = ${JSON.stringify(index)};\nRS.TRACKS = ${JSON.stringify(tracks)};\nRS.BUILD = ${JSON.stringify(BUILT)};\n`;
const js = (tracks, index) => JS.map(f => `/* ${f} */\n` + r('source/app/js/' + f)).join('\n') + '\n(function(RS){\n' + data(tracks, index) + '})(window.RS);\n';
const css = r('source/app/app.css'), body = r('source/app/app.html');

if (mode === 'dev') {
  // tests: track presets with the team fuel, replays inline
  const tracks = JSON.parse(JSON.stringify(TRACKS)); Object.keys(TRACK_FUEL).forEach(k => { if (tracks[k]) tracks[k].fuel = TRACK_FUEL[k]; });
  const devjs = js(tracks, REPLAY_INDEX) + `\nwindow.RS.DEV_ASSET = function (id) { return document.getElementById('dev-' + id).textContent; };\nwindow.RS.App.start();\n`;
  const assets = Object.entries(replays).map(([id, t]) => `<script type="application/json" id="dev-replay-${id}">${safe(JSON.stringify(t))}</script>`).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pit wall (dev)</title><style>${css}</style></head><body>${body}\n${assets}\n<script>${safe(devjs)}</script></body></html>`;
  fs.mkdirSync(path.join(ROOT, 'dev'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'dev/index.html'), html);
  fs.writeFileSync(path.join(ROOT, 'dev/app.js'), devjs);
  console.log('dev build', html.length, 'bytes');
  process.exit(0);
}

// public page: one file, no replays, no team fuel
const pub = js(TRACKS, []) + `\nwindow.RS.App.start();\n`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
  `<meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#0f1419"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="description" content="Pit wall: live race strategy screen for Al Kamel live timing">` +
  `<title>Pit wall</title><style>${css}</style></head><body>${body}\n<script>${safe(pub)}</script></body></html>`;
const teamNums = [...new Set(Object.values(TRACK_FUEL).flatMap(o => Object.values(o)).map(String))];
const leak = /fuelGalPerLap|pit-wall-team-pack"|"replays":\{/.test(html) ? 'team pack data' : teamNums.find(x => html.includes(x));
if (leak) { console.error('Refusing to build: team data found in the public page (' + leak + ').'); process.exit(1); }
fs.writeFileSync(path.join(ROOT, 'index.html'), html);
console.log('public page', html.length, 'bytes -> index.html', idx ? '' : '(no private data here: track presets kept from the previous build)');
