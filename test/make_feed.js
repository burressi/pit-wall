// Build a scripted LT2 race (what Al Kamel would publish, message by message) from the official Miami 12 h timing,
// plus the reference result to check every screen against. Used by hub_e2e.js and fake_alkamel.py.
const fs = require('fs');
module.exports = function makeFeed(RS, out, opts) {
  opts = opts || {};
  const rep = JSON.parse(fs.readFileSync(__dirname + '/../private/replays/' + (opts.race || 'miami-12h') + '.json'));
  const START = opts.start || Date.UTC(2026, 9, 3, 13, 0, 0);
  const SID = '6b00000000000000000000aa', SID0 = '6b00000000000000000000a9', FEEDS = [SID0, SID];
  const oid = (h) => ({ $type: 'oid', $value: h });
  // the official stops of the whole race: a car shows BOX while it is in the pit lane, and the official pit-lane time
  // is published as it leaves (as the timing page does), not when it next crosses the line
  const pre = new RS.Engine({ hero: '178', sisters: ['177'] }); const pp = new RS.Replay(pre, rep); pp._feedTo(pp.end, true);
  const STOPS = {}; Object.keys(pre.cars).forEach(n => {
    const c = pre.cars[n];
    // red-flag stoppages are inside the official pit time but not the lap clock: the car always leaves before its out-lap ends
    const st = STOPS[n] = c.stops.map(s => { const end = c.laps[s.outLap] ? c.laps[s.outLap].t - 2000 : Infinity; return { in: s.tIn - 5000, out: Math.min(s.tIn - 5000 + s.laneMs, end), laneMs: s.laneMs }; });
    // red-flag stops in the official data overlap; publish each one before the next one starts
    st.forEach((x, i) => { const nx = st[i + 1]; if (nx && x.out > nx.in - 1000) x.out = Math.max(x.in + 1000, nx.in - 1000); });
  });
  const ref = new RS.Engine({ hero: '178', sisters: ['177'] }); const player = new RS.Replay(ref, rep);
  const lines = [JSON.stringify({ meta: { start: START, sid: SID, sid0: SID0, feeds: FEEDS, durationMs: rep.meta.durationMs, cars: rep.cars.length } })];
  const push = (o, m) => lines.push(JSON.stringify({ o, m }));
  // before the start: entry list, status, weather
  push(-300000, { msg: 'added', collection: 'weather', id: 'w1', fields: { session: oid(SID), weather: { ambientTemperature: 29, humidity: 70, trackTemperature: 41, windSpeed: 4 } } });
  push(-300000, { msg: 'added', collection: 'session_status', id: 'ss1', fields: { session: oid(SID), currentFlag: 'GREEN', isFinished: false } });
  rep.cars.forEach((c, i) => push(-300000, { msg: 'added', collection: 'session_entry', id: 'e' + i, fields: { session: oid(SID), number: c.n, team: c.team, className: c.cls, drivers: c.drivers.map(d => ({ firstName: d.split(' ')[0], lastName: d.split(' ').slice(1).join(' ') })) } }));
  const STEP = opts.step || 5000, TP = opts.timingPoints || 8;
  const docs = {}, pits = {}; let rcN = 0, lastFlag = 'GF', n = 0;
  for (let t = 0; t <= player.end; t += STEP) {
    player._feedTo(t, true); const v = ref.compute();
    v.rows.forEach(r => {
      if (!r.laps) return;
      const c = ref.cars[r.n], lr = c.lastRec();
      const pace = c.bestMs || 110000, tp = Math.min(TP - 1, Math.floor(Math.max(0, t - lr.t) / pace * TP));
      const st = STOPS[r.n] || [], box = st.some(x => x.in <= t && t < x.out), done = st.filter(x => x.out <= t);
      const data = [r.pos, r.n, 'CLASSIFIED', r.cpos, r.laps, done.length, 2551, START + lr.t, box ? 'BOX' : 'TRACK', r.laps + 1].join(';');
      // the timing point the car last passed changes several times a lap, like the real feed's intermediate updates
      const doc = { session: oid(SID), data, lastLapTime: r.lastMs, bestLapTime: r.bestMs || null, currentTimingPoint: tp, timingPointTime: START + lr.t + Math.round(tp * pace / TP) };
      const prev = docs[r.n];
      if (!prev) { push(t, { msg: 'added', collection: 'standings', id: 'st' + r.n, fields: doc }); n++; }
      else { const ch = {}; for (const k in doc) if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) ch[k] = doc[k]; if (Object.keys(ch).length) { push(t, { msg: 'changed', collection: 'standings', id: 'st' + r.n, fields: ch }); n++; } }
      docs[r.n] = doc;
      const lastStop = done[done.length - 1];
      if (lastStop) {
        const pd = { session: oid(SID), number: r.n, lastPitTime: lastStop.laneMs, totalPitTime: done.reduce((a, s) => a + s.laneMs, 0), pitStops: done.length };
        const key = JSON.stringify(pd);
        if (pits[r.n] !== key) { push(t, { msg: pits[r.n] ? 'changed' : 'added', collection: 'session_pit_info', id: 'p' + r.n, fields: pd }); pits[r.n] = key; }
      }
    });
    if (v.session.flag !== lastFlag) { lastFlag = v.session.flag; push(t, { msg: 'added', collection: 'race_control', id: 'rc' + (++rcN), fields: { session: oid(SID), message: lastFlag === 'GF' ? 'GREEN FLAG' : 'FULL COURSE YELLOW', time: START + t } }); }
    if (t % 1800000 === 0 && t) push(t, { msg: 'changed', collection: 'weather', id: 'w1', fields: { weather: { ambientTemperature: 29 + (t / 3600000 % 3), humidity: 70, trackTemperature: 41 - (t / 3600000 % 5), windSpeed: 4 } } });
  }
  push(player.end + STEP, { msg: 'changed', collection: 'session_status', id: 'ss1', fields: { currentFlag: 'CHEQUERED', isFinished: true } });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  const final = ref.compute();
  const expect = {};
  Object.keys(ref.cars).forEach(k => {
    const c = ref.cars[k], row = final.byN[k];
    expect[k] = { laps: c.laps.map((l, i) => l ? [i, l.t] : null).filter(Boolean), stops: c.stops.map(s => s.laneMs), pos: row ? row.pos : null, cpos: row ? row.cpos : null };
  });
  return { START, SID, durationMs: rep.meta.durationMs, messages: lines.length - 1, standings: n, rcN, expect };
};
