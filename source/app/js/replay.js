/* Zenith Strategy — replay player + Al Kamel analysis CSV reader */
(function (G) {
  'use strict';
  var RS = G.RS;

  /* Parse an Al Kamel "Analysis" CSV (';' separated) into the replay format used by the player. */
  RS.parseAlKamelCSV = function (text, meta) {
    text = String(text).replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
    if (lines.length < 2) throw new Error('The file has no lap rows.');
    var head = lines[0].split(';').map(function (h) { return h.trim().toUpperCase(); });
    var ix = function (name) { return head.indexOf(name); };
    var need = ['NUMBER', 'LAP_NUMBER', 'LAP_TIME', 'ELAPSED'];
    need.forEach(function (n) { if (ix(n) < 0) throw new Error('Not an Al Kamel analysis file (missing ' + n + ').'); });
    var C = { num: ix('NUMBER'), dn: ix('DRIVER_NUMBER'), lap: ix('LAP_NUMBER'), lt: ix('LAP_TIME'), pit: ix('CROSSING_FINISH_LINE_IN_PIT'),
      s1: ix('S1'), s2: ix('S2'), s3: ix('S3'), el: ix('ELAPSED'), hr: ix('HOUR'), top: ix('TOP_SPEED'), dname: ix('DRIVER_NAME'),
      pt: ix('PIT_TIME'), cls: ix('CLASS'), team: ix('TEAM'), mfr: ix('MANUFACTURER'), flag: ix('FLAG_AT_FL') };
    var FLAGS = ['GF', 'FCY', 'SC', 'RF', 'FF', 'YF', 'CHK'];
    var cars = {}, order = [], laps = [], startClock = null;
    for (var i = 1; i < lines.length; i++) {
      var f = lines[i].split(';');
      if (f.length < 8) continue;
      var g = function (k) { return k >= 0 && k < f.length ? f[k].trim() : ''; };
      var n = g(C.num); if (!n) continue;
      var el = RS.toMs(g(C.el)), lt = RS.toMs(g(C.lt));
      if (el === null || lt === null) continue;
      var car = cars[n];
      if (!car) { car = cars[n] = { n: n, cls: g(C.cls), team: g(C.team), mfr: g(C.mfr), drvKeys: [], drivers: [] }; order.push(n); }
      var dk = g(C.dn) || '1', di = car.drvKeys.indexOf(dk);
      if (di < 0) { di = car.drvKeys.length; car.drvKeys.push(dk); car.drivers.push(g(C.dname).replace(/\*/g, '').trim()); }
      var hr = RS.toMs(g(C.hr));
      if (hr !== null) { var sc = hr - el; if (startClock === null || sc < startClock) startClock = sc; }
      var fl = g(C.flag), top = parseFloat(g(C.top));
      laps.push([n, parseInt(g(C.lap), 10), el, lt, RS.toMs(g(C.s1)) || 0, RS.toMs(g(C.s2)) || 0, RS.toMs(g(C.s3)) || 0,
        g(C.pit) === 'B' ? 1 : 0, RS.toMs(g(C.pt)) || 0, di, isFinite(top) ? Math.round(top * 10) : 0, Math.max(0, FLAGS.indexOf(fl))]);
    }
    order.sort(function (a, b) { return (parseInt(a, 10) || 9999) - (parseInt(b, 10) || 9999); });
    var idx = {}; order.forEach(function (n, i) { idx[n] = i; });
    laps.forEach(function (l) { l[0] = idx[l[0]]; });
    laps.sort(function (a, b) { return a[2] - b[2] || a[0] - b[0]; });
    var maxEl = laps.length ? laps[laps.length - 1][2] : 0;
    var half = 1800000, dur = maxEl % half < 600000 ? Math.floor(maxEl / half) * half : (Math.floor(maxEl / half) + 1) * half;
    return {
      meta: Object.assign({ id: 'csv-' + Date.now(), name: 'Imported session', track: '', startClockMs: startClock, durationMs: dur || null, flags: FLAGS, refLapMs: {}, pitLaneMs: {}, transitDeltaMs: {} }, meta || {}),
      cars: order.map(function (n) { var c = cars[n]; return { n: n, cls: c.cls, team: c.team, mfr: c.mfr, drivers: c.drivers }; }),
      laps: laps
    };
  };

  /* derive class reference pace + pit-lane bands for a replay that has none (e.g. an imported CSV) */
  RS.deriveMeta = function (rep) {
    var m = rep.meta, byc = {}, lanes = {};
    if (!m.sectorFrac) {                                    // where the sector lines sit round the lap (for the lap ring)
      var f1 = [], f2 = [];
      rep.laps.forEach(function (l) { if (!l[7] && !l[8] && l[1] > 1 && l[3] && l[4] && l[5] && (!l[11] || l[11] === 0)) { f1.push(l[4] / l[3]); f2.push((l[4] + l[5]) / l[3]); } });
      if (f1.length > 20) m.sectorFrac = [Math.round(RS.median(f1) * 1000) / 1000, Math.round(RS.median(f2) * 1000) / 1000];
    }
    if (m.refLapMs && Object.keys(m.refLapMs).length) return rep;
    rep.laps.forEach(function (l) {
      var cls = rep.cars[l[0]].cls;
      if (!l[7] && !l[8] && l[1] > 1 && (!l[11] || l[11] === 0)) (byc[cls] = byc[cls] || []).push(l[3]);
      if (l[8] && l[1] > 1 && l[8] >= 20000 && l[8] <= 600000) (lanes[cls] = lanes[cls] || []).push(l[8]);
    });
    m.refLapMs = {}; m.pitLaneMs = {};
    Object.keys(byc).forEach(function (k) { var v = byc[k].sort(function (a, b) { return a - b; }); m.refLapMs[k] = RS.median(v.slice(0, Math.max(5, v.length >> 1))); });
    Object.keys(lanes).forEach(function (k) { var v = lanes[k]; m.pitLaneMs[k] = { p10: RS.pct(v, 0.1), p50: RS.pct(v, 0.5), p80: RS.pct(v, 0.8), n: v.length }; });
    return rep;
  };

  /* Feed a replay into an engine against a session clock. */
  function Replay(engine, rep) {
    RS.Emitter.call(this);
    this.engine = engine; this.rep = rep;
    this.t = 0; this.i = 0; this.speed = 10; this.playing = false; this._last = null;
    this.end = rep.laps.length ? rep.laps[rep.laps.length - 1][2] + 5000 : 0;
    this.reset();
  }
  Replay.prototype = Object.create(RS.Emitter.prototype);
  Replay.prototype.reset = function () {
    var rep = this.rep;
    this.engine.reset(rep.meta, rep.cars);
    this.i = 0; this.t = 0;
  };
  Replay.prototype._feedTo = function (t, quiet) {
    var L = this.rep.laps, cars = this.rep.cars, flags = this.rep.meta.flags || ['GF'];
    while (this.i < L.length && L[this.i][2] <= t) {
      var l = L[this.i++], c = cars[l[0]];
      this.engine.addLap(c.n, { lap: l[1], elapsedMs: l[2], lapMs: l[3], s: [l[4] || null, l[5] || null, l[6] || null], inPit: l[7], pitMs: l[8], drv: l[9], topKph: l[10] ? l[10] / 10 : null, flag: flags[l[11]] || null }, quiet);
    }
    this.t = t;
    this.engine.setClock(t, this.rep.meta.durationMs ? Math.max(0, this.rep.meta.durationMs - t) : null);
  };
  Replay.prototype.seek = function (t) {
    t = RS.clamp(t, 0, this.end);
    if (t < this.t) this.reset();
    this._feedTo(t, true);
    var keep = this.engine.events.length;
    this.engine.compute(); // settle state (alerts/positions) without spamming the log
    this.engine.events.length = keep; this.engine.newEvents = [];
    this.emit('tick', this.t);
  };
  Replay.prototype.play = function () { this.playing = true; this._last = null; this.emit('state'); };
  Replay.prototype.pause = function () { this.playing = false; this.emit('state'); };
  Replay.prototype.tick = function (wallNow) {
    if (!this.playing) { this._last = null; return; }
    if (this._last === null) { this._last = wallNow; return; }
    var dt = (wallNow - this._last) * this.speed; this._last = wallNow;
    var t = Math.min(this.end, this.t + dt);
    this._feedTo(t, false);
    if (t >= this.end) this.pause();
    this.emit('tick', this.t);
  };
  RS.Replay = Replay;
})(typeof window !== 'undefined' ? window : globalThis);
