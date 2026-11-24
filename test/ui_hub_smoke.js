// The real page (dev build) in a fake DOM, served-by-the-hub mode: boots, finds the hub by itself, catches up,
// renders the pit wall on the laptop and the phone layout, shows the hub panel with the crew links, shares settings.
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process'), os = require('os');
const load = require('./load'); const makeFeed = require('./make_feed');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(ROOT + '/source/app/app.html', 'utf8');
const SPEED = 300, FAKE = 9800 + Math.floor(Math.random() * 100), HUBP = FAKE + 300;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ui-'));
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sets = []; const errors = [];
class El {
  constructor(id, tag) { this.id = id || ''; this.tagName = (tag || 'DIV').toUpperCase(); this._html = ''; this.textContent = ''; this.value = ''; this.hidden = false; this.dataset = {}; this.style = {}; this.listeners = {}; this.open = false; this.checked = false;
    this.classList = { _s: new Set(), toggle: (c, on) => on ? this.classList._s.add(c) : this.classList._s.delete(c), add: c => this.classList._s.add(c), remove: c => this.classList._s.delete(c) };
    this.clientWidth = 900; this.clientHeight = 300; }
  set innerHTML(v) { this._html = v; sets.push([this.id, v]); }
  get innerHTML() { return this._html; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {} querySelector() { return new El('q'); } querySelectorAll() { return []; } contains() { return false; } closest() { return null; }
  showModal() { this.open = true; } close() { this.open = false; }
  getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
  appendChild(c) { return c; } remove() {} click() {}
}
const els = {};
[...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]).forEach(id => { els[id] = new El(id, /^cv-/.test(id) ? 'canvas' : id === 'board' ? 'table' : 'div'); });
els.board.tHead = new El('thead'); els.board.tBodies = [new El('tbody')];
JSON.parse(fs.readFileSync(ROOT + '/private/replays/index.json')).races.forEach(r => { const e = new El('dev-replay-' + r.id); e.textContent = fs.readFileSync(ROOT + '/private/replays/' + r.id + '.json', 'utf8'); els[e.id] = e; });
const store = {};
const doc = { getElementById: id => els[id] || (els[id] = new El(id)), createElement: t => new El('', t), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, activeElement: null, head: new El('head'), body: new El('body'), documentElement: new El('html'), visibilityState: 'visible' };
let NARROW = false;
const BASE = `http://127.0.0.1:${HUBP}/`;
const abs = (u) => /^https?:/.test(u) ? u : BASE + String(u).replace(/^\//, '');
function makeES() {
  return class ES {
    constructor(url) { this.url = abs(url); this.readyState = 0; this.ls = {}; this.lastId = ''; this.closed = false; this._go(); }
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
    async _go() {
      if (this.closed) return; this.ctl = new AbortController();
      try {
        const h = { Accept: 'text/event-stream' }; if (this.lastId) h['Last-Event-ID'] = this.lastId;
        const r = await fetch(this.url, { headers: h, signal: this.ctl.signal }); this.readyState = 1;
        const dec = new TextDecoder(); let buf = '';
        for await (const ch of r.body) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); this._block(b); } }
      } catch (e) { /* */ }
      if (this.closed) return; this.readyState = 0; this.onerror && this.onerror(); setTimeout(() => this._go(), 2000);
    }
    _block(b) { let type = 'message', id = null; const data = []; b.split('\n').forEach(l => { if (!l || l[0] === ':') return; const k = l.indexOf(':'); const f = k < 0 ? l : l.slice(0, k); let v = k < 0 ? '' : l.slice(k + 1); if (v[0] === ' ') v = v.slice(1); if (f === 'event') type = v; else if (f === 'data') data.push(v); else if (f === 'id') id = v; });
      if (id !== null) this.lastId = id; if (data.length) (this.ls[type] || []).forEach(f => { try { f({ data: data.join('\n') }); } catch (e) { errors.push('sse ' + e.stack.split('\n').slice(0, 3).join(' | ')); } }); }
    close() { this.closed = true; this.readyState = 2; try { this.ctl && this.ctl.abort(); } catch (e) { /* */ } }
  };
}
const timers = [];
const win = { TextDecoder, document: doc, matchMedia: (q) => ({ matches: NARROW && /max-width/.test(q) }), console, JSON, Math, Date, Promise, Proxy, URL, Blob: class {}, performance: { now: () => Date.now() }, devicePixelRatio: 1,
  getComputedStyle: () => ({ getPropertyValue: () => '' }), localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
  setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval: (i) => clearInterval(i), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), addEventListener() {}, removeEventListener() {},
  location: { href: BASE, origin: BASE.slice(0, -1), protocol: 'http:', hash: '' }, open: () => ({}), navigator: {}, confirm: () => true, encodeURIComponent, decodeURIComponent, parseFloat, parseInt, isFinite,
  fetch: (u, o) => fetch(abs(u), o), AbortController, EventSource: makeES() };
