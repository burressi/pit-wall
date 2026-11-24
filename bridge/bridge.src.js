(function () {
  /* Zenith Strategy bridge: runs on the Al Kamel live timing page and forwards what that page already
     receives to your strategy dashboard window (same browser, postMessage). Nothing is stored or sent elsewhere. */
  var ORIGIN = '__DASH_ORIGIN__', DASH = '__DASH_URL__', V = 1;
  if (window.__zsBridge) { window.__zsBridge.show(); return; }
  var target = (window.opener && !window.opener.closed) ? window.opener : null;
  var acked = false, mode = '', queue = [], lastDom = '', sent = 0;
  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;font:12px/1.35 system-ui,sans-serif;background:#0f172a;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.45);cursor:pointer;max-width:330px';
  function setBadge(t, c) { badge.textContent = 'Strategy bridge: ' + t; badge.style.borderLeft = '4px solid ' + c; }
  (document.body || document.documentElement).appendChild(badge);
  badge.addEventListener('click', function () { if (!acked) { target = window.open(DASH, 'zenith-strategy'); hello(); } else { badge.style.display = 'none'; } });
  function post(m) { if (!target) return; m.zs = 1; m.v = V; try { target.postMessage(m, ORIGIN); sent++; } catch (e) { /* window gone */ } }
  function hello() { post({ kind: 'hello', url: location.href, title: document.title }); }
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.zsAck !== 1) return;
    if (!acked) { acked = true; setBadge('connected (' + mode + ') — click to hide', '#22c55e'); init(); }
    if (e.data.resend) init();
  });
  var M = window.Meteor || (window.Package && window.Package.meteor && window.Package.meteor.Meteor);
  function subsList() {
    var out = [];
    try { var s = M.connection._subscriptions; for (var id in s) out.push({ name: s[id].name, params: s[id].params, ready: !!s[id].ready }); } catch (e) { /* */ }
    return out;
  }
  function init() {
    if (mode !== 'meteor') return;
    var conn = M.connection, cols = {};
    for (var name in conn._stores) {
      try { var st = conn._stores[name], c = st._getCollection && st._getCollection(); if (c && c.find) cols[name] = c.find({}, { reactive: false }).fetch(); } catch (e) { /* */ }
    }
    var raw = (conn._stream && (conn._stream.rawUrl || conn._stream.url)) || location.origin;
    post({ kind: 'meteor-init', subs: subsList(), cols: cols, url: location.href, title: document.title, ddpUrl: String(raw) });
  }
  function txt(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function scrape() {
    var best = null, bestN = 0, tables = document.querySelectorAll('table'), headers = [], data = [];
    for (var i = 0; i < tables.length; i++) { var n = tables[i].querySelectorAll('tr').length; if (n > bestN && tables[i].offsetParent !== null) { best = tables[i]; bestN = n; } }
    if (best && bestN >= 3) {
      var trs = best.querySelectorAll('tr'), head = best.querySelector('thead tr') || trs[0];
      headers = [].map.call(head.children, txt);
      for (var j = 0; j < trs.length; j++) { if (trs[j] === head) continue; var cells = [].map.call(trs[j].children, txt); if (cells.length >= 4) data.push(cells); }
    } else {
      var all = document.querySelectorAll('div,ul,tbody,section'), cand = null, cn = 0;
      for (var k = 0; k < all.length; k++) {
        var ch = all[k].children; if (ch.length < 5) continue;
        var sig = ch[1].tagName + '|' + ch[1].className, same = 0;
        for (var q = 0; q < ch.length; q++) if ((ch[q].tagName + '|' + ch[q].className) === sig && ch[q].children.length >= 4) same++;
        if (same > cn) { cn = same; cand = all[k]; }
      }
      if (cand && cn >= 3) {
        var rowsEls = [].filter.call(cand.children, function (x) { return x.children.length >= 4; });
        var hdr = cand.previousElementSibling && cand.previousElementSibling.children.length >= 4 ? cand.previousElementSibling : rowsEls.shift();
        headers = [].map.call(hdr.children, txt);
        rowsEls.forEach(function (r) { data.push([].map.call(r.children, txt)); });
      }
    }
    var meta = { title: document.title, clocks: [], flagText: '' };
    var els = document.querySelectorAll('[class*=time],[class*=clock],[class*=remain],[id*=time],[id*=clock],[class*=flag],[class*=status],[class*=session],[class*=Time],[class*=Flag]');
    for (var e = 0; e < els.length && e < 300; e++) {
      var el = els[e]; if (el.children.length > 3) continue;
      var t = txt(el), hint = String(el.className) + ' ' + el.id;
      if (/^\d{1,2}:\d{2}:\d{2}$/.test(t)) meta.clocks.push({ text: t, hint: hint });
      else if (!meta.flagText && t.length < 40 && /green|yellow|fcy|red flag|chequer|checker|safety|code 60|finish/i.test(t)) meta.flagText = t;
    }
    var payload = { kind: 'dom', headers: headers, rows: data, meta: meta }, js = JSON.stringify(payload);
    if (js !== lastDom) { lastDom = js; post(payload); }
  }
  if (M && M.connection && M.connection._stream && M.connection._stream.on && M.connection._stores) {
    mode = 'meteor';
    M.connection._stream.on('message', function (raw) { queue.push(raw); });
    setInterval(function () { if (queue.length && acked) { post({ kind: 'ddp-batch', raws: queue }); } queue = []; }, 250);
    setInterval(function () { if (acked) post({ kind: 'subs', subs: subsList() }); }, 15000);
  } else {
    mode = 'table';
    setInterval(function () { if (acked) scrape(); }, 1000);
  }
  setBadge(target ? 'waiting for the dashboard…' : 'click here to open the dashboard', '#f59e0b');
  hello();
  var hi = setInterval(function () { if (acked) { clearInterval(hi); return; } hello(); }, 2000);
  setTimeout(function () { if (!acked) setBadge('dashboard not reachable — open it from the dashboard\'s "Open Zenith live timing" button, then click this bridge again', '#ef4444'); }, 8000);
  window.__zsBridge = { show: function () { badge.style.display = 'block'; }, stats: function () { return { mode: mode, sent: sent, acked: acked }; } };
})();
