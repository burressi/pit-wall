// End to end: fake Al Kamel server -> pitwall_hub.py -> three screens (laptop from the start, a phone that joins
// mid-race and sleeps, a screen that opens after the flag). Includes an Al Kamel drop and a hub crash + restart.
// Every screen must end with the same lap history, pit stops and positions as the official timing.
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const load = require('./load'); const makeFeed = require('./make_feed');
const ROOT = path.join(__dirname, '..');
const SPEED = +(process.env.SPEED || 600), FAKE = 9400 + Math.floor(Math.random() * 300), HUBP = FAKE + 1000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-e2e-'));
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const JS = ['util.js', 'engine.js', 'replay.js', 'live.js', 'lt2.js', 'hub.js'];

/* 1. the scripted race */
const base = load(JS);
const feed = makeFeed(base.RS, path.join(TMP, 'feed.jsonl'), {});
console.log('script:', feed.messages, 'messages,', feed.standings, 'standings updates,', Object.keys(feed.expect).length, 'cars');

/* 2. hub folder as delivered: pitwall_hub.py + web/index.html */
const HUBDIR = path.join(TMP, 'hub'); fs.mkdirSync(path.join(HUBDIR, 'web'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'hub/pitwall_hub.py'), path.join(HUBDIR, 'pitwall_hub.py'));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(HUBDIR, 'web/index.html'));
if (fs.existsSync(path.join(ROOT, 'private/team-pack.json'))) fs.copyFileSync(path.join(ROOT, 'private/team-pack.json'), path.join(HUBDIR, 'team-pack.json'));
const SIM_EPOCH = feed.START - 120000; let T0 = Date.now() / 1000 + 1.5;
const procs = [];
function spawn(name, args, env) {
  const log = fs.openSync(path.join(TMP, name + '.log'), 'a');
  const p = cp.spawn('python3', args, { env: Object.assign({}, process.env, env || {}), stdio: ['ignore', log, log] });
  procs.push(p); return p;
}
const fake = spawn('fake', [path.join(__dirname, 'fake_alkamel.py'), '--port', FAKE, '--script', path.join(TMP, 'feed.jsonl'), '--speed', SPEED, '--sim-epoch', SIM_EPOCH, '--t0', T0]);
const hubArgs = [path.join(HUBDIR, 'pitwall_hub.py'), '--upstream', `ws://127.0.0.1:${FAKE}/sockjs/{rand}/websocket`, '--builtin-ws', '--no-browser', '--port', HUBP, '--record-dir', path.join(TMP, 'rec')];
let hub = spawn('hub', hubArgs, { ZS_SIM_EPOCH: SIM_EPOCH, ZS_SIM_T0: T0, ZS_SIM_SPEED: SPEED });
const BASE = `http://127.0.0.1:${HUBP}/`;
const stats = async () => JSON.parse(await (await fetch(`http://127.0.0.1:${FAKE}/_stats`)).text());
const raceAt = async () => (await stats()).raceMs;

