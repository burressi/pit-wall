/* Zenith Strategy — bridge receiver, optional secure proxy client and results-file poller */
(function (G) {
  'use strict';
  var RS = G.RS;

  RS.ALKAMEL_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(alkamelsystems\.com|alkamelcloud\.com|alkamelna\.com)$/i;
  RS.LT2_URL = 'https://livetiming.alkamelsystems.com/zenith';
  RS.LT2_WS = 'wss://livetiming.alkamelsystems.com/websocket';
  RS.RESULTS_ROOT = 'http://usac.alkamelsystems.com/Results/08_Zenith%20Racing%20Series/';

  /* Receives postMessage traffic from the bridge running on the Al Kamel page. */
  function BridgeReceiver(mirror) {
    RS.Emitter.call(this);
    this.mirror = mirror; this.active = false; this.mode = null; this.last = null; this.msgs = 0; this.subs = []; this.ddpUrl = null; this.page = null;
    var self = this;
    this._onMsg = function (e) { self._handle(e); };
  }
  BridgeReceiver.prototype = Object.create(RS.Emitter.prototype);
  BridgeReceiver.prototype.listen = function () { G.addEventListener('message', this._onMsg); };
  BridgeReceiver.prototype.stop = function () { G.removeEventListener('message', this._onMsg); this.active = false; };
  BridgeReceiver.prototype._handle = function (e) {
    var d = e.data;
    if (!d || d.zs !== 1 || !RS.ALKAMEL_ORIGIN.test(e.origin)) return;
    this.msgs++; this.last = Date.now();
    var ack = function (extra) { try { e.source.postMessage(Object.assign({ zsAck: 1 }, extra || {}), e.origin); } catch (x) { /* */ } };
    switch (d.kind) {
      case 'hello':
        this.active = true; this.page = d.url; ack(); this.emit('hello', d); break;
      case 'meteor-init':
        this.mode = 'meteor'; this.subs = d.subs || []; this.ddpUrl = d.ddpUrl || null; this.page = d.url;
        this.mirror.load(d.cols || {}); this.emit('subs', this.subs); this.emit('data'); break;
      case 'ddp-batch':
        var any = false;
        (d.raws || []).forEach(function (raw) {
          var m; try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (x) { return; }
          if (Array.isArray(m)) m.forEach(function (mm) { any = this.mirror.apply(mm) || any; }, this);
          else any = this.mirror.apply(m) || any;
        }, this);
        if (any) this.emit('data'); break;
      case 'subs':
        this.subs = d.subs || []; this.emit('subs', this.subs); break;
      case 'dom':
        this.mode = 'table'; this.emit('dom', d); break;
    }
  };
  RS.BridgeReceiver = BridgeReceiver;

  RS.bridgeCode = function (dashOrigin, dashUrl) {
    return String(RS.BRIDGE_SRC || '').replace(/__DASH_ORIGIN__/g, dashOrigin).replace(/__DASH_URL__/g, dashUrl);
  };
  RS.bookmarklet = function (dashOrigin, dashUrl) {
    var code = RS.bridgeCode(dashOrigin, dashUrl).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*/g, ' ');
    return 'javascript:' + encodeURIComponent(code);
  };
  RS.userscript = function (dashOrigin, dashUrl) {
    return [
      '// ==UserScript==',
      '// @name         Zenith Strategy bridge',
      '// @namespace    zenith-strategy',
      '// @version      1.0',
      '// @description  Sends the Al Kamel live timing you are viewing to your strategy dashboard window (postMessage, same browser).',
      '// @match        https://livetiming.alkamelsystems.com/*',
      '// @run-at       document-idle',
      '// @grant        none',
      '// ==/UserScript==',
      'setTimeout(function () {', RS.bridgeCode(dashOrigin, dashUrl), '}, 4000);', ''
    ].join('\n');
  };

  /* Optional Cloudflare Worker proxy (see worker/ in the package). */
  function Proxy(cfg) { this.url = (cfg && cfg.url || '').replace(/\/+$/, ''); this.key = cfg && cfg.key || ''; }
  Proxy.prototype.ok = function () { return !!(this.url && this.key); };
  Proxy.prototype.fetchText = function (target) {
    if (!this.ok()) return Promise.reject(new Error('Set the proxy address and access key in Settings first.'));
    return fetch(this.url + '/fetch?url=' + encodeURIComponent(target), { headers: { 'X-Access-Key': this.key }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error('Proxy ' + r.status + ': ' + t.slice(0, 160)); }); return r.text(); });
  };
  Proxy.prototype.wsUrl = function (target) {
    return this.url.replace(/^http/, 'ws') + '/ws?url=' + encodeURIComponent(target) + '&key=' + encodeURIComponent(this.key);
  };
  // Find the newest analysis CSV under a session (or hour) folder of the Al Kamel results site
  Proxy.prototype.findAnalysis = function (folderUrl, depth) {
    var self = this; depth = depth || 0;
    if (/\.csv$/i.test(folderUrl)) return Promise.resolve(folderUrl);
    var base = folderUrl.replace(/\/?$/, '/');
    return this.fetchText(base).then(function (html) {
      var links = [], re = /href\s*=\s*["']([^"'#?]+)["']/gi, m;
      while ((m = re.exec(html))) { try { links.push(new URL(m[1], base).href); } catch (e) { /* */ } }
      var csv = links.filter(function (h) { return /23_Analysis[^/]*\.csv$/i.test(h); });
      if (csv.length) { csv.sort(); return csv[csv.length - 1]; }
      var hours = links.filter(function (h) { return /Hour(%20|\s|_)*\d+\/?$/i.test(h) && h.indexOf(base) === 0; });
      if (hours.length && depth < 2) {
        hours.sort(function (a, b) { return parseInt(a.match(/(\d+)\/?$/)[1], 10) - parseInt(b.match(/(\d+)\/?$/)[1], 10); });
        return self.findAnalysis(hours[hours.length - 1], depth + 1);
      }
      throw new Error('No analysis CSV found in that folder yet.');
    });
  };
  RS.Proxy = Proxy;
})(typeof window !== 'undefined' ? window : globalThis);
