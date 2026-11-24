// Al Kamel LT2 (confirmed format): SockJS framing, subscription probing, standings 'data' strings, recordings.
const load = require('./load'); const fs = require('fs'); const zlib = require('zlib');
const ctx = load(['util.js', 'engine.js', 'replay.js', 'live.js', 'lt2.js']); const RS = ctx.RS, LT2 = RS.LT2;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

/* 1. framing */
let f = LT2.decodeFrame('a["{\\"msg\\":\\"ready\\",\\"subs\\":[\\"x\\"]}"]');
ok(f.type === 'data' && f.msgs[0].msg === 'ready', 'decode SockJS a[] frame');
ok(LT2.decodeFrame('o').type === 'open' && LT2.decodeFrame('h').type === 'heartbeat' && LT2.decodeFrame('c[3000,"Go away!"]').type === 'close', 'decode o/h/c frames');
ok(LT2.encodeFrame({ msg: 'pong' }, true) === '["{\\"msg\\":\\"pong\\"}"]', 'encode SockJS frame');
ok(/^wss:\/\/livetiming\.alkamelsystems\.com\/sockjs\/\d{3}\/[a-z0-9]{8}\/websocket$/.test(LT2.sockUrl()), 'SockJS URL shape matches the capture');

/* 2. learn subscriptions from the capture Ian pasted (includes the chat's emoji damage) */
const cap = [
  '["{\\"msg\\"😕"sub\\",\\"id\\"😕"i45Bsdijp3bFbQ7mQ\\",\\"name\\"😕"meteor.loginServiceConfiguration\\",\\"params\\":[]}"] 110 18:04:19.345',
  '["{\\"msg\\"😕"sub\\",\\"id\\"😕"TCTrG7Ht8PtaEP6do\\",\\"name\\"😕"events\\",\\"params\\":[[{\\"$type\\"😕"oid\\",\\"$value\\"😕"6afc8efdb85b523068569be7\\"},{\\"$type\\"😕"oid\\",\\"$value\\"😕"6afc8f0fb85b523068569c9e\\"}]]}"]    745    18:16:08.398',
  '["{\\"msg\\":\\"sub\\",\\"id\\":\\"ab\\",\\"name\\":\\"livetimingFeed\\",\\"params\\":[\\"ferrarichallenge\\"]}"]',
  '["{\\"msg\\"😕"sub\\",\\"id\\"😕"nqHBZq7wQBoQYnw8s\\",\\"name\\"😕"sessionInfo\\",\\"params\\":[[{\\"$type\\"😕"oid\\",\\"$value\\"😕"670e9a0bb85b52282804109d\\"},{\\"$type\\"😕"oid\\",\\"$value\\"😕"670e9a0bb85b52282804109c\\"}]]}"]',
  '["{\\"msg\\"😕"sub\\",\\"id\\"😕"7PaEjxuc2JgdJJSyZ\\",\\"name\\"😕"sessionClasses\\",\\"params\\":[{\\"$type\\"😕"oid\\",\\"$value\\"😕"6afc8f0fb85b523068569cba\\"}]}"]    151    18:16:08.957',
  '["{\\"msg\\":\\"sub\\",\\"id\\":\\"q1\\",\\"name\\":\\"standingsX\\",\\"params\\":[{\\"$type\\":\\"oid\\",\\"$value\\":\\"6afc8f0fb85b523068569cba\\"}]}"]'
].join('\n');
const rc = LT2.recipeFromCapture(cap);
ok(rc.feed[0].name === 'livetimingFeed' && rc.feed[0].params[0] === '$SERIES', 'capture: feed subscription generalised to the series');
ok(rc.list.some(x => x.name === 'sessionInfo' && x.params[0] === '$FEED_SESSIONS'), 'capture: sessionInfo takes the feed session list');
ok(rc.session.map(x => x.names[0]).join() === 'sessionClasses,standingsX' && rc.session[0].params[0] === '$SESSION', 'capture: per-session subscriptions take the chosen session (meteor/events skipped)');