win.window = win; win.globalThis = win;

const feed = makeFeed(load(['util.js', 'engine.js', 'replay.js', 'live.js', 'lt2.js']).RS, path.join(TMP, 'feed.jsonl'), {});
const HUBDIR = path.join(TMP, 'hub'); fs.mkdirSync(path.join(HUBDIR, 'web'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'hub/pitwall_hub.py'), path.join(HUBDIR, 'pitwall_hub.py'));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(HUBDIR, 'web/index.html'));
const SIM_EPOCH = feed.START + 290 * 60000, T0 = Date.now() / 1000 + 1;          // the screen opens ~5 h into the race (clear of the red flags)
const procs = [];
const spawn = (name, args, env) => { const log = fs.openSync(path.join(TMP, name + '.log'), 'a'); const p = cp.spawn('python3', args, { env: Object.assign({}, process.env, env || {}), stdio: ['ignore', log, log] }); procs.push(p); return p; };
spawn('fake', [path.join(__dirname, 'fake_alkamel.py'), '--port', FAKE, '--script', path.join(TMP, 'feed.jsonl'), '--speed', SPEED, '--sim-epoch', SIM_EPOCH, '--t0', T0]);
spawn('hub', [path.join(HUBDIR, 'pitwall_hub.py'), '--upstream', `ws://127.0.0.1:${FAKE}/sockjs/{rand}/websocket`, '--builtin-ws', '--no-browser', '--port', HUBP, '--record-dir', path.join(TMP, 'rec')],
  { ZS_SIM_EPOCH: SIM_EPOCH, ZS_SIM_T0: T0, ZS_SIM_SPEED: SPEED });

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + 'api/hub')).ok) break; } catch (e) { /* */ } await sleep(200); }
    await sleep(2500);                                    // let the hub collect 2 h + of race
    vm.createContext(win);
    vm.runInContext(fs.readFileSync(ROOT + '/dev/app.js', 'utf8'), win, { filename: 'app.js' });
    const RS = win.RS, App = RS.App;
    const frame = () => { try { timers[0](); } catch (e) { errors.push(e.stack.split('\n').slice(0, 3).join(' | ')); } };
    const click = (data) => { const t = new El('t'); t.dataset = data; try { els['zs-app'].listeners.click.forEach(f => f({ target: { closest: () => t } })); } catch (e) { errors.push('click ' + JSON.stringify(data) + ': ' + e.message); } };
    const change = (el) => { try { els['zs-app'].listeners.change.forEach(f => f({ target: el })); } catch (e) { errors.push('change: ' + e.message); } };
    for (let i = 0; i < 100 && !(App.hub && App.hub.live); i++) { frame(); await sleep(100); }
    ok(App.source.kind === 'hub' && App.hub && App.hub.live, 'page found the hub by itself and went live (' + (App.hub ? App.hub.done : 0) + ' messages caught up)');
    let txt = ''; for (let i = 0; i < 20; i++) { App.dirty = true; frame(); await sleep(150); txt = els['src-text'].textContent; }
    ok(/^(Live · data|Waiting for data)/.test(txt) && !/hub|Catching/i.test(txt), 'status chip shows live data age (accelerated clock): ' + txt);
    ok(App.view.rows.length === Object.keys(feed.expect).filter(n => feed.expect[n].laps.length).length || App.view.rows.length >= 15, 'board has ' + App.view.rows.length + ' cars');
    ok(els['pw-main'].innerHTML.length > 3000 && /#178/.test(els['pw-main'].innerHTML), 'pit wall rendered with our car');
    ok(App.pwModel && App.pwModel.ahead && App.pwModel.ring.cars.length > 5, 'gaps and lap ring live (ahead #' + (App.pwModel.ahead && App.pwModel.ahead.n) + ')');
    const lead0 = App.view.rows[0].laps, hero0 = App.view.hero ? App.view.hero.n + ' lap ' + App.view.hero.laps : '-'; await sleep(2500); App.dirty = true; frame();
    ok(App.view.rows[0].laps > lead0, 'keeps updating in real time (leader lap ' + lead0 + ' → ' + App.view.rows[0].laps + '; our car #' + hero0 + ')');
    NARROW = true; for (const tab of ['gaps', 'pit', 'flags']) { click({ pwt: tab }); App.dirty = true; frame(); }
    ok(els['pw-phone'].innerHTML.length > 1000, 'crew phone layout renders (3 tabs)'); NARROW = false; click({ pwt: 'gaps' });
    click({ act: 'source' }); await sleep(600);
    const body = els['source-body'].innerHTML;
    ok(/pit wall hub/.test(body) && /THIS LAPTOP/.test(body) && /id="hub-session"/.test(body) && /hub-url/.test(body) && !/Strategy bridge|bm-code/.test(body), 'data source panel: hub status, session picker, crew address; no bridge/bookmark clutter');
    ok(/Following: <b>ZENITH RACING SERIES \| HOMESTEAD-MIAMI \| Endurance Race/.test(body) && /ok - standings/.test(body), 'panel shows the session and data sets');
    const sel = new El('hub-session'); sel.value = 'auto'; change(sel); await sleep(400);
    click({ act: 'close' });
    // laptop settings -> hub
    const sv = new El('s'); sv.dataset = { s: 'trackPreset' }; sv.value = 'homestead-miami'; sv.type = 'select-one'; sv.closest = (q) => q === '#settings-body' ? {} : null; change(sv);
    await sleep(900);
    const st = await (await fetch(BASE + 'api/hub')).json();
    ok(st.settings && st.settings.trackPreset === 'homestead-miami' && st.settingsVer > 1, 'laptop settings shared through the hub');
    click({ act: 'diag-copy' });
    click({ view: 'analysis' }); for (const tab of ['gap', 'laps', 'stints', 'log']) { click({ tab }); App.dirty = true; frame(); }
    click({ view: 'pitwall' }); App.dirty = true; frame();
    // replay from the menu stops the hub feed; reconnect brings it back
    await App.loadReplay('miami-12h'); App.dirty = true; frame();
    ok(App.source.kind === 'replay' && !App.hub, 'a replay can still be opened (hub paused for this screen)');
    click({ act: 'hub-connect' });
    for (let i = 0; i < 100 && !(App.hub && App.hub.live); i++) { frame(); await sleep(100); }
    ok(App.source.kind === 'hub' && App.hub.live, 'reconnects to the hub from the panel');
    ok(!errors.length, errors.length ? 'ERRORS:\n' + [...new Set(errors)].slice(0, 6).join('\n') : 'no runtime errors');
    App.hub && App.hub.stop();
  } catch (e) { fails++; console.log('FAIL exception', e.stack); }
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* */ } });
  console.log(fails ? fails + ' FAILED · logs in ' + TMP : 'all passed');
  process.exit(fails ? 1 : 0);
})();