/* 3. a screen: the same feed client and model the page uses */
function makeES(extra) {
  return class ES {
    constructor(url) { this.url = url; this.readyState = 0; this.ls = {}; this.lastId = ''; this.retry = 2000; this.closed = false; this._go(); }
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
    async _go() {
      if (this.closed) return;
      this.ctl = new AbortController();
      try {
        const h = Object.assign({ Accept: 'text/event-stream' }, extra); if (this.lastId) h['Last-Event-ID'] = this.lastId;
        const r = await fetch(this.url, { headers: h, signal: this.ctl.signal });
        if (!r.ok) { this.readyState = 2; this.onerror && this.onerror(); return; }
        this.readyState = 1; const dec = new TextDecoder(); let buf = '';
        for await (const ch of r.body) {
          buf += dec.decode(ch, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); this._block(b); }
        }
      } catch (e) { /* aborted or dropped */ }
      if (this.closed) return;
      this.readyState = 0; this.onerror && this.onerror();
      setTimeout(() => this._go(), this.retry);
    }
    _block(b) {
      let type = 'message', id = null; const data = [];
      b.split('\n').forEach(l => { if (!l || l[0] === ':') return; const k = l.indexOf(':'); const f = k < 0 ? l : l.slice(0, k); let v = k < 0 ? '' : l.slice(k + 1); if (v[0] === ' ') v = v.slice(1);
        if (f === 'event') type = v; else if (f === 'data') data.push(v); else if (f === 'id') id = v; else if (f === 'retry') this.retry = +v; });
      if (id !== null) this.lastId = id;
      if (data.length) (this.ls[type] || []).forEach(f => { try { f({ data: data.join('\n'), lastEventId: this.lastId }); } catch (e) { console.error('handler', e); } });
    }
    close() { this.closed = true; this.readyState = 2; try { this.ctl && this.ctl.abort(); } catch (e) { /* */ } }
  };
}
class MuteES { constructor() { this.readyState = 1; } addEventListener() {} close() { this.readyState = 2; } }   // a proxy that buffers the stream forever
function screen(name, headers, es) {
  const ctx = load(JS); const RS = ctx.RS;
  ctx.fetch = (u, o) => fetch(u, Object.assign({}, o || {}, { headers: Object.assign({}, (o || {}).headers || {}, headers || {}) }));
  ctx.EventSource = es === 'none' ? undefined : es === 'mute' ? MuteES : makeES(headers || {}); ctx.AbortController = AbortController;
  const S = { name, RS, resets: 0, statuses: 0, snaps: 0, errors: [], status: null, maxCatchMs: 0 };
  S.mirror = new RS.Mirror();
  const snap = (t) => { try { const s = S.model.snapshot(t); if (s && s.cars.length) { S.ls.apply(s); S.snaps++; } } catch (e) { S.errors.push(e.stack); } };
  const F = S.feed = new RS.Hub.Feed({ base: BASE, mirror: S.mirror, onSnap: snap });
  F.on('reset', st => { S.resets++; S.catchStart = Date.now(); S.mirror.clear(); S.eng = new RS.Engine({ hero: '178', sisters: ['177'] }); S.ls = new RS.LiveSession(S.eng); S.ls.start({ name: 'x' }); S.model = new RS.LT2.Model(S.mirror, {}); S.model.sessionId = st.session && st.session.id || null; });
  F.on('live', x => { S.maxCatchMs = Math.max(S.maxCatchMs, Date.now() - S.catchStart); S.lastCatch = x.messages; });
  F.on('status', st => { S.status = st; S.statuses++; if (S.model && st.session && !S.model.sessionId) S.model.sessionId = st.session.id; });
  F.on('data', () => { S.dirty = true; });
  F.on('error', e => S.errors.push(String(e && e.message || e)));
  S.timer = setInterval(() => { if (S.dirty && !F.catching && !F.draining && S.model) { S.dirty = false; snap(Math.max(F.now(), F.lastT)); F.markSnap(); } }, 150);
  S.stop = () => { clearInterval(S.timer); F.stop(); };
  F.start();
  return S;
}
function compare(S) {
  const exp = feed.expect, eng = S.eng; if (!eng) return { ok: false, why: 'no engine' };
  let lapsOk = 0, lapsN = 0, stopsOk = 0, stopsN = 0, posOk = 0, posN = 0, missing = [];
  const v = eng.compute();
  for (const n in exp) {
    const e = exp[n], c = eng.cars[n];
    if (!e.laps.length) continue;
    if (!c) { missing.push(n); continue; }
    e.laps.forEach(([k, t]) => { lapsN++; const l = c.laps[k]; if (l && l.t === t) lapsOk++; else if ((S.badLaps = S.badLaps || []).length < 6) S.badLaps.push(n + ' lap ' + k + ': ' + (l ? l.t : 'none') + ' vs ' + t + ' (has ' + c.laps.length + ')'); });
    const a = c.stops.map(s => s.laneMs).sort((x, y) => x - y), b = e.stops.slice().sort((x, y) => x - y);
    stopsN++; if (a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1)) stopsOk++; else S.badStops = (S.badStops || []).concat(n + ': ' + a.map(x => Math.round(x / 1000)).join(',') + ' vs ' + b.map(x => Math.round(x / 1000)).join(','));
    const r = v.byN[n]; posN++; if (r && r.pos === e.pos && r.cpos === e.cpos) posOk++;
  }
  return { lapsOk, lapsN, stopsOk, stopsN, posOk, posN, missing };
}

