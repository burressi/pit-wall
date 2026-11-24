/* Zenith Strategy — pit wall hub client.
   The laptop hub (pitwall_hub.py) holds the one Al Kamel connection. Each screen (laptop, crew phones):
     1. fetches the session's message log and replays it (catch-up: full lap history even when joining late),
     2. then receives every new message as it arrives (Server-Sent Events, pushed within ~0.1 s),
     3. reconnects by itself (phone asleep, Wi-Fi drop, hub restart) and catches up what it missed. */
(function (G) {
  'use strict';
  var RS = G.RS;
  var Hub = RS.Hub = {};
  var BUCKET = 15000;      // during catch-up, rebuild the standings every 15 s of feed time (no lap is that short)
  var PAGE = 20000;        // log lines per request

  /* is this page being served by the hub? */
  Hub.detect = function (base, timeoutMs) {
    if (!G.fetch) return Promise.reject(new Error('no fetch'));
    var ctl = G.AbortController ? new G.AbortController() : null, t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 3000) : null;
    return G.fetch((base || '') + 'api/hub', { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) {
      if (t) clearTimeout(t);
      if (!r.ok) throw new Error('no hub');
      return r.json();
    }).then(function (st) { if (!st || !st.hub) throw new Error('no hub'); return st; });
  };

  function Feed(opts) {
    RS.Emitter.call(this);
    this.base = opts.base || '';
    this.mirror = opts.mirror;
    this.onSnap = opts.onSnap || function () {};
    this.epoch = null; this.idx = 0; this.lastT = 0; this.lastSnapT = 0; this.applied = 0;
    this.queue = []; this.qi = 0; this.draining = false; this.catching = false; this.live = false;
    this.status = null; this.skew = 0; this.es = null; this.closed = true; this.lastHeard = 0; this.gen = 0;
    this.total = 0; this.done = 0; this.errors = 0; this.state = 'idle'; this._laps = {}; this._lapDirty = {};
  }
  Feed.prototype = Object.create(RS.Emitter.prototype);
  Feed.prototype.now = function () { return Date.now() + this.skew; };     // hub clock
  Feed.prototype.start = function (status) {
    var self = this; this.closed = false;
    if (status && status.epoch) { this._status(status); this._begin(status.epoch); } else this._restart();
    this._watch = setInterval(function () { self._watchdog(); }, 2500);
    this._vis = function () { if (G.document && G.document.visibilityState === 'visible') self._watchdog(true); };
    if (G.document && G.document.addEventListener) G.document.addEventListener('visibilitychange', this._vis);
    return this;
  };
  Feed.prototype.stop = function () {
    this.closed = true; this.gen++; this.draining = false; this.queue = []; this.qi = 0; this._pollToken = null; clearTimeout(this._sseCheck);
    if (this.es) { try { this.es.close(); } catch (e) { /* */ } this.es = null; }
    clearInterval(this._watch);
    if (this._vis && G.document && G.document.removeEventListener) G.document.removeEventListener('visibilitychange', this._vis);
    this._setState('idle');
  };
  Feed.prototype._setState = function (s) { if (s !== this.state) { this.state = s; this.emit('state', s); } };
  Feed.prototype.fetchStatus = function () {
    return G.fetch(this.base + 'api/hub', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('hub answered ' + r.status); return r.json(); });
  };
  Feed.prototype._status = function (st) {
    if (!st) return;
    if (st.now) this.skew = st.now - Date.now();
    this.lastHeard = Date.now();
    this.status = Object.assign({}, this.status || {}, st);
    this.emit('status', this.status);
  };
  Feed.prototype._restart = function () {
    var self = this, gen = ++this.gen;
    this._setState('connecting');
    this.fetchStatus().then(function (st) { if (gen !== self.gen || self.closed) return; self._status(st); self._begin(st.epoch); },
      function (e) { if (gen !== self.gen || self.closed) return; self.errors++; self._setState('unreachable'); self.emit('error', e); setTimeout(function () { if (gen === self.gen && !self.closed) self._restart(); }, 3000); });
  };
  /* a (new) session log: clear everything and replay it from the start */
  Feed.prototype._begin = function (epoch) {
    var gen = ++this.gen;
    if (this.es) { try { this.es.close(); } catch (e) { /* */ } this.es = null; }
    this.epoch = epoch; this.idx = 0; this.lastT = 0; this.lastSnapT = 0; this.applied = 0;
    this.queue = []; this.qi = 0; this.draining = false; this._then = null; this._laps = {}; this._lapDirty = {}; this.catching = true; this.live = false; this.done = 0; this.total = 0;
    this.emit('reset', this.status || {});
    this._setState('catching-up');
    this._page(gen);
  };
  Feed.prototype._page = function (gen) {
    var self = this;
    G.fetch(this.base + 'api/log?epoch=' + encodeURIComponent(this.epoch) + '&from=' + this.idx + '&limit=' + PAGE, { cache: 'no-store' }).then(function (r) {
      if (r.status === 409) return r.json().then(function () { throw { epochChanged: true }; });
      if (!r.ok) throw new Error('hub answered ' + r.status);
      var next = parseInt(r.headers.get('X-Next'), 10), total = parseInt(r.headers.get('X-Total'), 10);
      return r.text().then(function (txt) { return { txt: txt, next: next, total: total }; });
    }).then(function (p) {
      if (gen !== self.gen || self.closed) return;
      var items = [], lines = p.txt.split('\n');
      for (var i = 0; i < lines.length; i++) { if (!lines[i]) continue; try { items.push(JSON.parse(lines[i])); } catch (e) { /* torn line */ } }
      self.total = isFinite(p.total) ? p.total : self.total;
      self.idx = isFinite(p.next) ? p.next : self.idx + items.length;
      self._enqueue(items, function () {
        if (gen !== self.gen || self.closed) return;
        if (self.idx < self.total && items.length) self._page(gen); else self._goLive(gen);
      });
    }).catch(function (e) {
      if (gen !== self.gen || self.closed) return;
      if (e && e.epochChanged) { self._restart(); return; }
      self._setState('unreachable'); self.emit('error', e);
      setTimeout(function () { if (gen === self.gen && !self.closed) self._page(gen); }, 3000);
    });
  };
  /* apply messages in order, in slices so the screen stays responsive */
  Feed.prototype._enqueue = function (items, then) {
    var self = this;
    if (items && items.length) for (var i = 0; i < items.length; i++) this.queue.push(items[i]);
    if (then) this._then = then;
    if (this.draining) return;
    this.draining = true;
    var gen = this.gen;
    var step = function () {
      if (gen !== self.gen || self.closed) return;
      var t0 = Date.now(), Q = self.queue, M = self.mirror, n = 0;
      while (self.qi < Q.length) {
        var it = Q[self.qi++], t = it.t > self.lastT ? it.t : self.lastT;     // never backwards
        var lap = self._lapChange(it.m);
        // rebuild the standings every 15 s of feed time, and always before a car's lap count changes a second time
        if (self.applied && (t - self.lastSnapT >= BUCKET || (lap && self._lapDirty[lap]))) { self.onSnap(self.lastT); self.markSnap(); }
        M.apply(it.m); self.applied++; self.lastT = t; self.done++;
        if (lap) self._lapDirty[lap] = 1;
        if (!self.lastSnapT) self.lastSnapT = t;
        if (++n >= 400) { n = 0; if (Date.now() - t0 > 25) break; }
      }
      if (self.catching) self.emit('progress', { done: self.done, total: Math.max(self.total, self.done) });
      if (self.qi < Q.length) { setTimeout(step, 0); return; }
      self.queue = []; self.qi = 0; self.draining = false;
      if (!self.catching) self.emit('data');
      var f = self._then; self._then = null; if (f) f();
    };
    step();
  };
  Feed.prototype.markSnap = function () { this.lastSnapT = this.lastT; this._lapDirty = {}; };
  /* the standings document this message moves to a new lap (LT2 'data' string), or null */
  var LAPS_IX = RS.LT2 && RS.LT2.DATA_MAP ? RS.LT2.DATA_MAP.indexOf('laps') : -1;
  Feed.prototype._lapChange = function (m) {
    if (LAPS_IX < 0 || !m || (m.msg !== 'changed' && m.msg !== 'added') || !m.fields || typeof m.fields.data !== 'string' || !/standing/i.test(m.collection || '')) return null;
    var key = m.collection + '|' + (typeof m.id === 'object' ? JSON.stringify(m.id) : m.id), laps = m.fields.data.split(';')[LAPS_IX];
    var was = this._laps[key]; this._laps[key] = laps;
    return was !== undefined && was !== laps ? key : null;
  };
  Feed.prototype._goLive = function (gen) {
    if (this.catching) { this.onSnap(this.lastT); this.lastSnapT = this.lastT; }
    this.catching = false; this.live = true;
    this.emit('live', { messages: this.done });
    this._setState('live');
    this._stream(gen);
  };
  Feed.prototype._stream = function (gen) {
    var self = this;
    if (this.es) { try { this.es.close(); } catch (e) { /* */ } this.es = null; }
    // internet links through a Cloudflare quick tunnel cannot carry Server-Sent Events: long-poll there
    if (!this.pollMode && G.location && /trycloudflare\.com$/i.test(G.location.hostname || '')) this.pollMode = true;
    if (!G.EventSource || this.pollMode) { this._poll(gen); return; }
    var heard = false;
    var es = this.es = new G.EventSource(this.base + 'api/stream?epoch=' + encodeURIComponent(this.epoch) + '&from=' + this.idx);
    clearTimeout(this._sseCheck);
    this._sseCheck = setTimeout(function () {         // nothing through this connection: a proxy is buffering it
      if (gen !== self.gen || self.closed || heard || self.es !== es) return;
      try { es.close(); } catch (e) { /* */ } self.es = null; self.pollMode = true; self._poll(gen);
    }, 7000);
    es.addEventListener('m', function (ev) {
      if (gen !== self.gen) return;
      heard = true;
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.now) self.skew = d.now - Date.now();
      self.lastHeard = Date.now();
      if (typeof d.n === 'number') self.idx = d.n;
      self._setState('live');
      self._enqueue(d.msgs || []);
    });
    es.addEventListener('s', function (ev) { if (gen !== self.gen) return; heard = true; try { self._status(JSON.parse(ev.data)); } catch (e) { /* */ } self._setState('live'); });
    es.addEventListener('epoch', function () { if (gen !== self.gen) return; try { es.close(); } catch (e) { /* */ } self._restart(); });
    es.onerror = function () { if (gen !== self.gen) return; self._setState('reconnecting'); if (es.readyState === 2) setTimeout(function () { if (gen === self.gen && !self.closed && self.es === es) self._stream(gen); }, 2000); };
  };
  /* long-polling: the hub holds each request until new messages arrive (up to 20 s) */
  Feed.prototype._poll = function (gen) {
    var self = this, token = this._pollToken = {};
    var alive = function () { return gen === self.gen && !self.closed && self._pollToken === token; };
    var status = function () {
      if (!alive()) return;
      self.fetchStatus().then(function (st) { if (!alive()) return; if (st.epoch !== self.epoch) { self._restart(); return; } self._status(st); }, function () { /* */ });
      setTimeout(status, 3000);
    };
    var go = function () {
      if (!alive()) return;
      G.fetch(self.base + 'api/log?epoch=' + encodeURIComponent(self.epoch) + '&from=' + self.idx + '&limit=' + PAGE + '&wait=20', { cache: 'no-store' }).then(function (r) {
        if (!alive()) return null;
        if (r.status === 409) { self._restart(); return null; }
        if (!r.ok) throw new Error('hub answered ' + r.status);
        var next = parseInt(r.headers.get('X-Next'), 10), now = parseInt(r.headers.get('X-Now'), 10);
        return r.text().then(function (txt) {
          if (!alive()) return;
          var items = [], lines = txt.split('\n');
          for (var i = 0; i < lines.length; i++) { if (!lines[i]) continue; try { items.push(JSON.parse(lines[i])); } catch (e) { /* */ } }
          if (isFinite(now)) self.skew = now - Date.now();
          if (isFinite(next)) self.idx = next;
          self.lastHeard = Date.now(); self._setState('live');
          if (items.length) self._enqueue(items);
          setTimeout(go, 0);
        });
      }).catch(function () { if (!alive()) return; self._setState('reconnecting'); setTimeout(go, 2000); });
    };
    go(); status();
  };
  /* nothing heard for a while (phone slept, network changed): reopen; a restarted hub answers with a new epoch */
  Feed.prototype._watchdog = function (now) {
    if (this.closed || !this.live) return;
    var quiet = Date.now() - this.lastHeard;
    if (quiet > (now ? 4000 : 9000)) {
      var self = this, gen = this.gen;
      this._setState('reconnecting');
      this.fetchStatus().then(function (st) {
        if (gen !== self.gen || self.closed) return;
        self._status(st);
        if (st.epoch !== self.epoch) self._restart(); else self._stream(gen);     // (re)opens SSE, or restarts the long-poll loop
      }, function () { if (gen === self.gen) self._setState('unreachable'); });
    }
  };
  Hub.Feed = Feed;

  /* small helpers for the laptop's controls */
  Hub.post = function (base, path, body) {
    return G.fetch((base || '') + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error || ('hub answered ' + r.status)); return j; });
    });
  };
  /* settings shared from the laptop to the crew phones (not the per-device connection settings) */
  Hub.SHARED = ['hero', 'sisters', 'teamCars', 'follows', 'trackPreset', 'raceHours', 'fuel', 'pitPreset', 'pitManualS', 'fcyLossFactor', 'learnPitLoss',
    'yellowBurn', 'refuelMinLaneS', 'maxStintMin', 'minDriveMin', 'pitInPct', 'pitOutPct', 'paceLaps', 'classFocus'];
  Hub.shared = function (s) { var o = {}; Hub.SHARED.forEach(function (k) { if (s[k] !== undefined) o[k] = s[k]; }); return o; };
})(typeof window !== 'undefined' ? window : globalThis);
