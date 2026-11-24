// How long a screen takes to catch up on a whole 12-hour race (37 cars, an update at every timing point),
// and that the result is still identical to the official timing. Uses the page's feed client with a mocked hub.
const fs = require('fs'), path = require('path'), os = require('os');
const load = require('./load'); const makeFeed = require('./make_feed');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const race = process.env.RACE || 'daytona-12h';
const ctx = load(['util.js', 'engine.js', 'replay.js', 'live.js', 'lt2.js', 'hub.js']); const RS = ctx.RS;
const tmp = path.join(os.tmpdir(), 'perf-feed.jsonl');
const f = makeFeed(RS, tmp, { race, step: 2000 });
const script = fs.readFileSync(tmp, 'utf8').trim().split('\n').slice(1).map(JSON.parse);
const oid = (h) => ({ $type: 'oid', $value: h });
const log = [JSON.stringify({ t: f.START - 600000, m: { msg: 'added', collection: 'sessions', id: f.SID, fields: { name: 'Race', UtcOffsetMin: -300, date: f.START, endDate: f.START + f.durationMs, event: oid('ev1') } } })]
  .concat(script.map(x => JSON.stringify({ t: f.START + x.o + 300, m: x.m })));
const bytes = log.reduce((a, l) => a + l.length + 1, 0);
console.log(race + ':', log.length, 'messages,', (bytes / 1048576).toFixed(1), 'MB uncompressed');
ctx.fetch = async (url) => {
  const u = new URL(url, 'http://hub/'); const from = +u.searchParams.get('from'), lim = +u.searchParams.get('limit');
  const lines = log.slice(from, from + lim);
  return { ok: true, status: 200, headers: { get: (k) => ({ 'X-Next': String(from + lines.length), 'X-Total': String(log.length) })[k] }, text: async () => lines.join('\n'), json: async () => ({}) };
};
ctx.EventSource = class { constructor() { } addEventListener() { } close() { } };
const mirror = new RS.Mirror(); let eng, ls, model, snaps = 0;
const F = new RS.Hub.Feed({ base: 'http://hub/', mirror, onSnap: (t) => { const s = model.snapshot(t); if (s && s.cars.length) { ls.apply(s); snaps++; } } });
F.on('reset', () => { eng = new RS.Engine({ hero: '177', sisters: ['178'] }); ls = new RS.LiveSession(eng); ls.start({ name: 'x' }); model = new RS.LT2.Model(mirror, {}); model.sessionId = f.SID; });
const t0 = Date.now();
F.on('live', () => {
  const ms = Date.now() - t0; F.stop();
  ok(ms < 30000, 'whole race caught up in ' + (ms / 1000).toFixed(1) + ' s on this machine (' + snaps + ' standings rebuilds)');
  let lapsOk = 0, lapsN = 0, stopsOk = 0, stopsN = 0;
  for (const n in f.expect) { const e = f.expect[n], c = eng.cars[n]; if (!e.laps.length) continue;
    e.laps.forEach(([k, t]) => { lapsN++; if (c && c.laps[k] && c.laps[k].t === t) lapsOk++; });
    const a = c ? c.stops.map(s => s.laneMs).sort((x, y) => x - y) : [], b = e.stops.slice().sort((x, y) => x - y);
    stopsN++; if (a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1)) stopsOk++; }
  ok(lapsOk === lapsN, 'lap history identical (' + lapsOk + '/' + lapsN + ')');
  ok(stopsOk === stopsN, 'pit stops identical (' + stopsOk + '/' + stopsN + ' cars)');
  const v = eng.compute(); let posOk = 0, posN = 0; for (const n in f.expect) { const e = f.expect[n]; if (!e.laps.length) continue; posN++; const r = v.byN[n]; if (r && r.pos === e.pos && r.cpos === e.cpos) posOk++; }
  ok(posOk === posN, 'final positions identical (' + posOk + '/' + posN + ')');
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
});
F.start({ epoch: 'e1', session: { id: f.SID } });
