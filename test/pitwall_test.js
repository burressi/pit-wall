// Pit-wall model checks on real 2026 races: neighbours, gaps, closing rates, pit window, lap ring.
const load = require('./load'); const fs = require('fs');
const ctx = load(['util.js', 'engine.js', 'replay.js', 'live.js', 'lt2.js', 'charts.js', 'ui.js', 'pitwall.js']); const RS = ctx.RS, PW = RS.PW;
let fails = 0, checks = 0; const bad = (m) => { fails++; if (fails < 25) console.log('FAIL', m); };
const races = ['daytona-12h', 'miami-12h', 'vir-12h', 'road-america-r1', 'watkins-glen-r2', 'barber-r1'];
for (const id of races) {
  const rep = JSON.parse(fs.readFileSync(__dirname + '/../private/replays/' + id + '.json'));
  RS.deriveMeta(rep);
  for (const hero of ['177', '178']) {
    if (!rep.cars.some(c => c.n === hero)) continue;
    const settings = Object.assign({}, RS.DEFAULTS, { hero, sisters: hero === '177' ? ['178'] : ['177'] });
    const eng = new RS.Engine(settings); const pl = new RS.Replay(eng, rep);
    const App = { engine: eng, settings, ui: { pwNeighbours: 'class' }, lt2: null };
    const lines = [];
    for (let t = 30 * 60000; t < pl.end; t += 20 * 60000) {
      pl.seek(t); const v = eng.compute(); const M = PW.model(App, v);
      if (!M.row) continue;
      checks++;
      const cls = v.rows.filter(r => r.cls === M.row.cls), i = cls.indexOf(M.row);
      if ((M.ahead ? M.ahead.n : null) !== (i > 0 ? cls[i - 1].n : null)) bad(id + ' ' + hero + ' ahead car');
      if ((M.behind ? M.behind.n : null) !== (i < cls.length - 1 ? cls[i + 1].n : null)) bad(id + ' ' + hero + ' behind car');
      // gap to the car ahead equals the engine's class interval when on the same lap
      if (M.ahead && !M.row.intClsLaps && M.row.intClsMs !== null && M.row.intClsMs >= 0 && Math.abs(M.ahead.gapMs - M.row.intClsMs) > 1 && !M.stale) bad(id + ' ' + hero + ' gap ahead ' + M.ahead.gapMs + ' vs ' + M.row.intClsMs);
      M.ring.cars.forEach(c => { if (!(c.f >= 0 && c.f < 1)) bad('ring phase ' + c.f); });
      if (M.ring.ghost && !(M.ring.ghost.f >= 0 && M.ring.ghost.f < 1)) bad('ghost phase');
      if (M.pit) {
        M.pit.rows.forEach(r => { if (!r.yellow && r.cpos < M.row.cpos) bad(id + ' ' + hero + ' green stop gains places? ' + r.label + ' P' + r.cpos + ' from P' + M.row.cpos); if (r.lap <= M.pit.cur) bad('pit lap in the past'); });
        if (M.pit.win && (M.pit.win.first > M.pit.win.last || M.pit.win.first <= M.pit.cur)) bad('window order');
        const y = M.pit.rows.filter(r => r.yellow)[0], g = M.pit.rows[0];
        if (y && g && y.cpos > g.cpos) bad('yellow stop worse than green stop');
      }
      if (lines.length < 3 && t > 2 * 3600e3) {
        const wt = PW.windowText(M);
        lines.push('   ' + RS.fmtClock(t) + ' lap ' + M.hdr.lap + ' P' + M.row.cpos + ' cls | ahead ' + (M.ahead ? '#' + M.ahead.n + ' ' + (M.ahead.laps ? M.ahead.laps + ' laps' : (M.ahead.gapMs / 1000).toFixed(1) + ' s') + (M.ahead.closingMs !== null ? ' closing ' + (M.ahead.closingMs / 1000).toFixed(2) : '') : '—') +
          ' | behind ' + (M.behind ? '#' + M.behind.n + ' ' + (M.behind.laps ? M.behind.laps + ' laps' : (M.behind.gapMs / 1000).toFixed(1) + ' s') : '—') + ' | trend ' + (M.tiles.trend === null ? '–' : (M.tiles.trend / 1000).toFixed(2)) +
          ' | ' + wt.head + ' | box now → P' + M.pit.rows[0].cpos + ' (' + M.pit.rows[0].traffic.text + ')');
      }
    }
    console.log(id, '#' + hero); lines.forEach(l => console.log(l));
  }
}
console.log(checks + ' snapshots checked,', fails ? fails + ' FAILED' : 'all pit-wall checks passed');
process.exit(fails ? 1 : 0);