/* 3. a fake Al Kamel server behind a fake WebSocket, built from the Miami 12 h timing */
const rep = JSON.parse(fs.readFileSync(__dirname + '/../private/replays/miami-12h.json'));
const START = Date.UTC(2026, 9, 3, 13, 0, 0);       // session start (epoch ms)
const SID = '6b00000000000000000000aa', FEEDS = ['670e9a0bb85b5228280410a1', '670e9a0bb85b5228280410a2'];
const ACCEPT = { livetimingFeed: 1, sessions: 1, sessionInfo: 1, trackInfo: 1, sessionClasses: 1, standings: 1, sessionPitInfo: 1, sessionStatus: 1, raceControl: 1, weather: 1, sessionEntry: 1 }; // sessionResults refused
const sent = []; let server = null; const urls = [];
class FakeWS {
  constructor(url) { urls.push(url); this.url = url; server = this; this.out = []; setTimeout(() => { this.onopen && this.onopen(); this.push('o'); }, 0); }
  push(frame) { this.onmessage && this.onmessage({ data: frame }); }
  emit(m) { this.push('a' + JSON.stringify([JSON.stringify(m)])); }
  send(raw) {
    const arr = JSON.parse(raw); const m = JSON.parse(arr[0]); sent.push(m);
    if (m.msg === 'connect') this.emit({ msg: 'connected', session: 'x' });
    if (m.msg === 'sub') {
      const p = m.params;
      if (!ACCEPT[m.name]) { this.emit({ msg: 'nosub', id: m.id, error: { error: 404, reason: "Subscription '" + m.name + "' not found", message: "Subscription '" + m.name + "' not found [404]" } }); return; }
      if (m.name === 'standings' && !(p[0] && p[0].$type === 'oid')) { this.emit({ msg: 'nosub', id: m.id, error: { error: 400, reason: 'Match failed' } }); return; }
      if (m.name === 'livetimingFeed') {
        this.emit({ msg: 'added', collection: 'feeds', id: 'Z9PcE6kjsSqroG98D', fields: { name: p[0], running: true, sessions: FEEDS.map(LT2.oid) } });
        this.emit({ msg: 'added', collection: 'events', id: 'ev1', fields: { id: 459, index: START, champName: 'ZENITH RACING SERIES', name: 'HOMESTEAD-MIAMI', championship: LT2.oid('c1') } });
      }
      if (m.name === 'sessions') {
        this.emit({ msg: 'added', collection: 'sessions', id: '6b00000000000000000000a9', fields: { id: 2445, name: 'Qualifying ', UtcOffsetMin: -240, date: START - 86400000, endDate: START - 86400000 + 1800000, event: LT2.oid('ev1') } });
        this.emit({ msg: 'added', collection: 'sessions', id: SID, fields: { id: 2446, name: 'Endurance Race ', UtcOffsetMin: -240, date: START, endDate: START + rep.meta.durationMs, event: LT2.oid('ev1') } });
      }
      if (m.name === 'sessionClasses') rep.cars.forEach((c, i) => {});
      this.subs = this.subs || {}; this.subs[m.name] = m.id;
      this.emit({ msg: 'ready', subs: [m.id] });
    }
  }
  close() { this.closed = true; }
}
ctx.WebSocket = FakeWS; ctx.fetch = () => Promise.reject(new Error('blocked by CORS'));

