/* Zenith Strategy — Al Kamel live timing (LT2) connectors
   - Mirror:       keeps a copy of Meteor/DDP collections (from the bridge or a direct connection)
   - DDPClient:    direct WebSocket connection to the LT2 server
   - LT2Adapter:   turns whatever collections LT2 publishes into a normalised snapshot (heuristic + overrides)
   - DomAdapter:   turns a scraped timing table (bridge fallback) into the same snapshot
   - LiveSession:  pushes snapshots into the engine and builds lap history as laps tick over */
(function (G) {
  'use strict';
  var RS = G.RS;

  /* ---------------- EJSON-lite ---------------- */
  function ejson(v) {
    if (v && typeof v === 'object') {
      if (v.$date !== undefined) return typeof v.$date === 'number' ? v.$date : Date.parse(v.$date);
      if (Array.isArray(v)) return v.map(ejson);
      var o = {}; for (var k in v) o[k] = ejson(v[k]); return o;
    }
    return v;
  }

  /* ---------------- collection mirror ---------------- */
  function Mirror() {
    RS.Emitter.call(this); this.cols = {}; this.subs = []; this.count = 0; this.lastMsgAt = null;
    this.ver = {}; this.gen = 0; this.seq = 0; this.dv = typeof WeakMap !== 'undefined' ? new WeakMap() : null;   // change counters (let readers cache)
  }
  Mirror.prototype = Object.create(RS.Emitter.prototype);
  Mirror.prototype.clear = function () { this.cols = {}; this.count = 0; this.ver = {}; this.gen++; };
  Mirror.prototype.load = function (cols) {
    this.cols = {}; this.ver = {}; this.gen++;
    for (var name in cols) {
      var c = this.cols[name] = {};
      (cols[name] || []).forEach(function (d) { var id = d._id && d._id.$type ? JSON.stringify(d._id) : String(d._id); c[id] = ejson(d); });
    }
    this.emit('change');
  };
  Mirror.prototype.apply = function (m) {
    if (!m || !m.msg) return false;
    var c, id = m.id && typeof m.id === 'object' ? JSON.stringify(m.id) : m.id;
    switch (m.msg) {
      case 'added': case 'addedBefore':
        c = this.cols[m.collection] = this.cols[m.collection] || {};
        c[id] = Object.assign({ _id: id }, ejson(m.fields || {}));
        if (this.dv) this.dv.set(c[id], ++this.seq);
        break;
      case 'changed':
        c = this.cols[m.collection] = this.cols[m.collection] || {};
        var d = c[id] = c[id] || { _id: id };
        var f = ejson(m.fields || {});
        for (var k in f) setPath(d, k, f[k]);
        (m.cleared || []).forEach(function (k) { delPath(d, k); });
        if (this.dv) this.dv.set(d, ++this.seq);
        break;
      case 'removed':
        c = this.cols[m.collection]; if (c) delete c[id];
        break;
      default: return false;
    }
    this.ver[m.collection] = (this.ver[m.collection] || 0) + 1;
    this.count++; this.lastMsgAt = Date.now();
    return true;
  };
  function setPath(o, path, v) { // DDP sends top-level fields, but some servers use dotted paths
    if (path.indexOf('.') < 0) { o[path] = v; return; }
    var p = path.split('.'); for (var i = 0; i < p.length - 1; i++) { if (typeof o[p[i]] !== 'object' || o[p[i]] === null) o[p[i]] = {}; o = o[p[i]]; }
    o[p[p.length - 1]] = v;
  }
  function delPath(o, path) { var p = path.split('.'); for (var i = 0; i < p.length - 1; i++) { o = o[p[i]]; if (!o) return; } delete o[p[p.length - 1]]; }
  Mirror.prototype.summary = function () {
    var out = [];
    for (var name in this.cols) {
      var docs = this.cols[name], ids = Object.keys(docs), keys = {};
      ids.slice(0, 50).forEach(function (id) { Object.keys(docs[id]).forEach(function (k) { keys[k] = 1; }); });
      out.push({ name: name, docs: ids.length, keys: Object.keys(keys).slice(0, 40), sample: ids.length ? docs[ids[0]] : null });
    }
    return out.sort(function (a, b) { return b.docs - a.docs; });
  };
  RS.Mirror = Mirror;

  /* ---------------- direct DDP client (raw WebSocket or SockJS framing) ---------------- */
  function DDPClient(url, mirror, opts) {
    RS.Emitter.call(this);
    opts = opts || {};
    this.url = url; this.mirror = mirror || new Mirror(); this.subs = {}; this.nextId = 1;
    this.sockjs = !!opts.sockjs; this.recorder = opts.recorder || null;
    this.ws = null; this.closed = true; this.retry = 0; this.state = 'idle'; this.lastClose = null;
  }
  DDPClient.prototype = Object.create(RS.Emitter.prototype);
  DDPClient.prototype.connect = function () {
    var self = this; this.closed = false; this._setState('connecting');
    var ws, url = typeof this.url === 'function' ? this.url() : this.url;
    try { ws = this.ws = new G.WebSocket(url); } catch (e) { this._setState('error', e.message); this._reconnect(); return; }
    ws.onopen = function () { if (!self.sockjs) self._connectMsg(); };
    ws.onmessage = function (ev) { self._onRaw(ev.data); };
    ws.onerror = function () { self._setState('error', 'connection refused or dropped (the server may refuse this website — try the bridge or the proxy relay)'); };
    ws.onclose = function (ev) { self.lastClose = ev ? (ev.code + (ev.reason ? ' ' + ev.reason : '')) : null; if (!self.closed) { self._setState('reconnecting'); self._reconnect(); } else self._setState('idle'); };
  };
  DDPClient.prototype._connectMsg = function () { this._send({ msg: 'connect', version: '1', support: ['1', 'pre2', 'pre1'] }); };
  DDPClient.prototype._reconnect = function () {
    var self = this; if (this.closed) return;
    var wait = [1000, 2000, 5000, 10000, 15000][Math.min(this.retry++, 4)];
    setTimeout(function () { if (!self.closed) self.connect(); }, wait);
  };
  DDPClient.prototype.close = function () { this.closed = true; try { this.ws && this.ws.close(); } catch (e) { /* */ } this._setState('idle'); };
  DDPClient.prototype._setState = function (s, detail) { this.state = s; this.emit('state', s, detail); };
  DDPClient.prototype._send = function (m) {
    try { this.ws.send(this.sockjs ? JSON.stringify([JSON.stringify(m)]) : JSON.stringify(m)); } catch (e) { /* */ }
    if (this.recorder && (m.msg === 'sub' || m.msg === 'unsub' || m.msg === 'connect')) this.recorder.add('out', m);
  };
  DDPClient.prototype._onRaw = function (raw) {
    if (this.sockjs && RS.LT2) {
      var f = RS.LT2.decodeFrame(raw);
      if (f.type === 'open') { this._connectMsg(); return; }
      if (f.type === 'close') { this._setState('error', 'server closed the connection' + (f.reason ? ' (' + JSON.stringify(f.reason) + ')' : '')); return; }
      f.msgs.forEach(this._onMsg, this); return;
    }
    var m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (Array.isArray(m)) { m.forEach(this._onMsg, this); return; }
    this._onMsg(m);
  };
  DDPClient.prototype._onMsg = function (m) {
    if (!m || !m.msg) return;
    if (m.msg === 'ping') { this._send(m.id ? { msg: 'pong', id: m.id } : { msg: 'pong' }); return; }
    if (m.msg === 'pong') return;
    if (this.recorder) this.recorder.add('in', m);
    if (m.msg === 'connected') {
      this.retry = 0; this.mirror.clear();
      var ids = Object.keys(this.subs); this.state = 'connected';
      ids.forEach(function (id) { var x = this.subs[id]; if (!x) return; x.ready = false; this._send({ msg: 'sub', id: id, name: x.name, params: x.params || [] }); }, this);
      this._setState('connected');
      return;
    }
    if (m.msg === 'failed') { this._setState('error', 'Server refused DDP version ' + m.version); return; }
    if (m.msg === 'ready') { (m.subs || []).forEach(function (id) { if (this.subs[id]) this.subs[id].ready = true; }, this); this.emit('ready'); return; }
    if (m.msg === 'nosub') {
      var s = this.subs[m.id];
      if (s) { s.error = (m.error && (m.error.reason || m.error.message || m.error.error)) || 'stopped'; s.errorCode = m.error && m.error.error; delete this.subs[m.id]; }
      this.emit('nosub', s); return;
    }
    if (this.mirror.apply(m)) this.emit('data');
  };
  DDPClient.prototype.newId = function () { return 'zs' + (this.nextId++); };
  DDPClient.prototype.subscribe = function (name, params, meta, id) {
    id = id || this.newId();
    this.subs[id] = Object.assign({ id: id, name: name, params: params || [], ready: false }, meta || {});
    if (this.state === 'connected') this._send({ msg: 'sub', id: id, name: name, params: params || [] });
    return id;
  };
  DDPClient.prototype.unsubscribe = function (id) {
    if (!this.subs[id]) return;
    delete this.subs[id];
    if (this.state === 'connected') this._send({ msg: 'unsub', id: id });
  };
  RS.DDPClient = DDPClient;

  /* ---------------- field resolution ---------------- */
  var SYN = {
    num: ['number', 'carnumber', 'car_number', 'racenumber', 'startnumber', 'num', 'no', 'nr', 'participantnumber', 'carno', 'bib', 'vehiclenumber'],
    pos: ['position', 'pos', 'overallposition', 'positionoverall', 'rank', 'ranking', 'place', 'classification', 'currentposition', 'p'],
    cpos: ['classposition', 'positioninclass', 'pic', 'categoryposition', 'classpos', 'cpos', 'positionclass', 'classrank', 'cp'],
    cls: ['class', 'classname', 'category', 'categoryname', 'cat', 'carclass', 'classid', 'cls', 'cl'],
    team: ['team', 'teamname', 'entrant', 'entrantname'],
    mfr: ['manufacturer', 'brand', 'make', 'vehicle', 'model', 'vehiclemodel', 'carmodel', 'chassis'],
    driver: ['currentdriver', 'driver', 'drivername', 'drivershortname', 'currentdrivername', 'pilot', 'activedriver'],
    laps: ['laps', 'lapcount', 'lapscompleted', 'completedlaps', 'totallaps', 'numberoflaps', 'lapsdone', 'lap', 'currentlap'],
    last: ['lastlaptime', 'lastlap', 'lasttime', 'last', 'laptime', 'lastlapms'],
    best: ['bestlaptime', 'bestlap', 'besttime', 'best', 'fastestlap', 'fastestlaptime', 'bestlapms'],
    gap: ['gap', 'gaptofirst', 'gapfirst', 'gaptoleader', 'gapleader', 'diff', 'difference', 'behind', 'totalgap'],
    int: ['interval', 'gapprevious', 'gaptoprevious', 'gapprev', 'int', 'intervaltoprevious', 'gapahead', 'gaptoahead', 'intervalprev'],
    inPit: ['inpit', 'ispit', 'inpitlane', 'pitlane', 'isinpit', 'pitin', 'inpits', 'pitstatus'],
    status: ['status', 'state', 'carstatus', 'trackstatus', 'runningstatus'],
    pits: ['pitstops', 'pits', 'numberofpits', 'pitstopcount', 'stops', 'pitcount', 'nbpits'],
    s1: ['s1', 'sector1', 's1time', 'lastsector1', 'sector1time', 'lasts1'],
    s2: ['s2', 'sector2', 's2time', 'lastsector2', 'sector2time', 'lasts2'],
    s3: ['s3', 'sector3', 's3time', 'lastsector3', 'sector3time', 'lasts3'],
    total: ['totaltime', 'elapsed', 'elapsedtime', 'racetime', 'total'],
    kph: ['topspeed', 'speedtrap', 'kph', 'speed', 'maxspeed']
  };
  var SESSION_KEYS = ['sessionname', 'session', 'name', 'description', 'title', 'eventname', 'sessiontype'];
  var CLOCK_KEYS = { remaining: ['remaining', 'timeremaining', 'timeleft', 'remainingtime', 'countdown', 'timetogo', 'timetoend'],
    elapsed: ['elapsed', 'elapsedtime', 'sessiontime', 'racetime', 'runningtime', 'time'],
    duration: ['duration', 'sessionduration', 'length', 'totaltime', 'plannedduration'],
    flag: ['flag', 'currentflag', 'trackstatus', 'flagstatus', 'sessionstatus', 'status', 'state', 'trackcondition'] };

  function norm(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  // flatten an object one or two levels so {lastLap:{time:..}} resolves as lastlaptime / lastlap
  function flat(o, pre, out, depth) {
    out = out || {}; pre = pre || ''; depth = depth || 0;
    for (var k in o) {
      var v = o[k], nk = norm(pre + k);
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
        flat(v, pre + k, out, depth + 1);
        if (out[norm(k)] === undefined) out[norm(k)] = v; // keep raw object too
      } else if (out[nk] === undefined) out[nk] = v;
      if (pre && out[norm(k)] === undefined && (typeof v !== 'object' || v === null)) out[norm(k)] = v; // leaf name alias
    }
    return out;
  }
  function pick(f, list, override) {
    if (override) { var ov = f[norm(override)]; if (ov !== undefined) return ov; }
    for (var i = 0; i < list.length; i++) { var v = f[list[i]]; if (v !== undefined && v !== null && v !== '') return v; }
    return undefined;
  }
  function isNum(v) { return (typeof v === 'number' && v > 0 && v < 10000 && Math.floor(v) === v) || (typeof v === 'string' && /^\s*#?\d{1,4}\s*$/.test(v)); }
  function strOf(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return v.name || v.shortName || v.fullName || v.displayName || v.label || v.text || ((v.firstName || v.firstname || '') + ' ' + (v.lastName || v.lastname || v.surname || '')).trim() || '';
    return String(v);
  }

  function LT2Adapter(mirror, overrides) {
    this.mirror = mirror; this.ov = overrides || {}; this.units = null; this.found = {};
  }
  // returns candidate "car record" groups: {path, recs:[{f, raw}]}
  LT2Adapter.prototype._groups = function () {
    var groups = {}, cols = this.mirror.cols;
    function consider(path, obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      var f = flat(obj), n = pick(f, SYN.num);
      if (!isNum(n)) return;
      var score = 0; ['pos', 'laps', 'last', 'best', 'gap', 'cls', 'driver', 'team', 'cpos', 'inPit', 'pits'].forEach(function (k) { if (pick(f, SYN[k]) !== undefined) score++; });
      if (score < 2) return;
      (groups[path] = groups[path] || []).push({ f: f, raw: obj, n: String(n).replace(/\D/g, '') });
    }
    function walk(path, v, depth) {
      if (!v || typeof v !== 'object' || depth > 3) return;
      if (Array.isArray(v)) { v.forEach(function (x) { consider(path + '[]', x); walk(path + '[]', x, depth + 1); }); return; }
      for (var k in v) {
        var x = v[k]; if (!x || typeof x !== 'object') continue;
        if (Array.isArray(x)) walk(path + '.' + k, x, depth + 1);
        else {
          // object-of-records keyed by car number / id
          var kids = Object.keys(x), objs = kids.filter(function (kk) { return x[kk] && typeof x[kk] === 'object' && !Array.isArray(x[kk]); });
          if (objs.length >= 3) objs.forEach(function (kk) { consider(path + '.' + k + '{}', x[kk]); });
          walk(path + '.' + k, x, depth + 1);
        }
      }
    }
    for (var name in cols) for (var id in cols[name]) { var d = cols[name][id]; consider(name, d); walk(name, d, 0); }
    return Object.keys(groups).map(function (p) { return { path: p, recs: groups[p] }; });
  };
  LT2Adapter.prototype.snapshot = function () {
    var ov = this.ov.fields || {};
    var groups = this._groups();
    if (!groups.length) { this.found = {}; return null; }
    var score = function (g) {
      var withPos = g.recs.filter(function (r) { return pick(r.f, SYN.pos, ov.pos) !== undefined; }).length;
      var withTimes = g.recs.filter(function (r) { return pick(r.f, SYN.last, ov.last) !== undefined || pick(r.f, SYN.laps, ov.laps) !== undefined; }).length;
      return withPos * 2 + withTimes * 2 + g.recs.length;
    };
    var std = this.ov.standingsPath ? groups.filter(function (g) { return g.path === this.ov.standingsPath; }, this)[0] : null;
    if (!std) std = groups.slice().sort(function (a, b) { return score(b) - score(a); })[0];
    var entries = groups.filter(function (g) { return g !== std; }).sort(function (a, b) { return b.recs.length - a.recs.length; })[0] || null;
    this.found = { standings: std.path, entries: entries ? entries.path : null, groups: groups.map(function (g) { return { path: g.path, n: g.recs.length, score: score(g) }; }) };

    // unit detection for numeric times
    if (!this.units) {
      var nums = std.recs.map(function (r) { return pick(r.f, SYN.last, ov.last); }).filter(function (v) { return typeof v === 'number' && v > 0; });
      if (nums.length >= 3) this.units = RS.median(nums) > 5000 ? 'ms' : 's';
    }
    var unit = this.ov.units || this.units;
    var T = function (v) {
      if (typeof v === 'number') return unit === 'ms' ? Math.round(v) : unit === 's' ? Math.round(v * 1000) : RS.toMs(v);
      return RS.toMs(v);
    };
    var ent = {};
    if (entries) entries.recs.forEach(function (r) { ent[r.n] = r.f; });
    var cars = std.recs.map(function (r) {
      var f = Object.assign({}, ent[r.n] || {}, r.f);
      var status = strOf(pick(f, SYN.status, ov.status));
      var pitV = pick(f, SYN.inPit, ov.inPit);
      var inPit = pitV === true || pitV === 1 || /^(in|pit|true|yes|p|box)$/i.test(String(pitV === undefined ? '' : pitV)) || /\bpit|box|in lane\b/i.test(status);
      var drvs = pick(f, ['drivers', 'driverlist'], ov.drivers);
      var gapV = pick(f, SYN.gap, ov.gap), intV = pick(f, SYN.int, ov.int);
      var sectors = pick(f, ['sectors', 'sectortimes', 'lastsectors'], ov.sectors);
      var s = [T(pick(f, SYN.s1, ov.s1)), T(pick(f, SYN.s2, ov.s2)), T(pick(f, SYN.s3, ov.s3))];
      if (Array.isArray(sectors)) s = sectors.slice(0, 3).map(function (x) { return T(x && typeof x === 'object' ? (x.time !== undefined ? x.time : x.value) : x); });
      var lapsV = pick(f, SYN.laps, ov.laps);
      return {
        n: r.n,
        pos: parseInt(pick(f, SYN.pos, ov.pos), 10) || null,
        cpos: parseInt(pick(f, SYN.cpos, ov.cpos), 10) || null,
        cls: strOf(pick(f, SYN.cls, ov.cls)),
        team: strOf(pick(f, SYN.team, ov.team)),
        mfr: strOf(pick(f, SYN.mfr, ov.mfr)),
        driver: strOf(pick(f, SYN.driver, ov.driver)),
        drivers: Array.isArray(drvs) ? drvs.map(strOf).filter(Boolean) : null,
        laps: lapsV === undefined ? null : parseInt(lapsV, 10),
        lastMs: T(pick(f, SYN.last, ov.last)), bestMs: T(pick(f, SYN.best, ov.best)),
        gapText: gapV === undefined ? undefined : (typeof gapV === 'number' ? RS.fmtGap(T(gapV), 3) : String(gapV)),
        intText: intV === undefined ? undefined : (typeof intV === 'number' ? RS.fmtGap(T(intV), 3) : String(intV)),
        inPit: !!inPit, status: status,
        pits: parseInt(pick(f, SYN.pits, ov.pits), 10) || null,
        s: s, totalMs: T(pick(f, SYN.total, ov.total)), kph: parseFloat(pick(f, SYN.kph, ov.kph)) || null
      };
    }).filter(function (c) { return c.n; });
    return { session: this._session(), cars: cars, source: 'lt2' };
  };
  LT2Adapter.prototype._session = function () {
    var best = null, bestScore = 0, cols = this.mirror.cols, ov = this.ov.session || {};
    for (var name in cols) for (var id in cols[name]) {
      var f = flat(cols[name][id]), sc = 0;
      if (pick(f, SESSION_KEYS) !== undefined) sc++;
      ['remaining', 'elapsed', 'duration', 'flag'].forEach(function (k) { if (pick(f, CLOCK_KEYS[k]) !== undefined) sc++; });
      if (/session|info|status|clock|race/i.test(name)) sc++;
      if (sc > bestScore) { bestScore = sc; best = f; }
    }
    if (!best || bestScore < 2) return {};
    var now = Date.now();
    var remV = pick(best, CLOCK_KEYS.remaining, ov.remaining), elV = pick(best, CLOCK_KEYS.elapsed, ov.elapsed), durV = pick(best, CLOCK_KEYS.duration, ov.duration);
    var T = function (v) { if (typeof v === 'number' && v > 1e11) return null; return RS.toMs(v); };
    var rem = T(remV), el = T(elV), dur = T(durV);
    // epoch style end time
    var endV = pick(best, ['endtime', 'finishtime', 'scheduledend', 'end'], ov.end);
    if (rem === null && typeof endV === 'number' && endV > 1e11) rem = Math.max(0, endV - now);
    var flagRaw = pick(best, CLOCK_KEYS.flag, ov.flag);
    return { name: strOf(pick(best, SESSION_KEYS, ov.name)) || null, remainingMs: rem, elapsedMs: el, durationMs: dur, flag: RS.normFlag(strOf(flagRaw)), flagRaw: strOf(flagRaw) };
  };
  RS.LT2Adapter = LT2Adapter;
  RS.LT2_SYN = SYN;

  /* ---------------- scraped-table adapter (bridge fallback) ---------------- */
  var HEAD = {
    pos: /^(pos|p|position|rank|#pos|pos\.)$/, cpos: /^(pic|cp|class pos|cl pos|pos cl|pos class|cls pos|class position)$/,
    n: /^(#|no|nr|num|number|car|car no|n°|nº|no\.)$/, cls: /^(cl|cls|class|cat|category)$/, driver: /^(driver|drivers|pilot|name)$/,
    team: /^(team|entrant)$/, laps: /^(laps|lap|l)$/, gap: /^(gap|gap 1st|gap first|behind|diff)$/, int: /^(int|interval|gap prev|gap ahead|diff prev)$/,
    last: /^(last|last lap|last time|lap time)$/, best: /^(best|best lap|best time|fastest)$/, pits: /^(pit|pits|stops|pit stops|ps)$/,
    s1: /^(s1|sector 1|sec 1)$/, s2: /^(s2|sector 2|sec 2)$/, s3: /^(s3|sector 3|sec 3)$/, mfr: /^(car|vehicle|make|manufacturer|brand)$/
  };
  RS.domSnapshot = function (d) {
    var heads = (d.headers || []).map(function (h) { return String(h).toLowerCase().replace(/\s+/g, ' ').trim(); });
    var col = {};
    Object.keys(HEAD).forEach(function (k) { for (var i = 0; i < heads.length; i++) if (col[k] === undefined && HEAD[k].test(heads[i])) { col[k] = i; break; } });
    if (col.n === undefined) {
      // guess the car-number column: mostly 1-4 digit integers distinct from the position column
      for (var i = 0; i < heads.length; i++) {
        if (i === col.pos) continue;
        var hits = (d.rows || []).filter(function (r) { return /^\s*#?\d{1,4}\s*$/.test(r[i] || ''); }).length;
        if (hits >= Math.max(3, (d.rows || []).length * 0.8)) { col.n = i; break; }
      }
    }
    if (col.n === undefined) return null;
    var cars = (d.rows || []).map(function (r, idx) {
      var g = function (k) { return col[k] === undefined ? undefined : (r[col[k]] || '').trim(); };
      var n = (g('n') || '').replace(/\D/g, ''); if (!n) return null;
      var pitTxt = (g('pits') || '') + ' ' + r.join(' ');
      return {
        n: n, pos: parseInt(g('pos'), 10) || idx + 1, cpos: parseInt(g('cpos'), 10) || null, cls: g('cls') || '', team: g('team') || '', mfr: g('mfr') || '',
        driver: g('driver') || '', laps: g('laps') ? parseInt(g('laps'), 10) : null,
        lastMs: RS.toMs(g('last')), bestMs: RS.toMs(g('best')), gapText: g('gap'), intText: g('int'),
        inPit: /\b(in pit|pit in|in lane|box)\b|^\s*pit\s*$/i.test(pitTxt) || /^(in|pit)$/i.test(g('pits') || ''),
        pits: parseInt(g('pits'), 10) || null, s: [RS.toMs(g('s1')), RS.toMs(g('s2')), RS.toMs(g('s3'))]
      };
    }).filter(Boolean);
    var m = d.meta || {}, rem = null, flag = RS.normFlag(m.flagText);
    (m.clocks || []).forEach(function (c) { var ms = RS.toMs(c.text); if (ms !== null && /remain|left|to go|countdown/i.test(c.hint || '') && rem === null) rem = ms; });
    if (rem === null && m.clocks && m.clocks.length) rem = RS.toMs(m.clocks[0].text);
    return { session: { name: m.title || null, remainingMs: rem, flag: flag, flagRaw: m.flagText || '' }, cars: cars, source: 'dom', columns: col };
  };

  /* ---------------- live session: snapshots -> engine ---------------- */
  function LiveSession(engine) {
    RS.Emitter.call(this);
    this.engine = engine; this.started = false; this.sessionName = null; this.pit = {}; this.t0 = null;
    this.clockOffset = null; this.lastSnap = null; this.durationGuess = null;
  }
  LiveSession.prototype = Object.create(RS.Emitter.prototype);
  LiveSession.prototype.start = function (meta) {
    this.engine.reset(Object.assign({ name: 'Live session', kind: 'race', series: 'Zenith Racing Series' }, meta || {}), []);
    this.started = true; this.pit = {}; this.t0 = Date.now(); this.clockOffset = null; this.officialPits = false;
  };
  // session elapsed (ms) "now" from the best available source
  LiveSession.prototype._elapsed = function (s) {
    var wall = Date.now();
    if (s.elapsedMs !== null && s.elapsedMs !== undefined) { this.clockOffset = wall - s.elapsedMs; return s.elapsedMs; }
    var dur = s.durationMs || this.engine.meta.durationMs;
    if (dur && s.remainingMs !== null && s.remainingMs !== undefined) { this.clockOffset = wall - (dur - s.remainingMs); return dur - s.remainingMs; }
    if (this.clockOffset === null) this.clockOffset = this.t0;
    return wall - this.clockOffset;
  };
  LiveSession.prototype.apply = function (snap) {
    if (!snap || !snap.cars) return;
    var s = snap.session || {}, eng = this.engine, self = this;
    if (!this.started || (s.name && this.sessionName && s.name !== this.sessionName)) {
      this.start({ name: s.name || 'Live session', durationMs: s.durationMs || null, kind: /qual|practice|warm/i.test(s.name || '') ? 'practice' : 'race' });
    }
    if (s.name) { this.sessionName = s.name; eng.meta.name = s.name; eng.meta.kind = /practice|qual|warm|test/i.test(s.name) ? 'practice' : 'race'; }
    if (s.durationMs) eng.meta.durationMs = s.durationMs;
    var now = this._elapsed(s);
    eng.setClock(now, s.remainingMs !== undefined ? s.remainingMs : null);
    if (s.flag) eng.setFlag(s.flag, 'feed', now);
    // once the feed publishes official pit-lane times, stops come only from them (one per new official time);
    // pit-box state changes are then used only to mark in-laps, so a stop is never counted twice
    if (!this.officialPits) this.officialPits = snap.cars.some(function (c) { return !!c.lastPitMs; });
    var offPits = this.officialPits;
    snap.cars.forEach(function (c) {
      var car = eng.cars[c.n] || eng.addCar({ n: c.n, cls: c.cls, team: c.team, mfr: c.mfr, drivers: c.drivers || [] });
      // pit lane timing from status transitions
      var p = self.pit[c.n] = self.pit[c.n] || { inAt: null, pending: 0, official: false, measured: null, wasIn: false, inLapFlag: false };
      var official = p.init && c.lastPitMs && c.lastPitMs !== p.lastPitMs;                 // a new official pit-lane time
      if (c.inPit && !p.wasIn) { p.inAt = now; p.inLapFlag = true; p.measured = null; }
      if (official) {
        // it can arrive after the car left the box and a measured time was already booked: correct that stop
        if (p.measured && p.inAt === null && now - p.measured.at < 900000 && eng.correctStop(c.n, p.measured.lap, c.lastPitMs)) p.measured = null;
        else { p.pending = c.lastPitMs; p.official = true; }
      }
      if (!c.inPit && p.wasIn && p.inAt !== null) {
        if (!p.official && !offPits) p.pending = now - p.inAt;                            // measured (feeds without official pit times)
        p.inAt = null;
      }
      if (c.lastPitMs) p.lastPitMs = c.lastPitMs;
      p.init = true;
      p.wasIn = !!c.inPit;
      // lap completions
      if (c.laps !== null && c.laps !== undefined && c.laps > car.lastLap) {
        var prev = car.laps[car.lastLap];
        var t = c.totalMs || null;
        if (t === null && prev && c.lastMs && c.laps === car.lastLap + 1) t = prev.t + c.lastMs;
        if (t === null) t = now;
        var crossedInPit = !!c.inPit || p.inLapFlag && p.inAt !== null;
        eng.addLap(c.n, { lap: c.laps, elapsedMs: t, lapMs: c.laps === car.lastLap + 1 || !car.lastLap ? c.lastMs : null, s: c.s || null, inPit: crossedInPit ? 1 : 0,
          pitMs: p.pending || 0, drv: c.driver || null, topKph: c.kph || null }, false);
        p.measured = p.pending && !p.official ? { lap: c.laps, at: now } : null;
        p.pending = 0; p.official = false; p.inLapFlag = !!c.inPit;
      }
      eng.setLive(c.n, { pos: c.pos, cpos: c.cpos, laps: c.laps, lastMs: c.lastMs, bestMs: c.bestMs, gapText: c.gapText, intText: c.intText,
        inPit: !!c.inPit, pits: c.pits, driver: c.driver, status: c.status, cls: c.cls, team: c.team, mfr: c.mfr, drivers: c.drivers || undefined });
    });
    this.lastSnap = snap;
    this.emit('applied', snap);
  };
  // merge an official analysis CSV (exact history) into the running session
  LiveSession.prototype.backfill = function (rep) {
    var eng = this.engine, flags = rep.meta.flags || ['GF'];
    if (!this.started) this.start({ name: rep.meta.name, durationMs: rep.meta.durationMs, startClockMs: rep.meta.startClockMs });
    if (rep.meta.startClockMs !== undefined && eng.meta.startClockMs === undefined) eng.meta.startClockMs = rep.meta.startClockMs;
    ['refLapMs', 'pitLaneMs', 'transitDeltaMs'].forEach(function (k) { if (rep.meta[k] && Object.keys(rep.meta[k]).length) eng.meta[k] = rep.meta[k]; });
    rep.cars.forEach(function (c) { eng.addCar(c); });
    rep.laps.forEach(function (l) {
      var c = rep.cars[l[0]];
      eng.addLap(c.n, { lap: l[1], elapsedMs: l[2], lapMs: l[3], s: [l[4] || null, l[5] || null, l[6] || null], inPit: l[7], pitMs: l[8], drv: l[9], topKph: l[10] ? l[10] / 10 : null, flag: flags[l[11]] || null }, true);
    });
    var last = rep.laps.length ? rep.laps[rep.laps.length - 1][2] : 0;
    if (last > eng.now) eng.setClock(last);
    return rep.laps.length;
  };
  RS.LiveSession = LiveSession;
})(typeof window !== 'undefined' ? window : globalThis);
