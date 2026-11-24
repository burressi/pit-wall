/* Zenith Strategy — pit-wall screen (laptop) and crew phone view.
   Layout follows the pit-wall draft: car ahead / behind, gap history, lap tiles, timing tower,
   pit window, lap ring (circle lap tracking with the pit-stop rejoin ghost) and race control. */
(function (G) {
  'use strict';
  var RS = G.RS, esc = RS.esc;
  var PW = RS.PW = {};
  var BLUE = '#4da3ff', AMBER = '#f5b942', GREY = '#9aa7b4', LINE = '#26303b', TEXT = '#e8edf2', GREEN = '#43c37b', RED = '#ff6b6b';

  function sec(ms, d) { return ms === null || ms === undefined || !isFinite(ms) ? '–' : (ms / 1000).toFixed(d === undefined ? 1 : d); }
  function signed(ms, d) { if (ms === null || ms === undefined || !isFinite(ms)) return '–'; var s = (ms / 1000).toFixed(d === undefined ? 1 : d); return ms > 0 ? '+' + s : s; }
  function lapTxt(ms) { return ms ? RS.fmtLap(ms).replace(/(\.\d)\d\d$/, '$1') : '–'; }
  function mod1(f) { return ((f % 1) + 1) % 1; }

  /* ---------- geometry of the lap: timing points and pit lane ---------- */
  PW.trackGeom = function (App) {
    var eng = App.engine, m = eng.meta || {}, s = App.settings || {};
    var ticks = (m.timingPoints && m.timingPoints.length ? m.timingPoints : (m.sectorFrac || [])).filter(function (f) { return f > 0.01 && f < 0.99; });
    var pin = s.pitInPct ? 1 - s.pitInPct / 100 : (m.pitInFrac !== undefined ? m.pitInFrac : 0.965);
    var pout = s.pitOutPct ? s.pitOutPct / 100 : (m.pitOutFrac !== undefined ? m.pitOutFrac : 0.045);
    return { ticks: ticks, pitIn: mod1(pin), pitOut: mod1(pout) };
  };

  /* fraction of the lap a car has covered, dead-reckoned from its last line crossing and its pace */
  PW.phase = function (eng, c, now, geom) {
    var lr = c.lastRec(); if (!lr || lr.t === null || lr.t === undefined) return null;
    var pace = c.paceMs || eng.classRef(c.cls) || 120000;
    var inPit = !!(c.live.inPit || (c.stint && c.stint.inPit));
    if (inPit) {
      var lane = (eng.meta.pitLaneMs && eng.meta.pitLaneMs[c.cls] && eng.meta.pitLaneMs[c.cls].p50) || 90000;
      var span = mod1(geom.pitOut - geom.pitIn) || 0.08;
      var since = Math.max(0, now - lr.t);
      return { f: mod1(geom.pitIn + span * (0.5 + 0.5 * Math.min(1, since / lane))), pit: true };
    }
    var fl = eng._lastFlag || 'GF';
    if (fl === 'FCY' || fl === 'SC') pace *= 1.45;                       // under caution the field laps far slower
    var f = (now - lr.t) / pace;
    if (f > 0.95) f = 0.95 + 0.045 * (1 - Math.exp(-(f - 0.95) / 0.1));  // overdue: keep the order, never past the line
    return { f: f < 0 ? 0 : f, pit: false };
  };

  /* who is on the road just ahead of / behind the rejoin point */
  PW.traffic = function (App, hero, lossMs, inLaps) {
    var eng = App.engine, now = eng.now, geom = PW.trackGeom(App);
    var me = PW.phase(eng, hero, now, geom); if (!me || me.pit) return null;
    var pu = hero.paceMs || eng.classRef(hero.cls) || 120000;
    var ahead = [], behind = [];
    for (var n in eng.cars) {
      var x = eng.cars[n]; if (x === hero || !x.lastLap) continue;
      var ph = PW.phase(eng, x, now, geom); if (!ph || ph.pit) continue;
      var px = x.paceMs || eng.classRef(x.cls) || pu;
      var road = mod1(ph.f - me.f) * pu;                                   // ms x is ahead of us on the road now
      var after = road + lossMs + inLaps * (pu - px);                      // after our stop
      after = ((after % pu) + pu) % pu;
      if (after < 3000) ahead.push({ n: x.n, cls: x.cls, ms: after, slower: px > pu + 300 });
      else if (after > pu - 2000) behind.push({ n: x.n, cls: x.cls, ms: pu - after, faster: px < pu - 300 });
    }
    ahead.sort(function (a, b) { return a.ms - b.ms; }); behind.sort(function (a, b) { return a.ms - b.ms; });
    var slow = ahead.filter(function (a) { return a.slower; });
    var fast = behind.filter(function (b) { return b.faster; });
    var parts = [], count = slow.length + fast.length;
    if (slow.length) parts.push(slow.length === 1 ? 'slower #' + slow[0].n + ' just ahead' : slow.length + ' slower cars ahead');
    else if (ahead.length) parts.push('#' + ahead[0].n + ' ' + sec(ahead[0].ms) + ' s ahead');
    if (fast.length) parts.push('faster #' + fast[0].n + ' right behind');
    return { text: parts.length ? parts.join(' · ') : 'Clear', count: count, ahead: ahead, behind: behind };
  };

  /* ---------- model: everything the pit wall shows ---------- */
  PW.model = function (App, v) {
    var eng = App.engine, s = App.settings, ui = App.ui, now = eng.now;
    var hero = eng.cars[String(s.hero)] || null, hv = v.hero, row = hero ? v.byN[hero.n] : null;
    var mode = ui.pwNeighbours || 'class';
    var M = { hero: hero ? hero.n : String(s.hero), heroCls: hero ? hero.cls : '', row: row, hv: hv, mode: mode };
    eng._lastFlag = v.session.flag;

    // header
    var lapNow = row ? row.laps : (v.rows[0] ? v.rows[0].laps : 0);
    var hlr = hero ? hero.lastRec() : null, hpace = hero ? hero.paceMs || eng.classRef(hero.cls) || 120000 : 0;
    var moving = 0, total = 0;
    for (var cn in eng.cars) { var cc = eng.cars[cn], cl = cc.lastRec(); if (!cl) continue; total++; if (now - cl.t < 2 * (cc.paceMs || hpace)) moving++; }
    M.stale = hero && hlr && !(row && row.inPit) && eng.meta.kind !== 'practice' && now - hlr.t > 3 * hpace && moving >= Math.max(2, total * 0.4) ? now - hlr.t : 0;
    M.hdr = { lap: lapNow, remaining: v.session.remaining, now: now, flag: v.session.flag, flagSrc: v.session.flagSrc };

    // neighbours
    var list = v.rows.filter(function (r) { return mode === 'overall' || !hero || r.cls === hero.cls; });
    var i = row ? list.indexOf(row) : -1;
    var A = i > 0 ? list[i - 1] : null, B = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
    M.ahead = A ? PW.rel(eng, hero, eng.cars[A.n], -1) : null;
    M.behind = B ? PW.rel(eng, hero, eng.cars[B.n], 1) : null;
    if (M.stale) [M.ahead, M.behind].forEach(function (r) { if (r) { r.closingMs = null; r.catchLaps = null; r.stale = true; } });
    M.leader = i === 0;

    // lap tiles
    if (hero) {
      var clean = [], stintStart = hero.stint ? hero.stint.startLap : 1, trendPts = [];
      for (var k = hero.lastLap; k >= 2; k--) {
        var r = hero.laps[k]; if (!r || !r.ms || r.inPit || r.pitMs || r.slow) continue;
        if (clean.length < 5) clean.push(r.ms);
        if (k > stintStart && trendPts.length < 15) trendPts.push([k, r.ms]);
      }
      var tmed = trendPts.length ? RS.median(trendPts.map(function (p) { return p[1]; })) : 0;
      trendPts = trendPts.filter(function (p) { return p[1] <= tmed * 1.04; });           // drop traffic / incident laps
      M.tiles = { last: row ? row.lastMs : null, best: hero.bestMs, avg5: clean.length ? RS.mean(clean) : null, trend: trendPts.length >= 5 ? PW.slope(trendPts) : null, trendN: trendPts.length };
    }

    // pit window and scenarios
    if (hero && hv) {
      var loss = hv.predictor.lossMs, lossY = hv.predictor.lossFcyMs, w = hv.window, cur = hero.lastLap;
      var sc = function (label, inLaps, lossMs, note) {
        var rj = eng._rejoin(hero, v.rows, lossMs, inLaps, label);
        var tr = PW.traffic(App, hero, lossMs, inLaps);
        return { label: label, inLaps: inLaps, lap: cur + inLaps + 1, pos: rj.pos, cpos: rj.cpos, lostCls: rj.lostCls, lossMs: lossMs, traffic: tr, note: note || '', aheadCls: rj.aheadCls, behindCls: rj.behindCls };
      };
      var rows = [sc('This lap', 0, loss)];
      var best = null, win = PW.winLaps(w, cur);
      if (win) {
        for (var L = win.first; L <= win.last && L - win.first < 25; L++) {
          var c = sc('Lap ' + L, L - cur - 1, loss);
          if (!best || c.cpos < best.cpos || (c.cpos === best.cpos && (c.traffic ? c.traffic.count : 0) < (best.traffic ? best.traffic.count : 0))) best = c;
        }
        if (win.first > cur + 1) rows.push(sc('Window opens', win.first - cur - 1, loss, 'lap ' + win.first));
        if (best && best.inLaps > 0 && best.lap !== win.first) { var b2 = Object.assign({}, best); b2.label = 'Best · lap ' + best.lap; rows.push(b2); best = b2; }
        else if (best && best.inLaps === 0) best = rows[0];
        else if (best && best.lap === win.first && win.first > cur + 1) best = rows[rows.length - 1];
        if (win.last > win.first) rows.push(sc('Last lap on fuel', win.last - cur - 1, loss, 'lap ' + win.last));
      } else {
        rows.push(sc('In 3 laps', 3, loss)); rows.push(sc('In 8 laps', 8, loss));
      }
      var y = sc('Under yellow', 0, lossY, 'if it comes'); y.yellow = true; rows.push(y);
      M.pit = { lossMs: loss, lossYMs: lossY, lossLabel: PW.lossLabel(App, hero), window: w, win: win, best: best, rows: rows, cur: cur, inPit: hv.inPit,
        fuelLaps: w ? w.lapsLeft : null };
    }

    // ring
    var geom = PW.trackGeom(App), cars = [];
    v.rows.forEach(function (r) {
      var c = eng.cars[r.n], ph = PW.phase(eng, c, now, geom); if (!ph) return;
      var role = r.isHero ? 'us' : (M.ahead && r.n === M.ahead.n) || (M.behind && r.n === M.behind.n) ? 'rival' : r.isSister ? 'sister' : hero && r.cls === hero.cls ? 'class' : 'other';
      cars.push({ n: r.n, f: ph.f, pit: ph.pit, role: role });
    });
    M.ring = { geom: geom, cars: cars, lap: lapNow };
    if (hero && hv && !hv.inPit) {
      var me = PW.phase(eng, hero, now, geom);
      if (me && !me.pit) { var pu = hero.paceMs || eng.classRef(hero.cls) || 120000; M.ring.ghost = { f: mod1(me.f - hv.predictor.lossMs / pu), from: me.f }; }
    }

    // race control
    M.rc = PW.raceControl(App, v);
    // weather
    M.wx = App.lt2 && App.lt2.weather ? App.lt2.weather : null;
    return M;
  };

  /* race gap between a leading car A and a trailing car B at the line. When B crossed lap k first but A has since
     done lap k+1 (B in the pits, or just lapped), B's next crossing is projected from its pace. */
  PW.pairGap = function (eng, A, B) {
    var k = Math.min(A.lastLap, B.lastLap);
    while (k > 0 && (!A.laps[k] || !B.laps[k])) k--;
    if (k <= 0) return null;
    var g = B.laps[k].t - A.laps[k].t;
    if (g >= 0 || !A.laps[k + 1]) return g;
    var bNext = Math.max(eng.now, B.laps[k].t + (B.paceMs || eng.classRef(B.cls) || 120000));
    return bNext - A.laps[k + 1].t;
  };

  /* relation between hero and another car, from line-crossing times lap by lap */
  PW.rel = function (eng, hero, x, side) {
    if (!hero || !x) return null;
    var hist = [], L = hero.lastLap;
    for (var k = Math.max(1, L - 19); k <= L; k++) {
      var a = hero.laps[k], b = x.laps[k];
      if (!a || !b || a.t === null || b.t === null) continue;
      var g = side < 0 ? a.t - b.t : b.t - a.t;                       // positive = x ahead of us / x behind us
      hist.push({ x: k, y: g, pit: !!(a.inPit || a.pitMs || b.inPit || b.pitMs), slow: !!(a.slow || b.slow) });
    }
    var gap = side < 0 ? PW.pairGap(eng, x, hero) : PW.pairGap(eng, hero, x);
    if (gap === null) gap = hist.length ? hist[hist.length - 1].y : null;
    var lead = side < 0 ? x : hero, trail = side < 0 ? hero : x;
    var lapsDiff = lead.lastLap - trail.lastLap, pace = trail.paceMs || eng.classRef(trail.cls) || 120000;
    var laps = gap !== null && gap > pace ? Math.floor(gap / pace) : 0;
    if (lapsDiff > 1) laps = Math.max(laps, lapsDiff - 1);
    // trend: median change per lap over the last clean laps of both cars (robust to one-off traffic)
    var clean = hist.filter(function (p) { return !p.pit && !p.slow; }).slice(-6), d = [];
    for (var i = 1; i < clean.length; i++) if (clean[i].x - clean[i - 1].x === 1) d.push(clean[i].y - clean[i - 1].y);
    var rate = d.length >= 2 ? RS.median(d) : null;
    if (rate === null && hero.paceMs && x.paceMs) rate = side < 0 ? hero.paceMs - x.paceMs : x.paceMs - hero.paceMs;
    var closing = rate !== null ? -rate : null;                       // >0: gap shrinking
    var catchIn = closing && closing > 50 && gap > 0 && !laps ? gap / closing : null;
    return { n: x.n, cls: x.cls, gapMs: gap, laps: laps, closingMs: closing, catchLaps: catchIn, hist: hist, inPit: !!(x.live.inPit || (x.stint && x.stint.inPit)), pace: x.paceMs };
  };

  /* pit-eligible laps (we box at the end of the lap): first = earliest that still reaches the flag on the stops left, last = last lap the fuel covers */
  PW.winLaps = function (w, cur) {
    if (!w || w.status === 'finish' || w.open === null || w.close === null || w.open === undefined) return null;
    var first = Math.max(cur + 1, w.open), last = Math.max(first, w.close);
    return { first: first, last: last, openNow: first === cur + 1 };
  };

  PW.slope = function (pts) {                                       // Theil–Sen: median of pairwise slopes
    if (!pts || pts.length < 4) return null;
    var sl = [];
    for (var i = 0; i < pts.length; i++) for (var j = i + 1; j < pts.length; j++) if (pts[j][0] !== pts[i][0]) sl.push((pts[j][1] - pts[i][1]) / (pts[j][0] - pts[i][0]));
    return sl.length ? RS.median(sl) : null;
  };

  PW.lossLabel = function (App, hero) {
    var s = App.settings, eng = App.engine, m = eng.meta || {};
    if (s.pitPreset === 'manual' && s.pitManualS) return 'your manual pit loss';
    if (s.pitPreset === 'learned' && eng.learnedLoss[hero.n] && eng.learnedLoss[hero.n].length) return 'learned from our stops';
    var name = { p10: 'quick stop', p50: 'typical stop', p80: 'long stop' }[s.pitPreset] || 'typical stop';
    return m.pitLaneMs && m.pitLaneMs[hero.cls] ? name + ', ' + (m.track || 'track') + ' 2026' : 'class median so far';
  };

  PW.raceControl = function (App, v) {
    if (App.lt2 && App.lt2.raceControl && App.lt2.raceControl.length) {
      return App.lt2.raceControl.slice(-30).reverse().map(function (m) { return { time: m.time || '', text: m.text, level: m.level || '' }; });
    }
    var eng = App.engine, s = App.settings, out = [], m = eng.meta || {};
    var tm = function (t) { return m.startClockMs !== undefined && m.startClockMs !== null ? RS.fmtTod(m.startClockMs + t).slice(0, 5) : RS.fmtClock(t); };
    eng.flagLog.forEach(function (f) { if (f.t <= eng.now && f.t > 0) out.push({ t: f.t, time: tm(f.t), text: (RS.FLAG_LABEL[f.flag] || f.flag) + (f.src === 'inferred' ? ' (inferred)' : ''), level: f.flag === 'GF' ? '' : f.flag === 'RF' ? 'crit' : 'warn' }); });
    [String(s.hero)].concat((s.sisters || []).map(String)).forEach(function (n) {
      var c = eng.cars[n]; if (!c) return;
      c.stops.forEach(function (st) {
        if (st.tIn !== null && st.tIn <= eng.now) out.push({ t: st.tIn, time: tm(st.tIn), text: '#' + n + ' pit stop, end of lap ' + st.inLap + ' — lane ' + RS.fmtLap(st.laneMs).replace(/\.\d+$/, '') + (st.drvOut && st.drvIn && st.drvOut !== st.drvIn ? ' · ' + st.drvOut + ' → ' + st.drvIn : ''), level: '' });
      });
    });
    eng.events.forEach(function (e) { if ((e.type === 'call' || (e.type === 'flag' && /inferred/.test(e.text))) && e.t <= eng.now) out.push({ t: e.t, time: tm(e.t), text: e.text, level: e.level === 'warn' ? 'warn' : '' }); });
    out.sort(function (a, b) { return b.t - a.t; });
    return out.slice(0, 40);
  };

  /* ---------- SVG pieces ---------- */
  PW.ringSVG = function (M, size, opts) {
    opts = opts || {};
    var R = 80, C = 110, ring = M.ring, g = ring.geom, out = [];
    var P = function (f, r) { var a = -Math.PI / 2 + f * 2 * Math.PI; return [C + r * Math.cos(a), C + r * Math.sin(a)]; };
    var arc = function (f0, f1, r) {
      var span = mod1(f1 - f0); if (span < 0.002) return '';
      var p0 = P(f0, r), p1 = P(f0 + span, r);
      return 'M' + p0[0].toFixed(1) + ' ' + p0[1].toFixed(1) + 'A' + r + ' ' + r + ' 0 ' + (span > 0.5 ? 1 : 0) + ' 1 ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1);
    };
    out.push('<circle cx="110" cy="110" r="80" fill="none" stroke="' + LINE + '" stroke-width="' + (opts.compact ? 12 : 10) + '"/>');
    // pit lane: inner arc from pit-in to pit-out around the start/finish line
    out.push('<path d="' + arc(g.pitIn, g.pitOut, 64) + '" fill="none" stroke="' + AMBER + '" stroke-opacity=".55" stroke-width="6" stroke-linecap="round"/>');
    out.push('<path d="' + arc(g.pitIn, g.pitOut, 80) + '" fill="none" stroke="' + AMBER + '" stroke-width="' + (opts.compact ? 12 : 10) + '" stroke-opacity=".35"/>');
    // pit-stop rejoin ghost: the stretch of lap we lose if we box now
    if (ring.ghost && !opts.compact && mod1(ring.ghost.from - ring.ghost.f) < 0.85) out.push('<path d="' + arc(ring.ghost.f, ring.ghost.from, 93) + '" fill="none" stroke="' + BLUE + '" stroke-opacity=".55" stroke-width="3" stroke-dasharray="4 3"/>');
    // start/finish and timing points
    var sf0 = P(0, 68), sf1 = P(0, 94);
    out.push('<path d="M' + sf0[0] + ' ' + sf0[1] + 'L' + sf1[0] + ' ' + sf1[1] + '" stroke="' + TEXT + '" stroke-width="2"/>');
    if (!opts.compact) g.ticks.forEach(function (f) { var a = P(f, 88), b = P(f, 100); out.push('<path d="M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + 'L' + b[0].toFixed(1) + ' ' + b[1].toFixed(1) + '" stroke="' + GREY + '" stroke-width="1.5"/>'); });
    // cars, back to front
    var order = { other: 0, class: 1, sister: 2, rival: 3, us: 4 }, placed = [];
    ring.cars.slice().sort(function (a, b) { return order[a.role] - order[b.role]; }).forEach(function (c) {
      if (opts.compact && (c.role === 'other' || c.role === 'class')) return;
      var p = P(c.f, c.pit ? 64 : 80), col = c.role === 'us' ? BLUE : c.role === 'rival' ? AMBER : c.role === 'sister' ? '#2dd4bf' : GREY;
      var r = c.role === 'us' ? (opts.compact ? 10 : 7) : c.role === 'rival' || c.role === 'sister' ? (opts.compact ? 7 : 5) : 3.5;
      var op = c.role === 'other' ? ' fill-opacity=".45"' : '';
      out.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r + '" fill="' + col + '"' + op + (c.role === 'us' ? ' stroke="' + TEXT + '" stroke-width="' + (opts.compact ? 3 : 2) + '"' : '') + '><title>#' + esc(c.n) + (c.pit ? ' (pit lane)' : '') + '</title></circle>');
      if (!opts.compact && (c.role === 'rival' || c.role === 'sister')) {
        var radii = c.pit ? [50, 41] : [104, 115, 54, 44], cands = [];
        radii.forEach(function (r0) { [0, -18, 18].forEach(function (dx) { var pt = P(c.f, r0); pt[0] += dx; if (pt[0] >= 10 && pt[0] <= 210 && pt[1] >= 10 && pt[1] <= 214) cands.push(pt); }); });
        var bestPt = null, bestD = -1;
        for (var ci = 0; ci < cands.length; ci++) {
          var d = placed.reduce(function (m0, q0) { return Math.min(m0, Math.max(Math.abs(q0[0] - cands[ci][0]) / 22, Math.abs(q0[1] - cands[ci][1]) / 11)); }, 9);
          if (d >= 1) { bestPt = cands[ci]; break; }
          if (d > bestD) { bestD = d; bestPt = cands[ci]; }
        }
        var q = bestPt || P(c.f, radii[0]);
        placed.push(q);
        out.push('<text x="' + q[0].toFixed(1) + '" y="' + (q[1] + 4).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + col + '">' + esc(c.n) + '</text>');
      }
    });
    if (ring.ghost) {
      var gp = P(ring.ghost.f, 80);
      out.push('<circle cx="' + gp[0].toFixed(1) + '" cy="' + gp[1].toFixed(1) + '" r="' + (opts.compact ? 8 : 7) + '" fill="none" stroke="' + BLUE + '" stroke-width="2" stroke-dasharray="3 2"><title>Where we rejoin if we box now</title></circle>');
    }
    if (!opts.compact) {
      out.push('<text x="110" y="106" text-anchor="middle" font-size="22" font-weight="700" fill="' + TEXT + '">Lap ' + (ring.lap || 0) + '</text>');
      out.push('<text x="110" y="124" text-anchor="middle" font-size="11" fill="' + GREY + '">' + (ring.ghost ? 'dashed circle = box now' : 'S/F at top') + '</text>');
    }
    var lbl = 'Lap tracker: our car #' + esc(M.hero) + ' with ' + ring.cars.length + ' cars placed by how far round the lap they are; the pit lane is the amber arc at the start-finish line';
    return '<svg viewBox="0 0 220 220" role="img" aria-label="' + lbl + '" style="width:' + size + 'px;height:' + size + 'px;flex:none">' + out.join('') + '</svg>';
  };

  PW.gapSVG = function (M, h) {
    var A = M.ahead && !M.ahead.laps ? M.ahead.hist : [], B = M.behind && !M.behind.laps ? M.behind.hist : [];
    var pts = A.concat(B); if (!pts.length) return '<div class="pw-empty" style="height:' + h + 'px">' + (M.ahead || M.behind ? 'Neighbours are a lap or more away — no close fight to chart.' : 'Gap history appears after a few laps.') + '</div>';
    var CAP = 120000, x0 = Infinity, x1 = -Infinity, y1 = 0, y0 = 0;
    pts.forEach(function (p) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y1 = Math.max(y1, Math.min(p.y, CAP)); y0 = Math.min(y0, Math.max(p.y, -CAP)); });
    if (x1 === x0) x1 = x0 + 1;
    var step = function (v) { return Math.max(2000, Math.ceil(Math.abs(v) / 2000) * 2000); };
    y1 = y1 > 0 || y0 === 0 ? step(y1) : 0; y0 = y0 < 0 ? -step(y0) : 0;
    var W = 400, H = 110, X = function (x) { return 30 + (x - x0) / (x1 - x0) * (W - 34); }, Y = function (y) { return 6 + (y1 - Math.max(y0, Math.min(y, y1))) / (y1 - y0) * (H - 18); };
    var o = [];
    (y0 < 0 ? [y1, 0, y0] : [y1, y1 / 2, 0]).forEach(function (q) { var yy = Y(q); o.push('<line x1="30" y1="' + yy.toFixed(1) + '" x2="' + W + '" y2="' + yy.toFixed(1) + '" stroke="' + (q === 0 ? '#3a4656' : LINE) + '"/><text x="26" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="9" fill="' + GREY + '">' + (q / 1000).toFixed(0) + 's</text>'); });
    o.push('<text x="30" y="' + (H - 1) + '" font-size="9" fill="' + GREY + '">lap ' + x0 + '</text><text x="' + W + '" y="' + (H - 1) + '" text-anchor="end" font-size="9" fill="' + GREY + '">lap ' + x1 + '</text>');
    var line = function (P, col, dash) {
      if (!P.length) return '';
      var s = P.map(function (p) { return X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' ');
      var marks = P.filter(function (p) { return p.pit; }).map(function (p) { var my = Math.max(8, Y(p.y) - 3); return '<path d="M' + X(p.x).toFixed(1) + ' ' + my.toFixed(1) + 'l-4 -6h8z" fill="' + col + '"><title>pit stop lap ' + p.x + '</title></path>'; }).join('');
      return '<polyline points="' + s + '" fill="none" stroke="' + col + '" stroke-width="2.5"' + (dash ? ' stroke-dasharray="6 4"' : '') + '/>' + marks;
    };
    o.push(line(A, BLUE, false)); o.push(line(B, AMBER, true));
    var aria = 'Gap history over the last ' + (x1 - x0 + 1) + ' laps' + (M.ahead ? '; gap to #' + M.ahead.n + ' now ' + sec(M.ahead.gapMs) + ' s' : '') + (M.behind ? '; gap to #' + M.behind.n + ' now ' + sec(M.behind.gapMs) + ' s' : '');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(aria) + '" style="width:100%;height:' + h + 'px">' + o.join('') + '</svg>';
  };

  /* ---------- text helpers ---------- */
  PW.relCard = function (r, which, big) {
    if (!r) return '<div class="p"><h2 class="h">' + (which === 'ahead' ? 'Car ahead' : 'Car behind') + '</h2><div class="m">' + (which === 'ahead' ? 'Leading' : 'Nobody behind') + '</div></div>';
    var gapTxt = r.laps ? r.laps + ' lap' + (r.laps > 1 ? 's' : '') : (which === 'ahead' ? '+' : '') + sec(r.gapMs) + ' s';
    var line;
    if (r.inPit) line = '#' + esc(r.n) + ' is in the pits';
    else if (r.stale) line = 'No timing from our car';
    else if (r.laps) line = which === 'ahead' ? 'Laps ahead of us — not a fight on track' : 'A lap or more down on us';
    else if (r.closingMs === null) line = 'Trend after 3 clean laps';
    else if (which === 'ahead') {
      line = r.closingMs > 50 ? 'Closing ' + sec(r.closingMs, 1) + ' s/lap' + (r.catchLaps ? ' · catch in about ' + Math.ceil(r.catchLaps) + ' laps' : '')
        : r.closingMs < -50 ? 'Pulling away ' + sec(-r.closingMs, 1) + ' s/lap' : 'Holding steady';
    } else {
      line = r.closingMs > 50 ? 'Closing ' + sec(r.closingMs, 1) + ' s/lap' + (r.catchLaps ? ' · on us in about ' + Math.ceil(r.catchLaps) + ' laps' : '')
        : r.closingMs < -50 ? 'Falling back ' + sec(-r.closingMs, 1) + ' s/lap · no threat' : 'Holding steady';
    }
    var warn = which === 'behind' && r.closingMs > 50 && r.catchLaps && r.catchLaps < 10;
    var good = which === 'ahead' && r.closingMs > 50 && r.catchLaps && r.catchLaps < 15;
    var title = big ? (which === 'ahead' ? 'Car ahead' : 'Car behind') : (which === 'ahead' ? 'Ahead #' : 'Behind #') + esc(r.n);
    return '<div class="p' + (warn ? ' pw-warn' : good ? ' pw-good' : '') + '"><h2 class="h">' + title + (big ? '' : '') + '</h2>' +
      (big ? '<div class="pw-relrow"><span class="pw-num">#' + esc(r.n) + '</span><span class="big">' + gapTxt + '</span><span class="m">' + esc(r.cls) + '</span></div>' : '<div class="big">' + gapTxt + '</div>') +
      '<div class="m">' + line + '</div></div>';
  };

  function flagHTML(M, short) {
    var f = M.hdr.flag || 'GF', col = f === 'GF' ? GREEN : f === 'RF' ? RED : f === 'FF' || f === 'CHK' ? TEXT : AMBER;
    var label = short ? ({ GF: 'GREEN', FCY: 'FCY', SC: 'SAFETY CAR', YF: 'YELLOW', RF: 'RED', FF: 'FINISH', CHK: 'FINISH' }[f] || f) : (RS.FLAG_LABEL[f] || f) + (f === 'GF' ? ' FLAG' : '');
    return '<span class="pw-flag"><span aria-hidden="true" class="pw-dot" style="background:' + col + '"></span><strong>' + esc(label) + (M.hdr.flagSrc === 'inferred' ? ' ?' : '') + '</strong></span>';
  }
  PW.flagHTML = flagHTML;

  PW.towerRows = function (App, v, M, filter, compact) {
    var rows = v.rows, hero = M.row;
    if (filter === 'class' && hero) rows = rows.filter(function (r) { return r.cls === hero.cls; });
    else if (filter === 'around' && hero) {
      var cl = rows.filter(function (r) { return r.cls === hero.cls; }), i = cl.indexOf(hero);
      var keep = {}; cl.slice(Math.max(0, i - 3), i + 4).forEach(function (r) { keep[r.n] = 1; });
      var j = rows.indexOf(hero); rows.slice(Math.max(0, j - 2), j + 3).forEach(function (r) { keep[r.n] = 1; });
      if (cl[0]) keep[cl[0].n] = 1;
      rows = rows.filter(function (r) { return keep[r.n]; });
    }
    if (compact) {
      if (hero) { var cls = v.rows.filter(function (r) { return r.cls === hero.cls; }), k = cls.indexOf(hero); rows = cls.slice(Math.max(0, Math.min(k - 2, cls.length - 5)), Math.max(0, Math.min(k - 2, cls.length - 5)) + 5); }
      else rows = v.rows.slice(0, 5);
    }
    var useCls = filter !== 'all';
    return rows.map(function (r) {
      var gap = r.gapText !== undefined && !useCls ? r.gapText
        : useCls ? (r.leader || r.gapClsMs === 0 ? 'Leader' : r.gapClsLaps ? '+' + r.gapClsLaps + ' L' : r.gapClsMs !== null && r.gapClsMs !== undefined ? '+' + sec(r.gapClsMs) : '')
          : (r.pos === 1 ? 'Leader' : r.gapLaps ? '+' + r.gapLaps + ' L' : r.gapMs !== null && r.gapMs !== undefined ? '+' + sec(r.gapMs) : '');
      var state = r.inPit ? 'Box' : 'Track';
      var cls = (r.isHero ? 'me' : r.isSister ? 'sis' : '') + (r.inPit ? ' box' : '');
      if (compact) return '<tr class="' + cls + '" data-n="' + esc(r.n) + '"><td>' + (useCls ? r.cpos : r.pos) + '</td><td>#' + esc(r.n) + '</td><td>' + esc(gap) + '</td><td>' + lapTxt(r.lastMs) + '</td></tr>';
      return '<tr class="' + cls + '" data-n="' + esc(r.n) + '"><td>' + r.pos + '</td><td>' + r.cpos + '</td><td><b>#' + esc(r.n) + '</b></td><td>' + esc(r.cls) + '</td><td>' + esc(gap) + '</td><td>' + lapTxt(r.lastMs) + '</td><td>' + (r.pits || 0) + '</td><td>' + state + '</td></tr>';
    }).join('');
  };

  PW.pitTable = function (M, compact) {
    if (!M.pit) return '<div class="m">Pick our car in Settings to see the pit window.</div>';
    var rows = M.pit.rows.map(function (r) {
      var cls = r.yellow ? ' class="pw-y"' : r === M.pit.best ? ' class="pw-best"' : '';
      var rejoin = r.cpos ? 'P' + r.cpos + (compact ? '' : ' <span class="m">(' + r.pos + ')</span>') : '–';
      return '<tr' + cls + '><td>' + esc(r.label) + (r.note && !compact ? ' <span class="m">' + esc(r.note) + '</span>' : '') + '</td><td>' + rejoin + '</td><td>~' + sec(r.lossMs, 0) + ' s</td><td>' + esc(r.yellow ? 'If it comes' : r.traffic ? r.traffic.text : '–') + '</td></tr>';
    }).join('');
    return '<table class="t"><thead><tr><th>Pit in</th><th>Rejoin' + (compact ? '' : ' <span class="m">cls (ovr)</span>') + '</th><th>Time lost</th><th>Traffic</th></tr></thead><tbody>' + rows + '</tbody></table>';
  };

  PW.windowText = function (M) {
    if (!M.pit) return { head: 'Pit window', sub: '' };
    var w = M.pit.window, b = M.pit.best;
    if (M.pit.inPit) return { head: 'In the pits', sub: 'Window resets when we rejoin' };
    if (M.stale) return { head: 'No timing from #' + esc(M.hero), sub: 'Last crossed the line ' + Math.round(M.stale / 60000) + ' min ago' };
    if (!w) return { head: 'Window: –', sub: 'Needs race length / time remaining' };
    if (w.status === 'unknown') return { head: 'Window: –', sub: 'Fuel unknown: this screen joined at lap ' + (w.firstSeenLap || '?') + '. Known after our next stop, or load the official results file.' };
    if (!M.pit.win) return { head: 'Window: –', sub: 'No fuel window yet' };
    if (w.status === 'finish') return { head: 'No stop needed', sub: 'Fuel to the flag · ' + RS.fmtNum(w.margin, 1) + ' laps spare' };
    var wl = M.pit.win;
    var head = 'Window: laps ' + wl.first + (wl.last > wl.first ? '–' + wl.last : '');
    var sub = w.status === 'critical' ? 'FUEL CRITICAL · ' + RS.fmtNum(w.lapsLeft, 1) + ' laps left' : wl.openNow ? 'Open now · ' + RS.fmtNum(w.lapsLeft, 1) + ' laps of fuel' : 'Opens in ' + (wl.first - M.pit.cur - 1) + ' laps';
    if (b) sub += '<br>Best: lap ' + b.lap + ' → rejoin P' + b.cpos + ', ' + (b.traffic ? b.traffic.text.toLowerCase() : 'traffic unknown');
    return { head: head, sub: sub, status: w.status === 'critical' ? 'critical' : wl.openNow ? 'open' : 'closed' };
  };

  PW.rcList = function (M, max) {
    if (!M.rc.length) return '<div class="m">No messages yet.</div>';
    return M.rc.slice(0, max).map(function (m) { return '<div class="pw-rc ' + esc(m.level || '') + '"><span class="m">' + esc(m.time) + '</span> ' + esc(m.text) + '</div>'; }).join('');
  };

  /* ---------- laptop layout ---------- */
  PW.renderMain = function (App, v, M, el) {
    var f = App.ui.pwFilter || 'around', t = M.tiles || {};
    var wt = PW.windowText(M);
    var btn = function (k, label) { return '<button type="button" data-pwf="' + k + '" class="' + (f === k ? 'on' : '') + '">' + label + '</button>'; };
    var nb = function (k, label) { return '<button type="button" data-pwn="' + k + '" class="' + (M.mode === k ? 'on' : '') + '">' + label + '</button>'; };
    var trend = t.trend === null || t.trend === undefined ? '–' : (t.trend >= 0 ? '+' : '') + (t.trend / 1000).toFixed(2) + ' s/lap';
    el.innerHTML =
      '<div class="pw-main">' +
      '<div class="pw-left">' +
        '<section class="pw-2">' + PW.relCard(M.ahead, 'ahead', true) + PW.relCard(M.behind, 'behind', true) + '</section>' +
        '<section class="p"><div class="pw-headrow"><h2 class="h">Gap history · last 20 laps</h2><div class="pw-seg">' + nb('class', 'Class') + nb('overall', 'Overall') + '</div></div>' + PW.gapSVG(M, 170) +
          '<div class="m">Solid: gap to ' + (M.ahead ? '#' + esc(M.ahead.n) + (M.ahead.laps ? ' (lapped, not drawn)' : '') : 'car ahead') + ' · Dashed: gap to ' + (M.behind ? '#' + esc(M.behind.n) + (M.behind.laps ? ' (lapped, not drawn)' : '') : 'car behind') + ' · from line-crossing times · ▼ pit lap</div></section>' +
        '<section class="pw-4">' +
          '<div class="p"><h2 class="h">Last lap</h2><div class="pw-tile">' + lapTxt(t.last) + '</div></div>' +
          '<div class="p"><h2 class="h">Best lap</h2><div class="pw-tile">' + lapTxt(t.best) + '</div></div>' +
          '<div class="p"><h2 class="h">Last 5 avg</h2><div class="pw-tile">' + lapTxt(t.avg5) + '</div></div>' +
          '<div class="p"><h2 class="h">Stint trend</h2><div class="pw-tile' + (t.trend > 150 ? ' pw-bad' : '') + '">' + trend + '</div></div>' +
        '</section>' +
      '</div>' +
      '<section class="p pw-tower"><div class="pw-headrow"><h2 class="h">Timing tower</h2><div class="pw-seg">' + btn('around', 'Around us') + btn('class', 'Our class') + btn('all', 'All') + '</div></div>' +
        '<div class="pw-towerwrap"><table class="t"><thead><tr><th>Pos</th><th>Cls</th><th>Car</th><th></th><th>Gap</th><th>Last</th><th>Pits</th><th>State</th></tr></thead><tbody>' + PW.towerRows(App, v, M, f, false) + '</tbody></table></div></section>' +
      '</div>' +
      '<footer class="pw-foot">' +
        '<section class="p"><h2 class="h">Pit window</h2>' + PW.pitTable(M, false) +
          '<div class="m" style="margin-top:6px">Pit loss ' + (M.pit ? '~' + sec(M.pit.lossMs, 0) + ' s (' + esc(M.pit.lossLabel) + ') · ~' + sec(M.pit.lossYMs, 0) + ' s under yellow' : '–') + '</div></section>' +
        '<section class="p"><h2 class="h">Lap tracker · pit window</h2><div class="pw-ringrow">' + PW.ringSVG(M, 200) +
          '<div class="pw-wtext"><div class="pw-whead' + (wt.status === 'critical' ? ' pw-bad' : wt.status === 'open' ? ' pw-amber' : '') + '">' + wt.head + '</div><div class="m">' + wt.sub + '</div>' +
          '<div class="m" style="margin-top:6px">Blue: us · amber: ' + [M.ahead, M.behind].filter(Boolean).map(function (r) { return '#' + esc(r.n); }).join(', ') + (M.ahead || M.behind ? '' : 'rivals') + ' · dashed ring: rejoin if we box now · ticks: timing points</div></div></div></section>' +
        '<section class="p"><h2 class="h">Race control</h2><div class="pw-rclist">' + PW.rcList(M, 8) + '</div></section>' +
      '</footer>';
  };

  /* ---------- crew phone layout ---------- */
  PW.renderPhone = function (App, v, M, el) {
    var tab = App.ui.pwPhoneTab || 'gaps', wt = PW.windowText(M), body = '';
    var rem = M.hdr.remaining !== null && M.hdr.remaining !== undefined ? RS.fmtClock(M.hdr.remaining) : '--:--';
    var head = '<header class="pw-phead"><div><div class="pw-plap">Lap ' + (M.hdr.lap || 0) + ' · ' + rem + '</div><div class="m">#' + esc(M.hero) + (M.row ? ' · P' + M.row.pos + ' overall · P' + M.row.cpos + ' in class' : ' · not on track') + '</div></div>' + flagHTML(M, true) + '</header>';
    var ringBlock = '<section class="p pw-pring">' + PW.ringSVG(M, 120, { compact: true }) + '<div><div class="h" style="margin:0">Pit window</div><div class="pw-pwin">' + wt.head.replace('Window: laps ', 'Laps ') + '</div><div class="m">' + wt.sub + '</div></div></section>';
    if (tab === 'gaps') {
      body = '<section class="pw-2">' + PW.relCard(M.ahead, 'ahead', false) + PW.relCard(M.behind, 'behind', false) + '</section>' + ringBlock +
        '<section class="p"><h2 class="h">Order · our class</h2><table class="t">' + PW.towerRows(App, v, M, 'class', true) + '</table></section>' +
        '<section class="p"><h2 class="h">Race control</h2>' + PW.rcList(M, 2) + '</section>';
    } else if (tab === 'pit') {
      body = '<section class="p pw-pbig">' + PW.ringSVG(M, 240) + '</section>' +
        '<section class="p"><h2 class="h">' + wt.head + '</h2><div class="m" style="margin-bottom:6px">' + wt.sub + '</div>' + PW.pitTable(M, true) + '</section>';
    } else {
      body = '<section class="p pw-pflag">' + flagHTML(M, false) + '<div class="m">' + (M.hdr.flagSrc === 'inferred' ? 'Inferred from lap times — not an official flag' : 'From the timing feed') + '</div></section>' +
        '<section class="p"><h2 class="h">Race control</h2><div class="pw-rclist">' + PW.rcList(M, 30) + '</div></section>';
    }
    var nav = '<nav class="pw-nav">' + [['gaps', 'Gaps'], ['pit', 'Pit window'], ['flags', 'Flags']].map(function (b) { return '<button type="button" data-pwt="' + b[0] + '" class="' + (tab === b[0] ? 'on' : '') + '">' + b[1] + '</button>'; }).join('') + '</nav>';
    el.innerHTML = head + '<div class="pw-pbody">' + body + '</div>' + nav;
  };

  PW.render = function (App, v) {
    var main = G.document.getElementById('pw-main'), phone = G.document.getElementById('pw-phone');
    if (!main || !phone || App.pointerDown) return;
    var M = App.pwModel = PW.model(App, v);
    var narrow = G.matchMedia ? G.matchMedia('(max-width: 760px)').matches : false;
    if (narrow) PW.renderPhone(App, v, M, phone); else PW.renderMain(App, v, M, main);
  };
})(typeof window !== 'undefined' ? window : globalThis);
