/* Zenith Strategy — Al Kamel LT2 live timing, using the message format confirmed from captures:
   - transport: SockJS over WebSocket  wss://livetiming.alkamelsystems.com/sockjs/<nnn>/<id>/websocket  (raw /websocket as fallback)
   - Meteor DDP: sub livetimingFeed [<series>] -> feeds (sessions list, running) + events
                 sub sessions / sessionInfo / trackInfo [[<feed session ids>]] -> sessions (name, date, endDate, event), session_info, track_info
                 per session: session_classes, standings, session_pit_info, session_status, race_control, weather, session_entry, session_results
   - ids are Mongo ObjectIDs, sent as {"$type":"oid","$value":"<hex>"}; times are milliseconds
   - standings entries carry a ';' data string: position;car;status;class position;laps;pit stops;top speed?;line-crossing time;state;current lap
   The per-session subscription names are not confirmed yet: the client tries the likely names and keeps what the server accepts
   (a capture pasted from the browser, or the bridge, replaces the guesses with the page's own list). */
(function (G) {
  'use strict';
  var RS = G.RS;
  var LT2 = RS.LT2 = { HOST: 'livetiming.alkamelsystems.com' };

  function rnd(n, chars) { var s = ''; for (var i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; }
  LT2.sockUrl = function (host) { return 'wss://' + (host || LT2.HOST) + '/sockjs/' + rnd(3, '0123456789') + '/' + rnd(8, 'abcdefghijklmnopqrstuvwxyz0123456789') + '/websocket'; };
  LT2.rawUrl = function (host) { return 'wss://' + (host || LT2.HOST) + '/websocket'; };
  LT2.oid = function (hex) { return { $type: 'oid', $value: String(hex) }; };
  var oidStr = LT2.oidStr = function (v) { return v && typeof v === 'object' ? (v.$value !== undefined ? String(v.$value) : v._str !== undefined ? String(v._str) : '') : v === undefined || v === null ? '' : String(v); };

  /* SockJS framing: o = open, h = heartbeat, a[...] = messages (JSON strings), c[code,reason] = close */
  LT2.decodeFrame = function (raw) {
    if (typeof raw !== 'string' || !raw.length) return { type: 'none', msgs: [] };
    var c = raw.charAt(0);
    if (c === 'o') return { type: 'open', msgs: [] };
    if (c === 'h') return { type: 'heartbeat', msgs: [] };
    if (c === 'c') { var why = null; try { why = JSON.parse(raw.slice(1)); } catch (e) { /* */ } return { type: 'close', msgs: [], reason: why }; }
    if (c === 'a') {
      var arr = []; try { arr = JSON.parse(raw.slice(1)); } catch (e) { return { type: 'bad', msgs: [] }; }
      return { type: 'data', msgs: arr.map(function (s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { return null; } }).filter(Boolean) };
    }
    try { var m = JSON.parse(raw); return { type: 'data', msgs: Array.isArray(m) ? m : [m] }; } catch (e) { return { type: 'bad', msgs: [] }; }
  };
  LT2.encodeFrame = function (msg, sockjs) { var s = JSON.stringify(msg); return sockjs ? JSON.stringify([s]) : s; };

  /* ---------------- default subscription recipe ---------------- */
  // $SERIES, $FEED_SESSIONS (ids listed in the feeds doc), $EVENTS, $SESSION (chosen session id)
  LT2.DEFAULT_RECIPE = {
    feed: [{ name: 'livetimingFeed', params: ['$SERIES'] }],
    list: [{ name: 'sessions', params: ['$FEED_SESSIONS'] }, { name: 'sessionInfo', params: ['$FEED_SESSIONS'] }, { name: 'trackInfo', params: ['$FEED_SESSIONS'] }],
    session: [
      { key: 'classes', names: ['sessionClasses'], params: ['$SESSION'] },
      { key: 'standings', names: ['standings', 'sessionStandings', 'liveStandings'], params: ['$SESSION'] },
      { key: 'pits', names: ['sessionPitInfo', 'pitInfo', 'sessionPits'], params: ['$SESSION'] },
      { key: 'status', names: ['sessionStatus', 'status'], params: ['$SESSION'] },
      { key: 'rc', names: ['raceControl', 'sessionRaceControl', 'raceControlMessages'], params: ['$SESSION'] },
      { key: 'weather', names: ['weather', 'sessionWeather'], params: ['$SESSION'] },
      { key: 'entry', names: ['sessionEntry', 'sessionEntries', 'entries'], params: ['$SESSION'] },
      { key: 'results', names: ['sessionResults', 'results'], params: ['$SESSION'] }
    ]
  };

  /* turn a capture pasted from the browser's WebSocket messages (or the bridge's list) into a recipe */
  LT2.recipeFromCapture = function (text) {
    var t = String(text || '').replace(/\uD83D\uDE15/g, ':\\').replace(/\uD83D\uDE41/g, ':[');
    var subs = [], seen = {};
    var push = function (m) {
      if (!m || m.msg !== 'sub' || !m.name || /^meteor|^_roles$/i.test(m.name)) return;
      var key = m.name + JSON.stringify(m.params || []).slice(0, 40); if (seen[m.name]) return; seen[m.name] = key;
      subs.push({ name: m.name, params: m.params || [] });
    };
    t.split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf('[') >= 0 && line.indexOf('{') > line.indexOf('[') ? line.indexOf('[') : line.indexOf('{');
      if (i < 0) return;
      var body = line.slice(i).replace(/\t.*$/, '').replace(/\s+\d+\s+\d\d:\d\d:\d\d\.\d+\s*$/, '');
      var tries = [body, body.replace(/^a/, '')];
      for (var k = 0; k < tries.length; k++) {
        try {
          var v = JSON.parse(tries[k]);
          (Array.isArray(v) ? v : [v]).forEach(function (x) { if (typeof x === 'string') { try { push(JSON.parse(x)); } catch (e) { /* */ } } else push(x); });
          return;
        } catch (e) { /* try next */ }
      }
      var m = /"msg"\s*:\s*"sub"[\s\S]*?"name"\s*:\s*"([^"]+)"/.exec(line.replace(/\\"/g, '"'));
      if (m) { var p = /"params"\s*:\s*(\[[\s\S]*\])\s*\}/.exec(line.replace(/\\"/g, '"')); var params = []; try { params = p ? JSON.parse(p[1]) : []; } catch (e) { /* */ } push({ msg: 'sub', name: m[1], params: params }); }
    });
    return LT2.generalise(subs);
  };
  LT2.generalise = function (subs) {
    var isOid = function (v) { return v && typeof v === 'object' && v.$type === 'oid'; };
    var r = { feed: [], list: [], session: [], learned: true };
    subs.forEach(function (s) {
      var p = s.params || [];
      if (p.length === 1 && typeof p[0] === 'string') { r.feed.push({ name: s.name, params: ['$SERIES'] }); return; }
      if (/^events$/i.test(s.name)) return;                               // event names already arrive with the feed
      if (p.length === 1 && Array.isArray(p[0]) && (p[0].length > 1 || /^(sessions|sessionInfo|trackInfo)$/i.test(s.name))) { r.list.push({ name: s.name, params: ['$FEED_SESSIONS'] }); return; }
      if (p.length === 1 && Array.isArray(p[0]) && p[0].length === 1 && isOid(p[0][0])) { r.session.push({ key: s.name, names: [s.name], params: [['$SESSION']] }); return; }
      if (p.length >= 1 && isOid(p[0])) { r.session.push({ key: s.name, names: [s.name], params: ['$SESSION'].concat(p.slice(1)) }); return; }
      r.session.push({ key: s.name, names: [s.name], params: p, literal: true });
    });
    if (!r.feed.length) r.feed = LT2.DEFAULT_RECIPE.feed.slice();
    return r;
  };
  function fill(params, ctx) {
    return (params || []).map(function (p) {
      if (p === '$SERIES') return ctx.series;
      if (p === '$SESSION') return LT2.oid(ctx.session);
      if (p === '$FEED_SESSIONS') return (ctx.feedSessions || []).map(LT2.oid);
      if (p === '$EVENTS') return (ctx.events || []).map(LT2.oid);
      if (Array.isArray(p)) return fill(p, ctx);
      return p;
    });
  }
  LT2.fill = fill;

  /* ---------------- client: one connection, feed -> session list -> chosen session ---------------- */
  function Client(opts) {
    RS.Emitter.call(this);
    this.opts = Object.assign({ series: 'zenith', host: LT2.HOST, transport: 'sockjs', session: 'auto', url: null }, opts || {});
    this.mirror = opts.mirror || new RS.Mirror();
    this.recipe = opts.recipe && opts.recipe.feed ? opts.recipe : LT2.DEFAULT_RECIPE;
    this.feedSessions = []; this.sessionId = null; this.sessionSubs = {}; this.listKey = ''; this.subLog = [];
    this.recorder = opts.recorder || null;
  }
  Client.prototype = Object.create(RS.Emitter.prototype);
  Client.prototype.url = function () {
    if (this.opts.url) return this.opts.url;
    return this.opts.transport === 'raw' ? LT2.rawUrl(this.opts.host) : LT2.sockUrl(this.opts.host);
  };
  Client.prototype.start = function () {
    var self = this, sock = this.opts.url ? /\/sockjs\//.test(this.opts.url) : this.opts.transport !== 'raw';
    this.ddp = new RS.DDPClient(function () { return self.url(); }, this.mirror, { sockjs: sock, recorder: this.recorder });
    this.ddp.on('state', function (s, d) { self.emit('state', s, d); });
    this.ddp.on('data', function () { self._onData(); self.emit('data'); });
    this.ddp.on('nosub', function (s) { self._onNosub(s); });
    this.ddp.on('ready', function () { self.emit('ready'); });
    this.recipe.feed.forEach(function (r) { self._sub(r.name, fill(r.params, self._ctx()), 'feed'); });
    this.ddp.connect();
    LT2.timesync(this.opts.host).then(function (off) { self.clockOffset = off; self.emit('timesync', off); }, function () { /* cross-site blocked: estimate from data */ });
    return this;
  };
  Client.prototype.stop = function () { if (this.ddp) this.ddp.close(); this.ddp = null; };
  Client.prototype._ctx = function () { return { series: this.opts.series, feedSessions: this.feedSessions, session: this.sessionId, events: Object.keys(this.mirror.cols.events || {}) }; };
  Client.prototype._sub = function (name, params, group, key, id) {
    id = id || this.ddp.newId();
    this.subLog.push({ id: id, name: name, group: group, key: key || name, params: params });
    this.ddp.subscribe(name, params, { group: group, key: key || name }, id);
    return id;
  };
  Client.prototype._onData = function () {
    var feeds = this.mirror.cols.feeds || {}, mine = null;
    for (var id in feeds) { var f = feeds[id]; if (!mine || String(f.name || '').toLowerCase() === String(this.opts.series).toLowerCase()) mine = f; }
    if (mine && Array.isArray(mine.sessions)) {
      var list = mine.sessions.map(oidStr).filter(Boolean), key = list.join(',');
      if (key && key !== this.listKey) {
        this.listKey = key; this.feedSessions = list; var self = this;
        (this._listSubs || []).forEach(function (sid) { self.ddp.unsubscribe(sid); });
        this._listSubs = this.recipe.list.map(function (r) { return self._sub(r.name, fill(r.params, self._ctx()), 'list'); });
      }
      this.feedRunning = mine.running;
      this.feedDoc = mine;
    }
    var want = this.opts.session === 'auto' ? LT2.pickLive(this.sessions(), this.now()) : this.opts.session;
    if (want && want !== this.sessionId) this.useSession(want);
  };
  Client.prototype.now = function () { return Date.now() + (this.clockOffset || 0); };
  Client.prototype.sessions = function () { return LT2.sessionList(this.mirror); };
  Client.prototype.useSession = function (sid) {
    var self = this;
    Object.keys(this.sessionSubs).forEach(function (k) { var s = self.sessionSubs[k]; if (s && s.id) self.ddp.unsubscribe(s.id); });
    this.sessionSubs = {}; this.sessionId = sid;
    this.recipe.session.forEach(function (r) { self._trySession(r, 0, 0); });
    this.emit('session', sid);
  };
  Client.prototype._trySession = function (r, nameIx, shape) {
    var name = r.names[nameIx]; if (!name) { this.sessionSubs[r.key] = { failed: true, tried: r.names.slice() }; this.emit('subfail', r.key); return; }
    var params = shape === 1 ? [[LT2.oid(this.sessionId)]] : fill(r.params, this._ctx());
    var id = this.ddp.newId();
    this.sessionSubs[r.key] = { id: id, name: name, r: r, nameIx: nameIx, shape: shape };
    this._sub(name, params, 'session', r.key, id);
  };
  Client.prototype._onNosub = function (s) {
    if (!s) return;
    var e = s.error || '';
    if (s.group === 'session') {
      var cur = this.sessionSubs[s.key]; if (!cur || cur.id !== s.id) return;
      if (/not found|404/i.test(e)) this._trySession(cur.r, cur.nameIx + 1, 0);           // unknown name: next guess
      else if (cur.shape === 0 && !cur.r.literal && /match|param|400|argument|expected/i.test(e)) this._trySession(cur.r, cur.nameIx, 1); // wrong parameter shape
      else this.sessionSubs[s.key] = { failed: true, name: s.name, error: e };
    }
    this.emit('nosub', s);
  };
  Client.prototype.status = function () {
    var out = {}, subs = this.ddp ? this.ddp.subs : {};
    for (var k in this.sessionSubs) { var x = this.sessionSubs[k]; out[k] = x.failed ? 'refused' + (x.error ? ' (' + x.error + ')' : '') : subs[x.id] && subs[x.id].ready ? 'ok · ' + x.name : 'waiting · ' + x.name; }
    return out;
  };
  /* the subscriptions that worked, as a recipe to store for next time */
  Client.prototype.workingRecipe = function () {
    var subs = this.ddp ? this.ddp.subs : {}, r = { feed: this.recipe.feed, list: this.recipe.list, session: [], learned: true };
    for (var k in this.sessionSubs) {
      var x = this.sessionSubs[k]; if (!x.id || !subs[x.id] || !subs[x.id].ready) continue;
      r.session.push({ key: k, names: [x.name], params: x.shape === 1 ? [['$SESSION']] : x.r.params });
    }
    return r.session.length ? r : null;
  };
  LT2.Client = Client;

  LT2.timesync = function (host) {
    if (!G.fetch) return Promise.reject(new Error('no fetch'));
    var t0 = Date.now();
    return G.fetch('https://' + (host || LT2.HOST) + '/_timesync', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (txt) {
      var srv = parseFloat(txt), t1 = Date.now(); if (!isFinite(srv) || srv < 1e12) throw new Error('bad timesync');
      return Math.round(srv - (t0 + t1) / 2);
    });
  };

  /* ---------------- sessions ---------------- */
  LT2.sessionList = function (mirror) {
    var cols = mirror.cols, ses = cols.sessions || {}, ev = cols.events || {}, out = [];
    for (var id in ses) {
      var s = ses[id], e = ev[oidStr(s.event)] || {};
      var start = typeof s.date === 'number' ? s.date : Date.parse(s.date), end = typeof s.endDate === 'number' ? s.endDate : Date.parse(s.endDate);
      out.push({ id: id, name: String(s.name || '').trim(), event: String(e.name || '').trim(), champ: String(e.champName || '').trim(), start: isFinite(start) ? start : null, end: isFinite(end) ? end : null,
        closed: !!(s.closed || s.isClosed || s.finished), utcOffsetMin: s.UtcOffsetMin !== undefined ? s.UtcOffsetMin : s.utcOffsetMin, label: [e.champName, e.name, s.name].map(function (x) { return String(x || '').trim(); }).filter(Boolean).join(' | ') });
    }
    return out.sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
  };
  // the session running now (or the next one within 30 min, or the last one that ended within 90 min)
  LT2.pickLive = function (list, now) {
    if (!list.length) return null;
    var live = list.filter(function (s) { return s.start && s.start - 10 * 60000 <= now && (!s.end || now <= s.end + 45 * 60000); });
    if (live.length) { var open = live.filter(function (s) { return !s.closed; }); return (open.length ? open : live)[0].id; }
    var next = list.filter(function (s) { return s.start && s.start > now && s.start - now < 30 * 60000; })[0];
    if (next) return next.id;
    var past = list.filter(function (s) { return s.end && s.end < now && now - s.end < 90 * 60000; });
    return past.length ? past[past.length - 1].id : null;
  };

  /* ---------------- model: collections -> snapshot for the strategy engine ---------------- */
  var DATA_MAP = ['pos', 'n', 'status', 'cpos', 'laps', 'pits', 'kph', 'line', 'state', 'curLap'];
  LT2.DATA_MAP = DATA_MAP;
  var NORM = {}, NORM_N = 0;
  function norm(k) {      // field names repeat endlessly: remember their normalised form
    var v = NORM[k]; if (v !== undefined) return v;
    v = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (NORM_N++ < 5000) NORM[k] = v;
    return v;
  }
  function num(v) { if (v === null || v === undefined || v === '') return null; var x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; }
  function timeMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') return timeMs(v.time !== undefined ? v.time : v.value !== undefined ? v.value : v.ms);
    if (typeof v === 'number') return v > 0 ? Math.round(v) : null;                 // LT2 times are milliseconds
    var s = String(v); if (s.indexOf(';') >= 0) s = s.split(';')[0];
    if (/^\d+$/.test(s)) return parseInt(s, 10) || null;
    return RS.toMs(s);
  }
  function findKey(o, re) { for (var k in o) if (re.test(norm(k))) return k; return null; }

  function Model(mirror, opts) { this.mirror = mirror; this.opts = opts || {}; this.sessionId = null; this.offsets = []; this.rcSeen = {}; this.found = {}; }
  Model.prototype.col = function (re) { var out = []; for (var name in this.mirror.cols) if (re.test(name)) { var c = this.mirror.cols[name]; for (var id in c) out.push(c[id]); } return out; };
  Model.prototype.forSession = function (docs) {
    var sid = this.sessionId; if (!sid) return docs;
    var mine = docs.filter(function (d) { for (var k in d) { if (/^session(id)?$/i.test(k) && oidStr(d[k]) === sid) return true; } return false; });
    var tagged = docs.filter(function (d) { for (var k in d) if (/^session(id)?$/i.test(k)) return true; return false; });
    return tagged.length ? mine : docs;
  };
  /* per-car entries inside the standings collection: either one doc per car, or docs holding arrays / maps of cars */
  Model.prototype.entries = function () {
    var docs = this.forSession(this.col(/standing/i)), out = [];
    var looksCar = function (o) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
      if (typeof o.data === 'string' && o.data.split(';').length >= 6) return true;
      for (var k in o) if (/^(number|carnumber|racenumber|startnumber|no|nr)$/.test(norm(k)) && /^\s*\d{1,4}\s*$/.test(String(o[k]))) return true;
      return false;
    };
    var walk = function (v, depth) {
      if (!v || typeof v !== 'object' || depth > 3) return;
      if (looksCar(v)) { out.push(v); return; }
      if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
      for (var k in v) if (v[k] && typeof v[k] === 'object') walk(v[k], depth + 1);
    };
    docs.forEach(function (d) { walk(d, 0); });
    return out;
  };
  Model.prototype.parseEntry = function (e, map, classNames) {
    var o = { raw: e }, parts = typeof e.data === 'string' ? e.data.split(';') : null;
    if (parts) map.forEach(function (k, i) { if (k && parts[i] !== undefined) o[k] = parts[i]; });
    var f = {}; for (var k in e) if (k !== 'data') f[norm(k)] = e[k];
    var get = function (names) { for (var i = 0; i < names.length; i++) if (f[names[i]] !== undefined && f[names[i]] !== null && f[names[i]] !== '') return f[names[i]]; return undefined; };
    var n = String(o.n !== undefined ? o.n : get(['number', 'carnumber', 'racenumber', 'startnumber', 'no', 'nr']) || '').replace(/[^\dA-Za-z]/g, '');
    var cls = get(['classname', 'class', 'category', 'classid', 'carclass']);
    cls = cls && typeof cls === 'object' ? (cls.name || oidStr(cls)) : cls;
    if (cls && classNames[oidStr(cls)]) cls = classNames[oidStr(cls)];
    var state = String(o.state !== undefined ? o.state : get(['state', 'trackstate', 'carstate']) || '').toUpperCase();
    var status = String(o.status !== undefined ? o.status : get(['status', 'classificationstatus']) || '').toUpperCase();
    // last / best laps and sectors: names vary, so look for keys that mention them
    var lastK = findKey(e, /^last(lap)?(time)?$|lastlaptime/), bestK = findKey(e, /^best(lap)?(time)?$|bestlaptime/);
    var secK = findKey(e, /^(current|last)?sectors?$|sectortimes|lastsectors/);
    var sectors = null;
    if (secK) { var sv = e[secK]; if (Array.isArray(sv)) sectors = sv.map(timeMs); else if (typeof sv === 'string') sectors = sv.split(/[|,]/).map(timeMs); }
    var line = num(o.line !== undefined ? o.line : get(['lapstarttime', 'linetime', 'lastpassingtime', 'crossingtime', 'lastlinetime', 'passingtime']));
    return {
      n: n, pos: parseInt(o.pos !== undefined ? o.pos : get(['position', 'pos', 'overallposition']), 10) || null,
      cpos: parseInt(o.cpos !== undefined ? o.cpos : get(['classposition', 'positioninclass', 'catposition']), 10) || null,
      laps: o.laps !== undefined && o.laps !== '' ? parseInt(o.laps, 10) : (get(['laps', 'lapscompleted', 'completedlaps']) !== undefined ? parseInt(get(['laps', 'lapscompleted', 'completedlaps']), 10) : null),
      pits: o.pits !== undefined && o.pits !== '' ? parseInt(o.pits, 10) : (parseInt(get(['pitstops', 'pits', 'stops']), 10) || null),
      kph: num(o.kph !== undefined ? o.kph : get(['topspeed', 'speed', 'maxspeed'])),
      line: line, state: state, status: status, cls: cls ? String(cls) : '',
      inPit: /BOX|PIT|IN_?PIT/.test(state), stopped: /STOP/.test(state),
      lastMs: lastK ? timeMs(e[lastK]) : null, bestMs: bestK ? timeMs(e[bestK]) : null, s: sectors ? sectors.slice(0, 3) : null,
      driver: (function () { var d = get(['currentdriver', 'driver', 'drivername']); return d && typeof d === 'object' ? (d.name || ((d.firstName || '') + ' ' + (d.lastName || '')).trim()) : d || ''; })(),
      curLap: o.curLap
    };
  };
  /* results that only depend on a few collections are kept until one of those collections changes
     (a late screen rebuilds thousands of snapshots while catching up) */
  Model.prototype._memo = function (slot, re, fn) {
    var m = this.mirror, k = (m.gen || 0) + '|' + this.sessionId;
    if (!m.ver) return fn.call(this);
    for (var name in m.cols) if (re.test(name)) k += '|' + name + ':' + (m.ver[name] || 0);
    var c = this._mc || (this._mc = {});
    if (c[slot] && c[slot].k === k) return c[slot].v;
    var v = fn.call(this); c[slot] = { k: k, v: v }; return v;
  };
  Model.prototype.classNames = function () { return this._memo('cls', /class/i, this._classNames); };
  Model.prototype.entryInfo = function () { return this._memo('entry', /entr/i, this._entryInfo); };
  Model.prototype.pitInfo = function () { return this._memo('pit', /pit/i, this._pitInfo); };
  Model.prototype._classNames = function () {
    var out = {};
    this.col(/class/i).forEach(function (d) {
      var name = d.name || d.shortName || d.className || d.code; if (!name) return;
      if (d._id) out[String(d._id)] = name; if (d.id !== undefined) out[String(d.id)] = name;
      // a session_classes doc may also hold a list of classes
      ['classes', 'list', 'items'].forEach(function (k) { (Array.isArray(d[k]) ? d[k] : []).forEach(function (c) { if (c && (c.name || c.shortName)) { if (c.id !== undefined) out[String(c.id)] = c.name || c.shortName; if (c._id) out[oidStr(c._id)] = c.name || c.shortName; } }); });
    });
    return out;
  };
  Model.prototype._entryInfo = function () {
    var out = {}, walk = function (v, depth) {
      if (!v || typeof v !== 'object' || depth > 3) return;
      if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
      var nk = findKey(v, /^(number|carnumber|racenumber|startnumber|no|nr)$/);
      if (nk && /^\s*\d{1,4}\s*$/.test(String(v[nk]))) {
        var n = String(v[nk]).trim(), drv = v.drivers || v.driverList;
        out[n] = { team: v.team && typeof v.team === 'object' ? v.team.name : v.team || v.teamName || v.entrant || '', cls: v.class && typeof v.class === 'object' ? v.class.name : v.className || v.class || v.category || '',
          mfr: v.vehicle && typeof v.vehicle === 'object' ? v.vehicle.name : v.vehicle || v.brand || v.manufacturer || v.car || '',
          drivers: Array.isArray(drv) ? drv.map(function (d) { return typeof d === 'object' ? (d.name || ((d.firstName || '') + ' ' + (d.lastName || d.surname || '')).trim()) : String(d); }).filter(Boolean) : null };
        return;
      }
      for (var k in v) if (v[k] && typeof v[k] === 'object') walk(v[k], depth + 1);
    };
    this.forSession(this.col(/entr/i)).forEach(function (d) { walk(d, 0); });
    return out;
  };
  Model.prototype._pitInfo = function () {
    var out = {};
    var walk = function (v, depth) {
      if (!v || typeof v !== 'object' || depth > 3) return;
      if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
      var nk = findKey(v, /^(number|carnumber|racenumber|startnumber|no|nr|participant)$/);
      var lk = findKey(v, /lastpit(time)?$|lastpitduration|lastpitstop/), tk = findKey(v, /^(total)?pittime$|totalpit/), ck = findKey(v, /^(pitstops|pits|numberofpits|stops)$/);
      if (nk && (lk || tk || ck)) {
        out[String(oidStr(v[nk]) || v[nk]).trim()] = { lastMs: lk ? timeMs(v[lk]) : null, totalMs: tk ? timeMs(v[tk]) : null, count: ck ? parseInt(v[ck], 10) : null };
        return;
      }
      for (var k in v) if (v[k] && typeof v[k] === 'object') walk(v[k], depth + 1);
    };
    this.forSession(this.col(/pit/i)).forEach(function (d) { walk(d, 0); });
    return out;
  };
  Model.prototype.status = function () {
    var docs = this.forSession(this.col(/session_?status|^status/i)), o = {};
    docs.forEach(function (d) { var f = {}; (function flat(x, depth) { for (var k in x) { var v = x[k]; if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2 && v.$type === undefined) flat(v, depth + 1); else if (f[norm(k)] === undefined) f[norm(k)] = v; } })(d, 0); Object.assign(o, f); });
    var pick = function (names) { for (var i = 0; i < names.length; i++) if (o[names[i]] !== undefined && o[names[i]] !== null && o[names[i]] !== '') return o[names[i]]; return undefined; };
    var flag = pick(['currentflag', 'flag', 'trackflag', 'trackstatus', 'flagstatus', 'sessionflag', 'state', 'status']);
    var rem = pick(['remaining', 'timeremaining', 'remainingtime', 'timeleft', 'timetogo', 'countdown']);
    var el = pick(['elapsed', 'elapsedtime', 'sessiontime', 'runningtime']);
    var fin = pick(['isfinished', 'finished', 'ended', 'closed', 'isclosed']);
    var stopAt = pick(['finaltime', 'endtime', 'stoptime', 'sessionend', 'enddate']);
    var startAt = pick(['starttime', 'startdate', 'realstart', 'greentime', 'sessionstart']);
    var laps = pick(['currentlap', 'lap', 'laps', 'lapscompleted', 'leaderlaps']);
    return { flagRaw: flag === undefined ? '' : String(flag), flag: RS.normFlag(flag === undefined ? '' : String(flag)), remainingMs: rem !== undefined ? timeMs(rem) : null, elapsedMs: el !== undefined ? timeMs(el) : null,
      finished: fin === true || /^(true|1|yes)$/i.test(String(fin === undefined ? '' : fin)), endAt: num(stopAt), startAt: num(startAt), laps: laps !== undefined ? parseInt(laps, 10) : null, keys: Object.keys(o).slice(0, 40) };
  };
  Model.prototype.weather = function () {
    var w = null;
    this.forSession(this.col(/weather/i)).forEach(function (d) { var x = d.weather && typeof d.weather === 'object' ? d.weather : d; if (x.ambientTemperature !== undefined || x.trackTemperature !== undefined || x.airTemperature !== undefined) w = x; });
    if (!w) return null;
    return { air: num(w.ambientTemperature !== undefined ? w.ambientTemperature : w.airTemperature), track: num(w.trackTemperature), humidity: num(w.humidity), wind: num(w.windSpeed), rain: w.rain !== undefined ? w.rain : null };
  };
  Model.prototype.raceControl = function (tzMin) {
    var out = [], walk = function (v, depth) {
      if (!v || typeof v !== 'object' || depth > 4) return;
      if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
      var tk = findKey(v, /^(message|text|msg|description|content|title)$/);
      if (tk && typeof v[tk] === 'string' && v[tk].trim()) {
        var timeK = findKey(v, /^(time|date|timestamp|hour|createdat|datetime)$/), t = timeK ? v[timeK] : null;
        out.push({ text: v[tk].trim(), at: typeof t === 'number' ? t : t ? Date.parse(t) || null : null, timeText: typeof t === 'string' && !/^\d{4}-/.test(t) ? t : null });
        return;
      }
      for (var k in v) if (v[k] && typeof v[k] === 'object') walk(v[k], depth + 1);
    };
    this.forSession(this.col(/race_?control|racecontrol|messages/i)).forEach(function (d) { walk(d, 0); });
    out.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var seen = {};
    return out.filter(function (m) { var k = m.at + '|' + m.text; if (seen[k]) return false; seen[k] = 1; return true; }).map(function (m) {
      var time = m.timeText || (m.at && m.at > 1e11 ? LT2.clock(m.at, tzMin) : m.at ? RS.fmtTod(m.at).slice(0, 5) : '');
      var lvl = /red flag|red\b/i.test(m.text) ? 'crit' : /yellow|fcy|safety|caution|code ?60|penalt|drive.?through|stop.?go/i.test(m.text) ? 'warn' : '';
      return { time: time, text: m.text, level: lvl, at: m.at };
    });
  };
  // track-local clock HH:MM from an epoch time and the session's UTC offset
  LT2.clock = function (epoch, tzMin) {
    var d = new Date(epoch + ((tzMin !== undefined && tzMin !== null ? tzMin : -new Date(epoch).getTimezoneOffset()) * 60000));
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  };
  Model.prototype.track = function () {
    var docs = this.forSession(this.col(/track/i)), len = null, pts = [];
    docs.forEach(function (d) {
      var lk = findKey(d, /^(length|tracklength|distance|lengthm|lengthkm)$/); if (lk && num(d[lk])) len = num(d[lk]);
      ['sectors', 'timingPoints', 'loops', 'points', 'splits', 'intermediates'].forEach(function (k) {
        (Array.isArray(d[k]) ? d[k] : []).forEach(function (p) { var dk = p && typeof p === 'object' ? findKey(p, /^(distance|position|meters|length|end|enddistance|to)$/) : null; if (dk && num(p[dk])) pts.push(num(p[dk])); });
      });
    });
    if (!len || !pts.length) return { length: len, fracs: null };
    if (len < 50) len *= 1000;                                                       // km -> m
    var fr = pts.map(function (p) { return p > len * 1.01 && p < len * 1010 ? p / 1000 / len : p / len; }).filter(function (f) { return f > 0.01 && f < 0.99; });
    fr = fr.sort(function (a, b) { return a - b; }).filter(function (f, i, a) { return !i || f - a[i - 1] > 0.004; });
    return { length: len, fracs: fr.length ? fr : null };
  };

  /* snapshot in the format LiveSession understands */
  Model.prototype.snapshot = function (nowEpoch) {
    if (!this.sessionId) this.sessionId = this.guessSession();
    var self = this, info = this.sessionInfo(), map = (this.opts.dataMap && this.opts.dataMap.length ? this.opts.dataMap : DATA_MAP);
    var classNames = this.classNames(), ent = this.entryInfo(), pits = this.pitInfo();
    var raw = this.entries();
    this.found = { entries: raw.length, sample: raw[0] ? JSON.stringify(raw[0]).slice(0, 600) : null, map: map };
    if (!raw.length) return null;
    var dv = this.mirror.dv, pe = this._pe = this._pe || (typeof WeakMap !== 'undefined' ? new WeakMap() : null);
    var cars = raw.map(function (e) {
      var v = dv && pe ? dv.get(e) : undefined, hit = v !== undefined ? pe.get(e) : null;
      if (hit && hit.v === v && hit.map === map && hit.cn === classNames) return hit.p;
      var p = self.parseEntry(e, map, classNames);
      if (v !== undefined) pe.set(e, { v: v, map: map, cn: classNames, p: p });
      return p;
    }).filter(function (c) { return c.n && /^\d{1,4}[A-Za-z]?$/.test(c.n) && c.status !== 'NOT_STARTED'; });
    // line-crossing times: epoch ms, or milliseconds into the session/day
    var lines = cars.map(function (c) { return c.line; }).filter(function (x) { return x !== null && x > 0; });
    var epoch = lines.length && RS.median(lines) > 1e12;
    var base = epoch ? (info.start || Math.min.apply(null, lines)) : 0;
    if (epoch && nowEpoch && !this.fixedOffset) {
      // estimate the server clock from fresh crossings (only latency can make this low)
      var seenL = this.seenLines = this.seenLines || {};
      var seenNew = cars.filter(function (c) { var key = c.n + ':' + c.line; if (seenL[key]) return false; seenL[key] = 1; return c.line && nowEpoch - c.line < 20000 && nowEpoch - c.line > -20000; });
      seenNew.forEach(function (c) { self.offsets.push(c.line - nowEpoch); });
      if (this.offsets.length > 60) this.offsets.splice(0, this.offsets.length - 60);
    }
    var st = this.status();
    var now = nowEpoch ? nowEpoch + (this.offsets.length >= 5 && !this.fixedOffset ? Math.max(0, RS.pct(this.offsets, 0.9)) : 0) : null;
    this.serverNow = now;
    var tz = info.utcOffsetMin !== undefined && info.utcOffsetMin !== null ? info.utcOffsetMin : null;
    if (!epoch && lines.length && info.start && now && tz !== null) {
      // milliseconds of the track's day: re-base on the session's scheduled start
      var startDay = ((info.start + tz * 60000) % 86400000 + 86400000) % 86400000, med = RS.median(lines);
      if (med > startDay - 3600000 && med < startDay + 30 * 3600000 && med < 2 * 86400000) {
        base = startDay; var nowDay = ((now + tz * 60000) % 86400000 + 86400000) % 86400000; if (nowDay < startDay - 3600000) nowDay += 86400000;
        this.dayClock = nowDay;
      }
    }
    var elapsed = st.elapsedMs !== null ? st.elapsedMs : epoch && now ? now - base : this.dayClock !== undefined && base ? this.dayClock - base : null;
    if (elapsed !== null && elapsed < 0) elapsed = 0;
    var remaining = st.remainingMs !== null ? st.remainingMs : info.end && now ? Math.max(0, info.end - now) : null;
    if (st.finished) remaining = 0;
    var out = cars.map(function (c) {
      var e = ent[c.n] || {}, p = pits[c.n] || {};
      return { n: c.n, pos: c.pos, cpos: c.cpos, cls: c.cls || e.cls || '', team: e.team || '', mfr: e.mfr || '', drivers: e.drivers || null, driver: c.driver || '',
        laps: c.laps, lastMs: c.lastMs, bestMs: c.bestMs, s: c.s, inPit: c.inPit, stopped: c.stopped, status: c.state + (c.status ? ' ' + c.status : ''),
        pits: c.pits !== null ? c.pits : p.count, lastPitMs: p.lastMs || null, totalMs: c.line && (epoch || base || c.line < 2 * 86400000) ? c.line - base : null, kph: c.kph };
    });
    return { session: { name: info.label || info.name || null, track: info.event || null, series: info.champ || null, durationMs: info.end && info.start ? info.end - info.start : null,
      remainingMs: remaining, elapsedMs: elapsed, flag: st.flag, flagRaw: st.flagRaw, finished: st.finished }, cars: out, source: 'lt2' };
  };
  // which session the standings belong to (bridge and recordings do not say which one was chosen)
  Model.prototype.guessSession = function () {
    var docs = this.col(/standing|session_?status|session_?entry/i);
    for (var i = 0; i < docs.length; i++) for (var k in docs[i]) if (/^session(id)?$/i.test(k) && oidStr(docs[i][k])) return oidStr(docs[i][k]);
    var list = LT2.sessionList(this.mirror);
    return list.length === 1 ? list[0].id : null;
  };
  Model.prototype.sessionInfo = function () {
    var self = this, list = LT2.sessionList(this.mirror), s = list.filter(function (x) { return x.id === self.sessionId; })[0];
    return s || (list.length === 1 ? list[0] : {});
  };
  Model.prototype.extras = function () {
    var info = this.sessionInfo();
    return { weather: this.weather(), raceControl: this.raceControl(info.utcOffsetMin), track: this.track() };
  };
  LT2.Model = Model;

  /* ---------------- recorder: every message received, with its arrival time ---------------- */
  function Recorder() { this.lines = []; this.count = 0; this.on = false; this.bytes = 0; }
  Recorder.prototype.add = function (dir, m) {
    if (!this.on) return;
    var line = JSON.stringify({ t: Date.now(), dir: dir, m: m });
    this.lines.push(line); this.count++; this.bytes += line.length + 1;
  };
  Recorder.prototype.text = function () { return this.lines.join('\n') + '\n'; };
  Recorder.prototype.blob = function () {
    var text = this.text();
    if (G.CompressionStream && G.Blob && G.Response) {
      var gz = new G.Blob([text]).stream().pipeThrough(new G.CompressionStream('gzip'));
      return new G.Response(gz).blob().then(function (b) { return { blob: b, ext: '.jsonl.gz' }; });
    }
    return Promise.resolve({ blob: new G.Blob([text], { type: 'application/x-ndjson' }), ext: '.jsonl' });
  };
  LT2.Recorder = Recorder;

  /* ---------------- recordings: read the dashboard's .jsonl(.gz) or the recorder script's .raw.jsonl.gz ---------------- */
  LT2.readFile = function (file) {
    var gz = /\.gz$/i.test(file.name);
    var buf = file.arrayBuffer ? file.arrayBuffer() : new Promise(function (res, rej) { var r = new G.FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); });
    return buf.then(function (ab) {
      var u = new Uint8Array(ab);
      if (gz || (u[0] === 0x1f && u[1] === 0x8b)) {
        if (!G.DecompressionStream) throw new Error('This browser cannot unzip .gz files — unzip it first.');
        return new G.Response(new G.Blob([u]).stream().pipeThrough(new G.DecompressionStream('gzip'))).text();
      }
      return new G.TextDecoder().decode(u);
    });
  };
  var DDP_MSGS = /^(added|changed|removed|addedBefore|movedBefore|ready|nosub|sub|unsub|connected|ping|pong|result|updated|connect|method)$/;
  LT2.parseRecording = function (text) {
    var out = [], lastT = 0, n = 0;
    var tsOf = function (o) {
      var keys = ['t', 'ts', 'time', 'timestamp', 'received', 'recv', 'at', 'wall', 'clock'];
      for (var i = 0; i < keys.length; i++) {
        var v = o[keys[i]]; if (v === undefined || v === null) continue;
        if (typeof v === 'number') return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
        if (typeof v === 'string') { var d = Date.parse(v); if (isFinite(d)) return d; var x = parseFloat(v); if (isFinite(x)) return x < 1e11 ? Math.round(x * 1000) : Math.round(x); }
      }
      return null;
    };
    var msgsOf = function (v, depth) {
      if (v === null || v === undefined || depth > 3) return [];
      if (typeof v === 'string') {
        var f = LT2.decodeFrame(v);
        return f.type === 'data' ? f.msgs.filter(function (m) { return m && DDP_MSGS.test(m.msg); }) : [];
      }
      if (Array.isArray(v)) { var a = []; v.forEach(function (x) { a = a.concat(msgsOf(x, depth + 1)); }); return a; }
      if (typeof v === 'object') {
        if (typeof v.msg === 'string' && DDP_MSGS.test(v.msg)) return [v];
        var keys = ['m', 'msg', 'message', 'data', 'raw', 'frame', 'payload', 'ddp'], r = [];
        keys.forEach(function (k) { if (v[k] !== undefined && typeof v[k] !== 'number') r = r.concat(msgsOf(v[k], depth + 1)); });
        return r;
      }
      return [];
    };
    String(text).split(/\r?\n/).forEach(function (line) {
      line = line.trim(); if (!line) return;
      var o; try { o = JSON.parse(line); } catch (e) { var f = LT2.decodeFrame(line); if (f.type === 'data') f.msgs.forEach(function (m) { out.push({ t: lastT, m: m }); }); return; }
      var dir = o && typeof o === 'object' && !Array.isArray(o) ? String(o.dir || o.direction || o.type || '') : '';
      if (/^(out|send|sent|tx|>)$/i.test(dir)) return;
      var t = o && typeof o === 'object' && !Array.isArray(o) ? tsOf(o) : null;
      if (t === null) t = lastT; else lastT = t;
      msgsOf(o, 0).forEach(function (m) { if (/^(added|changed|removed|addedBefore)$/.test(m.msg)) { out.push({ t: t, m: m }); n++; } });
    });
    if (out.length && !out[0].t) { var first = out.filter(function (x) { return x.t; })[0]; out.forEach(function (x) { if (!x.t) x.t = first ? first.t : 0; }); }
    out.sort(function (a, b) { return a.t - b.t; });
    return { msgs: out, start: out.length ? out[0].t : 0, end: out.length ? out[out.length - 1].t : 0, count: n };
  };

  /* plays a recording into a mirror against a moving clock */
  function Player(rec, mirror) { RS.Emitter.call(this); this.rec = rec; this.mirror = mirror; this.speed = 10; this.playing = false; this.i = 0; this.t = 0; this.end = rec.end - rec.start; this._last = null; }
  Player.prototype = Object.create(RS.Emitter.prototype);
  Player.prototype.seek = function (t) {
    t = Math.max(0, Math.min(this.end, t));
    if (t < this.t) { this.mirror.clear(); this.i = 0; this.emit('rewind'); }
    var L = this.rec.msgs, abs = this.rec.start + t;
    while (this.i < L.length && L[this.i].t <= abs) { this.mirror.apply(L[this.i].m); this.i++; }
    this.t = t; this.emit('data');
  };
  Player.prototype.now = function () { return this.rec.start + this.t; };
  Player.prototype.play = function () { this.playing = true; this._last = null; this.emit('state'); };
  Player.prototype.pause = function () { this.playing = false; this.emit('state'); };
  Player.prototype.tick = function (perfNow) {
    if (!this.playing) { this._last = null; return; }
    if (this._last !== null) this.seek(this.t + (perfNow - this._last) * this.speed);
    this._last = perfNow;
    if (this.t >= this.end) this.pause();
  };
  LT2.Player = Player;
})(typeof window !== 'undefined' ? window : globalThis);
