/* Zenith Strategy — rendering */
(function (G) {
  'use strict';
  var RS = G.RS, D = G.document;
  var UI = RS.UI = {};
  var $ = function (id) { return D.getElementById(id); };
  var esc = RS.esc;

  UI.CLS_COLOR = { ZP1: '#f43f5e', ZP2: '#fb923c', ZR1: '#38bdf8', ZR2: '#4ade80', ZR3: '#facc15', ZR4: '#cbd5e1' };
  UI.clsColor = function (c) { return UI.CLS_COLOR[c] || '#94a3b8'; };
  UI.clsBadge = function (c) { return '<span class="cls" style="background:' + UI.clsColor(c) + '">' + esc(c || '?') + '</span>'; };
  var PALETTE = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#f87171', '#a3e635', '#22d3ee', '#fb7185', '#e879f9', '#fdba74'];
  UI.carColor = function (App, n, i) {
    var s = App.settings;
    if (String(n) === String(s.hero)) return '#a855f7';
    if ((s.sisters || []).map(String).indexOf(String(n)) >= 0) return '#3b82f6';
    return PALETTE[(i || 0) % PALETTE.length];
  };

  function gapTxt(ms, laps, live) {
    if (laps) return '+' + laps + ' L';
    if (ms === null || ms === undefined) return live ? esc(live) : '';
    return RS.fmtGap(ms, 1);
  }
  UI.gapTxt = gapTxt;

  /* ---------------- leaderboard ---------------- */
  var COLS = [['P', 'pos'], ['CP', 'cpos'], ['#', 'n'], ['Cls', 'cls', 1], ['Driver', 'driver', 1], ['Laps', 'laps'], ['Gap cls', 'gap'], ['Int cls', 'int'],
    ['Last', 'last'], ['Best', 'best'], ['Pace', 'pace'], ['Stint', 'stint'], ['Pits', 'pits'], ['Last pit', 'lpit'], ['To hero', 'rel'], ['Δ/lap', 'close'], ['', 'st', 1]];
  UI.renderBoard = function (App, v) {
    var tabs = $('cls-tabs'), s = App.settings, ui = App.ui;
    var heroRow = v.byN[String(s.hero)];
    var classes = Object.keys(v.classes).sort();
    var tabDefs = [['hero', heroRow ? '★ ' + heroRow.cls : '★ Hero class'], ['all', 'All']].concat(classes.map(function (c) { return [c, c]; })).concat([['team', 'Team + follows']]);
    var th = tabDefs.map(function (t) {
      var cnt = t[0] === 'all' ? v.rows.length : v.classes[t[0]] || (t[0] === 'hero' && heroRow ? v.classes[heroRow.cls] : '');
      return '<button type="button" data-cls="' + esc(t[0]) + '" class="' + (ui.clsTab === t[0] ? 'on' : '') + '">' + esc(t[1]) + (cnt ? '<span class="cnt">' + cnt + '</span>' : '') + '</button>';
    }).join('');
    if (tabs._h !== th) { tabs.innerHTML = th; tabs._h = th; }
    var tb = $('board');
    var head = '<tr>' + COLS.map(function (c) { return '<th class="' + (c[2] ? 'l' : '') + '">' + c[0] + '</th>'; }).join('') + '</tr>';
    if (tb.tHead._h !== head) { tb.tHead.innerHTML = head; tb.tHead._h = head; }
    if (!v.rows.length) { tb.tBodies[0].innerHTML = '<tr><td colspan="' + COLS.length + '" class="l"><div class="empty">' + UI.welcome(App) + '</div></td></tr>'; return; }
    var focus = ui.clsTab, follows = (s.follows || []).map(String);
    var rows = v.rows.filter(function (r) {
      if (focus === 'all') return true;
      if (focus === 'hero') return heroRow ? r.cls === heroRow.cls || r.isHero || r.isSister : true;
      if (focus === 'team') return r.isHero || r.isSister || follows.indexOf(r.n) >= 0;
      return r.cls === focus;
    });
    var cb = App.engine.classBest, eng = App.engine;
    var html = rows.map(function (r) {
      var cls = [r.isHero ? 'hero' : r.isSister ? 'sister' : r.isFollow ? 'follow' : '', r.inPit ? 'inpit' : '', ui.chartCars.indexOf(r.n) >= 0 ? 'sel' : ''].join(' ');
      var best = cb[r.cls] && r.bestMs === cb[r.cls].ms ? 'cb' : '';
      var last = r.lastMs && cb[r.cls] && r.lastMs === cb[r.cls].ms ? 'cb' : (r.lastMs && r.lastMs === r.bestMs ? 'pb' : (r.lastSlow ? 'slow' : ''));
      var car = eng.cars[r.n], lr = car && car.lastRec();
      var st = r.inPit ? '<span class="tag">PIT</span>' : (lr && lr.inPit ? '<span class="tag out">OUT</span>' : '');
      var closeCls = '', close = '';
      if (r.closeMs !== undefined && r.closeMs !== null && !r.isHero) {
        var d = -r.closeMs / 1000; close = (d > 0 ? '+' : '') + d.toFixed(2);
        if (r.relGapMs > 0 && r.closeMs > 0) closeCls = 'down'; else if (r.relGapMs < 0 && r.closeMs < 0) closeCls = 'up';
      }
      return '<tr data-n="' + esc(r.n) + '" class="' + cls + '">' +
        '<td>' + r.pos + '</td><td>' + r.cpos + '</td><td><b>' + esc(r.n) + '</b></td><td class="l">' + UI.clsBadge(r.cls) + '</td>' +
        '<td class="l">' + esc(r.driver) + '</td><td>' + (r.laps || '') + '</td>' +
        '<td>' + (r.leader ? 'Leader' : gapTxt(r.gapClsMs, r.gapClsLaps, r.gapText)) + '</td>' +
        '<td>' + (r.leader ? '' : gapTxt(r.intClsMs, r.intClsLaps, r.intText)) + '</td>' +
        '<td class="' + last + '">' + RS.fmtLap(r.lastMs) + '</td><td class="' + best + '">' + RS.fmtLap(r.bestMs) + '</td>' +
        '<td>' + RS.fmtLap(r.paceMs) + '</td><td>' + (r.stintLaps ? r.stintLaps + 'L ' + (r.stintMs ? RS.fmtClock(r.stintMs, false) : '') : '') + '</td>' +
        '<td>' + (r.pits || '') + '</td><td>' + (r.lastPitLap ? 'L' + r.lastPitLap + ' · ' + RS.fmtLap(r.lastLaneMs).replace(/\.\d+$/, '') : '') + '</td>' +
        '<td>' + (r.isHero ? '—' : RS.fmtGap(r.relGapMs, 1)) + '</td><td class="' + closeCls + '">' + close + '</td><td class="l">' + st + '</td></tr>';
    }).join('');
    tb.tBodies[0].innerHTML = html;
  };

  UI.welcome = function (App) {
    return '<div style="font-size:15px;color:#e2e8f0;margin-bottom:10px">Choose where the timing comes from</div>' +
      '<div class="row" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<button type="button" class="btn primary" data-act="source">Go live — Zenith live timing</button>' +
      '<button type="button" class="btn" data-act="quick-replay">Replay a 2026 race</button>' +
      '<button type="button" class="btn" data-act="source">Load an official results file</button></div>' +
      '<p class="small">Live mode connects this page to Al Kamel live timing, straight from this browser or through your laptop hub. Nothing is stored on a server.</p>';
  };

  /* ---------------- team car cards ---------------- */
  UI.renderCards = function (App, v) {
    var el = $('team-cards');
    var list = [v.hero].concat(v.sisters).filter(Boolean);
    if (!list.length) { el.innerHTML = '<div class="card"><div class="muted">Team cars ' + esc((App.settings.teamCars || []).join(', ')) + ' are not in this session yet.</div></div>'; return; }
    el.innerHTML = list.map(function (h, i) {
      var w = h.window || {}, f = h.fuel;
      var fuelPct = f && f.tank && f.used !== null ? RS.clamp((f.tank - f.used) / f.tank, 0, 1) * 100 : 0;
      var win = '';
      if (w.status === 'unknown') win = '<div class="win closed"><b>Fuel unknown</b> · this screen joined at lap ' + (w.firstSeenLap || '?') + '<br><span class="muted">Known after #' + esc(h.n) + '\'s next stop, or drop the official results file (Data source) to fill in the laps missed.</span></div>';
      else if (w.status === 'finish') win = '<div class="win finish">Fuel to the finish ✓ — margin ' + RS.fmtNum(w.margin, 1) + ' laps (' + w.lapsToGo + ' to go)</div>';
      else if (w.status) win = '<div class="win ' + w.status + '"><b>' + (w.status === 'open' ? 'PIT WINDOW OPEN' : w.status === 'critical' ? 'FUEL CRITICAL' : 'Next stop window') + '</b> · laps ' + w.open + '–' + w.close +
        ' (now ' + w.now + ')<br><span class="muted">' + w.stopsNeeded + ' stop' + (w.stopsNeeded > 1 ? 's' : '') + ' to go · max stint ' + w.maxStint + ' laps · ~' + w.lapsToGo + ' laps left in the race' +
        (w.fuelToFinishAtClose ? ' · final stop needs ' + RS.fmtNum(w.fuelToFinishAtClose, 1) + ' gal' : '') + '</span></div>';
      var ahead = h.aheadCls ? '#' + esc(h.aheadCls) + ' ' + gapTxt(h.gapAheadCls, h.gapAheadClsLaps) : 'Class leader';
      var behind = h.behindCls ? '#' + esc(h.behindCls.n) + ' ' + gapTxt(h.behindCls.ms, h.behindCls.laps) : '—';
      var drv = (h.drivers || []).map(function (d) { return esc(d.name) + ' ' + RS.fmtClock(d.ms, false) + (d.minLeftMs ? ' <span class="slow">(' + RS.fmtClock(d.minLeftMs, false) + ' to min)</span>' : ''); }).join(' · ');
      return '<div class="card ' + (i ? 'sister' : '') + '">' +
        '<div class="top"><div><div class="num">#' + esc(h.n) + ' ' + UI.clsBadge(h.cls) + (h.inPit ? ' <span class="tag">IN PIT</span>' : '') + '</div><div class="muted small">' + esc(h.driver || '') + '</div></div>' +
        '<div class="pos"><b>P' + h.cpos + '</b> <span class="muted">in class</span><div class="muted small">P' + h.pos + ' overall · lap ' + (h.laps || 0) + '</div></div></div>' +
        '<div class="gaps"><div class="gapbox"><label>Car ahead (class)</label><div class="v">' + ahead + '</div></div><div class="gapbox"><label>Car behind (class)</label><div class="v">' + behind + '</div></div></div>' +
        '<div class="kv"><div><label>Last</label><span>' + RS.fmtLap(h.lastMs) + '</span></div><div><label>Pace (' + App.settings.paceLaps + ')</label><span>' + RS.fmtLap(h.paceMs) + '</span></div><div><label>Best</label><span>' + RS.fmtLap(h.bestMs) + '</span></div>' +
        '<div><label>Stint</label><span>' + (h.stintLaps || 0) + ' L · ' + RS.fmtClock(h.stintMs, false) + '</span></div><div><label>Stops</label><span>' + h.stops.length + '</span></div>' +
        '<div><label>Fuel left</label><span>' + (f.used === null ? '?' : RS.fmtNum(f.tank - f.used, 1) + ' gal') + '</span><div class="fuelbar"><i style="width:' + fuelPct.toFixed(0) + '%"></i></div></div></div>' +
        win + (drv ? '<div class="small muted" style="margin-top:6px">Drive time: ' + drv + '</div>' : '') + '</div>';
    }).join('');
  };

  /* ---------------- pit predictor ---------------- */
  UI.renderPit = function (App, v) {
    var el = $('pitpred'), s = App.settings;
    var cars = [v.hero].concat(v.sisters).filter(Boolean);
    if (!cars.length) { el.innerHTML = '<div class="ph"><h3>Pit stop predictor</h3></div><div class="pp muted">Waiting for team cars…</div>'; return; }
    var cur = cars.filter(function (c) { return c.n === App.ui.ppCar; })[0] || cars[0];
    var p = cur.predictor;
    var presets = [['p10', 'Quick stop'], ['p50', 'Typical stop'], ['p80', 'Long stop'], ['learned', 'Learned (our stops)'], ['manual', 'Manual']];
    var sel = '<select id="pp-preset">' + presets.map(function (x) { return '<option value="' + x[0] + '"' + (s.pitPreset === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>';
    var rows = p.scenarios.map(function (sc) {
      return '<tr><td class="l">' + esc(sc.label) + '</td><td><b>P' + (sc.cpos || '?') + '</b>' + (sc.lostCls ? ' <span class="down">(−' + sc.lostCls + ')</span>' : '') + '</td>' +
        '<td>' + (sc.aheadCls ? '#' + esc(sc.aheadCls.n) + ' ' + RS.fmtNum(sc.aheadCls.ms / 1000, 1) + 's' : 'Leader') + '</td>' +
        '<td>' + (sc.behindCls ? '#' + esc(sc.behindCls.n) + ' ' + RS.fmtNum(sc.behindCls.ms / 1000, 1) + 's' : '—') + '</td></tr>';
    }).join('');
    // class cars inside the pit-loss window
    var inside = v.rows.filter(function (r) { return r.cls === cur.cls && r.n !== cur.n && r.relGapMs > 0 && r.relGapMs < p.lossMs + 10000 && !r.inPit; })
      .sort(function (a, b) { return a.relGapMs - b.relGapMs; }).slice(0, 8)
      .map(function (r) { var inW = r.relGapMs < p.lossMs; return '<span class="chip" style="border-color:' + (inW ? '#ef4444' : '#22c55e') + '">#' + esc(r.n) + ' +' + RS.fmtNum(r.relGapMs / 1000, 1) + 's</span>'; }).join(' ');
    var tabs = cars.length > 1 ? '<div class="tabs">' + cars.map(function (c) { return '<button type="button" data-pp="' + esc(c.n) + '" class="' + (c.n === cur.n ? 'on' : '') + '">#' + esc(c.n) + '</button>'; }).join('') + '</div>' : '';
    el.innerHTML = '<div class="ph"><h3>Pit stop predictor</h3>' + tabs + '</div><div class="pp">' +
      '<div class="loss"><span>Pit loss <b class="mono">' + RS.fmtNum(p.lossMs / 1000, 1) + ' s</b> · under caution <b class="mono">' + RS.fmtNum(p.lossFcyMs / 1000, 0) + ' s</b></span>' + sel +
      (s.pitPreset === 'manual' ? '<input type="number" id="pp-manual" min="10" max="900" step="1" value="' + (s.pitManualS || '') + '" style="width:70px" aria-label="Manual pit loss seconds"> s' : '') + '</div>' +
      '<table class="tbl"><thead><tr><th class="l">If we…</th><th>Rejoin</th><th>Ahead</th><th>Behind</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="small" style="margin-top:6px"><span class="muted">Class cars behind within reach of a stop</span> (red = would pass):<br>' + (inside || '<span class="muted">none — clear air</span>') + '</div></div>';
  };

  /* ---------------- fuel & stint planner ---------------- */
  UI.renderFuel = function (App, v) {
    var el = $('fuelpanel'), s = App.settings;
    var cars = [v.hero].concat(v.sisters).filter(Boolean);
    if (!cars.length) { el.innerHTML = ''; return; }
    var plan = App.ui.planLap || {};
    var body = cars.map(function (h) {
      var w = h.window, f = h.fuel;
      if (!w) return '<div class="muted small">#' + esc(h.n) + ': set the race length in Settings to plan stops.</div>';
      if (w.status === 'unknown') return '<div class="muted small">#' + esc(h.n) + ': fuel unknown (this screen joined mid-race) until the next stop.</div>';
      var pl = plan[h.n], out = '';
      if (pl && pl > w.now) {
        var pace = h.paceMs || 1, lapsAfter = Math.max(0, w.lapsToGo - (pl - w.now));
        var canReach = pl - w.now <= Math.floor(w.lapsLeft);
        var need = lapsAfter * f.burn + f.reserve, stopsAfter = Math.max(0, Math.ceil((lapsAfter - w.maxStint) / w.maxStint));
        out = '<div class="small" style="margin-top:4px">Stop on lap ' + pl + ': ' + (canReach ? '<span class="up">reachable</span>' : '<span class="down">NOT reachable on fuel</span>') +
          ' · ' + lapsAfter + ' laps after · ' + (stopsAfter ? stopsAfter + ' more stop(s)' : 'needs ' + RS.fmtNum(Math.min(f.tank, need), 1) + ' gal to finish') + '</div>';
      }
      return '<div style="padding:6px 0;border-bottom:1px solid var(--line)"><b>#' + esc(h.n) + '</b> <span class="muted small">tank ' + f.tank + ' gal · burn ' + f.burn + ' gal/lap · reserve ' + f.reserve + '</span>' +
        '<div class="kv"><div><label>Laps on fuel</label><span>' + RS.fmtNum(w.lapsLeft, 1) + '</span></div><div><label>Laps to go</label><span>' + w.lapsToGo + '</span></div><div><label>Stops left</label><span>' + w.stopsNeeded + '</span></div></div>' +
        '<div class="row" style="display:flex;gap:6px;align-items:center;margin-top:6px"><span class="small muted">Plan a stop on lap</span><input type="number" data-plan="' + esc(h.n) + '" value="' + (pl || '') + '" style="width:70px" min="1" aria-label="Planned pit lap"></div>' + out + '</div>';
    }).join('');
    el.innerHTML = '<div class="ph"><h3>Fuel &amp; stint planner</h3><span class="muted small">' + (s.maxStintMin ? 'max stint ' + s.maxStintMin + ' min' : '') + '</span></div><div class="pp">' + body + '</div>';
  };

  /* ---------------- alerts ---------------- */
  UI.renderAlerts = function (App, v) {
    var el = $('alerts');
    var h = v.alerts.map(function (a) { return '<div class="alert ' + a.level + '">' + (a.level === 'crit' ? '⚠' : a.level === 'warn' ? '●' : 'ℹ') + ' ' + esc(a.text) + '</div>'; }).join('');
    if (el._h !== h) { el.innerHTML = h; el._h = h; }
  };

  /* ---------------- chart car chips ---------------- */
  UI.renderChips = function (App) {
    var el = $('chart-cars');
    var h = App.ui.chartCars.map(function (n, i) { return '<span class="chip" data-chip="' + esc(n) + '" title="Remove"><i style="background:' + UI.carColor(App, n, i) + '"></i>#' + esc(n) + ' ×</span>'; }).join('') +
      '<span class="chip" data-chip-reset="1" title="Pick cars around the hero">auto</span>';
    if (el._h !== h) { el.innerHTML = h; el._h = h; }
  };

  /* ---------------- charts ---------------- */
  UI.renderGapChart = function (App, v) {
    var eng = App.engine, hero = String(App.settings.hero), mode = App.ui.gapMode;
    var loss = v.hero ? v.hero.predictor.lossMs : null;
    var series = App.ui.chartCars.map(function (n, i) {
      var pts = eng.series(n, mode === 'hero' ? 'gapHero' : 'gapLeader', hero);
      return { name: n, label: '#' + n, color: UI.carColor(App, n, i), width: n === hero ? 2.6 : 1.6, points: pts };
    });
    var o = { series: series, invertY: true, xLabel: 'lap', yFmt: function (y) { return RS.fmtNum(y / 1000, 0) + 's'; }, empty: 'Pick cars from the leaderboard to chart them' };
    if (mode === 'hero' && loss) { o.band = { y0: 0, y1: loss, color: 'rgba(168,85,247,.13)', label: 'pit loss ' + RS.fmtNum(loss / 1000, 0) + 's — cars here pass you if you stop' }; o.yMin = -loss * 2; o.yMax = loss * 2.5; o.refs = [{ y: 0, color: '#a855f7', label: '#' + hero }]; }
    RS.Chart.line($('cv-gap'), o);
  };
  UI.renderLapChart = function (App) {
    var eng = App.engine, all = [];
    var series = App.ui.chartCars.map(function (n, i) {
      var pts = eng.series(n, 'lap'); pts.forEach(function (p) { if (!p.pit && !p.slow) all.push(p.y); });
      return { name: n, label: '#' + n, color: UI.carColor(App, n, i), width: n === String(App.settings.hero) ? 2.4 : 1.4, points: pts };
    });
    var lo = all.length ? Math.min.apply(null, all) : null, med = RS.median(all);
    RS.Chart.line($('cv-laps'), { series: series, xLabel: 'lap', yMin: lo ? lo * 0.995 : undefined, yMax: med ? med * 1.12 : undefined, yFmt: function (y) { return RS.fmtLap(y).replace(/\d$/, '').replace(/\d$/, ''); }, empty: 'Pick cars from the leaderboard to chart them' });
  };
  UI.renderMap = function (App, v) {
    var eng = App.engine, s = App.settings, hero = eng.cars[String(s.hero)], now = eng.now;
    var focusCls = hero ? hero.cls : null, cars = [];
    var frac = function (c) {
      var lr = c.lastRec(); if (!lr) return null;
      var pace = c.paceMs || eng.classRef(c.cls) || 120000;
      var f = (now - lr.t) / pace; return f < 0 ? 0 : f > 0.995 ? 0.995 : f;
    };
    v.rows.forEach(function (r, i) {
      var c = eng.cars[r.n], f = frac(c); if (f === null) return;
      cars.push({ n: r.n, frac: f, color: UI.clsColor(r.cls), hero: r.isHero, sister: r.isSister, follow: r.isFollow, inPit: r.inPit, dim: focusCls && r.cls !== focusCls && !r.isSister, z: r.isHero ? 3 : r.isSister ? 2 : r.cls === focusCls ? 1 : 0,
        labelAlways: r.cls === focusCls, tag: r.isHero ? '' : '' });
    });
    var hv = cars.filter(function (c) { return c.hero; })[0], o = { cars: cars, caption: RS.fmtClock(now) };
    if (hv && v.hero) {
      var pace = hero.paceMs || eng.classRef(hero.cls) || 120000, g = hv.frac - v.hero.predictor.lossMs / pace;
      o.hero = hv; o.ghost = { frac: ((g % 1) + 1) % 1, label: 'after stop' };
    }
    RS.Chart.timeMap($('cv-map'), o);
    var side = $('map-side');
    if (v.hero) {
      var sc = v.hero.predictor.scenarios[0];
      side.innerHTML = '<h3 style="margin:0 0 6px">If #' + esc(v.hero.n) + ' pits now</h3><div>Rejoins <b>P' + sc.cpos + '</b> in class (P' + sc.pos + ' overall)</div>' +
        '<div class="muted">Loses ' + sc.lostCls + ' class place(s), ' + sc.lostAll + ' overall</div>' +
        '<div style="margin-top:6px">Ahead: ' + (sc.aheadCls ? '#' + esc(sc.aheadCls.n) + ' by ' + RS.fmtNum(sc.aheadCls.ms / 1000, 1) + 's' : 'nobody — leads class') + '<br>Behind: ' + (sc.behindCls ? '#' + esc(sc.behindCls.n) + ' by ' + RS.fmtNum(sc.behindCls.ms / 1000, 1) + 's' : '—') + '</div>' +
        '<p class="small muted">Dots are placed by how far round the lap each car is, from its last line crossing and current pace. The purple arc is the pit loss: class cars inside it would pass you during a stop. Inner ring = in the pits.</p>';
    } else side.innerHTML = '<div class="muted">Hero car not in session.</div>';
  };

  /* ---------------- stints & pits ---------------- */
  UI.stintsOf = function (eng, c) {
    var out = [], starts = [{ lap: 1, t: 0 }].concat(c.stops.map(function (s) { return { lap: s.outLap, t: s.tIn, stop: s }; }));
    for (var i = 0; i < starts.length; i++) {
      var a = starts[i], endLap = i + 1 < starts.length ? c.stops[i].inLap : c.lastLap, laps = [], drv = {};
      for (var k = a.lap; k <= endLap; k++) { var r = c.laps[k]; if (!r) continue; var dn = c.driverName(r.drv); if (dn) drv[dn] = 1; if (r.ms && !r.inPit && !r.pitMs && !r.slow && k > 1) laps.push(r.ms); }
      var endT = c.laps[endLap] ? c.laps[endLap].t : null;
      out.push({ i: i + 1, from: a.lap, to: endLap, laps: Math.max(0, endLap - a.lap + 1), drivers: Object.keys(drv), ms: endT !== null && a.t !== null ? endT - a.t : null,
        avg: laps.length ? RS.mean(laps.slice().sort(function (x, y) { return x - y; }).slice(0, Math.max(1, Math.ceil(laps.length * 0.8)))) : null, best: laps.length ? Math.min.apply(null, laps) : null,
        stopAfter: i < c.stops.length ? c.stops[i] : null, stopIdx: i });
    }
    return out;
  };
  UI.renderStints = function (App) {
    var el = $('tab-stints'), eng = App.engine, n = App.ui.stintCar || String(App.settings.hero), c = eng.cars[n];
    var opts = eng.order.slice().sort(function (a, b) { return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0); }).map(function (x) { return '<option value="' + esc(x) + '"' + (x === n ? ' selected' : '') + '>#' + esc(x) + ' ' + esc(eng.cars[x].cls) + '</option>'; }).join('');
    if (!c) { el.innerHTML = '<div class="empty">No data for this car yet.</div>'; return; }
    var team = eng.isTeam(n);
    var rows = UI.stintsOf(eng, c).map(function (s) {
      var st = s.stopAfter;
      return '<tr><td>' + s.i + '</td><td class="l">' + esc(s.drivers.join(' / ')) + '</td><td>' + s.from + '–' + s.to + '</td><td>' + s.laps + '</td><td>' + RS.fmtClock(s.ms) + '</td><td>' + RS.fmtLap(s.avg) + '</td><td>' + RS.fmtLap(s.best) + '</td>' +
        '<td>' + (st ? RS.fmtLap(st.laneMs) : '') + '</td><td class="l">' + (st ? esc(st.flag || '') : '') + '</td>' +
        '<td class="l">' + (st && team ? '<label class="small"><input type="checkbox" data-fuel="' + s.stopIdx + '"' + (st.fuel ? ' checked' : '') + '> refuel</label>' : (st ? (st.fuel ? 'refuel' : '') : '')) + '</td></tr>';
    }).join('');
    el.innerHTML = '<div class="chart-opts"><label>Car <select id="stint-car">' + opts + '</select></label><span class="muted small">Stint = from the out-lap to the in-lap. Avg = mean of the best 80% of clean laps. ' + (team ? 'Untick “refuel” for stops that took no fuel (fuel model updates).' : '') + '</span></div>' +
      '<table class="tbl"><thead><tr><th>Stint</th><th class="l">Driver(s)</th><th>Laps</th><th>#</th><th>Time</th><th>Avg</th><th>Best</th><th>Pit lane after</th><th class="l">Flag</th><th class="l"></th></tr></thead><tbody>' + rows + '</tbody></table>';
  };

  /* ---------------- compare ---------------- */
  UI.renderCompare = function (App, v) {
    var el = $('tab-compare'), eng = App.engine, hn = String(App.settings.hero), h = eng.cars[hn];
    var other = App.ui.selected && App.ui.selected !== hn ? App.ui.selected : App.ui.chartCars.filter(function (x) { return x !== hn; })[0];
    var o = other ? eng.cars[other] : null;
    if (!h || !o) { el.innerHTML = '<div class="empty">Click a car on the leaderboard to compare it with #' + esc(hn) + '.</div>'; return; }
    var lastN = function (c, i) { var a = []; for (var k = c.lastLap; k >= 2 && a.length < 5; k--) { var r = c.laps[k]; if (r && !r.inPit && !r.pitMs && !r.slow && r.s[i]) a.push(r.s[i]); } return RS.mean(a); };
    var row = function (lbl, a, b, fmt, lowerBetter) {
      var d = a !== null && b !== null && a !== undefined && b !== undefined ? b - a : null;
      var cls = d === null ? '' : (lowerBetter !== false ? (d > 0 ? 'up' : d < 0 ? 'down' : '') : '');
      return '<tr><td class="l">' + lbl + '</td><td>' + (fmt ? fmt(a) : a) + '</td><td>' + (fmt ? fmt(b) : b) + '</td><td class="' + cls + '">' + (d === null ? '' : (d > 0 ? '+' : '') + (fmt === RS.fmtLap ? (d / 1000).toFixed(3) : RS.fmtNum(d, 1))) + '</td></tr>';
    };
    var vr = v.byN[o.n] || {};
    var tbl = row('Best lap', h.bestMs, o.bestMs, RS.fmtLap) + row('Pace (last ' + App.settings.paceLaps + ' clean)', h.paceMs, o.paceMs, RS.fmtLap) +
      [0, 1, 2].map(function (i) { return row('Best S' + (i + 1), h.bestS[i], o.bestS[i], RS.fmtLap) + row('Avg S' + (i + 1) + ' (last 5)', lastN(h, i), lastN(o, i), RS.fmtLap); }).join('') +
      row('Stint laps', h.stint ? h.stint.laps : null, o.stint ? o.stint.laps : null, null, false) + row('Pit stops', h.stops.length, o.stops.length, null, false);
    var rel = vr.relGapMs, catchTxt = '';
    if (vr.lapsToCatch) catchTxt = rel > 0 ? '#' + esc(o.n) + ' catches #' + esc(hn) + ' in ~' + Math.ceil(vr.lapsToCatch) + ' laps' : '#' + esc(hn) + ' catches #' + esc(o.n) + ' in ~' + Math.ceil(vr.lapsToCatch) + ' laps';
    el.innerHTML = '<div class="chart-opts"><b>#' + esc(hn) + '</b> vs <b>#' + esc(o.n) + '</b> ' + UI.clsBadge(o.cls) + ' <span class="muted">' + esc(o.team) + '</span>' +
      '<span>Race gap: <b class="mono">' + (rel === null || rel === undefined ? '—' : RS.fmtGap(rel, 1) + 's') + '</b> ' + (rel > 0 ? '(behind us)' : rel < 0 ? '(ahead of us)' : '') + '</span>' +
      (vr.closeMs !== undefined && vr.closeMs !== null ? '<span>Pace delta: <b class="mono">' + RS.fmtNum(-vr.closeMs / 1000, 2) + ' s/lap</b></span>' : '') + (catchTxt ? '<span class="slow">' + catchTxt + '</span>' : '') + '</div>' +
      '<table class="tbl" style="max-width:640px"><thead><tr><th class="l"></th><th>#' + esc(hn) + '</th><th>#' + esc(o.n) + '</th><th>Δ (them − us)</th></tr></thead><tbody>' + tbl + '</tbody></table>';
  };

  /* ---------------- race log ---------------- */
  UI.renderLog = function (App) {
    var el = $('tab-log'), eng = App.engine, scope = App.ui.logScope || 'relevant', s = App.settings;
    var hero = eng.cars[String(s.hero)], heroCls = hero ? hero.cls : null, follows = (s.follows || []).map(String);
    var ev = eng.events.filter(function (e) {
      if (scope === 'all') return true;
      if (scope === 'alerts') return e.type === 'alert' || e.type === 'flag';
      if (!e.n) return true;
      var c = eng.cars[e.n];
      return eng.isTeam(e.n) || follows.indexOf(String(e.n)) >= 0 || (c && c.cls === heroCls && e.type !== 'pb') || e.type === 'best';
    }).slice(-400).reverse();
    var sel = '<select id="log-scope"><option value="relevant"' + (scope === 'relevant' ? ' selected' : '') + '>Team, follows &amp; our class</option><option value="all"' + (scope === 'all' ? ' selected' : '') + '>Everything</option><option value="alerts"' + (scope === 'alerts' ? ' selected' : '') + '>Flags &amp; alerts only</option></select>';
    el.innerHTML = '<div class="chart-opts">' + sel + '<span class="muted small">' + eng.events.length + ' events</span></div><div class="loglist">' +
      (ev.length ? ev.map(function (e) { return '<div class="e ' + e.level + '"><span class="mono">' + (e.tod !== null ? RS.fmtTod(e.tod) : RS.fmtClock(e.t)) + '</span><span class="mono muted">' + RS.fmtClock(e.t, false) + '</span><span>' + esc(e.text) + '</span></div>'; }).join('') : '<div class="empty">Nothing yet.</div>') + '</div>';
  };

  /* ---------------- strategy calls ---------------- */
  UI.renderCalls = function (App) {
    var el = $('tab-calls'), calls = App.calls || [];
    if (!el._built) {
      el.innerHTML = '<div class="calls-in"><input type="text" id="call-text" placeholder="Log a call, e.g. “Box lap 45 — fuel + driver change to Clark”" aria-label="Strategy call">' +
        '<button type="button" class="btn primary" data-call="">Log</button>' +
        ['BOX THIS LAP', 'BOX NEXT LAP', 'STAY OUT', 'FUEL ONLY', 'DRIVER CHANGE', 'PUSH', 'SAVE FUEL'].map(function (q) { return '<button type="button" class="btn sm" data-call="' + q + '">' + q + '</button>'; }).join('') +
        '<button type="button" class="btn ghost sm" data-act="calls-export">Export CSV</button><button type="button" class="btn ghost sm" data-act="calls-clear">Clear</button></div><div id="calls-list" class="loglist"></div>';
      el._built = true;
    }
    var h = calls.slice().reverse().map(function (c) { return '<div class="e info"><span class="mono">' + esc(c.tod || '') + '</span><span class="mono muted">L' + (c.lap || '') + ' P' + (c.cpos || '') + '</span><span><b>' + esc(c.text) + '</b> <span class="muted small">' + esc(c.session || '') + ' · ' + esc(c.remaining || '') + ' left</span></span></div>'; }).join('');
    var L = $('calls-list'); if (L._h !== h) { L.innerHTML = h || '<div class="empty">Logged calls appear here with the time, lap and position, and stay on this device.</div>'; L._h = h; }
  };

  /* ---------------- feed inspector ---------------- */
  UI.renderInspect = function (App) {
    var el = $('tab-inspect'), src = App.source, m = App.mirror, ad = App.adapter, br = App.bridge;
    var sum = m.summary();
    var age = m.lastMsgAt ? Math.round((Date.now() - m.lastMsgAt) / 1000) + ' s ago' : 'never';
    var subs = (App.learnedSubs || []).map(function (s) { return esc(s.name) + '(' + esc(JSON.stringify(s.params || [])) + ')'; }).join(', ');
    var pick = App.ui.inspectCol || (sum[0] && sum[0].name);
    var colSel = sum.map(function (c) { return '<option value="' + esc(c.name) + '"' + (c.name === pick ? ' selected' : '') + '>' + esc(c.name) + ' (' + c.docs + ')</option>'; }).join('');
    var sample = sum.filter(function (c) { return c.name === pick; })[0];
    var domInfo = App.lastDom ? '<div>Scraped table: ' + App.lastDom.rows.length + ' rows · columns: ' + esc((App.lastDom.headers || []).join(' | ')) + '</div>' : '';
    var html = '<div class="form" style="grid-template-columns:1fr 1fr">' +
      '<fieldset><legend>Source</legend><div>Mode: <b>' + esc(src.label || 'none') + '</b> — ' + esc(src.status || '') + '</div>' +
      '<div>Bridge: ' + (br.active ? 'active (' + esc(br.mode || 'waiting') + '), ' + br.msgs + ' messages' : 'not connected') + '</div>' +
      '<div>Feed messages: ' + m.count + ' · last ' + age + '</div><div>Live subscriptions learned: ' + (subs || '<span class="muted">none yet (use the bridge once)</span>') + '</div>' + domInfo + '</fieldset>' +
      '<fieldset><legend>Detected layout</legend><div>Standings: <b>' + esc(ad.found.standings || '—') + '</b></div><div>Entry list: ' + esc(ad.found.entries || '—') + '</div><div>Time units: ' + esc(ad.ov.units || ad.units || 'auto') + '</div>' +
      '<div class="small muted">' + esc((ad.found.groups || []).map(function (g) { return g.path + ' (' + g.n + ')'; }).join(' · ')) + '</div></fieldset></div>' +
      (sum.length ? '<div class="chart-opts" style="margin-top:8px"><label>Collection <select id="insp-col">' + colSel + '</select></label><span class="muted small">keys: ' + esc(sample ? sample.keys.join(', ') : '') + '</span></div><pre class="json">' + esc(sample ? JSON.stringify(sample.sample, null, 1).slice(0, 6000) : '') + '</pre>' : '<div class="empty">No live collections received yet.</div>') +
      '';
    if (!el._built) {
      el.innerHTML = '<div id="insp-main"></div><details style="margin-top:8px"><summary>Field overrides (only if a column is detected wrongly)</summary><p class="small muted">JSON, e.g. {"standingsPath":"standings","units":"ms","fields":{"pos":"position","laps":"laps","last":"lastLapTime"}}</p>' +
        '<textarea class="code" id="insp-ov">' + esc(JSON.stringify(ad.ov || {}, null, 1)) + '</textarea><div class="row" style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn sm" data-act="ov-apply">Apply overrides</button><button type="button" class="btn ghost sm" data-act="diag-copy">Copy diagnostics</button></div></details>';
      el._built = true;
    }
    var main = $('insp-main');
    if (main._h !== html) { main.innerHTML = html; main._h = html; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
