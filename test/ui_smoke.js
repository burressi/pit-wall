// Smoke-test the whole dashboard in a fake DOM: load a replay, play it, open every tab/dialog, fire clicks.
const fs = require('fs'), vm = require('vm');
const ROOT = __dirname + '/..';
const html = fs.readFileSync(ROOT + '/source/app/app.html', 'utf8');
const sets = []; let errors = [];
class El {
  constructor(id, tag) { this.id = id || ''; this.tagName = (tag || 'DIV').toUpperCase(); this._html = ''; this.textContent = ''; this.value = ''; this.hidden = false; this.dataset = {}; this.style = {}; this.listeners = {}; this.open = false; this.checked = false;
    this.classList = { _s: new Set(), toggle: (c, on) => on ? this.classList._s.add(c) : this.classList._s.delete(c), add: c => this.classList._s.add(c), remove: c => this.classList._s.delete(c) };
    this.clientWidth = 900; this.clientHeight = 300; }
  set innerHTML(v) { this._html = v; sets.push([this.id, v]); }
  get innerHTML() { return this._html; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  querySelector() { return new El('q'); }
  querySelectorAll() { return []; }
  contains() { return false; }
  closest() { return null; }
  showModal() { this.open = true; } close() { this.open = false; }
  getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
  appendChild(c) { return c; } remove() {} click() {}
}
const els = {};
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
ids.forEach(id => { els[id] = new El(id, /^cv-/.test(id) ? 'canvas' : id === 'board' ? 'table' : 'div'); });
els.board.tHead = new El('thead'); els.board.tBodies = [new El('tbody')];
els['rp-speed'].value = '60';
// dev replay assets
const idx = JSON.parse(fs.readFileSync(ROOT + '/private/replays/index.json'));
idx.races.forEach(r => { const e = new El('dev-replay-' + r.id); e.textContent = fs.readFileSync(ROOT + '/private/replays/' + r.id + '.json', 'utf8'); els[e.id] = e; });
const timers = [];
const store = {};
const doc = { getElementById: id => els[id] || (els[id] = new El(id)), createElement: t => new El('', t), querySelectorAll: () => [], addEventListener() {}, activeElement: null, head: new El('head'), body: new El('body'), documentElement: new El('html') };
let NARROW = false;
const win = { TextDecoder, document: doc, matchMedia: (q) => ({ matches: NARROW && /max-width/.test(q) }), console, JSON, Math, Date, Promise, Proxy, URL, Blob: class {}, performance: { now: () => Date.now() }, devicePixelRatio: 1,
  getComputedStyle: () => ({ getPropertyValue: () => '' }), localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
  setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval() {}, setTimeout: (f) => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
  location: { href: 'https://ianburress.github.io/strategy/', origin: 'https://ianburress.github.io', protocol: 'https:', hash: '' }, open: () => ({}), navigator: {}, confirm: () => true, encodeURIComponent, decodeURIComponent, parseFloat, parseInt, isFinite };
win.window = win; win.globalThis = win;
vm.createContext(win);
const js = fs.readFileSync(ROOT + '/dev/app.js', 'utf8');
try { vm.runInContext(js, win, { filename: 'app.js' }); } catch (e) { console.error('BOOT ERROR', e); process.exit(1); }
const RS = win.RS, App = RS.App;
const frame = () => { try { timers[0](); } catch (e) { errors.push(e.stack.split('\n').slice(0, 3).join(' | ')); } };
const click = (data, extra) => {
  const t = new El('t'); t.dataset = data; Object.assign(t, extra || {});
  const ev = { target: { closest: () => t } };
  try { els['zs-app'].listeners.click.forEach(f => f(ev)); } catch (e) { errors.push('click ' + JSON.stringify(data) + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')); }
};
const change = (el) => { try { els['zs-app'].listeners.change.forEach(f => f({ target: el })); } catch (e) { errors.push('change: ' + e.message); } };
frame(); // empty state
click({ act: 'source' }); click({ act: 'settings' }); click({ act: 'close' });
(async () => {
  await App.loadReplay('miami-12h');
  await new Promise(r => setImmediate(r));
  console.log('source:', JSON.stringify(App.source), 'cars', App.engine.order.length);
  // pit-wall screen (default view) at several points of the race, laptop and phone
  const pw = [];
  for (const h of [0.75, 2, 4, 6.5, 8.4]) {
    App.replay.seek(h * 3600e3); App.dirty = true; frame();
    const M = App.pwModel; pw.push(M);
    if (h === 4) { NARROW = true; for (const tab of ['gaps', 'pit', 'flags']) { click({ pwt: tab }); App.dirty = true; frame(); fs.writeFileSync('/tmp/zs_phone_' + tab + '.html', els['pw-phone'].innerHTML); } NARROW = false; click({ pwt: 'gaps' }); }
    if (h === 6.5) { click({ pwn: 'overall' }); App.dirty = true; frame(); fs.writeFileSync('/tmp/zs_main_overall.html', els['pw-main'].innerHTML); click({ pwn: 'class' }); for (const f of ['class', 'all', 'around']) { click({ pwf: f }); App.dirty = true; frame(); } }
    fs.writeFileSync('/tmp/zs_main_' + h + 'h.html', els['pw-main'].innerHTML);
  }
  console.log('pit wall:', pw.map(M => 'lap ' + M.hdr.lap + ' P' + (M.row ? M.row.cpos : '?') + ' ahead ' + (M.ahead ? '#' + M.ahead.n + ' ' + (M.ahead.gapMs / 1000).toFixed(1) + 's' : '-') + ' behind ' + (M.behind ? '#' + M.behind.n + ' ' + (M.behind.gapMs / 1000).toFixed(1) + 's' : '-') + ' | ' + (M.pit ? RS.PW.windowText(M).head : '') + ' | ring ' + M.ring.cars.length + (M.ring.ghost ? ' ghost' : '')).join('\n          '));
  fs.writeFileSync('/tmp/zs_pw_model.json', JSON.stringify(pw.map(M => ({ hdr: M.hdr, ahead: M.ahead && Object.assign({}, M.ahead, { hist: M.ahead.hist.length }), behind: M.behind && Object.assign({}, M.behind, { hist: M.behind.hist.length }), tiles: M.tiles, pit: M.pit && { lossMs: M.pit.lossMs, win: M.pit.win, best: M.pit.best && M.pit.best.label, rows: M.pit.rows.map(r => [r.label, r.lap, r.cpos, r.pos, Math.round(r.lossMs / 1000), r.traffic && r.traffic.text]) }, rc: M.rc.slice(0, 4), ticks: M.ring.geom })), null, 1));
  click({ view: 'analysis' }); App.dirty = true; frame();
  App.replay.speed = 300; App.replay.play();
  const t0 = Date.now(); let n = 0;
  for (const tab of ['gap', 'laps', 'map', 'stints', 'compare', 'log', 'calls', 'inspect']) {
    click({ tab });
    for (let i = 0; i < 6; i++) { App.dirty = true; frame(); n++; }
  }
  App.replay.seek(4 * 3600e3); App.dirty = true; frame();
  click({ n: '178' }); click({ n: '14' }); click({ tab: 'compare' }); App.dirty = true; frame();
  click({ cls: 'all' }); App.dirty = true; frame(); click({ cls: 'team' }); App.dirty = true; frame();
  click({ hero: '177' }); App.dirty = true; frame(); click({ pp: '178' }); App.dirty = true; frame();
  const pp = new El('pp-preset'); pp.value = 'p80'; change(pp); App.dirty = true; frame();
  const plan = new El('x'); plan.dataset = { plan: '177' }; plan.value = String(App.engine.cars['177'].lastLap + 10); change(plan); App.dirty = true; frame();
  click({ call: 'BOX THIS LAP' }); click({ tab: 'calls' }); App.dirty = true; frame();
  click({ act: 'settings' }); const sv = new El('s'); sv.dataset = { s: 'follows' }; sv.value = '14, 85'; sv.type = 'text'; sv.closest = (q) => q === '#settings-body' ? {} : null; change(sv);
  click({ act: 'source' });
  click({ tab: 'map' }); App.dirty = true; frame();
  // results-file path
  const csv = fs.readFileSync((process.env.ZS_CSV_DIR || __dirname + '/../csv') + '/Watkins G 26 race 2.csv', 'utf8');
  App.loadResultsText(csv, 'Watkins G 26 race 2', false); App.dirty = true; frame();
  console.log('results-file replay:', App.engine.order.length, 'cars, lap records', App.replay.rep.laps.length, 'ref', JSON.stringify(App.engine.meta.refLapMs));
  // live via bridge with a DOM snapshot
  App.useBridge();
  App.lastDom = { headers: ['POS', 'NO.', 'CLS', 'DRIVER', 'LAPS', 'GAP', 'LAST', 'BEST', 'PIT'], rows: [['1', '4', 'ZP2', 'A', '10', '', '1:31.5', '1:30.9', ''], ['2', '177', 'ZR3', 'B', '10', '+20.1', '1:36.0', '1:35.1', ''], ['3', '178', 'ZR2', 'C', '9', '1 Lap', '1:34.0', '1:33.1', 'IN PIT']], meta: { title: 'Endurance Race 1', clocks: [{ text: '3:59:00', hint: 'remaining' }], flagText: 'GREEN' } };
  App.domDirty = true; App.dirty = true; frame();
  console.log('bridge/dom live:', JSON.stringify(App.source), 'hero view', !!App.view.hero, 'rows', App.view.rows.length);
  click({ view: 'pitwall' }); App.dirty = true; frame(); NARROW = true; App.dirty = true; frame(); NARROW = false;
  console.log('pit wall on bridge data:', els['pw-main'].innerHTML.length > 1000 ? 'rendered' : 'EMPTY');
  // source dialog with the new live options, and a connection attempt without a network
  click({ act: 'source' });
  // direct Al Kamel connection (fake server) -> pit wall with weather and race control
  const SID = '6b00000000000000000000aa'; let srv = null; const now0 = Date.now();
  win.WebSocket = class { constructor(url) { this.url = url; srv = this; }
    push(f) { this.onmessage({ data: f }); } emit(m) { this.push('a' + JSON.stringify([JSON.stringify(m)])); }
    send(raw) { const m = JSON.parse(JSON.parse(raw)[0]);
      if (m.msg === 'connect') this.emit({ msg: 'connected' });
      if (m.msg === 'sub') {
        if (m.name === 'livetimingFeed') { this.emit({ msg: 'added', collection: 'feeds', id: 'f1', fields: { name: 'zenith', running: true, sessions: [{ $type: 'oid', $value: 'aa1' }] } }); this.emit({ msg: 'added', collection: 'events', id: 'ev1', fields: { champName: 'ZENITH', name: 'SEBRING' } }); }
        if (m.name === 'sessions') this.emit({ msg: 'added', collection: 'sessions', id: SID, fields: { name: 'Race 1', UtcOffsetMin: -300, date: now0 - 3600e3, endDate: now0 + 3 * 3600e3, event: { $type: 'oid', $value: 'ev1' } } });
        this.emit({ msg: 'ready', subs: [m.id] }); } }
    close() {} };
  App.connectLT2({ series: 'zenith' }); srv.onopen && srv.onopen(); srv.push('o');
  const S = { $type: 'oid', $value: SID };
  [['177', 1, 'ZR3', 0], ['178', 2, 'ZR2', 1500], ['14', 3, 'ZR3', 4200]].forEach(([n, pos, cls, d], i) => {
    for (let lap = 1; lap <= 6; lap++) srv.emit({ msg: lap === 1 ? 'added' : 'changed', collection: 'standings', id: 's' + n, fields: { session: S, data: [pos, n, 'CLASSIFIED', i === 2 ? 2 : 1, lap, 0, 250, now0 - 3600e3 + lap * 100000 + d, 'TRACK', lap + 1].join(';'), lastLapTime: 100000, className: cls } });
  });
  srv.emit({ msg: 'added', collection: 'weather', id: 'w', fields: { session: S, weather: { ambientTemperature: 24, trackTemperature: 33, humidity: 60, windSpeed: 3 } } });
  srv.emit({ msg: 'added', collection: 'race_control', id: 'r1', fields: { session: S, message: 'FULL COURSE YELLOW - CAR 14 OFF AT T10', time: now0 - 120000 } });
  App.dirty = true; frame(); App.dirty = true; frame();
  console.log('direct live:', App.source.kind, 'session', App.lt2c.sessionId === SID, 'cars', App.view.rows.length, '| header wx:', els['hd-wx'].textContent, '| rc in pit wall:', /CAR 14 OFF/.test(els['pw-main'].innerHTML), '| recorded', App.recorder.count);
  click({ act: 'source' }); console.log('session picker lists the session:', /Race 1/.test(els['source-body'].innerHTML));
  const recText = App.recorder.text();
  await App.loadRecording({ name: 'zenith_test.jsonl', arrayBuffer: async () => Buffer.from(recText) });
  App.recPlayer.seek(App.recPlayer.end); App.dirty = true; frame();
  console.log('recording playback:', App.source.kind, 'cars', App.view.rows.length, 'wx', els['hd-wx'].textContent);
  console.log('frames', n, 'ms', Date.now() - t0, 'innerHTML writes', sets.length);
  console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'no runtime errors');
  // dump the last html of key panels for markup validation
  const last = {}; sets.forEach(([id, h]) => { last[id] = h; });
  fs.writeFileSync('/tmp/zs_panels.json', JSON.stringify(last));
})();
