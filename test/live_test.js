// Simulate an LT2-style Meteor feed from a real race and check the live pipeline rebuilds the same race state
const load = require('./load'); const fs = require('fs');
const ctx = load(['util.js', 'engine.js', 'replay.js', 'live.js']); const RS = ctx.RS;
const rep = JSON.parse(fs.readFileSync(__dirname + '/../private/replays/miami-12h.json'));

function run(variant) {
  const refEng = new RS.Engine({ hero: '178', sisters: ['177'] }); const player = new RS.Replay(refEng, rep);
  const liveEng = new RS.Engine({ hero: '178', sisters: ['177'] }); const live = new RS.LiveSession(liveEng);
  const mirror = new RS.Mirror(); const ad = new RS.LT2Adapter(mirror, {});
  let docs = {}; let msgs = 0; const STEP = 4000;
  const send = (m) => { mirror.apply(JSON.parse(JSON.stringify(m))); msgs++; };
  send({ msg: 'added', collection: 'session_info', id: 's1', fields: { sessionName: 'Endurance Race 1', duration: variant.ms ? rep.meta.durationMs : RS.fmtClock(rep.meta.durationMs), remaining: 0, flag: 'Green' } });
  for (let t = 0; t <= player.end; t += STEP) {
    player._feedTo(t, true); const v = refEng.compute();
    // the "server" publishes standings
    v.rows.forEach(r => {
      if (!r.laps) return;
      const c = refEng.cars[r.n];
      const lr = c.lastRec();
      const doc = variant.nested
        ? { num: r.n, pos: r.pos, pic: r.cpos, category: { name: r.cls }, team: r.team, lap: r.laps, lastLap: { time: RS.fmtLap(r.lastMs) }, bestLap: { time: RS.fmtLap(r.bestMs) }, gap: r.gapMs ? RS.fmtGap(r.gapMs, 3) : '', pitStops: r.pits, status: r.inPit ? 'PIT' : 'RUN', driver: { firstName: r.driver.split(' ')[0], lastName: r.driver.split(' ').slice(1).join(' ') }, sectors: lr ? lr.s.map(x => ({ time: x })) : [] }
        : { number: +r.n, position: r.pos, classPosition: r.cpos, class: r.cls, teamName: r.team, laps: r.laps, lastLapTime: r.lastMs, bestLapTime: r.bestMs, gapToFirst: r.gapMs, inPit: r.inPit, pitStops: r.pits, currentDriver: r.driver, totalTime: variant.total ? lr.t : undefined };
      if (variant.single) {
        docs[r.n] = doc;
      } else {
        const prev = docs[r.n];
        if (!prev) send({ msg: 'added', collection: 'standings', id: 'car' + r.n, fields: doc });
        else { const ch = {}; for (const k in doc) if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) ch[k] = doc[k]; if (Object.keys(ch).length) send({ msg: 'changed', collection: 'standings', id: 'car' + r.n, fields: ch }); }
        docs[r.n] = doc;
      }
    });
    if (variant.single) send({ msg: t ? 'changed' : 'added', collection: 'livetiming', id: 'main', fields: { standings: docs } });
    send({ msg: 'changed', collection: 'session_info', id: 's1', fields: { remaining: variant.ms ? Math.max(0, rep.meta.durationMs - t) : RS.fmtClock(Math.max(0, rep.meta.durationMs - t)) } });
    const snap = ad.snapshot(); live.apply(snap); liveEng.compute();
  }
  const a = refEng.compute(), b = liveEng.compute();
  let same = 0, lapsSame = 0, stopsSame = 0;
  a.rows.forEach(r => { const x = b.byN[r.n]; if (x && x.pos === r.pos) same++; if (x && x.laps === r.laps) lapsSame++; if (x && refEng.cars[r.n].stops.length === liveEng.cars[r.n].stops.length) stopsSame++; });
  const h = b.hero, hr = a.hero;
  console.log(JSON.stringify(variant), 'msgs', msgs, 'found', JSON.stringify(ad.found.standings), 'units', ad.units);
  console.log('   cars', a.rows.length, 'pos same', same, 'laps same', lapsSame, 'stops same', stopsSame, '| live hero P' + h.pos + ' cls P' + h.cpos + ' stops ' + h.stops.length + ' pace ' + RS.fmtLap(h.paceMs) + ' vs ref ' + RS.fmtLap(hr.paceMs) + ' stint ' + h.stintLaps + '/' + hr.stintLaps + ' flag ' + b.session.flag + ' rem ' + RS.fmtClock(b.session.remaining));
  const lc = liveEng.cars['178'], rc = refEng.cars['178'];
  let maxErr = 0; for (let k = 1; k <= rc.lastLap; k++) if (lc.laps[k] && rc.laps[k]) maxErr = Math.max(maxErr, Math.abs(lc.laps[k].t - rc.laps[k].t));
  console.log('   max lap-time-stamp error for #178 (ms):', maxErr, ' live stop lanes', lc.stops.slice(0, 4).map(s => (s.laneMs / 1000).toFixed(0)).join(','), 'ref', rc.stops.slice(0, 4).map(s => (s.laneMs / 1000).toFixed(0)).join(','));
}
run({ ms: true, total: true });
run({ ms: true, total: false });
run({ nested: true });
run({ nested: true, single: true });
// DOM adapter
const dom = RS.domSnapshot({ headers: ['POS', 'NO.', 'CLS', 'PIC', 'DRIVER', 'LAPS', 'GAP', 'INT', 'LAST', 'BEST', 'PIT'], rows: [['1', '4', 'ZP2', '1', 'Kamden Hibbitt', '102', '', '', '1:31.502', '1:30.990', '3'], ['2', '177', 'ZR3', '1', 'Tom O\'Gorman', '99', '3 Laps', '1:02.3', '1:36.002', '1:35.101', 'IN PIT']], meta: { title: 'Zenith - Endurance Race 1', clocks: [{ text: '04:12:09', hint: 'remaining' }], flagText: 'FULL COURSE YELLOW' } });
console.log('DOM', JSON.stringify(dom.session), JSON.stringify(dom.cars[1]));
