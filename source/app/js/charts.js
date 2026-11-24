/* Zenith Strategy — dependency-free canvas charts */
(function (G) {
  'use strict';
  var RS = G.RS;
  var C = RS.Chart = {};

  function setup(cv) {
    var dpr = G.devicePixelRatio || 1, w = cv.clientWidth || 600, h = cv.clientHeight || 260;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }
  function css(name, fb) { try { var v = G.getComputedStyle(G.document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; } }
  function niceStep(span, n) {
    var raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }

  /* opts: {series:[{name,color,points:[{x,y,pit,slow}],width,dash,label}], yFmt, xFmt, invertY, band:{y0,y1,color,label}, refs:[{y,color,label}], yMin,yMax, empty} */
  C.line = function (cv, o) {
    var s = setup(cv), g = s.g, W = s.w, H = s.h;
    var fg = css('--muted', '#94a3b8'), grid = css('--grid', 'rgba(148,163,184,.15)'), text = css('--text', '#e2e8f0');
    var pad = { l: 64, r: 14, t: 12, b: 26 };
    var pts = []; (o.series || []).forEach(function (se) { se.points.forEach(function (p) { if (p.y !== null && isFinite(p.y)) pts.push(p); }); });
    g.font = '11px system-ui, sans-serif';
    if (!pts.length) { g.fillStyle = fg; g.textAlign = 'center'; g.fillText(o.empty || 'No data yet', W / 2, H / 2); return; }
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach(function (p) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; });
    if (o.yMin !== undefined && o.yMin !== null) y0 = o.yMin; if (o.yMax !== undefined && o.yMax !== null) y1 = o.yMax;
    if (o.band) { y0 = Math.min(y0, o.band.y0); y1 = Math.max(y1, o.band.y1); }
    (o.refs || []).forEach(function (r) { y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y); });
    if (x1 === x0) x1 = x0 + 1; if (y1 === y0) { y1 += 1000; y0 -= 1000; }
    var yp = (y1 - y0) * 0.06; y0 -= yp; y1 += yp;
    var X = function (x) { return pad.l + (x - x0) / (x1 - x0) * (W - pad.l - pad.r); };
    var Y = function (y) { var f = (y - y0) / (y1 - y0); if (o.invertY) f = 1 - f; return H - pad.b - f * (H - pad.t - pad.b); };
    // grid + axes
    g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = fg; g.textAlign = 'right'; g.textBaseline = 'middle';
    var ys = niceStep(y1 - y0, 6);
    for (var yv = Math.ceil(y0 / ys) * ys; yv <= y1; yv += ys) {
      g.beginPath(); g.moveTo(pad.l, Y(yv)); g.lineTo(W - pad.r, Y(yv)); g.stroke();
      g.fillText(o.yFmt ? o.yFmt(yv) : String(Math.round(yv)), pad.l - 6, Y(yv));
    }
    var xs = Math.max(1, niceStep(x1 - x0, 10)); g.textAlign = 'center'; g.textBaseline = 'top';
    for (var xv = Math.ceil(x0 / xs) * xs; xv <= x1; xv += xs) {
      g.beginPath(); g.moveTo(X(xv), pad.t); g.lineTo(X(xv), H - pad.b); g.stroke();
      g.fillText(o.xFmt ? o.xFmt(xv) : String(Math.round(xv)), X(xv), H - pad.b + 5);
    }
    if (o.band) {
      g.fillStyle = o.band.color || 'rgba(168,85,247,.12)';
      var a = Y(o.band.y0), b = Y(o.band.y1); g.fillRect(pad.l, Math.min(a, b), W - pad.l - pad.r, Math.abs(b - a));
      if (o.band.label) { g.fillStyle = text; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(o.band.label, pad.l + 6, Math.min(a, b) - 2); }
    }
    (o.refs || []).forEach(function (r) {
      g.save(); g.strokeStyle = r.color || fg; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(pad.l, Y(r.y)); g.lineTo(W - pad.r, Y(r.y)); g.stroke(); g.restore();
      if (r.label) { g.fillStyle = r.color || fg; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(r.label, W - pad.r - 4, Y(r.y) - 2); }
    });
    // series
    (o.series || []).forEach(function (se) {
      g.save(); g.strokeStyle = se.color; g.lineWidth = se.width || 1.6; if (se.dash) g.setLineDash(se.dash);
      g.beginPath(); var started = false;
      se.points.forEach(function (p) {
        if (p.y === null || !isFinite(p.y) || p.y < y0 || p.y > y1) { started = false; return; }
        if (!started) { g.moveTo(X(p.x), Y(p.y)); started = true; } else g.lineTo(X(p.x), Y(p.y));
      });
      g.stroke(); g.restore();
      g.fillStyle = se.color;
      se.points.forEach(function (p) {
        if (!p.pit || p.y === null || p.y < y0 || p.y > y1) return;
        var px = X(p.x), py = Y(p.y); g.beginPath(); g.moveTo(px, py - 5); g.lineTo(px - 4, py + 3); g.lineTo(px + 4, py + 3); g.closePath(); g.fill();
      });
      var last = null; for (var i = se.points.length - 1; i >= 0; i--) if (se.points[i].y !== null && se.points[i].y >= y0 && se.points[i].y <= y1) { last = se.points[i]; break; }
      if (last && se.label) { g.fillStyle = se.color; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = 'bold 11px system-ui, sans-serif'; g.fillText(se.label, Math.min(W - 40, X(last.x) + 4), Y(last.y)); g.font = '11px system-ui, sans-serif'; }
    });
    if (o.xLabel) { g.fillStyle = fg; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(o.xLabel, W - pad.r, H - 2); }
  };

  /* circular "time map": every car placed by the fraction of its lap completed (dead-reckoned from its pace) */
  C.timeMap = function (cv, o) {
    var s = setup(cv), g = s.g, W = s.w, H = s.h;
    var cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) / 2 - 34;
    var fg = css('--muted', '#94a3b8'), text = css('--text', '#e2e8f0');
    g.lineWidth = 14; g.strokeStyle = css('--track', 'rgba(148,163,184,.18)');
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    var ang = function (f) { return -Math.PI / 2 + f * Math.PI * 2; };
    // start/finish
    g.strokeStyle = text; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy - R - 12); g.lineTo(cx, cy - R + 12); g.stroke();
    g.fillStyle = fg; g.font = '11px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('S/F', cx, cy - R - 18);
    // pit-loss arc behind the hero
    if (o.ghost && o.hero) {
      var a0 = ang(o.ghost.frac), a1 = ang(o.hero.frac);
      g.strokeStyle = 'rgba(168,85,247,.35)'; g.lineWidth = 22; g.beginPath();
      if (o.ghost.frac <= o.hero.frac) g.arc(cx, cy, R, a0, a1); else { g.arc(cx, cy, R, a0, ang(1)); g.moveTo(cx + R * Math.cos(ang(0)), cy + R * Math.sin(ang(0))); g.arc(cx, cy, R, ang(0), a1); }
      g.stroke();
      var gx = cx + (R + 26) * Math.cos(a0), gy = cy + (R + 26) * Math.sin(a0);
      g.fillStyle = '#c084fc'; g.font = 'bold 11px system-ui, sans-serif'; g.fillText(o.ghost.label || 'pit ghost', gx, gy);
      g.strokeStyle = '#c084fc'; g.lineWidth = 2; g.setLineDash([3, 3]); g.beginPath(); g.arc(cx + R * Math.cos(a0), cy + R * Math.sin(a0), 9, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    (o.cars || []).slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).forEach(function (c) {
      var a = ang(c.frac), r = c.inPit ? R - 26 : R, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      var big = c.hero || c.sister || c.follow;
      g.beginPath(); g.arc(x, y, big ? 9 : 5, 0, Math.PI * 2); g.fillStyle = c.color; g.globalAlpha = c.dim ? 0.35 : 1; g.fill(); g.globalAlpha = 1;
      if (c.hero || c.sister) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
      if (big || c.labelAlways) {
        g.fillStyle = text; g.font = (big ? 'bold ' : '') + '11px system-ui, sans-serif'; g.textAlign = 'center';
        var lx = cx + (r - 24) * Math.cos(a), ly = cy + (r - 24) * Math.sin(a);
        g.fillText('#' + c.n + (c.tag ? ' ' + c.tag : ''), lx, ly + 4);
      }
    });
    if (o.caption) { g.fillStyle = fg; g.font = '11px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(o.caption, cx, cy + 4); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
