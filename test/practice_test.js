const load = require('./load'); const fs = require('fs');
const ctx = load(['util.js', 'engine.js', 'replay.js']); const RS = ctx.RS;
const txt = fs.readFileSync((process.env.ZS_CSV_DIR || __dirname + '/../csv') + '/Road America 26 combo practice.csv', 'utf8');
const rep = RS.deriveMeta(RS.parseAlKamelCSV(txt, { name: 'Combined Practice', kind: 'practice' }));
const eng = new RS.Engine({ hero: '177', sisters: ['178'] }); const p = new RS.Replay(eng, rep); p.seek(p.end);
const v = eng.compute();
v.rows.filter(r => r.cls === 'ZR3').slice(0, 5).forEach(r => console.log(r.cpos, '#' + r.n, RS.fmtLap(r.bestMs), r.leader ? 'Leader' : RS.fmtGap(r.gapClsMs, 3), RS.fmtGap(r.intClsMs, 3)));