(async () => {
  try {
    // wait for the hub
    for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + 'api/hub'); if (r.ok) break; } catch (e) { /* */ } await sleep(200); }
    const st0 = await (await fetch(BASE + 'api/hub')).json();
    ok(st0.hub && st0.local === true && st0.urls && /localhost/.test(st0.urls.local), 'hub answers; this machine is recognised as the laptop');
    const page = await fetch(BASE, { headers: { 'Accept-Encoding': 'gzip' } });
    const html = await page.text();
    ok(page.ok && /<title>Pit wall<\/title>/.test(html) && html.length > 2e5 && !/zs-asset-app|PBKDF2|fuelGalPerLap/.test(html), 'serves the pit wall page (no password gate, no team data in it)');
    const tp = await fetch(BASE + 'api/team-pack').then(r => r.ok ? r.json() : null).catch(() => null);
    ok(tp && tp.kind === 'pit-wall-team-pack' && Object.keys(tp.replays || {}).length >= 9 && tp.settings.trackFuel['homestead-miami'], 'serves the private team pack from the laptop (replays + fuel)');

    const A = screen('laptop');
    await sleep(2500);
    const s1 = await (await fetch(BASE + 'api/hub')).json();
    ok(s1.state === 'connected' && s1.session && s1.session.id === feed.SID, 'hub connected over SockJS and picked the race session by itself');
    ok(/ok - standings/.test(s1.subs.standings) && /ok - sessionPitInfo/.test(s1.subs.pits) && /refused/.test(s1.subs.results), 'data sets: accepted ones streaming, unknown ones given up (' + JSON.stringify(s1.subs).slice(0, 160) + ')');
    const fst = await stats();
    ok(fst.stats.nosub.includes('standings') && fst.stats.nosub.includes('sessionResults'), 'both parameter shapes tried; the wrong one refused without harm');

    // settings from the laptop reach the phones
    let r = await fetch(BASE + 'api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { hero: '178', teamCars: ['177', '178'], trackPreset: 'homestead-miami' } }) });
    ok(r.ok, 'laptop shares its team settings');

    while (await raceAt() < feed.durationMs * 0.4) await sleep(300);
    const B = screen('phone', { 'X-Forwarded-For': '192.168.1.50' });
    await sleep(300);
    r = await fetch(BASE + 'api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.168.1.50' }, body: '{"session":"auto"}' });
    ok(r.status === 403, 'a phone cannot change the session (only the laptop can)');
    while (B.feed.catching) await sleep(100);
    ok(B.status && B.status.local === false && B.lastCatch > 1000, 'phone joined mid-race and caught up ' + B.lastCatch + ' messages in ' + B.maxCatchMs + ' ms');
    const full = await B.feed.fetchStatus();
    ok(full.settings && full.settings.trackPreset === 'homestead-miami', 'phone receives the laptop settings');

    const D = screen('internet-link (long-poll)', { 'Cf-Connecting-Ip': '203.0.113.9' }, 'none');
    const E = screen('buffering proxy', { 'X-Forwarded-For': '10.0.0.7' }, 'mute');
    while (await raceAt() < feed.durationMs * 0.5) await sleep(300);
    for (let i = 0; i < 60 && !E.feed.pollMode; i++) await sleep(250);
    ok(D.feed.live && D.status && D.status.local === false, 'internet-link screen (no streaming) is live by long-polling');
    ok(E.feed.pollMode === true && E.feed.live, 'screen behind a buffering proxy noticed and switched to long-polling');
    // a short outage: at 600x even one real second is 10 race-minutes, so hold the race clock while the hub reconnects
    await fetch(`http://127.0.0.1:${FAKE}/_pause`);
    await fetch(`http://127.0.0.1:${FAKE}/_drop`);
    console.log('     dropped the Al Kamel connection at', Math.round((await raceAt()) / 60000), 'min');
    let s2 = null;
    for (let i = 0; i < 40; i++) { await sleep(250); s2 = await (await fetch(BASE + 'api/hub')).json(); if (s2.state === 'connected' && /ok/.test(s2.subs.standings || '')) break; }
    await fetch(`http://127.0.0.1:${FAKE}/_resume`);
    ok(s2.state === 'connected' && (await stats()).stats.conns >= 2, 'hub reconnected to Al Kamel with a fresh SockJS address and resubscribed');

    // phone goes to sleep for ~3 s (30 sim-minutes) then wakes
    B.feed.es.close(); B.feed.lastHeard = 0; const bAppliedBefore = B.feed.applied; B.feed.live = false;
    await sleep(3000); B.feed.live = true; B.feed._watchdog(true);
    await sleep(2500);
    ok(B.feed.applied > bAppliedBefore + 200 && B.feed.state === 'live', 'phone woke up and received what it missed (' + (B.feed.applied - bAppliedBefore) + ' messages)');

    while (await raceAt() < feed.durationMs * 0.65) await sleep(300);
    await fetch(`http://127.0.0.1:${FAKE}/_pause`);
    await sleep(1500);                                  // let the hub flush its recording, then crash it
    hub.kill('SIGKILL');
    const simNow = +(await (await fetch(`http://127.0.0.1:${FAKE}/_timesync`)).text());
    T0 = Date.now() / 1000 + 2.5;
    hub = spawn('hub', hubArgs, { ZS_SIM_EPOCH: simNow, ZS_SIM_T0: T0, ZS_SIM_SPEED: SPEED });
    await sleep(2500); await fetch(`http://127.0.0.1:${FAKE}/_resume`);
    console.log('     hub crashed and restarted at', Math.round((simNow - feed.START) / 60000), 'min');
    await sleep(4000);
    const s3 = await (await fetch(BASE + 'api/hub')).json();
    ok(s3.state === 'connected' && s3.session && s3.session.id === feed.SID && s3.msgs > 1000, 'restarted hub picked up its own recording (' + s3.msgs + ' messages) and carried on');
    ok(A.resets >= 2 && B.resets >= 2 && D.resets >= 2 && E.resets >= 2, 'every screen noticed the restart and rebuilt from the hub (laptop ' + A.resets + ', phone ' + B.resets + ', long-poll ' + D.resets + '/' + E.resets + ')');

    const end = feed.START + feed.durationMs;
    while ((await stats()).pos < (await stats()).len) await sleep(500);
    await sleep(2500);
    const C = screen('late');
    while (C.feed.catching || !C.eng) await sleep(100);
    await sleep(1000);
    const st = await (await fetch(BASE + 'api/hub')).json();
    console.log('     hub log', st.msgs, 'messages; late screen caught up in', C.maxCatchMs, 'ms');

    for (const S of [A, B, C, D, E]) {
      const c = compare(S);
      ok(c.lapsOk === c.lapsN && c.lapsN > 2000, S.name + ': lap history identical to official timing (' + c.lapsOk + '/' + c.lapsN + ' laps)' + (c.lapsOk === c.lapsN ? '' : ' ' + (S.badLaps || []).join(' | ')));
      ok(c.stopsOk === c.stopsN, S.name + ': pit stops and pit-lane times identical (' + c.stopsOk + '/' + c.stopsN + ' cars)' + (S.badStops ? ' ' + S.badStops.slice(0, 3).join(' | ') : ''));
      ok(c.posOk === c.posN && !c.missing.length, S.name + ': final overall + class positions identical (' + c.posOk + '/' + c.posN + ')');
      ok(!S.errors.filter(e => !/fetch failed|hub answered|ECONNREFUSED/i.test(e)).length, S.name + ': no errors' + (S.errors.length ? ' (' + S.errors.slice(0, 2).join(' | ').slice(0, 200) + ')' : ''));
    }
    const finished = C.model.snapshot(C.feed.lastT).session;
    ok(finished.finished === true && finished.remainingMs === 0, 'chequered flag / session finished reached every screen');
    const recs = fs.readdirSync(path.join(TMP, 'rec'));
    ok(recs.filter(n => n.includes(feed.SID)).length === 1, 'one recording file for the session, continued across the restart: ' + recs.join(', '));
    const recText = fs.readFileSync(path.join(TMP, 'rec', recs.find(n => n.includes(feed.SID))), 'utf8');
    const rec = base.RS.LT2.parseRecording(recText);
    ok(rec.count > 10000, 'recording opens in the page\'s recording player (' + rec.count + ' messages)');
    [A, B, C, D, E].forEach(S => S.stop());
  } catch (e) { fails++; console.log('FAIL exception', e.stack); }
  procs.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* */ } });
  console.log(fails ? fails + ' FAILED' : 'all passed', '· logs in', TMP);
  if (!fails) { /* keep logs only on failure */ }
  process.exit(fails ? 1 : 0);
})();
