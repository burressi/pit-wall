/* Zenith Strategy — race state + strategy engine (source-agnostic) */
(function (G) {
  'use strict';
  var RS = G.RS;

  RS.DEFAULTS = {
    hero: '177', sisters: ['178'], follows: [], classFocus: 'auto', paceLaps: 5,
    pitPreset: 'p50', pitManualS: null, fcyLossFactor: 0.5, learnPitLoss: true,
    fuel: { '177': { tank: 18.0, burn: 0.6, reserve: 0.5 }, '178': { tank: 18.0, burn: 0.6, reserve: 0.5 } },   // generic; the team pack sets the real burn per track
    yellowBurn: 0.6, refuelMinLaneS: 70, maxStintMin: 0, minDriveMin: 0,
    cautionDetect: true, eventScope: 'relevant', sound: false
  };

  function Car(info) {
    this.n = String(info.n);
    this.cls = info.cls || '';
    this.team = info.team || '';
    this.mfr = info.mfr || '';
    this.drivers = (info.drivers || []).slice();
    this.laps = [];           // index = lap number (sparse)
    this.lastLap = 0;
    this.stops = [];          // {inLap, outLap, laneMs, tIn, drvOut, drvIn, flag, fuel}
    this.bestMs = null; this.bestLap = null;
    this.bestS = [null, null, null];
    this.live = {};           // overlay from a live feed
    this.driveMs = {};        // driver -> ms
  }
  Car.prototype.lap = function (k) { return this.laps[k] || null; };
  Car.prototype.lastRec = function () { return this.laps[this.lastLap] || null; };
  Car.prototype.driverName = function (d) {
    if (typeof d === 'number') return this.drivers[d] || ('Driver ' + (d + 1));
    return d || '';
  };

  function Engine(settings) {
    RS.Emitter.call(this);
    this.settings = Object.assign({}, RS.DEFAULTS, settings || {});
    this.reset({ name: 'No session', durationMs: null }, []);
  }
  Engine.prototype = Object.create(RS.Emitter.prototype);

  Engine.prototype.reset = function (meta, cars) {
    this.meta = Object.assign({ kind: 'race', refLapMs: {}, pitLaneMs: {}, transitDeltaMs: {} }, meta || {});
    this.cars = {};
    this.order = [];
    this.now = 0; this.remaining = null; this.clockTod = null;
    this.feedFlag = null; this.flag = 'GF'; this.flagSrc = 'none';
    this.inferred = false; this.flagLog = [];
    this.events = []; this.newEvents = [];
    this.recent = [];          // lap completions for caution inference [t, ratio, n]
    this.classBest = {};       // cls -> {ms, n, lap}
    this.livePositions = false;
    this.prevHeroCpos = null; this.alertState = {};
    this.learnedLoss = {};     // n -> [ms]
    this.version = 0;
    var self = this;
    (cars || []).forEach(function (c) { self.addCar(c); });
  };

  Engine.prototype.addCar = function (info) {
    var n = String(info.n);
    var c = this.cars[n];
    if (!c) { c = this.cars[n] = new Car(info); this.order.push(n); }
    else {
      if (info.cls) c.cls = info.cls; if (info.team) c.team = info.team; if (info.mfr) c.mfr = info.mfr;
      if (info.drivers && info.drivers.length) c.drivers = info.drivers.slice();
    }
    return c;
  };

  Engine.prototype.classRef = function (cls) {
    var r = this.meta.refLapMs && this.meta.refLapMs[cls];
    if (r) return r;
    // fall back to median of best laps in class
    var b = [];
    for (var n in this.cars) { var c = this.cars[n]; if (c.cls === cls && c.bestMs) b.push(c.bestMs); }
    return b.length ? RS.median(b) * 1.02 : null;
  };

  // rec: {lap, elapsedMs, lapMs, s:[], inPit, pitMs, drv, flag, topKph}
  Engine.prototype.addLap = function (n, rec, quiet) {
    var c = this.cars[String(n)] || this.addCar({ n: n });
    var k = rec.lap | 0; if (k <= 0) return;
    var prev = c.laps[k - 1] || null;
    var existed = !!c.laps[k];
    var r = {
      lap: k, t: rec.elapsedMs, ms: rec.lapMs, s: rec.s || [null, null, null],
      inPit: rec.inPit ? 1 : 0, pitMs: rec.pitMs || 0, drv: rec.drv === undefined ? null : rec.drv,
      flag: rec.flag || null, kph: rec.topKph || null, slow: false
    };
    if (r.t === null || r.t === undefined) {
      r.t = prev && prev.t !== null && r.ms ? prev.t + r.ms : this.now;
    }
    c.laps[k] = r;
    if (k > c.lastLap) c.lastLap = k;
    this.version++;

    // classify the lap against the class reference (caution / slow lap)
    var ref = this.classRef(c.cls);
    var ratio = ref && r.ms ? r.ms / ref : null;
    var pitLap = r.inPit || r.pitMs > 0;
    if (ratio && !pitLap && k > 1) {
      r.slow = ratio > 1.2;
      this.recent.push([r.t, ratio, c.n]);
      if (this.recent.length > 4000) this.recent.splice(0, 2000);
    }
    if (r.flag && r.flag !== 'GF') r.slow = true;

    // best laps (clean laps only)
    if (r.ms && !pitLap && !r.slow && k > 1) {
      if (!c.bestMs || r.ms < c.bestMs) {
        var hadBest = c.bestMs; c.bestMs = r.ms; c.bestLap = k;
        var cb = this.classBest[c.cls];
        if (!cb || r.ms < cb.ms) {
          this.classBest[c.cls] = { ms: r.ms, n: c.n, lap: k };
          if (!quiet && cb) this.event('best', c.n, 'Class best ' + c.cls + ': #' + c.n + ' ' + RS.fmtLap(r.ms) + ' (lap ' + k + ')', 'good', r.t);
        } else if (!quiet && hadBest && this.isTeam(c.n)) {
          this.event('pb', c.n, '#' + c.n + ' personal best ' + RS.fmtLap(r.ms), 'good', r.t);
        }
      }
      for (var i = 0; i < 3; i++) if (r.s[i] && (!c.bestS[i] || r.s[i] < c.bestS[i])) c.bestS[i] = r.s[i];
    }

    // driving time
    var dn = c.driverName(r.drv);
    if (dn && r.ms && !existed) c.driveMs[dn] = (c.driveMs[dn] || 0) + r.ms;

    // pit stops: the lap that carries pit-lane time is the out-lap; the lap before is the in-lap
    if (r.pitMs > 0 && k > 1 && !existed) {
      var inRec = prev;
      var stop = {
        inLap: k - 1, outLap: k, laneMs: r.pitMs, tIn: inRec ? inRec.t : null,
        drvOut: inRec ? c.driverName(inRec.drv) : '', drvIn: dn,
        flag: this.flag, fuel: r.pitMs >= this.settings.refuelMinLaneS * 1000
      };
      c.stops.push(stop);
      if (this.settings.learnPitLoss && inRec && inRec.ms && r.ms && ref && this.flag === 'GF') {
        var loss = inRec.ms + r.ms - 2 * (c.paceMs || ref);
        if (loss > 10000 && loss < 600000) (this.learnedLoss[c.n] = this.learnedLoss[c.n] || []).push(loss);
      }
      if (!quiet) {
        var chg = stop.drvOut && stop.drvIn && stop.drvOut !== stop.drvIn ? ' · driver ' + stop.drvOut + ' → ' + stop.drvIn : '';
        this.event('pit-out', c.n, '#' + c.n + ' rejoins — pit lane ' + RS.fmtLap(r.pitMs) + chg, this.isTeam(c.n) ? 'info' : 'muted', r.t);
      }
    }
    if (r.inPit && !existed && !quiet) {
      this.event('pit-in', c.n, '#' + c.n + ' in the pits (end of lap ' + k + ')' + (this.flag !== 'GF' ? ' under ' + this.flag : ''), this.isTeam(c.n) ? 'warn' : 'muted', r.t);
    }
    if (r.flag && r.flag !== this.feedFlag) this.setFlag(r.flag, 'timing', r.t, quiet);
    if (r.t > this.now) this.now = r.t;
  };

  // the official pit-lane time arrived after a measured one was used: correct that stop instead of adding another
  Engine.prototype.correctStop = function (n, outLap, laneMs) {
    var c = this.cars[String(n)]; if (!c || !laneMs) return false;
    var r = c.laps[outLap]; if (r) r.pitMs = laneMs;
    for (var i = c.stops.length - 1; i >= 0; i--) {
      var s = c.stops[i];
      if (s.outLap === outLap) { s.laneMs = laneMs; s.fuel = laneMs >= this.settings.refuelMinLaneS * 1000; this.version++; return true; }
    }
    return false;
  };

  Engine.prototype.setLive = function (n, o) {
    var c = this.cars[String(n)] || this.addCar({ n: n, cls: o.cls, team: o.team, mfr: o.mfr });
    if (o.cls && !c.cls) c.cls = o.cls; if (o.team && !c.team) c.team = o.team; if (o.mfr && !c.mfr) c.mfr = o.mfr;
    if (o.drivers && o.drivers.length) c.drivers = o.drivers;
    var was = c.live.inPit;
    c.live = Object.assign({}, c.live, o);
    if (o.pos) this.livePositions = true;
    if (o.inPit && !was && this.isTeam(c.n)) this.event('pit-in', c.n, '#' + c.n + ' entering pit lane', 'warn', this.now);
  };

  Engine.prototype.setClock = function (nowMs, remainingMs, todMs) {
    if (nowMs !== null && nowMs !== undefined && isFinite(nowMs)) this.now = nowMs;
    if (remainingMs !== undefined) this.remaining = remainingMs;
    if (todMs !== undefined) this.clockTod = todMs;
  };

  Engine.prototype.setFlag = function (code, src, t, quiet) {
    code = RS.normFlag(code) || code;
    if (!code) return;
    this.feedFlag = code;
    if (code !== this.flag) {
      this.flag = code; this.flagSrc = src || 'feed';
      this.flagLog.push({ t: t === undefined ? this.now : t, flag: code, src: this.flagSrc });
      if (!quiet) this.event('flag', null, (RS.FLAG_LABEL[code] || code), code === 'GF' ? 'good' : code === 'RF' ? 'crit' : 'warn', t);
    }
  };

  Engine.prototype.isTeam = function (n) {
    n = String(n); var s = this.settings;
    return n === String(s.hero) || (s.sisters || []).map(String).indexOf(n) >= 0;
  };

  Engine.prototype.event = function (type, n, text, level, t) {
    var e = { id: this.events.length + 1, type: type, n: n, text: text, level: level || 'info', t: t === undefined ? this.now : t };
    e.tod = this.meta.startClockMs !== undefined && this.meta.startClockMs !== null && e.t !== null ? this.meta.startClockMs + e.t : null;
    this.events.push(e); this.newEvents.push(e);
    if (this.events.length > 3000) this.events.splice(0, 1000);
    return e;
  };

  /* ---------- derived per-car metrics ---------- */
  Engine.prototype._pace = function (c) {
    var N = this.settings.paceLaps || 5, out = [], all = [];
    for (var k = c.lastLap; k >= 2 && all.length < 14; k--) {
      var r = c.laps[k]; if (!r || !r.ms || r.inPit || r.pitMs || r.slow) continue;
      all.push(r.ms);
    }
    if (!all.length) return null;
    var med = RS.median(all);
    for (var i = 0; i < all.length && out.length < N; i++) if (all[i] <= med * 1.04) out.push(all[i]);
    return out.length ? RS.mean(out) : med;
  };

  Engine.prototype._stint = function (c) {
    var last = c.stops.length ? c.stops[c.stops.length - 1] : null;
    var startLap = last ? last.outLap : 1;
    var startT = last ? last.tIn : 0;
    var inPitNow = (c.live.inPit !== undefined ? !!c.live.inPit : false);
    var lr = c.lastRec();
    if (c.live.inPit === undefined && lr && lr.inPit) {           // crossed the line in the pit lane and not out yet
      var lane = this.meta.pitLaneMs && this.meta.pitLaneMs[c.cls];
      var hold = Math.min(150000, 0.6 * ((lane && lane.p50) || 90000));
      if (this.now - lr.t < hold) inPitNow = true;
    }
    var laps = c.lastLap ? c.lastLap - startLap + 1 : 0;
    if (laps < 0) laps = 0;
    var fuelStop = null;
    for (var i = c.stops.length - 1; i >= 0; i--) if (c.stops[i].fuel) { fuelStop = c.stops[i]; break; }
    // first lap we have timing for: a screen that joined mid-race has not seen the earlier laps or stops,
    // so the fuel in the car is unknown until its next refuel (or the official results fill in the gap)
    var fs = c._firstSeen;
    if (!fs || !c.laps[fs] || (fs > 1 && c.laps[fs - 1])) { fs = 0; for (var k = 1; k <= (c.lastLap || 0); k++) if (c.laps[k]) { fs = k; break; } c._firstSeen = fs; }
    var fuelUnknown = !fuelStop && fs > 3;
    return { startLap: startLap, startT: startT, laps: laps, ms: startT !== null ? this.now - startT : null, inPit: inPitNow, fuelFromLap: fuelStop ? fuelStop.outLap : 1, fuelUnknown: fuelUnknown, firstSeenLap: fs };
  };

  Engine.prototype.elapsedAt = function (c, k) { var r = c.laps[k]; return r ? r.t : null; };

  // gap of car a to car b at the line: {ms, laps}
  Engine.prototype.gapAtLine = function (a, b) {
    if (!a.lastLap || !b.lastLap) return null;
    var L = a.lastLap;
    var ta = this.elapsedAt(a, L), tb = this.elapsedAt(b, L);
    if (ta === null || tb === null) {
      if (b.lastLap > a.lastLap) return { ms: null, laps: b.lastLap - a.lastLap };
      return null;
    }
    var down = 0;
    for (var k = L + 1; k <= b.lastLap; k++) { var t = this.elapsedAt(b, k); if (t !== null && t <= ta) down++; else break; }
    return { ms: ta - tb, laps: down };
  };

  // race-time gap of x relative to hero at their most recent common lap (positive = x behind hero)
  Engine.prototype.relGap = function (x, h) {
    var m = Math.min(x.lastLap, h.lastLap);
    while (m > 0 && (!x.laps[m] || !h.laps[m])) m--;
    if (m <= 0) return null;
    return x.laps[m].t - h.laps[m].t;
  };

  Engine.prototype.pitLossMs = function (n) {
    var c = this.cars[String(n)]; if (!c) return null;
    var s = this.settings;
    if (s.pitPreset === 'manual' && s.pitManualS) return s.pitManualS * 1000;
    var lane = this.meta.pitLaneMs && this.meta.pitLaneMs[c.cls];
    var delta = (this.meta.transitDeltaMs && this.meta.transitDeltaMs[c.cls]) || 0;
    var base = lane ? (lane[s.pitPreset] || lane.p50) + delta : null;
    var learned = this.learnedLoss[c.n];
    if (s.pitPreset === 'learned' && learned && learned.length) return RS.median(learned);
    if (base) return base;
    if (learned && learned.length) return RS.median(learned);
    // fallback: median observed pit lane time in class
    var all = [];
    for (var k in this.cars) if (this.cars[k].cls === c.cls) this.cars[k].stops.forEach(function (st) { all.push(st.laneMs); });
    return all.length ? RS.median(all) : 90000;
  };

  /* ---------- caution inference ---------- */
  Engine.prototype._inferCaution = function () {
    if (!this.settings.cautionDetect) return false;
    var W = 100000, t0 = this.now - W, n = 0, slow = 0, seen = {};
    for (var i = this.recent.length - 1; i >= 0; i--) {
      var e = this.recent[i]; if (e[0] < t0) break; if (e[0] > this.now) continue;
      if (seen[e[2]]) continue; seen[e[2]] = 1; n++; if (e[1] > 1.25) slow++;
    }
    var running = 0; for (var k in this.cars) if (this.cars[k].lastLap) running++;
    var need = Math.max(4, Math.round(running * 0.25));
    if (n < need) return this.inferred && n > 0 ? slow / n > 0.35 : false;
    var frac = slow / n;
    return this.inferred ? frac > 0.35 : frac >= 0.65;
  };

  /* ---------- main computation ---------- */
  Engine.prototype.compute = function () {
    var s = this.settings, self = this;
    var hero = this.cars[String(s.hero)] || null;
    var sisters = (s.sisters || []).map(String);
    var follows = (s.follows || []).map(String);

    // flags: feed flag wins; otherwise infer cautions from lap times
    var inf = this._inferCaution();
    if (inf !== this.inferred) {
      this.inferred = inf;
      if (!this.feedFlag || this.feedFlag === 'GF') {
        this.event('flag', null, inf ? 'Caution suspected — field lapping slow (inferred)' : 'Field back to green pace (inferred)', inf ? 'warn' : 'good');
      }
    }
    var flag = this.feedFlag && this.feedFlag !== 'GF' ? this.feedFlag : (inf ? 'FCY' : (this.feedFlag || 'GF'));
    var flagSrc = this.feedFlag && this.feedFlag !== 'GF' ? 'feed' : (inf ? 'inferred' : (this.feedFlag ? 'feed' : 'none'));

    // standings
    var list = this.order.map(function (n) { return self.cars[n]; });
    list.forEach(function (c) { c.paceMs = self._pace(c); c.stint = self._stint(c); });
    var useLive = this.livePositions, practice = this.meta.kind === 'practice';
    list.sort(function (a, b) {
      if (useLive) {
        var pa = a.live.pos || 9999, pb = b.live.pos || 9999; if (pa !== pb) return pa - pb;
      }
      if (practice) { var ba = a.bestMs || Infinity, bb = b.bestMs || Infinity; if (ba !== bb) return ba - bb; }
      if (b.lastLap !== a.lastLap) return b.lastLap - a.lastLap;
      var ta = a.lastLap ? a.laps[a.lastLap].t : Infinity, tb = b.lastLap ? b.laps[b.lastLap].t : Infinity;
      if (ta !== tb) return ta - tb;
      return (parseInt(a.n, 10) || 0) - (parseInt(b.n, 10) || 0);
    });
    var clsPos = {}, clsLeader = {}, prevInCls = {}, prevAll = null;
    var rows = list.map(function (c, i) {
      var cp = clsPos[c.cls] = (clsPos[c.cls] || 0) + 1;
      if (!clsLeader[c.cls]) clsLeader[c.cls] = c;
      var lr = c.lastRec();
      var row = {
        n: c.n, cls: c.cls, team: c.team, mfr: c.mfr,
        pos: useLive && c.live.pos ? c.live.pos : i + 1,
        cpos: useLive && c.live.cpos ? c.live.cpos : cp,
        laps: c.live.laps !== undefined && c.live.laps > c.lastLap ? c.live.laps : c.lastLap,
        driver: c.live.driver || (lr ? c.driverName(lr.drv) : ''),
        lastMs: c.live.lastMs || (lr ? lr.ms : null), bestMs: c.bestMs || c.live.bestMs || null,
        lastS: lr ? lr.s : [null, null, null], bestS: c.bestS,
        paceMs: c.paceMs, stintLaps: c.stint.laps, stintMs: c.stint.ms,
        pits: Math.max(c.stops.length, c.live.pits || 0),
        lastLaneMs: c.stops.length ? c.stops[c.stops.length - 1].laneMs : null,
        lastPitLap: c.stops.length ? c.stops[c.stops.length - 1].inLap : null,
        inPit: !!(c.live.inPit || c.stint.inPit),
        isHero: hero && c.n === hero.n, isSister: sisters.indexOf(c.n) >= 0, isFollow: follows.indexOf(c.n) >= 0,
        kph: lr ? lr.kph : null, lastSlow: lr ? lr.slow : false
      };
      // gaps at the line
      var L = clsLeader[c.cls];
      if (useLive && (c.live.gapText !== undefined || c.live.gapMs !== undefined)) {
        row.gapCls = c.live.gapClsText || null;
      }
      if (practice) {
        var A0 = prevInCls[c.cls];
        row.leader = L === c;
        row.gapClsMs = L !== c && c.bestMs && L.bestMs ? c.bestMs - L.bestMs : (L === c ? 0 : null); row.gapClsLaps = 0;
        row.intClsMs = A0 && c.bestMs && A0.bestMs ? c.bestMs - A0.bestMs : null; row.intClsLaps = 0; row.aheadCls = A0 ? A0.n : null;
      } else if (L !== c) {
        var g = self.gapAtLine(c, L);
        row.gapClsMs = g ? g.ms : null; row.gapClsLaps = g ? g.laps : null;
        var A = prevInCls[c.cls];
        var gi = A ? self.gapAtLine(c, A) : null;
        row.intClsMs = gi ? gi.ms : null; row.intClsLaps = gi ? gi.laps : null; row.aheadCls = A ? A.n : null;
      } else { row.gapClsMs = 0; row.gapClsLaps = 0; row.leader = true; }
      if (prevAll) { var ga = self.gapAtLine(c, prevAll); row.intMs = ga ? ga.ms : null; row.intLaps = ga ? ga.laps : null; }
      if (i > 0) { var g0 = self.gapAtLine(c, list[0]); row.gapMs = g0 ? g0.ms : null; row.gapLaps = g0 ? g0.laps : null; }
      if (c.live.gapText !== undefined) row.gapText = c.live.gapText;
      if (c.live.intText !== undefined) row.intText = c.live.intText;
      prevInCls[c.cls] = c; prevAll = c;
      // relation to hero
      if (hero && c !== hero) {
        row.relGapMs = self.relGap(c, hero);
        if (c.paceMs && hero.paceMs) {
          row.closeMs = hero.paceMs - c.paceMs; // >0: this car is faster than the hero (per lap)
          if (row.relGapMs !== null) {
            // laps until this car catches the hero (behind & faster) or the hero catches it (ahead & slower)
            var gap = Math.abs(row.relGapMs), rate = row.relGapMs > 0 ? row.closeMs : -row.closeMs;
            row.lapsToCatch = rate > 50 ? gap / rate : null;
          }
        }
      }
      return row;
    });
    var byN = {}; rows.forEach(function (r) { byN[r.n] = r; });

    var heroView = hero ? this._teamCar(hero, byN[hero.n], rows, flag) : null;
    var sisterViews = sisters.filter(function (n) { return self.cars[n] && (!hero || n !== hero.n); })
      .map(function (n) { return self._teamCar(self.cars[n], byN[n], rows, flag); });

    // alerts
    var alerts = [];
    [heroView].concat(sisterViews).forEach(function (v) {
      if (!v) return;
      var w = v.window;
      if (w && w.status === 'open') alerts.push({ key: 'win-' + v.n, level: 'warn', text: '#' + v.n + ' pit window OPEN (laps ' + w.open + '–' + w.close + ')' });
      if (w && w.status === 'critical') alerts.push({ key: 'fuel-' + v.n, level: 'crit', text: '#' + v.n + ' FUEL CRITICAL — ' + RS.fmtNum(w.lapsLeft, 1) + ' laps left' });
      if ((flag === 'FCY' || flag === 'SC') && w && w.stopsNeeded > 0 && w.open !== null && w.open - v.laps <= 6 && !v.inPit)
        alerts.push({ key: 'fcy-' + v.n, level: 'crit', text: '#' + v.n + ' CAUTION PIT OPPORTUNITY — pit loss ≈ ' + RS.fmtNum(v.predictor.lossFcyMs / 1000, 0) + ' s under ' + flag });
      if (s.maxStintMin && v.stintMs > 0.9 * s.maxStintMin * 60000) alerts.push({ key: 'stint-' + v.n, level: 'warn', text: '#' + v.n + ' stint ' + RS.fmtClock(v.stintMs) + ' — near the ' + s.maxStintMin + ' min limit' });
      (v.threats || []).forEach(function (t) { alerts.push({ key: 'thr-' + v.n + '-' + t.n, level: 'info', text: t.text }); });
    });
    alerts.forEach(function (a) { if (!self.alertState[a.key]) self.event('alert', null, a.text, a.level); });
    var st = {}; alerts.forEach(function (a) { st[a.key] = 1; }); this.alertState = st;

    // hero class position changes
    if (heroView) {
      if (this.prevHeroCpos !== null && heroView.cpos !== this.prevHeroCpos && heroView.laps > 1) {
        var gained = heroView.cpos < this.prevHeroCpos;
        this.event('pos', hero.n, '#' + hero.n + (gained ? ' gains' : ' loses') + ' class position: P' + this.prevHeroCpos + ' → P' + heroView.cpos, gained ? 'good' : 'warn');
      }
      this.prevHeroCpos = heroView.cpos;
    }

    var classes = {}; rows.forEach(function (r) { classes[r.cls] = (classes[r.cls] || 0) + 1; });
    var ev = this.newEvents; this.newEvents = [];
    var remaining = this.remaining !== null && this.remaining !== undefined ? this.remaining
      : (this.meta.durationMs ? Math.max(0, this.meta.durationMs - this.now) : null);
    return {
      session: { name: this.meta.name, track: this.meta.track, series: this.meta.series, now: this.now, remaining: remaining,
        duration: this.meta.durationMs, flag: flag, flagSrc: flagSrc,
        tod: this.clockTod !== null ? this.clockTod : (this.meta.startClockMs !== undefined && this.meta.startClockMs !== null ? this.meta.startClockMs + this.now : null) },
      rows: rows, byN: byN, classes: classes, hero: heroView, sisters: sisterViews, alerts: alerts, newEvents: ev, version: this.version
    };
  };

  /* team car analysis: stint, fuel, window, pit predictor, threats */
  Engine.prototype._teamCar = function (c, row, rows, flag) {
    var s = this.settings, self = this;
    var f = (s.fuel && s.fuel[c.n]) || { tank: 18, burn: 0.6, reserve: 0.5 };
    var pace = c.paceMs || this.classRef(c.cls) || 120000;
    // fuel since the last refuel
    var used = 0, from = c.stint.fuelFromLap;
    for (var k = from; k <= c.lastLap; k++) {
      var r = c.laps[k]; if (!r) { used += f.burn; continue; }
      used += f.burn * (r.slow ? s.yellowBurn : 1);
    }
    if (c.stint.fuelUnknown) used = null;
    var fuelLeft = used === null ? null : Math.max(0, f.tank - used);
    var lapsLeft = f.burn > 0 && fuelLeft !== null ? Math.max(0, (fuelLeft - f.reserve) / f.burn) : null;
    var maxStint = f.burn > 0 ? Math.floor((f.tank - f.reserve) / f.burn) : null;
    if (s.maxStintMin && pace) maxStint = Math.min(maxStint || 1e9, Math.floor(s.maxStintMin * 60000 / pace));
    var remaining = this.remaining !== null && this.remaining !== undefined ? this.remaining : (this.meta.durationMs ? Math.max(0, this.meta.durationMs - this.now) : null);
    var lapsToGo = remaining !== null ? Math.ceil(remaining / pace) : null;
    var win = null;
    if (used === null && lapsToGo !== null && maxStint) win = { status: 'unknown', lapsToGo: lapsToGo, lapsLeft: null, fuelLeft: null, maxStint: maxStint, stopsNeeded: null, now: c.lastLap, open: null, close: null, firstSeenLap: c.stint.firstSeenLap };
    else if (lapsToGo !== null && lapsLeft !== null && maxStint) {
      var stopsNeeded = Math.max(0, Math.ceil((lapsToGo - Math.floor(lapsLeft)) / maxStint));
      var cur = c.lastLap;
      win = { lapsToGo: lapsToGo, lapsLeft: lapsLeft, fuelLeft: fuelLeft, maxStint: maxStint, stopsNeeded: stopsNeeded, now: cur };
      if (stopsNeeded === 0) {
        win.status = 'finish'; win.open = null; win.close = null; win.margin = lapsLeft - lapsToGo;
      } else {
        win.open = cur + Math.max(0, lapsToGo - stopsNeeded * maxStint);
        win.close = cur + Math.floor(lapsLeft);
        win.status = lapsLeft < 1.5 ? 'critical' : (win.open <= cur ? 'open' : 'closed');
        if (stopsNeeded === 1) win.fuelToFinishAtClose = Math.min(f.tank, Math.max(0, (lapsToGo - Math.floor(lapsLeft)) * f.burn + f.reserve));
      }
    }
    // pit predictor
    var loss = this.pitLossMs(c.n);
    var lossFcy = loss * (s.fcyLossFactor || 0.5);
    var scen = [0, 1, 2].map(function (laps) {
      return self._rejoin(c, rows, loss, laps, 'Box ' + (laps === 0 ? 'this lap' : laps === 1 ? 'next lap' : 'in ' + laps + ' laps'));
    });
    scen.push(this._rejoin(c, rows, lossFcy, 0, 'Box now under caution'));
    // threats: class cars within reach
    var threats = [];
    rows.forEach(function (r) {
      if (r.n === c.n || r.cls !== c.cls || r.lapsToCatch === undefined || r.lapsToCatch === null) return;
      if (c.n !== String(s.hero)) return;
      if (r.relGapMs > 0 && r.lapsToCatch < 12 && Math.abs(r.relGapMs) < 30000)
        threats.push({ n: r.n, text: '#' + r.n + ' closing on #' + c.n + ' at ' + RS.fmtNum(r.closeMs / 1000, 2) + ' s/lap — catches in ~' + Math.ceil(r.lapsToCatch) + ' laps' });
    });
    var drivers = Object.keys(c.driveMs).map(function (d) {
      var ms = c.driveMs[d]; return { name: d, ms: ms, minLeftMs: s.minDriveMin ? Math.max(0, s.minDriveMin * 60000 - ms) : null };
    });
    return {
      n: c.n, cls: c.cls, team: c.team, pos: row.pos, cpos: row.cpos, laps: c.lastLap, driver: row.driver,
      lastMs: row.lastMs, bestMs: c.bestMs, paceMs: c.paceMs, inPit: row.inPit,
      stintLaps: c.stint.laps, stintMs: c.stint.ms, stops: c.stops.slice(), fuel: { tank: f.tank, burn: f.burn, reserve: f.reserve, used: used },
      window: win, predictor: { lossMs: loss, lossFcyMs: lossFcy, scenarios: scen }, threats: threats.slice(0, 3), drivers: drivers,
      gapAheadCls: row.intClsMs, gapAheadClsLaps: row.intClsLaps, aheadCls: row.aheadCls,
      behindCls: (function () { var b = rows.filter(function (x) { return x.cls === c.cls && x.aheadCls === c.n; })[0]; return b ? { n: b.n, ms: b.intClsMs, laps: b.intClsLaps } : null; })()
    };
  };

  // where does car c rejoin if it pits (after `inLaps` laps) losing lossMs?
  Engine.prototype._rejoin = function (c, rows, lossMs, inLaps, label) {
    var self = this, passed = [], passedCls = [], ahead = null, behind = null, aheadCls = null, behindCls = null;
    var heroPace = c.paceMs || this.classRef(c.cls) || 120000;
    var base = rows.filter(function (r) { return r.n === c.n; })[0];
    var pos = base ? base.pos : null, cpos = base ? base.cpos : null;
    rows.forEach(function (r) {
      if (r.n === c.n || r.relGapMs === null || r.relGapMs === undefined) return;
      var x = self.cars[r.n];
      var rate = x.paceMs ? heroPace - x.paceMs : 0;            // >0 -> x gains on c each lap
      var g = r.relGapMs - inLaps * rate;                        // projected gap at the moment of the stop
      if (x.stint && (x.live.inPit || x.stint.inPit)) return;     // ignore cars in the pits right now
      var after = g - lossMs;                                     // after the stop (negative = x now ahead)
      if (g > 0 && after < 0) { passed.push(r.n); if (r.cls === c.cls) passedCls.push(r.n); }
      if (after < 0 && (!ahead || after > ahead.ms)) ahead = { n: r.n, ms: after };
      if (after >= 0 && (!behind || after < behind.ms)) behind = { n: r.n, ms: after };
      if (r.cls === c.cls) {
        if (after < 0 && (!aheadCls || after > aheadCls.ms)) aheadCls = { n: r.n, ms: after };
        if (after >= 0 && (!behindCls || after < behindCls.ms)) behindCls = { n: r.n, ms: after };
      }
    });
    return {
      label: label, lossMs: lossMs, inLaps: inLaps, pos: pos !== null ? pos + passed.length : null, cpos: cpos !== null ? cpos + passedCls.length : null,
      lostAll: passed.length, lostCls: passedCls.length, passedBy: passedCls,
      ahead: ahead ? { n: ahead.n, ms: -ahead.ms } : null, behind: behind,
      aheadCls: aheadCls ? { n: aheadCls.n, ms: -aheadCls.ms } : null, behindCls: behindCls
    };
  };

  /* chart series helpers */
  Engine.prototype.series = function (n, kind, refN) {
    var c = this.cars[String(n)]; if (!c) return [];
    var out = [];
    if (kind === 'lap') {
      for (var k = 1; k <= c.lastLap; k++) { var r = c.laps[k]; if (r && r.ms) out.push({ x: k, y: r.ms, pit: r.inPit || r.pitMs > 0, slow: r.slow, t: r.t }); }
    } else if (kind === 'gapHero' || kind === 'gapLeader') {
      var ref = refN ? this.cars[String(refN)] : null;
      for (var j = 1; j <= c.lastLap; j++) {
        var a = c.laps[j]; if (!a) continue;
        var tb = null;
        if (kind === 'gapHero' && ref) { var b = ref.laps[j]; tb = b ? b.t : null; }
        else tb = this.classMinAt(c.cls, j);
        if (tb !== null) out.push({ x: j, y: a.t - tb, pit: a.inPit || a.pitMs > 0, t: a.t });
      }
    }
    return out;
  };
  Engine.prototype.classMinAt = function (cls, k) {
    var m = null;
    for (var n in this.cars) { var c = this.cars[n]; if (c.cls !== cls) continue; var r = c.laps[k]; if (r && (m === null || r.t < m)) m = r.t; }
    return m;
  };

  RS.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