(async () => {
  const mirror = new RS.Mirror(); const recorder = new LT2.Recorder(); recorder.on = true;
  const client = new LT2.Client({ series: 'zenith', mirror, recorder });
  client.now = () => clock;   // simulated wall clock
  let clock = START - 5 * 60000;
  client.start();
  await new Promise(r => setTimeout(r, 20));
  ok(urls[0].includes('/sockjs/'), 'connects over SockJS');
  ok(sent[0].msg === 'connect' && sent.some(m => m.name === 'livetimingFeed' && m.params[0] === 'zenith'), 'subscribes livetimingFeed ["zenith"]');
  ok(sent.some(m => m.name === 'sessions' && m.params[0].length === 2 && m.params[0][0].$type === 'oid'), 'subscribes sessions with the feed\'s session list');
  ok(client.sessionId === SID, 'auto-picks the session that is about to start');
  const st = client.status();
  ok(/ok · standings/.test(st.standings) && /ok · sessionPitInfo/.test(st.pits) && /refused/.test(st.results), 'per-session subscriptions: accepted ones kept, unknown names given up');
  ok(sent.filter(m => m.msg === 'sub' && /^(sessionResults|results)$/.test(m.name)).length === 2, 'tries the alternative names before giving up');
  const wr = client.workingRecipe();
  ok(wr && wr.session.some(x => x.names[0] === 'standings'), 'working recipe stored for next time');

  /* stream the race: standings with the ';' data string, pit info, status, race control, weather */
  const ref = new RS.Engine({ hero: '178', sisters: ['177'] }); const player = new RS.Replay(ref, rep);
  const live = new RS.Engine({ hero: '178', sisters: ['177'] }); const ls = new RS.LiveSession(live);
  const model = new LT2.Model(mirror, {}); model.sessionId = SID;
  const ws = server; const docs = {}; let checks = 0, posOk = 0, gapOk = 0, gapN = 0;
  ws.emit({ msg: 'added', collection: 'weather', id: '6afff1a4929529c2c9c1959d', fields: { session: LT2.oid(SID), weather: { ambientTemperature: 29, humidity: 70, trackTemperature: 41, windSpeed: 4 } } });
  ws.emit({ msg: 'added', collection: 'session_status', id: 'ss1', fields: { session: LT2.oid(SID), currentFlag: 'GREEN', isFinished: false } });
  rep.cars.forEach((c, i) => ws.emit({ msg: 'added', collection: 'session_entry', id: 'e' + i, fields: { session: LT2.oid(SID), number: c.n, team: c.team, className: c.cls, drivers: c.drivers.map(d => ({ firstName: d.split(' ')[0], lastName: d.split(' ').slice(1).join(' ') })) } }));
  const STEP = 5000; let rcN = 0, lastFlag = 'GF';
  for (let t = 0; t <= player.end; t += STEP) {
    player._feedTo(t, true); const v = ref.compute(); clock = START + t;
    v.rows.forEach(r => {
      if (!r.laps) return;
      const c = ref.cars[r.n], lr = c.lastRec();
      const data = [r.pos, r.n, 'CLASSIFIED', r.cpos, r.laps, r.pits, 2551, START + lr.t, r.inPit ? 'BOX' : 'TRACK', r.laps + 1].join(';');
      const doc = { session: LT2.oid(SID), data, lastLapTime: r.lastMs, bestLapTime: r.bestMs || null };
      const prev = docs[r.n];
      if (!prev) ws.emit({ msg: 'added', collection: 'standings', id: 'st' + r.n, fields: doc });
      else { const ch = {}; for (const k in doc) if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) ch[k] = doc[k]; if (Object.keys(ch).length) ws.emit({ msg: 'changed', collection: 'standings', id: 'st' + r.n, fields: ch }); }
      docs[r.n] = doc;
      const lastStop = c.stops[c.stops.length - 1];
      if (lastStop) ws.emit({ msg: 'added', collection: 'session_pit_info', id: 'p' + r.n, fields: { session: LT2.oid(SID), number: r.n, lastPitTime: lastStop.laneMs, totalPitTime: c.stops.reduce((a, s) => a + s.laneMs, 0), pitStops: c.stops.length } });
    });
    if (v.session.flag !== lastFlag) { lastFlag = v.session.flag; ws.emit({ msg: 'added', collection: 'race_control', id: 'rc' + (++rcN), fields: { session: LT2.oid(SID), message: lastFlag === 'GF' ? 'GREEN FLAG' : 'FULL COURSE YELLOW', time: START + t } }); }
    const snap = model.snapshot(START + t + 700);           // messages arrive 0.7 s after the crossing
    if (!snap) continue;
    ls.apply(snap);
    if (t % 600000 === 0 && t > 0) {
      const lv = live.compute(); checks++;
      const same = lv.rows.every(lr => { const rr = v.byN[lr.n]; return rr && rr.pos === lr.pos && rr.cpos === lr.cpos; });
      if (same) posOk++;
      lv.rows.forEach(lr => { const rr = v.byN[lr.n]; if (rr && rr.gapClsMs !== null && lr.gapClsMs !== null && !lr.gapClsLaps && !rr.gapClsLaps) { gapN++; if (Math.abs(rr.gapClsMs - lr.gapClsMs) <= 1) gapOk++; } });
    }
  }
  const lv = live.compute(), rv = ref.compute();
  ok(lv.rows.length === rv.rows.length, 'all ' + rv.rows.length + ' cars rebuilt from the standings data strings');
  ok(posOk === checks && checks > 40, 'overall + class positions identical at ' + posOk + '/' + checks + ' checkpoints');
  ok(gapOk === gapN && gapN > 100, 'class gaps from line-crossing times exact to 1 ms (' + gapOk + '/' + gapN + ')');
  const h = live.cars['178'], hr = ref.cars['178'];
  ok(h.stops.length === hr.stops.length, '#178 pit stops detected: ' + h.stops.length + ' (official ' + hr.stops.length + ')');
  h.stops.forEach((s, i) => { if (Math.abs(s.laneMs - hr.stops[i].laneMs) >= 1) console.log('   stop', i, 'live', s.laneMs, 'official', hr.stops[i].laneMs, 'inLap', s.inLap, hr.stops[i].inLap); });
  ok(h.stops.every((s, i) => Math.abs(s.laneMs - hr.stops[i].laneMs) < 1), '#178 pit-lane times taken from the official pit info');
  ok(Math.abs(model.offsets.length ? RS.pct(model.offsets, 0.9) : 0) < 1500, 'server clock estimated from fresh crossings');
  const ex = model.extras();
  ok(ex.weather && ex.weather.air === 29 && ex.weather.track === 41, 'weather: air 29°, track 41°');
  ok(ex.raceControl.length === rcN && /^\d\d:\d\d$/.test(ex.raceControl[0].time), 'race control messages: ' + rcN + ' (first at track time ' + (ex.raceControl[0] || {}).time + ')');
  const si = model.snapshot(START + 3600000).session;
  ok(/HOMESTEAD-MIAMI/.test(si.track) && /Endurance Race/.test(si.name) && si.durationMs === rep.meta.durationMs, 'session name, event and duration from sessions/events');
  ok(live.cars['178'].drivers.length >= 2 && live.cars['178'].team, 'entry list: team and drivers');

  /* 4. recordings: this page's own format, and other plausible recorder formats */
  const text = recorder.text();
  const rec = LT2.parseRecording(text);
  ok(rec.count > 1000 && rec.msgs.every(x => x.t > 0), 'own recording parsed: ' + rec.count + ' data messages');
  const pm = new RS.Mirror(); const P = new LT2.Player(rec, pm); P.seek(P.end);
  ok(Object.keys(pm.cols.standings || {}).length === Object.keys(mirror.cols.standings).length, 'player rebuilds the standings collection');
  const m2 = new LT2.Model(pm, {}); const s2 = m2.snapshot(P.now());
  ok(m2.sessionId === SID && s2.cars.length === rv.rows.length, 'session recognised from the recording itself');
  const alt1 = rec.msgs.slice(0, 50).map(x => JSON.stringify({ ts: x.t / 1000, direction: 'in', raw: 'a' + JSON.stringify([JSON.stringify(x.m)]) })).join('\n');
  const alt2 = rec.msgs.slice(0, 50).map(x => JSON.stringify({ time: new Date(x.t).toISOString(), msg: x.m })).join('\n');
  const alt3 = rec.msgs.slice(0, 50).map(x => JSON.stringify(Object.assign({ received: x.t }, x.m))).join('\n');
  ok(LT2.parseRecording(alt1).count === 50 && LT2.parseRecording(alt2).count === 50 && LT2.parseRecording(alt3).count === 50, 'other recorder layouts (raw SockJS frames, ISO times, flat messages) read');
  const gz = zlib.gzipSync(Buffer.from(text));
  ok(gz[0] === 0x1f && gz[1] === 0x8b, 'gzip recordings are detected by their header (unzipped in the browser)');

  /* 5. reconnect uses a fresh SockJS session URL */
  ws.onclose && ws.onclose({ code: 1006 });
  await new Promise(r => setTimeout(r, 1200));
  ok(urls.length === 2 && urls[1] !== urls[0] && urls[1].includes('/sockjs/'), 'reconnects with a new SockJS session id');
  ok(sent.filter(m => m.msg === 'sub' && m.name === 'standings').length >= 2, 're-subscribes after reconnecting');
  client.stop();
  console.log(fails ? fails + ' FAILED' : 'all LT2 checks passed');
  process.exit(fails ? 1 : 0);
})();
