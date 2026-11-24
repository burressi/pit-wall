/* Zenith Strategy — shared helpers */
(function (G) {
  'use strict';
  var RS = G.RS = G.RS || {};

  /* ---------- time ---------- */
  // "1:32.564", "32.564", "0:01:47.679", "+1.234", 92564 (ms) or 92.564 (s) -> ms
  RS.toMs = function (v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      if (Math.abs(v) >= 1e11) return null;           // epoch-like, not a duration
      if (Math.abs(v) >= 3000 || Number.isInteger(v) && Math.abs(v) >= 1000) return Math.round(v); // ms
      return Math.round(v * 1000);                     // seconds
    }
    if (typeof v === 'object') {
      if (v.$date) return null;
      var c = v.ms ?? v.millis ?? v.time ?? v.value ?? v.t;
      return c === undefined ? null : RS.toMs(c);
    }
    var s = String(v).trim().replace(/^\+/, '');
    if (!s || /lap|pit|ret|dnf|dns|-{1,}$|^\D+$/i.test(s)) return null;
    var neg = s[0] === '-'; if (neg) s = s.slice(1);
    var parts = s.split(':'), x = 0;
    for (var i = 0; i < parts.length; i++) { var p = parseFloat(parts[i]); if (isNaN(p)) return null; x = x * 60 + p; }
    return Math.round((neg ? -x : x) * 1000);
  };
  // laps-down text ("1 Lap", "3 Laps", "+2L") -> integer or null
  RS.lapsText = function (v) {
    if (v === null || v === undefined) return null;
    var m = String(v).match(/^\s*\+?(\d+)\s*(l|lap|laps)\b/i);
    return m ? parseInt(m[1], 10) : null;
  };
  RS.fmtLap = function (ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '';
    var neg = ms < 0; ms = Math.abs(ms);
    var m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
    var t = m ? m + ':' + (s < 10 ? '0' : '') + s.toFixed(3) : s.toFixed(3);
    return (neg ? '-' : '') + t;
  };
  RS.fmtGap = function (ms, digits) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '';
    var d = digits === undefined ? 1 : digits, a = Math.abs(ms) / 1000, sign = ms < 0 ? '-' : '+';
    if (a >= 60) { var m = Math.floor(a / 60); var s = a - m * 60; return sign + m + ':' + (s < 10 ? '0' : '') + s.toFixed(d); }
    return sign + a.toFixed(d);
  };
  RS.fmtClock = function (ms, withSec) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '--:--';
    var neg = ms < 0; ms = Math.abs(Math.round(ms / 1000));
    var h = Math.floor(ms / 3600), m = Math.floor(ms % 3600 / 60), s = ms % 60;
    var t = h + ':' + (m < 10 ? '0' : '') + m + (withSec === false ? '' : ':' + (s < 10 ? '0' : '') + s);
    return (neg ? '-' : '') + t;
  };
  RS.fmtTod = function (ms) { // time of day
    if (ms === null || ms === undefined || !isFinite(ms)) return '';
    ms = ((ms % 86400000) + 86400000) % 86400000;
    return RS.fmtClock(ms);
  };
  RS.fmtNum = function (v, d) { return v === null || v === undefined || !isFinite(v) ? '' : Number(v).toFixed(d === undefined ? 1 : d); };

  /* ---------- stats ---------- */
  RS.median = function (a) {
    if (!a || !a.length) return null;
    var b = a.slice().sort(function (x, y) { return x - y; }), m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  RS.mean = function (a) { if (!a || !a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
  RS.pct = function (a, q) {
    if (!a || !a.length) return null;
    var b = a.slice().sort(function (x, y) { return x - y; });
    return b[Math.min(b.length - 1, Math.max(0, Math.round(q * (b.length - 1))))];
  };
  RS.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  /* ---------- html ---------- */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  RS.esc = function (s) { return s === null || s === undefined ? '' : String(s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };

  /* ---------- storage ---------- */
  RS.store = {
    get: function (k, d) { try { var v = G.localStorage && G.localStorage.getItem('zs.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { G.localStorage && G.localStorage.setItem('zs.' + k, JSON.stringify(v)); } catch (e) { /* quota */ } },
    del: function (k) { try { G.localStorage && G.localStorage.removeItem('zs.' + k); } catch (e) { /* ignore */ } }
  };

  /* ---------- tiny emitter ---------- */
  RS.Emitter = function () { this._h = {}; };
  RS.Emitter.prototype.on = function (n, f) { (this._h[n] = this._h[n] || []).push(f); return this; };
  RS.Emitter.prototype.off = function (n, f) { var h = this._h[n]; if (h) this._h[n] = h.filter(function (x) { return x !== f; }); };
  RS.Emitter.prototype.emit = function (n, a, b) { var h = this._h[n]; if (h) for (var i = 0; i < h.length; i++) { try { h[i](a, b); } catch (e) { if (G.console) console.error(e); } } };

  RS.FLAG_LABEL = { GF: 'GREEN', FCY: 'FULL COURSE YELLOW', SC: 'SAFETY CAR', YF: 'YELLOW', RF: 'RED FLAG', FF: 'CHEQUERED', CHK: 'CHEQUERED', NONE: 'NO SESSION' };
  // normalise a flag/state string from any source
  RS.normFlag = function (v) {
    if (v === null || v === undefined || v === '') return null;
    var s = String(v).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim();
    if (/^(GF|GREEN|GREEN FLAG|RACING|RUNNING|GO)$/.test(s) || /\bGREEN\b/.test(s)) return 'GF';
    if (/\b(FCY|FULL COURSE|CODE ?60|VSC|VIRTUAL)\b/.test(s)) return 'FCY';
    if (/\b(SC|SAFETY ?CAR|PACE ?CAR|CAUTION)\b/.test(s)) return 'SC';
    if (/\b(RF|RED)\b/.test(s)) return 'RF';
    if (/\b(FF|CHK|CHEQ|CHECK|FINISH|FINISHED|ENDED|END)\b/.test(s)) return 'FF';
    if (/\b(YF|YELLOW|SLOW ZONE)\b/.test(s)) return 'YF';
    return null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
