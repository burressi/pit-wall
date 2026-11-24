// Run the bridge against a fake Meteor page and the dashboard receiver against it
const fs = require('fs'), vm = require('vm'); const load = require('./load');
const dash = load(['util.js', 'engine.js', 'replay.js', 'live.js', 'proxy.js']); const RS = dash.RS;
const DASH_ORIGIN = 'https://ianburress.github.io';
const src = fs.readFileSync(__dirname + '/../bridge/bridge.src.js', 'utf8');
RS.BRIDGE_SRC = src;
// --- dashboard side
const mirror = new RS.Mirror(); const rx = new RS.BridgeReceiver(mirror);
const dashListeners = []; dash.addEventListener = (t, f) => dashListeners.push(f); dash.removeEventListener = () => {};
rx.listen();
let dataEvents = 0; rx.on('data', () => dataEvents++); rx.on('subs', s => console.log('dashboard learned subscriptions:', JSON.stringify(s)));
// --- fake LT2 page
const pageListeners = []; const timers = [];
const streamCbs = [];
const store = { standings: [{ _id: 'a', number: '177', position: 3, laps: 10 }] };
const page = {
  console, JSON, Math, Date, String, encodeURIComponent,
  location: { href: 'https://livetiming.alkamelsystems.com/zenith', origin: 'https://livetiming.alkamelsystems.com' },
  document: { title: 'LT2', body: { appendChild() {} }, documentElement: {}, createElement: () => ({ style: {}, addEventListener() {}, set textContent(v) { page._badge = v; } }), querySelectorAll: () => [] },
  addEventListener: (t, f) => pageListeners.push(f),
  setInterval: (f, ms) => { timers.push(f); return timers.length; }, clearInterval() {}, setTimeout: (f) => 0,
  Meteor: { connection: { _subscriptions: { 1: { name: 'livetimingFeed', params: ['zenith'], ready: true }, 2: { name: 'sessionStandings', params: ['abc123'], ready: true } },
    _stores: { standings: { _getCollection: () => ({ find: () => ({ fetch: () => store.standings }) }) } },
    _stream: { rawUrl: 'https://livetiming.alkamelsystems.com/', on: (n, cb) => streamCbs.push(cb) } } }
};
page.window = page;
// opener = dashboard window
page.opener = { closed: false, postMessage: (m, origin) => {
  if (origin !== DASH_ORIGIN) throw new Error('wrong target origin');
  const e = { data: JSON.parse(JSON.stringify(m)), origin: 'https://livetiming.alkamelsystems.com', source: { postMessage: (a, o) => pageListeners.forEach(f => f({ data: a, origin: DASH_ORIGIN })) } };
  dashListeners.forEach(f => f(e));
} };
vm.createContext(page);
vm.runInContext(RS.bridgeCode(DASH_ORIGIN, DASH_ORIGIN + '/strategy/'), page);
console.log('badge:', page._badge);
// live DDP traffic arrives on the page's stream
streamCbs.forEach(cb => cb(JSON.stringify({ msg: 'changed', collection: 'standings', id: 'a', fields: { laps: 11, lastLapTime: 92564 } })));
streamCbs.forEach(cb => cb(JSON.stringify({ msg: 'added', collection: 'standings', id: 'b', fields: { number: '178', position: 5, laps: 11 } })));
timers.forEach(f => f()); // flush intervals
console.log('mirror after bridge:', JSON.stringify(mirror.cols));
console.log('data events', dataEvents, 'receiver mode', rx.mode, 'ddpUrl', rx.ddpUrl);
// bookmarklet & userscript build
const bm = RS.bookmarklet(DASH_ORIGIN, DASH_ORIGIN + '/strategy/');
console.log('bookmarklet length', bm.length, bm.slice(0, 60));
new Function(decodeURIComponent(bm.slice(11))); console.log('bookmarklet parses');
const us = RS.userscript(DASH_ORIGIN, DASH_ORIGIN + '/strategy/'); new Function(us); console.log('userscript parses, lines', us.split('\n').length);
// spoofed origin is ignored
dashListeners.forEach(f => f({ data: { zs: 1, kind: 'meteor-init', cols: { evil: [{ _id: 'x' }] } }, origin: 'https://evil.example.com', source: null }));
console.log('spoofed origin ignored:', !mirror.cols.evil);
