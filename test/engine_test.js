const load = require('./load'); const fs = require('fs');
const ctx = load(['util.js', 'engine.js', 'replay.js']); const RS = ctx.RS;
const posRef = {}; // session -> lap -> {o,c, gap}
for (const line of (fs.existsSync(process.env.ZS_POSITIONS || '') ? fs.readFileSync(process.env.ZS_POSITIONS, 'utf8') : '').split('\n').slice(1)) {
  const f = line.split(','); if (f.length < 10) continue; posRef[f[1] + '|' + f[5]] = { o: +f[6], c: +f[7], g: f[11] };
}
const cases = [['miami-12h', 'homestead-miami', '178', 'race-1'], ['daytona-12h', 'daytona', '177', 'race-1'], ['road-america-r2', 'road-america', '177', 'race-2'], ['barber-r2', 'barber', '177', 'race-2']];
for (const [rid, ev, car, sess] of cases) {
  const rep = JSON.parse(fs.readFileSync(__dirname + `/../private/replays/${rid}.json`));
  const eng = new RS.Engine({ hero: car, sisters: car === '177' ? ['178'] : ['177'] });
  const p = new RS.Replay(eng, rep);
  let checked = 0, okO = 0, okC = 0, mism = [];
  // step through every lap crossing of the hero: compare positions right after the crossing
  const heroLaps = rep.laps.filter(l => rep.cars[l[0]].n === car);
  const t0 = Date.now();
  for (const hl of heroLaps) {
    p._feedTo(hl[2], true);
    // feed any other crossings at the exact same ms
    const v = eng.compute();
    const r = v.byN[car]; const ref = posRef[`${ev}_${car}_${sess}|${hl[1]}`];
    if (!ref) continue; checked++;
    if (r.pos === ref.o) okO++; if (r.cpos === ref.c) okC++; else if (mism.length < 3) mism.push([hl[1], r.cpos, ref.c]);
  }
  const v = eng.compute();
  console.log(rid, 'car', car, 'laps checked', checked, 'overall match', okO, 'class match', okC, 'mismatch sample', JSON.stringify(mism), 'ms', Date.now() - t0);
  const h = v.hero;
  console.log('  end: P' + h.pos + ' / class P' + h.cpos + ' laps ' + h.laps + ' stops ' + h.stops.length + ' pace ' + RS.fmtLap(h.paceMs) + ' loss ' + (h.predictor.lossMs / 1000).toFixed(1) + 's events ' + eng.events.length);
}
// mid-race snapshot of Daytona at 6h for a look at the strategy views
const rep = JSON.parse(fs.readFileSync(__dirname + '/../private/replays/daytona-12h.json'));
const eng = new RS.Engine({ hero: '177', sisters: ['178'] }); const p = new RS.Replay(eng, rep);
p.seek(6 * 3600e3); p.playing = true; p.speed = 60; p._last = 0; for (let w = 1; w <= 10; w++) p.tick(w * 1000);
const v = eng.compute();
console.log('\nDaytona +' + RS.fmtClock(v.session.now) + ' remaining ' + RS.fmtClock(v.session.remaining) + ' flag ' + v.session.flag + '/' + v.session.flagSrc);
v.rows.filter(r => r.cls === 'ZR3').slice(0, 6).forEach(r => console.log('  ', r.cpos, '#' + r.n, r.driver.padEnd(20), 'L' + r.laps, 'gap', r.gapClsLaps ? '+' + r.gapClsLaps + 'L' : RS.fmtGap(r.gapClsMs), 'int', r.intClsLaps ? '+' + r.intClsLaps + 'L' : RS.fmtGap(r.intClsMs), 'last', RS.fmtLap(r.lastMs), 'pace', RS.fmtLap(r.paceMs), 'stint', r.stintLaps, 'pits', r.pits, 'rel', RS.fmtGap(r.relGapMs), 'close', r.closeMs ? (r.closeMs / 1000).toFixed(2) : ''));
const h = v.hero;
console.log('hero window', JSON.stringify(h.window));
h.predictor.scenarios.forEach(s => console.log('  ', s.label, 'loss', (s.lossMs / 1000).toFixed(0), 'P' + s.pos, 'cls P' + s.cpos, 'lost cls', s.lostCls, 'ahead', JSON.stringify(s.aheadCls), 'behind', JSON.stringify(s.behindCls)));
console.log('alerts', JSON.stringify(v.alerts));
console.log('last events'); eng.events.slice(-8).forEach(e => console.log('  ', RS.fmtTod(e.tod), e.type, e.text));
