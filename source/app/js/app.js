/* Zenith Strategy — controller: sources, dialogs, settings, render loop */
(function (G) {
  'use strict';
  var RS = G.RS, D = G.document, UI = RS.UI;
  var $ = function (id) { return D.getElementById(id); };
  var esc = RS.esc;

  var App = RS.App = {
    ui: Object.assign({ clsTab: 'hero', chartCars: [], autoChart: true, tab: 'gap', gapMode: 'hero', ppCar: null, selected: null, logScope: 'relevant', planLap: {},
      view: 'pitwall', pwFilter: 'around', pwNeighbours: 'class', pwPhoneTab: 'gaps' }, RS.store.get('ui', {})),
    source: { kind: 'none', label: 'Offline', status: '' },
    calls: RS.store.get('calls', []),
    learnedSubs: RS.store.get('lt2subs', []),
    lastDom: null
  };

  /* ---------------- settings ---------------- */
  function loadSettings() {
    var s = Object.assign({}, RS.DEFAULTS, { teamCars: ['177', '178'], trackPreset: '', raceHours: 0,
      direct: { url: RS.LT2_WS, viaProxy: false }, proxy: { url: '', key: '' }, overrides: {},
      lt2: null }, RS.store.get('settings', {}));
    var phone = G.matchMedia ? G.matchMedia('(max-width: 760px)').matches : false;   // phones: no recording by default (memory)
    s.lt2 = Object.assign({ series: 'zenith', transport: 'sockjs', session: 'auto', viaProxy: false, record: !phone, recipe: null, learned: {}, dataMap: '' }, s.lt2 || {});
    s.fuel = Object.assign({}, RS.DEFAULTS.fuel, s.fuel || {});
    return s;
  }
  App.saveSettings = function () {
    RS.store.set('settings', App.settings);
    App.engine.settings = App.settings;
    App.adapter.ov = App.settings.overrides || {};
    App.dirty = true;
    if (App.hub && App.hubStatus && App.hubStatus.local) App.hubPushSettings();
  };
  App.applyTrack = function (eventId, opts) {
    var T = (RS.TRACKS || {})[eventId]; if (!T) return false;
    var m = App.engine.meta;
    if (!m.refLapMs || !Object.keys(m.refLapMs).length || (opts && opts.force)) { m.refLapMs = T.refLapMs; }
    if (!m.pitLaneMs || !Object.keys(m.pitLaneMs).length || (opts && opts.force)) { m.pitLaneMs = T.pitLaneMs; m.transitDeltaMs = T.transitDeltaMs; }
    var TF = (App.settings.trackFuel || {})[eventId] || T.fuel || {};
    if (opts && opts.fuel) Object.keys(TF).forEach(function (n) { if (TF[n]) { App.settings.fuel[n] = Object.assign({}, App.settings.fuel[n] || { tank: 18, reserve: 0.5 }, { burn: TF[n] }); } });
    return true;
  };

  /* ---------------- toast / sound ---------------- */
  var toastT = null;
  App.toast = function (msg, ms) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, ms || 3500); };
  var actx = null;
  function beep() {
    if (!App.settings.sound) return;
    try { actx = actx || new (G.AudioContext || G.webkitAudioContext)(); var o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(actx.destination); g.gain.value = 0.08; o.start(); o.stop(actx.currentTime + 0.25); } catch (e) { /* no audio */ }
  }

  /* ---------------- sources ---------------- */
  function stopSources() {
    if (App.replay) { App.replay.pause(); App.replay = null; }
    if (App.ddp) { App.ddp.close(); App.ddp = null; }
    if (App.lt2c) { App.lt2c.stop(); App.lt2c = null; }
    if (App.recPlayer) { App.recPlayer.pause(); App.recPlayer = null; }
    if (App.hub) { App.hub.stop(); App.hub = null; }
    App.lt2model = null; App.lt2 = null; App.hubProgress = null;
    if (App.pollTimer) { clearInterval(App.pollTimer); App.pollTimer = null; }
    $('replaybar').hidden = true;
  }
  function setSource(kind, label, status) { App.source = { kind: kind, label: label, status: status || '' }; App.dirty = true; }
  App.resetChart = function () { App.ui.autoChart = true; App.ui.chartCars = []; };

  /* ---------------- team pack: race replays + the team's fuel numbers, kept out of the public page ---------------- */
  var IDB = {
    db: function () {
      return new Promise(function (res, rej) {
        if (!G.indexedDB) return rej(new Error('no storage'));
        var q = G.indexedDB.open('pit-wall', 1);
        q.onupgradeneeded = function () { q.result.createObjectStore('kv'); };
        q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); };
      });
    },
    run: function (mode, fn) {
      return IDB.db().then(function (db) {
        return new Promise(function (res, rej) { var t = db.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = function () { res(q && q.result); }; t.onerror = function () { rej(t.error); }; });
      });
    },
    get: function (k) { return IDB.run('readonly', function (st) { return st.get(k); }); },
    set: function (k, v) { return IDB.run('readwrite', function (st) { return st.put(v, k); }); },
    del: function (k) { return IDB.run('readwrite', function (st) { return st.delete(k); }); }
  };
  App.teamReplays = {};
  App.builtinReplays = (RS.REPLAY_INDEX || []).slice();
  // opts.auto: loaded at start-up (from the hub or this browser) - adds the replays and per-track fuel without touching
  // the fuel numbers already in Settings; a pack the user loads also sets the fuel for the current track
  App.loadTeamPack = function (text, opts) {
    opts = opts || {};
    var pack = typeof text === 'string' ? JSON.parse(text) : text;
    if (!pack || pack.kind !== 'pit-wall-team-pack') throw new Error('That file is not a pit wall team pack.');
    var s = App.settings, ps = pack.settings || {};
    s.trackFuel = ps.trackFuel || {};
    if (!opts.auto) {
      Object.keys(ps.fuel || {}).forEach(function (n) { s.fuel[n] = Object.assign({}, s.fuel[n] || {}, ps.fuel[n]); });
      if (ps.teamCars && ps.teamCars.length) { s.teamCars = ps.teamCars.slice(); s.sisters = s.teamCars.filter(function (x) { return String(x) !== String(s.hero); }); }
      if (s.trackPreset) App.applyTrack(s.trackPreset, { fuel: true });
    }
    App.teamReplays = pack.replays || {};
    var have = {}; App.builtinReplays.forEach(function (r) { have[r.id] = 1; });
    RS.REPLAY_INDEX = App.builtinReplays.concat((pack.replayIndex || []).filter(function (r) { return !have[r.id] && App.teamReplays[r.id]; }));
    App.teamPack = { built: pack.built, team: pack.team || '', races: Object.keys(App.teamReplays).length, from: opts.from || 'file' };
    App.saveSettings();
    if (!opts.auto && opts.from !== 'hub') IDB.set('team-pack', typeof text === 'string' ? text : JSON.stringify(pack)).catch(function () { App.toast('Loaded, but this browser would not keep it - load it again next time.', 6000); });
    return App.teamPack;
  };
  App.readTeamPack = function (f) {
    var r = new FileReader();
    r.onload = function () {
      try { var tp = App.loadTeamPack(String(r.result)); App.toast('Team pack loaded: ' + tp.races + ' race replays and your fuel numbers. This browser keeps it.', 6000); if ($('dlg-source').open) App.openSource(true); if ($('dlg-settings').open) App.openSettings(); }
      catch (e) { App.toast(e.message, 6000); }
    };
    r.readAsText(f);
  };
  App.forgetTeamPack = function () {
    IDB.del('team-pack').catch(function () { /* */ });
    App.teamReplays = {}; App.teamPack = null; RS.REPLAY_INDEX = App.builtinReplays.slice();
    App.settings.trackFuel = null; App.saveSettings();
  };
  function autoTeamPack() {
    var fromHub = App.hubAvailable && RS.Hub ? G.fetch('api/team-pack', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('none'); return r.text(); }).then(function (t) { App.loadTeamPack(t, { auto: true, from: 'hub' }); }) : Promise.reject(new Error('no hub'));
    return fromHub.catch(function () {
      return IDB.get('team-pack').then(function (t) { if (t) App.loadTeamPack(t, { auto: true, from: 'browser' }); });
    }).then(function () { App.dirty = true; }, function () { /* nothing kept */ });
  }

  App.loadReplay = function (id) {
    var entry = (RS.REPLAY_INDEX || []).filter(function (r) { return r.id === id; })[0];
    if (!entry) { App.openSource(); App.toast('Race replays come from your team pack - load it under Race replays.', 6000); return Promise.resolve(); }
    var getter = App.teamReplays[id] ? Promise.resolve(JSON.parse(JSON.stringify(App.teamReplays[id]))) : G.__ZS_KEYRING__ && G.__ZS_KEYRING__.asset ? G.__ZS_KEYRING__.asset('replay-' + id) : (RS.INLINE_ASSET || RS.DEV_ASSET ? Promise.resolve((RS.INLINE_ASSET || RS.DEV_ASSET)('replay-' + id)) : Promise.reject(new Error('Replay data not available in this build.')));
    App.toast('Loading ' + (entry ? entry.name : id) + '…');
    return getter.then(function (txt) {
      var rep = typeof txt === 'string' ? JSON.parse(txt) : txt;
      App.startReplay(rep);
      if (rep.meta.event) { App.applyTrack(rep.meta.event, { fuel: true }); App.saveSettings(); }
    }).catch(function (e) { App.toast('Could not load the replay: ' + e.message, 6000); });
  };
  App.startReplay = function (rep) {
    stopSources();
    RS.deriveMeta(rep);
    App.live = null;
    App.replay = new RS.Replay(App.engine, rep);
    App.replay.speed = parseFloat($('rp-speed').value) || 10;
    App.replay.on('state', function () { $('rp-play').textContent = App.replay && App.replay.playing ? 'Pause' : 'Play'; });
    $('replaybar').hidden = false;
    App.resetChart();
    App.replay.seek(Math.min(App.replay.end, 45 * 60000));
    setSource('replay', 'Replay', rep.meta.name);
    closeDialogs();
    App.toast('Replay ready — press Play, or drag the slider to any point of the race.');
  };

  function ensureLive(kind, label) {
    if (App.source.kind !== kind || !App.live) {
      stopSources();
      App.live = new RS.LiveSession(App.engine);
      App.live.start({ name: 'Live session' });
      if (App.settings.trackPreset) App.applyTrack(App.settings.trackPreset);
      if (App.settings.raceHours) App.engine.meta.durationMs = App.settings.raceHours * 3600000;
      App.resetChart();
      setSource(kind, label, 'waiting for data');
    }
  }
  App.useBridge = function () { ensureLive('bridge', 'Live · bridge'); };
  App.openLT2 = function () {
    App.lt2Win = G.open(App.settings.lt2Url || RS.LT2_URL, 'zs-lt2');
    App.useBridge();
    App.toast('Zenith live timing opened in a new tab — click your “Strategy bridge” bookmark there.', 6000);
  };
  /* recipe: what to subscribe to. A capture or the bridge gives the page's own list; otherwise the defaults,
     with the names that worked last time tried first */
  App.lt2Recipe = function () {
    var L = App.settings.lt2 || {};
    if (L.recipe && L.recipe.feed && L.recipe.session && L.recipe.session.length) return L.recipe;
    var r = JSON.parse(JSON.stringify(RS.LT2.DEFAULT_RECIPE)), learned = L.learned || {};
    r.session.forEach(function (x) {
      var l = learned[x.key]; if (!l) return;
      x.names = [l.name].concat(x.names.filter(function (n) { return n !== l.name; }));
      if (l.shape === 1) x.params = [['$SESSION']];
    });
    return r;
  };
  App.dataMap = function () {
    var m = (App.settings.lt2 || {}).dataMap;
    return m ? String(m).split(',').map(function (x) { return x.trim(); }) : null;
  };
  App.connectLT2 = function (opts) {
    var L = App.settings.lt2 = Object.assign({}, App.settings.lt2, opts || {});
    if (!L.series) { App.toast('Enter the series name from the live timing address first (for Zenith: zenith).'); return; }
    stopSources();
    ensureLive('direct', 'Live · Al Kamel');
    App.mirror.clear();
    App.recorder = new RS.LT2.Recorder(); App.recorder.on = L.record !== false; App.recSaved = 0;
    App.lt2model = new RS.LT2.Model(App.mirror, { dataMap: App.dataMap() });
    var url = L.viaProxy ? new RS.Proxy(App.settings.proxy).wsUrl(L.transport === 'raw' ? RS.LT2.rawUrl() : RS.LT2.sockUrl()) : null;
    var c = App.lt2c = new RS.LT2.Client({ series: L.series, transport: L.transport || 'sockjs', session: L.session || 'auto', mirror: App.mirror, recipe: App.lt2Recipe(), recorder: App.recorder, url: url });
    c.on('state', function (st, detail) { App.source.status = st + (detail ? ' — ' + detail : ''); App.dirty = true; if (st === 'connected') App.toast('Connected to Al Kamel live timing (' + L.series + ').'); });
    c.on('data', function () { App.feedDirty = true; });
    c.on('timesync', function () { if (App.lt2model) App.lt2model.fixedOffset = true; });
    c.on('session', function (sid) {
      App.lt2model.sessionId = sid; App.lt2model.offsets = []; App.lt2model.seenLines = {};
      App.live.start({ name: 'Live session' });
      if (App.settings.trackPreset) App.applyTrack(App.settings.trackPreset);
      App.resetChart(); App.feedDirty = true;
      var info = c.sessions().filter(function (x) { return x.id === sid; })[0];
      App.toast('Following ' + (info ? info.label : 'session ' + sid), 5000);
    });
    c.on('ready', function () {
      var learned = Object.assign({}, App.settings.lt2.learned || {}), subs = c.ddp ? c.ddp.subs : {};
      Object.keys(c.sessionSubs).forEach(function (k) { var x = c.sessionSubs[k]; if (x.id && subs[x.id] && subs[x.id].ready) learned[k] = { name: x.name, shape: x.shape }; });
      if (JSON.stringify(learned) !== JSON.stringify(App.settings.lt2.learned || {})) { App.settings.lt2.learned = learned; RS.store.set('settings', App.settings); }
      App.dirty = true;
    });
    c.on('nosub', function () { App.dirty = true; });
    c.start();
    App.saveSettings();
    closeDialogs();
  };
  App.connectDirect = function () { App.connectLT2(); };

  /* ---------------- pit wall hub (the laptop runs pitwall_hub.py; every screen connects to it) ---------------- */
  function hubSnap(tHub) {
    var M = App.lt2model; if (!M || !App.live) return;
    var off = (App.hubStatus && App.hubStatus.clockOffset) || 0, snap = null;
    try { snap = M.snapshot(tHub + off); } catch (e) { App.lt2err = e.message; }
    if (snap && snap.cars && snap.cars.length) { App.live.apply(snap); App.lastFeedAt = Date.now(); }
  }
  App.connectHub = function (status) {
    stopSources();
    ensureLive('hub', 'Live · pit wall hub');
    App.mirror.clear();
    var H = App.hub = new RS.Hub.Feed({ mirror: App.mirror, onSnap: hubSnap });
    H.on('reset', function (st) {
      App.mirror.clear();
      App.lt2model = new RS.LT2.Model(App.mirror, { dataMap: App.dataMap() });
      App.lt2model.sessionId = st.session && st.session.id ? st.session.id : null;
      if (st.clockOffset !== null && st.clockOffset !== undefined) App.lt2model.fixedOffset = true;
      App.lt2 = null;
      App.live.start({ name: st.session && st.session.label ? st.session.label : 'Live session' });
      if (App.settings.trackPreset) App.applyTrack(App.settings.trackPreset);
      if (App.settings.raceHours) App.engine.meta.durationMs = App.settings.raceHours * 3600000;
      App.resetChart(); App.lastFeedAt = null; App.hubProgress = { done: 0, total: 0 }; App.dirty = true;
    });
    H.on('progress', function (p) { App.hubProgress = p; App.dirty = true; });
    H.on('live', function (x) {
      App.hubProgress = null; App.feedDirty = true; App.dirty = true;
      var se = App.hubStatus && App.hubStatus.session;
      App.toast(se && se.label ? 'Live: ' + se.label + (x.messages > 200 ? ' (caught up ' + x.messages + ' messages)' : '') : 'Connected to the pit wall hub — waiting for a session to start.', 5000);
    });
    H.on('data', function () { App.feedDirty = true; });
    H.on('state', function () { App.dirty = true; });
    H.on('status', function (st) {
      App.hubStatus = st;
      if (App.lt2model && st.session && st.session.id && !App.lt2model.sessionId) App.lt2model.sessionId = st.session.id;
      if (App.lt2model && st.clockOffset !== null && st.clockOffset !== undefined) App.lt2model.fixedOffset = true;
      App.source.status = 'Al Kamel ' + (st.state || '?') + (st.detail ? ' (' + st.detail + ')' : '') + ' · ' + (st.cars || 0) + ' cars · ' + (st.clients || 0) + ' screens';
      if (st.local && !App.hubSettingsSent) { App.hubSettingsSent = true; App.hubPushSettings(true); }
      if (!st.local && st.settingsVer && st.settingsVer !== App.hubSettingsVer) {
        App.hubSettingsVer = st.settingsVer;
        H.fetchStatus().then(function (full) { App.hubFull = full; applySharedSettings(full.settings); }, function () { App.hubSettingsVer = null; });
      }
      App.dirty = true;
    });
    App.hubAvailable = true;
    if (status && status.urls) App.hubFull = status;
    H.start(status && status.epoch ? status : null);
    closeDialogs();
  };
  var hubPushT = null;
  App.hubPushSettings = function (now) {
    clearTimeout(hubPushT);
    hubPushT = setTimeout(function () {
      if (!App.hub) return;
      RS.Hub.post(App.hub.base, 'api/settings', { settings: RS.Hub.shared(App.settings) }).then(function (r) { App.hubSettingsVer = r.settingsVer; }, function () { /* phone, or hub gone */ });
    }, now ? 0 : 400);
  };
  function applySharedSettings(sh) {
    if (!sh || typeof sh !== 'object') return;
    var s = App.settings, keepHero = s.hero, oldHero = s.hero, oldTrack = s.trackPreset;
    RS.Hub.SHARED.forEach(function (k) { if (sh[k] !== undefined) s[k] = sh[k]; });
    if (App.ui.heroLocal && (s.teamCars || []).indexOf(String(keepHero)) >= 0) s.hero = keepHero;
    s.sisters = (s.teamCars || []).filter(function (x) { return String(x) !== String(s.hero); });
    s.fuel = Object.assign({}, RS.DEFAULTS.fuel, s.fuel || {});
    RS.store.set('settings', s); App.engine.settings = s;
    if (s.trackPreset && s.trackPreset !== oldTrack) App.applyTrack(s.trackPreset, { force: true });
    if (s.raceHours && App.live) App.engine.meta.durationMs = s.raceHours * 3600000;
    if (String(s.hero) !== String(oldHero)) App.resetChart();
    App.dirty = true;
  }
  App.hubSession = function (sid) {
    if (!App.hub) return;
    RS.Hub.post(App.hub.base, 'api/session', { session: sid || 'auto' }).then(function () { App.toast(sid && sid !== 'auto' ? 'The hub is switching session — every screen will follow.' : 'The hub will follow whichever session is running.', 5000); },
      function (e) { App.toast(e.message, 6000); });
  };
  function hubSection() {
    var st = Object.assign({}, App.hubFull || {}, App.hubStatus || {}), local = !!st.local, urls = (App.hubFull && App.hubFull.urls) || {};
    var sessions = (App.hubFull && App.hubFull.sessions) || [], cur = st.session && st.session.id;
    var fmt = function (ms) { if (!ms) return ''; var d = new Date(ms); return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
    var opts = '<option value="auto"' + (st.auto ? ' selected' : '') + '>Auto — follow the session that is running</option>' + sessions.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (!st.auto && x.id === cur ? ' selected' : '') + '>' + (x.id === cur ? '▶ ' : '') + esc(fmt(x.start)) + ' · ' + esc(x.label) + '</option>';
    }).join('');
    var subs = st.subs ? Object.keys(st.subs).map(function (k) { return k + ': ' + st.subs[k]; }).join(' · ') : '';
    var lan = (urls.lan || []).map(function (u) { return '<div class="hub-url">' + esc(u) + '</div>'; }).join('');
    var H = App.hub, scr = H ? (H.catching ? 'catching up' : H.state) : 'not connected';
    return '<div class="srcopt"><h4>Live — pit wall hub <span class="tag out">' + (local ? 'THIS LAPTOP' : 'CREW SCREEN') + '</span></h4>' +
      '<p>The hub program on the strategy laptop holds the one connection to Al Kamel live timing and pushes every update to this screen and the crew\'s phones as it arrives.</p>' +
      '<p class="small">Al Kamel: <b>' + esc(st.state || '?') + '</b>' + (st.detail ? ' (' + esc(st.detail) + ')' : '') + ' · feed <b>' + esc(st.series || '') + '</b> · ' + (st.cars || 0) + ' cars · ' + (st.clients || 0) + ' screens connected · this screen: ' + esc(scr) +
      (st.session ? '<br>Following: <b>' + esc(st.session.label || st.session.id) + '</b>' : '<br>No session running yet — the hub picks it up when it starts.') +
      (subs ? '<br>Data sets: ' + esc(subs) : '') + (st.recording ? '<br>Recording: ' + esc(st.recording) : '') + '</p>' +
      (local ? '<div class="row"><label>Session <select id="hub-session" style="width:520px">' + opts + '</select></label></div>' : '<p class="small muted">The session is chosen on the strategy laptop.</p>') +
      '<div class="row"><button type="button" class="btn primary" data-act="hub-connect">Reconnect this screen</button>' +
      (local ? '<button type="button" class="btn" data-act="hub-reconnect">Reconnect to Al Kamel</button>' + (st.recording ? '<a class="btn" href="recordings/' + encodeURIComponent(st.recording) + '" download>Download recording</a>' : '') : '') +
      '<button type="button" class="btn ghost" data-act="diag-copy">Copy diagnostics</button></div>' +
      (lan || urls.tunnel ? '<p class="small"><b>Crew phones</b> — open this address in the phone browser (phone on the same Wi-Fi or hotspot as the laptop):</p>' + lan +
        (urls.tunnel ? '<p class="small">From anywhere (internet link — keep it inside the team):</p><div class="hub-url">' + esc(urls.tunnel) + '</div>' : '') : '') +
      (local ? '<details><summary class="small">Advanced — subscriptions (' + esc(st.recipe || 'built-in') + ')</summary>' +
        '<p class="small muted">If a data set shows “refused”, copy the timing page\'s own list: open the session on the timing page with developer tools → Network → WS → Messages, type <b>params</b> in the filter, select all the lines, paste them here and click Learn.</p>' +
        '<textarea class="code" id="lt2-capture" placeholder="Paste the WebSocket messages here"></textarea>' +
        '<div class="row"><button type="button" class="btn sm" data-act="hub-learn">Learn from capture</button><button type="button" class="btn ghost sm" data-act="hub-forget">Forget learned subscriptions</button></div></details>' : '') +
      '</div>';
  }

  App.pickSession = function (sid) {
    App.settings.lt2.session = sid || 'auto'; App.saveSettings();
    if (App.lt2c) { App.lt2c.opts.session = sid || 'auto'; if (sid && sid !== 'auto') App.lt2c.useSession(sid); else App.lt2c._onData(); }
  };
  App.downloadRecording = function () {
    var r = App.recorder; if (!r || !r.count) { App.toast('Nothing recorded yet.'); return; }
    var info = App.lt2model ? App.lt2model.sessionInfo() : {};
    var name = ((App.settings.lt2 || {}).series || 'alkamel') + '_' + (String(info.label || 'session').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session') + '_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    r.blob().then(function (b) {
      var a = D.createElement('a'); a.href = URL.createObjectURL(b.blob); a.download = name + b.ext; D.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      App.recSaved = r.count; App.toast('Saved ' + r.count + ' messages (' + Math.round(r.bytes / 1024) + ' KB before compression).');
    });
  };
  App.loadRecording = function (file) {
    App.toast('Reading ' + file.name + '…');
    return RS.LT2.readFile(file).then(function (text) {
      var rec = RS.LT2.parseRecording(text);
      if (!rec.count) throw new Error('No Al Kamel timing messages found in ' + file.name + '.');
      stopSources();
      ensureLive('recording', 'Recording');
      App.mirror.clear();
      App.lt2model = new RS.LT2.Model(App.mirror, { dataMap: App.dataMap() });
      var P = App.recPlayer = new RS.LT2.Player(rec, App.mirror);
      P.speed = parseFloat($('rp-speed').value) || 10;
      P.on('data', function () { App.feedDirty = true; });
      P.on('rewind', function () { App.live.start({ name: 'Recording' }); App.lt2model.offsets = []; App.lt2model.seenLines = {}; if (App.settings.trackPreset) App.applyTrack(App.settings.trackPreset); });
      P.on('state', function () { $('rp-play').textContent = App.recPlayer && App.recPlayer.playing ? 'Pause' : 'Play'; });
      $('replaybar').hidden = false;
      P.seek(Math.min(P.end, 60000));
      App.source.status = rec.count + ' messages · ' + file.name;
      closeDialogs();
      App.toast('Recording loaded: ' + rec.count + ' timing messages over ' + RS.fmtClock(P.end) + '. Press Play.', 6000);
    }).catch(function (e) { App.toast(e.message, 7000); });
  };
  App.loadResultsText = function (text, name, asBackfill) {
    var rep;
    try { rep = RS.parseAlKamelCSV(text, { name: name || 'Official results file', kind: /practice|qual|warm|test/i.test(name || '') ? 'practice' : 'race' }); } catch (e) { App.toast(e.message, 6000); return; }
    RS.deriveMeta(rep);
    if (asBackfill && App.live) {
      var n = App.live.backfill(rep);
      App.toast('Merged ' + n + ' official laps into the live session.');
    } else {
      App.startReplay(rep);
      App.replay.seek(App.replay.end); App.replay.pause();
      App.toast('Loaded ' + rep.laps.length + ' laps — at the end of the file. Drag the slider to replay it.');
    }
  };
  App.pollResults = function (url, minutes) {
    var px = new RS.Proxy(App.settings.proxy);
    var go = function () {
      px.findAnalysis(url).then(function (csvUrl) { return px.fetchText(csvUrl).then(function (t) { return [csvUrl, t]; }); })
        .then(function (r) {
          var name = decodeURIComponent(r[0].split('/').pop());
          if (App.live) App.loadResultsText(r[1], name, true);
          else { App.loadResultsText(r[1], name, false); }
          App.source.status = 'results updated ' + new Date().toLocaleTimeString();
        }).catch(function (e) { App.toast('Results fetch failed: ' + e.message, 7000); });
    };
    go();
    if (App.pollTimer) clearInterval(App.pollTimer);
    if (minutes > 0) App.pollTimer = setInterval(go, minutes * 60000);
  };

  /* bridge events */
  function wireBridge() {
    App.bridge.on('hello', function () {
      if (App.source.kind !== 'bridge') { App.useBridge(); App.toast('Bridge connected — live timing is flowing from the Zenith page.'); }
    });
    App.bridge.on('subs', function (subs) {
      var keep = (subs || []).filter(function (s) { return s.name && !/^meteor/i.test(s.name); });
      if (keep.length) {
        App.learnedSubs = keep; RS.store.set('lt2subs', keep);
        var rec = RS.LT2.generalise(keep);
        if (rec.session.length) { App.settings.lt2.recipe = rec; RS.store.set('settings', App.settings); }
      }
      if (App.bridge.ddpUrl) {
        var u = App.bridge.ddpUrl.replace(/^http/, 'ws').replace(/\/?$/, '/') + 'websocket';
        if (/alkamel/i.test(u)) { App.settings.direct = Object.assign({}, App.settings.direct, { url: u }); RS.store.set('settings', App.settings); }
      }
    });
    App.bridge.on('data', function () { if (App.source.kind === 'bridge') App.feedDirty = true; });
    App.bridge.on('dom', function (d) { App.lastDom = d; if (App.source.kind === 'bridge') App.domDirty = true; });
    App.bridge.listen();
  }

  function pumpFeed() {
    if (!App.live) return;
    if (App.hub && (App.hub.catching || App.hub.draining)) return;
    var snap = null;
    if (App.feedDirty) {
      App.feedDirty = false;
      if (App.lt2model || App.source.kind === 'bridge') {
        if (!App.lt2model) App.lt2model = new RS.LT2.Model(App.mirror, { dataMap: App.dataMap() });
        var nowEpoch = App.recPlayer ? App.recPlayer.now() : App.lt2c ? App.lt2c.now() : App.hub ? Math.max(App.hub.now(), App.hub.lastT) + ((App.hubStatus && App.hubStatus.clockOffset) || 0) : Date.now();
        try { snap = App.lt2model.snapshot(nowEpoch); App.lt2 = App.lt2model.extras(); } catch (e) { App.lt2err = e.message; snap = null; }
        if (App.hub) App.hub.markSnap();
      }
      if (!snap || !snap.cars.length) snap = App.adapter.snapshot();
    }
    else if (App.domDirty) { App.domDirty = false; snap = App.lastDom ? RS.domSnapshot(App.lastDom) : null; }
    if (snap && snap.cars && snap.cars.length) {
      App.live.apply(snap);
      if (App.lt2 && App.lt2.track && App.lt2.track.fracs) App.engine.meta.timingPoints = App.lt2.track.fracs;
      App.source.status = snap.cars.length + ' cars · ' + (snap.source === 'dom' ? 'table' : snap.source === 'lt2' ? 'standings' : 'feed') + ' · ' + new Date().toLocaleTimeString();
      App.lastFeedAt = Date.now();
    }
  }
  /* ---------------- dialogs ---------------- */
  function closeDialogs() { ['dlg-source', 'dlg-settings'].forEach(function (id) { var d = $(id); if (d.open) d.close(); }); }
  function dashUrl() { return G.location.href.split('#')[0]; }
  function dashOrigin() { return G.location.origin && G.location.origin !== 'null' ? G.location.origin : '*'; }

  App.sessionOptions = function () {
    var L = App.settings.lt2 || {}, list = App.lt2c ? App.lt2c.sessions() : [], cur = App.lt2c ? App.lt2c.sessionId : null;
    var fmt = function (ms) { if (!ms) return ''; var d = new Date(ms); return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
    return '<option value="auto"' + (L.session === 'auto' ? ' selected' : '') + '>Auto — follow the session that is running</option>' + list.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (L.session === x.id ? ' selected' : '') + '>' + (x.id === cur ? '▶ ' : '') + esc(fmt(x.start)) + ' · ' + esc(x.label) + (x.closed ? ' (closed)' : '') + '</option>';
    }).join('');
  };
  App.openSource = function (refresh) {
    var reps = (RS.REPLAY_INDEX || []).map(function (r) {
      return '<option value="' + esc(r.id) + '">' + esc(r.name) + ' — ' + r.cars + ' cars, ' + r.laps + ' laps</option>';
    }).join('');
    var L = App.settings.lt2 || {}, c = App.lt2c, fileOrigin = G.location.protocol === 'file:';
    var subsTxt = c ? Object.keys(c.status()).map(function (k) { return k + ': ' + c.status()[k]; }).join(' · ') : '';
    var recipe = L.recipe && L.recipe.session ? 'from your capture (' + L.recipe.session.map(function (x) { return x.names[0]; }).join(', ') + ')' : Object.keys(L.learned || {}).length ? 'learned last time (' + Object.keys(L.learned).map(function (k) { return L.learned[k].name; }).join(', ') + ')' : 'built-in guesses';
    var rec = App.recorder && App.recorder.count ? App.recorder.count + ' messages recorded' + (App.recSaved >= App.recorder.count ? ' (saved)' : '') : 'nothing recorded yet';
    var viaHub = !!App.hubAvailable, stamp = App.ui.srcStamp = Date.now();
    if (viaHub && App.hub && !refresh) App.hub.fetchStatus().then(function (full) { App.hubFull = full; if ($('dlg-source').open && !busy($('dlg-source')) && App.ui.srcStamp === stamp) App.openSource(true); }, function () { /* */ });
    $('source-body').innerHTML = (viaHub ? hubSection() : '') + (viaHub ? '' :
      '<div class="srcopt"><h4>Live — Al Kamel live timing <span class="tag out">RECOMMENDED</span></h4>' +
      '<p>Connects this page straight to the live timing feed, the same way the timing website does, and reads the standings, pit, flag, race control and weather data. Works on the crew\'s phones too. Data stays in this browser.</p>' +
      '<div class="row"><label>Series <input type="text" id="lt2-series" value="' + esc(L.series || 'zenith') + '" style="width:150px" aria-label="Series name"></label>' +
      '<span class="muted small">the part after livetiming.alkamelsystems.com/ — zenith, or e.g. hsr for a rehearsal</span></div>' +
      '<div class="row"><button type="button" class="btn primary" data-act="lt2-connect">' + (c ? 'Reconnect' : 'Connect') + '</button><button type="button" class="btn ghost" data-act="lt2-stop">Disconnect</button>' +
      '<label class="small"><input type="checkbox" id="lt2-record"' + (L.record !== false ? ' checked' : '') + '> Record the session</label>' +
      '<button type="button" class="btn" data-act="rec-download">Download recording</button><span class="muted small" id="rec-state">' + esc(rec) + '</span></div>' +
      '<div class="row"><label>Session <select id="lt2-session" style="width:520px">' + App.sessionOptions() + '</select></label></div>' +
      (c ? '<p class="small">Status: ' + esc(App.source.status || '') + (subsTxt ? '<br>Data sets: ' + esc(subsTxt) : '') + '</p>' : '') +
      '<details><summary class="small">Advanced</summary>' +
      '<div class="row"><label class="small">Connection <select id="lt2-transport"><option value="sockjs"' + (L.transport !== 'raw' ? ' selected' : '') + '>SockJS (as the timing page)</option><option value="raw"' + (L.transport === 'raw' ? ' selected' : '') + '>Plain WebSocket</option></select></label>' +
      '<label class="small"><input type="checkbox" id="lt2-proxy"' + (L.viaProxy ? ' checked' : '') + '> via my proxy (if the server refuses this website)</label></div>' +
      '<p class="small muted">Subscriptions: ' + esc(recipe) + '. To copy the timing page\'s own list: open the session on the timing page with developer tools → Network → WS → Messages, type <b>params</b> in the filter, select all the lines, paste them here and click Learn.</p>' +
      '<textarea class="code" id="lt2-capture" placeholder="Paste the WebSocket messages here"></textarea>' +
      '<div class="row"><button type="button" class="btn sm" data-act="lt2-learn">Learn from capture</button><button type="button" class="btn ghost sm" data-act="lt2-forget">Forget learned subscriptions</button></div></details></div>') +
      '<div class="srcopt"><h4>Play back a recording</h4><p>Load a recording saved by this page (.jsonl.gz) or by the Python recorder (.raw.jsonl.gz). It plays through exactly the same screens as live — the quickest way to check the feed parsing before race day.</p>' +
      '<div class="drop" id="drop-rec">Drop a recording here or <label style="text-decoration:underline;cursor:pointer">choose a file<input type="file" id="rec-file" accept=".gz,.jsonl,.json,.txt" hidden></label></div></div>' +
      (viaHub ? '' : '<div class="srcopt"><h4>Live — bridge from the timing page (fallback)</h4>' +
      '<p>If the direct connection is refused, open the Zenith timing page in this browser and click a bookmark there; the page passes its data across.</p>' +
      (fileOrigin ? '<p class="slow">You opened this page from a file. Publish it to your site first — the bridge needs a web address to talk to.</p>' : '') +
      '<textarea class="code" id="bm-code" readonly>' + esc(RS.bookmarklet(dashOrigin(), dashUrl())) + '</textarea>' +
      '<div class="row"><button type="button" class="btn" data-act="open-lt2">Open Zenith live timing</button><button type="button" class="btn" data-act="copy-bm">Copy bookmark code</button><button type="button" class="btn ghost" data-act="dl-userscript">Download userscript</button>' +
      '<span class="muted small">Bridge: ' + (App.bridge.active ? 'connected (' + esc(App.bridge.mode || 'waiting') + ')' : 'not connected') + '</span></div></div>') +
      '<div class="srcopt"><h4>Official results file (Al Kamel analysis CSV)</h4><p>Drop the “23_Analysis…” CSV from the Zenith results site. During a live session this <b>back-fills full lap history</b> (e.g. after joining late); otherwise it opens the file as a replay.</p>' +
      '<div class="drop" id="drop">Drop a CSV here or <label style="text-decoration:underline;cursor:pointer">choose a file<input type="file" id="csv-file" accept=".csv,.CSV,text/csv" hidden></label></div>' +
      '<div class="row"><input type="url" id="res-url" style="width:420px" placeholder="Results folder or CSV address (needs the optional proxy)" value="' + esc(App.settings.resultsUrl || '') + '"><select id="res-every"><option value="0">once</option><option value="2">every 2 min</option><option value="5" selected>every 5 min</option><option value="15">every 15 min</option></select><button type="button" class="btn" data-act="res-fetch">Fetch</button></div></div>' +
      '<div class="srcopt"><h4>Race replays</h4><p>2026 Zenith races from the official timing, replayed at up to 300× through the same screens as live: practice for strategy calls.</p>' +
      (reps ? '<div class="row"><select id="rep-pick" style="width:420px">' + reps + '</select><button type="button" class="btn" data-act="rep-load">Load replay</button></div>' : '') +
      (App.teamPack ? '<p class="small muted">Team pack: ' + App.teamPack.races + ' races and your fuel numbers' + (App.teamPack.from === 'hub' ? ', from the laptop hub' : ', kept in this browser') + (App.teamPack.built ? ' (built ' + esc(String(App.teamPack.built).slice(0, 10)) + ')' : '') + '. ' +
        (App.teamPack.from === 'hub' ? '' : '<button type="button" class="btn ghost sm" data-act="pack-forget">Remove from this browser</button>') + '</p>' :
        '<p class="small">The replays and your fuel numbers are not part of the public site. Load your <b>team pack</b> (pit-wall-team-pack.json) once on each device and the browser keeps it. The laptop hub loads it by itself.</p>') +
      '<div class="drop" id="drop-pack">Drop the team pack here or <label style="text-decoration:underline;cursor:pointer">choose a file<input type="file" id="pack-file" accept=".json,application/json" hidden></label></div>' +
      '<p class="small muted">Or drop an official results CSV under Official results file to replay any session.</p></div>';
    var wireDrop = function (id, fn) {
      var drop = $(id);
      ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer.files[0]; if (f) fn(f); });
    };
    wireDrop('drop', readFile); wireDrop('drop-rec', App.loadRecording); wireDrop('drop-pack', App.readTeamPack);
    $('pack-file').addEventListener('change', function (e) { var f = e.target.files[0]; if (f) App.readTeamPack(f); });
    $('csv-file').addEventListener('change', function (e) { var f = e.target.files[0]; if (f) readFile(f); });
    $('rec-file').addEventListener('change', function (e) { var f = e.target.files[0]; if (f) App.loadRecording(f); });
    App.sessCount = App.lt2c ? App.lt2c.sessions().length : 0;
    if (!refresh || !$('dlg-source').open) $('dlg-source').showModal();
  };
  function readFile(f) {
    var r = new FileReader();
    r.onload = function () { App.loadResultsText(String(r.result), f.name.replace(/\.csv$/i, ''), !!App.live); closeDialogs(); };
    r.readAsText(f);
  }

  App.openSettings = function () {
    var s = App.settings, eng = App.engine;
    var carOpts = function (sel) {
      var list = eng.order.length ? eng.order.slice() : (s.teamCars || []).slice();
      if (list.indexOf(String(sel)) < 0) list.unshift(String(sel));
      return list.sort(function (a, b) { return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0); }).map(function (n) { return '<option value="' + esc(n) + '"' + (String(n) === String(sel) ? ' selected' : '') + '>#' + esc(n) + (eng.cars[n] ? ' ' + esc(eng.cars[n].cls) + ' ' + esc(eng.cars[n].team) : '') + '</option>'; }).join('');
    };
    var tracks = Object.keys(RS.TRACKS || {}).map(function (k) { return '<option value="' + k + '"' + (s.trackPreset === k ? ' selected' : '') + '>' + esc(RS.TRACKS[k].name) + '</option>'; }).join('');
    var fuelRows = (s.teamCars || []).map(function (n) {
      var f = s.fuel[n] || { tank: 18, burn: 0.6, reserve: 0.5 };
      var hint = s.trackFuel ? '' : '<div class="small muted">Generic numbers. Load your team pack (Data source → Race replays) for your real burn rates.</div>';
      return '<fieldset><legend>Fuel · #' + esc(n) + '</legend><label>Usable tank (gal) <input type="number" step="0.1" data-fuel-car="' + esc(n) + '" data-k="tank" value="' + f.tank + '"></label>' +
        '<label>Burn, green (gal/lap) <input type="number" step="0.01" data-fuel-car="' + esc(n) + '" data-k="burn" value="' + f.burn + '"></label>' +
        '<label>Reserve (gal) <input type="number" step="0.1" data-fuel-car="' + esc(n) + '" data-k="reserve" value="' + f.reserve + '"></label>' + hint + '</fieldset>';
    }).join('');
    $('settings-body').innerHTML = '<div class="form">' +
      '<fieldset><legend>Cars</legend><label>Hero car <select data-s="hero">' + carOpts(s.hero) + '</select></label>' +
      '<label>Team cars <input type="text" data-s="teamCars" value="' + esc((s.teamCars || []).join(', ')) + '"></label>' +
      '<label>Follow cars <input type="text" data-s="follows" value="' + esc((s.follows || []).join(', ')) + '" placeholder="e.g. 14, 85, 392"></label></fieldset>' +
      '<fieldset><legend>Track &amp; race</legend><label>Track preset <select data-s="trackPreset"><option value="">— none —</option>' + tracks + '</select></label>' +
      '<label>Race length (h, live) <input type="number" step="0.5" min="0" data-s="raceHours" value="' + (s.raceHours || 0) + '"></label>' +
      '<label>Pit entry, % of lap before the line <input type="number" step="0.5" min="0" max="20" data-s="pitInPct" value="' + (s.pitInPct || '') + '" placeholder="3.5"></label>' +
      '<label>Pit exit, % of lap after the line <input type="number" step="0.5" min="0" max="20" data-s="pitOutPct" value="' + (s.pitOutPct || '') + '" placeholder="4.5"></label>' +
      '<div class="small muted">Picking a track loads its 2026 pace and pit-lane times, and your fuel burn for it if the team pack is loaded. Race length is only needed when the feed does not give time remaining. Pit entry/exit place the pit lane on the lap ring.</div>' +
      '<button type="button" class="btn sm" data-act="apply-track">Apply track preset now</button></fieldset>' +
      '<fieldset><legend>Pit stops</legend><label>Pit loss <select data-s="pitPreset"><option value="p10">Quick stop (fast 10%)</option><option value="p50">Typical stop (median)</option><option value="p80">Long stop (slow 20%)</option><option value="learned">Learned from our stops</option><option value="manual">Manual</option></select></label>' +
      '<label>Manual pit loss (s) <input type="number" step="1" data-s="pitManualS" value="' + (s.pitManualS || '') + '"></label>' +
      '<label>Caution pit-loss factor <input type="number" step="0.05" min="0.1" max="1" data-s="fcyLossFactor" value="' + s.fcyLossFactor + '"></label>' +
      '<label>Stops longer than (s) count as refuel <input type="number" step="5" data-s="refuelMinLaneS" value="' + s.refuelMinLaneS + '"></label></fieldset>' +
      fuelRows +
      '<fieldset><legend>Strategy rules</legend><label>Yellow-lap fuel factor <input type="number" step="0.05" min="0.1" max="1" data-s="yellowBurn" value="' + s.yellowBurn + '"></label>' +
      '<label>Max stint (min, 0 = off) <input type="number" step="5" data-s="maxStintMin" value="' + s.maxStintMin + '"></label>' +
      '<label>Min drive time per driver (min) <input type="number" step="5" data-s="minDriveMin" value="' + s.minDriveMin + '"></label>' +
      '<label>Pace = average of last <input type="number" min="2" max="15" data-s="paceLaps" value="' + s.paceLaps + '"> clean laps</label></fieldset>' +
      '<fieldset><legend>Alerts</legend><label>Detect cautions from lap times <input type="checkbox" data-s="cautionDetect"' + (s.cautionDetect ? ' checked' : '') + '></label>' +
      '<label>Sound on critical alerts <input type="checkbox" data-s="sound"' + (s.sound ? ' checked' : '') + '></label></fieldset>' +
      '<fieldset><legend>Optional proxy (Cloudflare Worker)</legend><label>Proxy address <input type="url" data-s="proxy.url" value="' + esc(s.proxy.url || '') + '" placeholder="https://…workers.dev"></label>' +
      '<label>Access key <input type="password" data-s="proxy.key" value="' + esc(s.proxy.key || '') + '" autocomplete="off"></label>' +
      '<label>Live timing page <input type="url" data-s="lt2Url" value="' + esc(s.lt2Url || RS.LT2_URL) + '"></label></fieldset>' +
      '<fieldset><legend>Backup</legend><div class="row" style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn sm" data-act="set-export">Export settings</button><label class="btn sm">Import<input type="file" id="set-import" accept=".json" hidden></label><button type="button" class="btn ghost sm" data-act="set-reset">Reset to defaults</button></div></fieldset>' +
      '</div>';
    $('settings-body').querySelector('[data-s=pitPreset]').value = s.pitPreset;
    $('set-import').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return; var r = new FileReader();
      r.onload = function () {
        var obj; try { obj = JSON.parse(r.result); } catch (x) { App.toast('Not a settings file.'); return; }
        if (obj && obj.kind === 'pit-wall-team-pack') { try { var tp = App.loadTeamPack(String(r.result)); App.openSettings(); App.toast('Team pack loaded: ' + tp.races + ' race replays and your fuel numbers.', 6000); } catch (x) { App.toast(x.message, 6000); } return; }
        Object.assign(App.settings, obj); App.saveSettings(); App.openSettings(); App.toast('Settings imported.');
      };
      r.readAsText(f);
    });
    $('dlg-settings').showModal();
  };
  function onSettingChange(el) {
    var s = App.settings;
    if (el.dataset.fuelCar) { var n = el.dataset.fuelCar; s.fuel[n] = Object.assign({}, s.fuel[n] || {}); s.fuel[n][el.dataset.k] = parseFloat(el.value) || 0; App.saveSettings(); return; }
    var k = el.dataset.s; if (!k) return;
    var v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : parseFloat(el.value)) : el.value;
    if (k === 'teamCars' || k === 'follows') v = String(v).split(/[\s,;]+/).map(function (x) { return x.replace(/\D/g, ''); }).filter(Boolean);
    if (k.indexOf('.') > 0) { var p = k.split('.'); s[p[0]] = Object.assign({}, s[p[0]]); s[p[0]][p[1]] = v; }
    else s[k] = v;
    if (k === 'hero' || k === 'teamCars') s.sisters = (s.teamCars || []).filter(function (x) { return String(x) !== String(s.hero); });
    if (k === 'raceHours' && App.live && v) App.engine.meta.durationMs = v * 3600000;
    if (k === 'trackPreset' && v) { App.applyTrack(v, { force: true, fuel: true }); App.saveSettings(); App.openSettings(); return; }
    if (k === 'hero') { App.resetChart(); if (App.hubStatus && !App.hubStatus.local) App.ui.heroLocal = true; }
    App.saveSettings();
  }
  function download(name, text, type) {
    var a = D.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.download = name; D.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function copy(text) {
    if (G.navigator.clipboard) return G.navigator.clipboard.writeText(text).then(function () { App.toast('Copied.'); }, function () { App.toast('Copy failed — select the text and copy it manually.'); });
    App.toast('Select the text and copy it manually.');
  }

  /* ---------------- strategy calls ---------------- */
  App.logCall = function (text) {
    text = (text || '').trim(); if (!text) return;
    var v = App.view || {}, h = v.hero || {}, se = v.session || {};
    App.calls.push({ id: Date.now(), text: text, session: se.name || '', tod: se.tod !== null && se.tod !== undefined ? RS.fmtTod(se.tod) : new Date().toLocaleTimeString(), t: se.now,
      lap: h.laps || '', pos: h.pos || '', cpos: h.cpos || '', car: h.n || '', remaining: se.remaining !== null && se.remaining !== undefined ? RS.fmtClock(se.remaining) : '' });
    if (App.calls.length > 2000) App.calls.splice(0, 500);
    RS.store.set('calls', App.calls);
    App.engine.event('call', h.n || null, 'CALL: ' + text, 'info');
    App.toast('Logged: ' + text);
    App.dirty = true;
  };

  /* ---------------- events ---------------- */
  function onClick(e) {
    var t = e.target.closest('[data-act],[data-cls],[data-tab],[data-pp],[data-chip],[data-chip-reset],[data-call],[data-hero],[data-view],[data-pwf],[data-pwn],[data-pwt],tr[data-n]');
    if (!t) return;
    var act = t.dataset.act;
    if (act) {
      switch (act) {
        case 'source': App.openSource(); break;
        case 'settings': App.openSettings(); break;
        case 'close': closeDialogs(); break;
        case 'quick-replay': App.loadReplay((RS.REPLAY_INDEX || [])[0] ? RS.REPLAY_INDEX[0].id : ''); break;
        case 'pack-forget': App.forgetTeamPack(); App.openSource(true); App.toast('Team pack removed from this browser.'); break;
        case 'open-lt2': App.openLT2(); break;
        case 'copy-bm': copy($('bm-code').value); break;
        case 'dl-userscript': download('zenith-strategy-bridge.user.js', RS.userscript(dashOrigin(), dashUrl()), 'text/javascript'); break;
        case 'lt2-connect':
          App.connectLT2({ series: ($('lt2-series').value || 'zenith').trim().replace(/^.*alkamelsystems\.com\//, '').replace(/[^A-Za-z0-9_-]/g, ''), record: $('lt2-record').checked,
            transport: $('lt2-transport').value, viaProxy: $('lt2-proxy').checked, session: $('lt2-session').value || 'auto' }); break;
        case 'lt2-stop': if (App.lt2c || App.ddp) { stopSources(); setSource('none', 'Offline', 'disconnected'); App.toast('Disconnected.'); } break;
        case 'rec-download': App.downloadRecording(); break;
        case 'hub-connect': App.connectHub(); break;
        case 'hub-reconnect': if (App.hub) RS.Hub.post(App.hub.base, 'api/reconnect', {}).then(function () { App.toast('The hub is reconnecting to Al Kamel.'); }, function (x) { App.toast(x.message, 6000); }); break;
        case 'hub-learn':
          var hr = RS.LT2.recipeFromCapture($('lt2-capture').value);
          if (!hr.session.length) { App.toast('No subscriptions found in that text — copy the lines that contain "params".', 6000); break; }
          RS.Hub.post(App.hub ? App.hub.base : '', 'api/recipe', { recipe: hr }).then(function () { App.toast('The hub learned ' + hr.session.length + ' data sets: ' + hr.session.map(function (x) { return x.names[0]; }).join(', ') + '.', 8000); }, function (x) { App.toast(x.message, 6000); }); break;
        case 'hub-forget': RS.Hub.post(App.hub ? App.hub.base : '', 'api/recipe', { recipe: null, forget: true }).then(function () { App.toast('The hub is back to its built-in subscription list.'); }, function (x) { App.toast(x.message, 6000); }); break;
        case 'lt2-learn':
          var r = RS.LT2.recipeFromCapture($('lt2-capture').value);
          if (!r.session.length) { App.toast('No subscriptions found in that text — copy the lines that contain "params".', 6000); break; }
          App.settings.lt2.recipe = r; App.saveSettings(); App.openSource();
          App.toast('Learned ' + r.session.length + ' session data sets: ' + r.session.map(function (x) { return x.names[0]; }).join(', ') + '. Click Connect.', 8000); break;
        case 'lt2-forget': App.settings.lt2.recipe = null; App.settings.lt2.learned = {}; App.saveSettings(); App.openSource(); App.toast('Back to the built-in subscription guesses.'); break;
        case 'res-fetch':
          App.settings.resultsUrl = $('res-url').value.trim(); App.saveSettings();
          if (!App.settings.resultsUrl) { App.toast('Paste the results folder or CSV address first.'); break; }
          App.pollResults(App.settings.resultsUrl, parseInt($('res-every').value, 10) || 0); closeDialogs(); break;
        case 'rep-load': App.loadReplay($('rep-pick').value); break;
        case 'rp-play': var P = App.replay || App.recPlayer; if (P) { if (P.playing) P.pause(); else P.play(); } break;
        case 'rp-back': var P1 = App.replay || App.recPlayer; if (P1) P1.seek(P1.t - 300000); App.dirty = true; break;
        case 'rp-fwd': var P2 = App.replay || App.recPlayer; if (P2) P2.seek(P2.t + 300000); App.dirty = true; break;
        case 'apply-track': if (App.settings.trackPreset) { App.applyTrack(App.settings.trackPreset, { force: true, fuel: true }); App.saveSettings(); App.openSettings(); App.toast('Track preset applied.'); } break;
        case 'set-export': download('zenith-strategy-settings.json', JSON.stringify(App.settings, null, 1), 'application/json'); break;
        case 'set-reset': if (G.confirm('Reset all settings to defaults?')) { RS.store.del('settings'); App.settings = loadSettings(); App.saveSettings(); App.openSettings(); } break;
        case 'calls-export':
          download('strategy-calls.csv', 'time,session,remaining,car,lap,overall,class,call\n' + App.calls.map(function (c) { return [c.tod, c.session, c.remaining, c.car, c.lap, c.pos, c.cpos, c.text].map(function (x) { return '"' + String(x === undefined ? '' : x).replace(/"/g, '""') + '"'; }).join(','); }).join('\n'), 'text/csv'); break;
        case 'calls-clear': if (G.confirm('Clear all logged calls on this device?')) { App.calls = []; RS.store.set('calls', []); App.dirty = true; } break;
        case 'ov-apply':
          try { App.settings.overrides = JSON.parse($('insp-ov').value || '{}'); App.adapter.units = null; App.saveSettings(); App.feedDirty = true; App.toast('Overrides applied.'); } catch (x) { App.toast('That is not valid JSON.'); }
          break;
        case 'diag-copy':
          var lc = App.lt2c, lm = App.lt2model;
          copy(JSON.stringify({ built: RS.BUILD || '', source: App.source, lt2: lc ? { series: lc.opts.series, transport: lc.opts.transport, session: lc.sessionId, feedSessions: lc.feedSessions.length, sessions: lc.sessions().length, subs: lc.status(), log: lc.subLog.slice(-40).map(function (x) { return x.name + ' ' + JSON.stringify(x.params).slice(0, 80); }), lastClose: lc.ddp && lc.ddp.lastClose, clockOffset: lc.clockOffset } : null,
            hub: App.hub ? { status: App.hubStatus, state: App.hub.state, epoch: App.hub.epoch, idx: App.hub.idx, applied: App.hub.applied, catching: App.hub.catching } : null,
            model: lm ? { found: lm.found, status: lm.status(), offsets: lm.offsets.length, error: App.lt2err || null } : null, recording: App.recPlayer ? { msgs: App.recPlayer.rec.count, at: App.recPlayer.t } : null,
            generic: { found: App.adapter.found, units: App.adapter.units }, subs: App.learnedSubs, recipe: App.settings.lt2.recipe, learned: App.settings.lt2.learned,
            bridge: { active: App.bridge.active, mode: App.bridge.mode, msgs: App.bridge.msgs, page: App.bridge.page, ddpUrl: App.bridge.ddpUrl },
            collections: App.mirror.summary().map(function (c) { return { name: c.name, docs: c.docs, keys: c.keys, sample: JSON.stringify(c.sample).slice(0, 1500) }; }), dom: App.lastDom ? { headers: App.lastDom.headers, row0: App.lastDom.rows[0], meta: App.lastDom.meta } : null }, null, 1));
          break;
      }
      return;
    }
    if (t.dataset.view) { App.setView(t.dataset.view); return; }
    if (t.dataset.pwf) { App.ui.pwFilter = t.dataset.pwf; App.saveUi(); App.dirty = true; return; }
    if (t.dataset.pwn) { App.ui.pwNeighbours = t.dataset.pwn; App.saveUi(); App.dirty = true; return; }
    if (t.dataset.pwt) { App.ui.pwPhoneTab = t.dataset.pwt; App.saveUi(); App.dirty = true; G.scrollTo && G.scrollTo(0, 0); return; }
    if (t.dataset.cls) { App.ui.clsTab = t.dataset.cls; App.dirty = true; return; }
    if (t.dataset.hero) { if (App.hubStatus && !App.hubStatus.local) App.ui.heroLocal = true; App.settings.hero = t.dataset.hero; App.settings.sisters = (App.settings.teamCars || []).filter(function (x) { return x !== t.dataset.hero; }); App.resetChart(); App.saveSettings(); return; }
    if (t.dataset.tab) {
      App.ui.tab = t.dataset.tab;
      Array.prototype.forEach.call(D.querySelectorAll('#btabs button'), function (b) { b.classList.toggle('on', b.dataset.tab === App.ui.tab); });
      Array.prototype.forEach.call(D.querySelectorAll('.tabbody'), function (b) { b.hidden = b.id !== 'tab-' + App.ui.tab; });
      App.saveUi(); App.dirty = true; return;
    }
    if (t.dataset.pp) { App.ui.ppCar = t.dataset.pp; App.dirty = true; return; }
    if (t.dataset.chipReset) { App.resetChart(); App.dirty = true; return; }
    if (t.dataset.chip) { App.ui.autoChart = false; App.ui.chartCars = App.ui.chartCars.filter(function (x) { return x !== t.dataset.chip; }); App.dirty = true; return; }
    if (t.dataset.call !== undefined) { var inp = $('call-text'); App.logCall(t.dataset.call || inp.value); if (!t.dataset.call) inp.value = ''; return; }
    if (t.dataset.n) {
      var n = t.dataset.n; App.ui.selected = n; App.ui.stintCar = n; App.ui.autoChart = false;
      var i = App.ui.chartCars.indexOf(n);
      if (i >= 0) { if (n !== String(App.settings.hero)) App.ui.chartCars.splice(i, 1); } else App.ui.chartCars.push(n);
      if (App.ui.chartCars.length > 10) App.ui.chartCars.splice(1, 1);
      App.dirty = true;
    }
  }
  function onDbl(e) {
    var tr = e.target.closest('tr[data-n]'); if (!tr) return;
    var n = tr.dataset.n, f = (App.settings.follows || []).map(String), i = f.indexOf(n);
    if (i >= 0) f.splice(i, 1); else f.push(n);
    App.settings.follows = f; App.saveSettings();
    App.toast(i >= 0 ? '#' + n + ' unfollowed' : '#' + n + ' followed');
  }
  function onChange(e) {
    var el = e.target;
    if (el.closest('#settings-body')) { onSettingChange(el); return; }
    if (el.id === 'pp-preset') { App.settings.pitPreset = el.value; App.saveSettings(); return; }
    if (el.id === 'pp-manual') { App.settings.pitManualS = parseFloat(el.value) || null; App.saveSettings(); return; }
    if (el.dataset.plan) { App.ui.planLap[el.dataset.plan] = parseInt(el.value, 10) || null; App.dirty = true; return; }
    if (el.id === 'rp-speed' && (App.replay || App.recPlayer)) { (App.replay || App.recPlayer).speed = parseFloat(el.value) || 10; return; }
    if (el.id === 'lt2-session') { App.pickSession(el.value); return; }
    if (el.id === 'hub-session') { App.hubSession(el.value); return; }
    if (el.id === 'lt2-record') { App.settings.lt2.record = el.checked; App.saveSettings(); if (App.recorder) App.recorder.on = el.checked; return; }
    if (el.name === 'gapmode') { App.ui.gapMode = el.value; App.dirty = true; return; }
    if (el.id === 'stint-car') { App.ui.stintCar = el.value; App.dirty = true; return; }
    if (el.id === 'log-scope') { App.ui.logScope = el.value; App.dirty = true; return; }
    if (el.id === 'insp-col') { App.ui.inspectCol = el.value; App.dirty = true; return; }
    if (el.dataset.fuel !== undefined) {
      var c = App.engine.cars[App.ui.stintCar || String(App.settings.hero)]; if (c && c.stops[+el.dataset.fuel]) { c.stops[+el.dataset.fuel].fuel = el.checked; App.dirty = true; }
    }
  }
  function onInput(e) {
    var P = App.replay || App.recPlayer;
    if (e.target.id === 'rp-pos' && P) { P.seek(P.end * (+e.target.value / 1000)); App.dirty = true; }
  }
  function onKey(e) {
    if (e.target.id === 'call-text' && e.key === 'Enter') { App.logCall(e.target.value); e.target.value = ''; }
    var P = App.replay || App.recPlayer;
    if (e.key === ' ' && P && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); if (P.playing) P.pause(); else P.play(); }
  }

  /* ---------------- render loop ---------------- */
  function autoChartCars(v) {
    var s = App.settings, hero = v.byN[String(s.hero)], out = [];
    if (hero) {
      out.push(hero.n);
      var cls = v.rows.filter(function (r) { return r.cls === hero.cls; });
      var i = cls.indexOf(hero);
      cls.slice(Math.max(0, i - 2), i + 3).forEach(function (r) { if (out.indexOf(r.n) < 0) out.push(r.n); });
      if (cls[0] && out.indexOf(cls[0].n) < 0) out.push(cls[0].n);
    } else v.rows.slice(0, 5).forEach(function (r) { out.push(r.n); });
    (s.follows || []).forEach(function (n) { n = String(n); if (v.byN[n] && out.indexOf(n) < 0 && out.length < 10) out.push(n); });
    return out;
  }
  function busy(el) { var a = D.activeElement; return a && el && el.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName); }
  function renderHeader(v) {
    var se = v.session, s = App.settings, none = App.source.kind === 'none';
    var series = [se.series || '', se.name || ''].filter(Boolean).join(' · ');
    $('sess-name').textContent = none ? 'Zenith race strategy' : (series || 'Session');
    var hero = v.byN[String(s.hero)], lap = hero ? hero.laps : (v.rows[0] ? v.rows[0].laps : 0);
    $('hd-lap').textContent = none ? 'Lap –' : 'Lap ' + (lap || 0);
    $('clk-rem').textContent = se.remaining !== null && se.remaining !== undefined ? RS.fmtClock(se.remaining) : '--:--';
    $('sess-track').textContent = none ? 'Choose a data source to begin' : (se.track || '');
    var fc = $('flag-chip'), flag = none ? 'NONE' : se.flag || 'GF';
    fc.className = 'flag flag-' + flag + (se.flagSrc === 'inferred' ? ' inferred' : '');
    $('flag-text').textContent = flag === 'NONE' ? 'NO SESSION' : (RS.FLAG_LABEL[flag] || flag) + (flag === 'GF' ? ' FLAG' : '') + (se.flagSrc === 'inferred' ? ' ?' : '');
    fc.title = se.flagSrc === 'inferred' ? 'Inferred from lap times — not an official flag' : '';
    var car = hero ? '<span class="m">Our car</span> <strong>#' + esc(hero.n) + '</strong> · P' + hero.pos + ' overall · P' + hero.cpos + ' in class' : (none ? '' : '<span class="m">Our car</span> <strong>#' + esc(s.hero) + '</strong> · not in this session');
    var hc = $('hd-car'); if (hc._h !== car) { hc.innerHTML = car; hc._h = car; }
    var wx = App.lt2 && App.lt2.weather ? App.lt2.weather : null;
    $('hd-wx').textContent = wx ? [wx.air !== null && wx.air !== undefined ? 'Air ' + Math.round(wx.air) + '°' : '', wx.track !== null && wx.track !== undefined ? 'Track ' + Math.round(wx.track) + '°' : ''].filter(Boolean).join(' · ') : '';
    $('clk-el').textContent = none ? '--:--' : RS.fmtClock(se.now);
    $('clk-tod').textContent = se.tod !== null && se.tod !== undefined ? RS.fmtTod(se.tod) : '--:--';
    var hs = (s.teamCars || []).map(function (n) { return '<button type="button" data-hero="' + esc(n) + '" class="' + (String(n) === String(s.hero) ? 'on' : '') + '">#' + esc(n) + '</button>'; }).join('');
    var hel = $('hero-sel'); if (hel._h !== hs) { hel.innerHTML = hs; hel._h = hs; }
    var chip = $('src-chip'), k = App.source.kind, isLive = k === 'bridge' || k === 'direct' || k === 'recording' || k === 'hub';
    var age = App.lastFeedAt ? (Date.now() - App.lastFeedAt) / 1000 : null, stale = isLive && k !== 'recording' && (age === null || age > 15);
    var hubTxt = null, HS = App.hubStatus || {};
    if (k === 'hub' && App.hub) {
      var lastAt = Math.max(HS.lastData || 0, App.hub.lastT || 0); age = lastAt ? Math.max(0, (App.hub.now() - lastAt) / 1000) : null;
      stale = age === null || age > 15;
      if (App.hub.catching) hubTxt = 'Catching up · ' + (App.hubProgress && App.hubProgress.total ? Math.min(99, Math.floor(App.hubProgress.done / App.hubProgress.total * 100)) : 0) + '%';
      else if (App.hub.state === 'unreachable') hubTxt = 'Hub not reachable — retrying';
      else if (App.hub.state === 'reconnecting' || App.hub.state === 'connecting') hubTxt = 'Reconnecting to the hub';
      else if (HS.state && HS.state !== 'connected') hubTxt = 'Hub: Al Kamel ' + HS.state;
      else if (!HS.session) hubTxt = 'Live · waiting for a session';
      if (hubTxt) stale = true;
    }
    chip.className = 'src ' + (k === 'none' ? 'src-off' : k === 'replay' || k === 'recording' ? 'src-replay' : stale ? 'src-stale' : 'src-live');
    var txt = k === 'none' ? 'Offline' : k === 'replay' ? 'Replay · ' + (App.replay ? App.replay.speed + '×' : '') : k === 'recording' ? 'Recording · ' + (App.recPlayer ? App.recPlayer.speed + '×' : '')
      : stale ? 'Waiting for data' + (age !== null ? ' · ' + Math.round(age) + ' s' : '') : 'Live · data ' + (age !== null ? age.toFixed(1) : '0.0') + ' s old';
    if (App.recorder && App.recorder.on) txt += ' · REC ' + App.recorder.count;
    if (hubTxt) txt = hubTxt;
    else if (k === 'hub' && HS.clients > 1) txt += ' · ' + HS.clients + ' screens';
    $('src-text').textContent = txt;
    chip.title = App.source.status || '';
    Array.prototype.forEach.call(D.querySelectorAll('[data-view]'), function (b) { b.classList.toggle('on', b.dataset.view === App.ui.view); });
    if (App.replay) {
      $('rp-time').textContent = RS.fmtClock(App.replay.t) + ' / ' + RS.fmtClock(App.replay.end);
      if (D.activeElement !== $('rp-pos')) $('rp-pos').value = Math.round(App.replay.t / Math.max(1, App.replay.end) * 1000);
    } else if (App.recPlayer) {
      $('rp-time').textContent = RS.fmtClock(App.recPlayer.t) + ' / ' + RS.fmtClock(App.recPlayer.end);
      if (D.activeElement !== $('rp-pos')) $('rp-pos').value = Math.round(App.recPlayer.t / Math.max(1, App.recPlayer.end) * 1000);
    }
  }
  App.setView = function (view) {
    App.ui.view = view === 'analysis' ? 'analysis' : 'pitwall';
    $('view-pitwall').hidden = App.ui.view !== 'pitwall';
    $('view-analysis').hidden = App.ui.view !== 'analysis';
    $('alerts').hidden = App.ui.view !== 'analysis';
    D.body.classList.toggle('pw-on', App.ui.view === 'pitwall');
    App.saveUi(); App.dirty = true;
  };
  App.saveUi = function () { var u = App.ui; RS.store.set('ui', { view: u.view, pwFilter: u.pwFilter, pwNeighbours: u.pwNeighbours, pwPhoneTab: u.pwPhoneTab, tab: u.tab, gapMode: u.gapMode }); };
  var lastFull = 0, lastMap = 0, lastVer = -1, lastAlertKeys = '';
  function frame() {
    var now = Date.now();
    if (App.replay) App.replay.tick(G.performance.now());
    if (App.recPlayer) App.recPlayer.tick(G.performance.now());
    pumpFeed();
    var PL = App.replay || App.recPlayer;
    var period = PL && PL.playing ? (PL.speed >= 60 ? 400 : 700) : (App.source.kind === 'direct' || App.source.kind === 'bridge' ? 500 : 1000);
    if (App.dirty || now - lastFull > period) {
      App.dirty = false; lastFull = now;
      var v = App.view = App.engine.compute();
      if (App.ui.autoChart) App.ui.chartCars = autoChartCars(v);
      renderHeader(v);
      var keys = v.alerts.filter(function (a) { return a.level === 'crit'; }).map(function (a) { return a.key; }).join('|');
      if (keys && keys !== lastAlertKeys) beep(); lastAlertKeys = keys;
      if (App.ui.view === 'pitwall') {
        if (!busy($('view-pitwall'))) RS.PW.render(App, v);
      } else {
        if (!busy($('board'))) UI.renderBoard(App, v);
        UI.renderCards(App, v);
        if (!busy($('pitpred'))) UI.renderPit(App, v);
        if (!busy($('fuelpanel'))) UI.renderFuel(App, v);
        UI.renderAlerts(App, v);
        UI.renderChips(App);
        var tab = App.ui.tab;
        if (tab === 'gap') UI.renderGapChart(App, v);
        else if (tab === 'laps') UI.renderLapChart(App, v);
        else if (tab === 'stints' && !busy($('tab-stints'))) UI.renderStints(App);
        else if (tab === 'compare') UI.renderCompare(App, v);
        else if (tab === 'log' && !busy($('tab-log'))) UI.renderLog(App);
        else if (tab === 'calls') UI.renderCalls(App);
        else if (tab === 'inspect' && !busy($('tab-inspect'))) UI.renderInspect(App);
      }
      lastVer = v.version;
    }
    if (App.lt2c && $('dlg-source').open && $('lt2-session') && App.lt2c.sessions().length !== App.sessCount && !busy($('dlg-source'))) {
      App.sessCount = App.lt2c.sessions().length; $('lt2-session').innerHTML = App.sessionOptions();
    }
    if (App.recorder && $('rec-state') && $('dlg-source').open) $('rec-state').textContent = App.recorder.count + ' messages recorded' + (App.recSaved >= App.recorder.count ? ' (saved)' : '');
    if (App.ui.view === 'analysis' && App.ui.tab === 'map' && App.view && now - lastMap > 250) { lastMap = now; UI.renderMap(App, App.view); }
  }

  App.start = function () {
    App.settings = loadSettings();
    App.settings.sisters = (App.settings.teamCars || []).filter(function (x) { return String(x) !== String(App.settings.hero); });
    App.engine = new RS.Engine(App.settings);
    App.mirror = new RS.Mirror();
    App.adapter = new RS.LT2Adapter(App.mirror, App.settings.overrides || {});
    App.bridge = new RS.BridgeReceiver(App.mirror);
    wireBridge();
    var root = $('zs-app');
    root.addEventListener('click', onClick);
    root.addEventListener('pointerdown', function () { App.pointerDown = true; });
    G.addEventListener('pointerup', function () { App.pointerDown = false; });
    G.addEventListener('pointercancel', function () { App.pointerDown = false; });
    root.addEventListener('dblclick', onDbl);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    D.addEventListener('keydown', onKey);
    G.addEventListener('resize', function () { App.dirty = true; });
    G.addEventListener('beforeunload', function (e) { if (App.recorder && App.recorder.count > (App.recSaved || 0) + 50) { e.preventDefault(); e.returnValue = ''; } });
    App.setView(App.ui.view);
    Array.prototype.forEach.call(D.querySelectorAll('#btabs button'), function (b) { b.classList.toggle('on', b.dataset.tab === App.ui.tab); });
    Array.prototype.forEach.call(D.querySelectorAll('.tabbody'), function (b) { b.hidden = b.id !== 'tab-' + App.ui.tab; });
    setInterval(frame, 100);
    App.dirty = true; frame();
    if (G.location.hash === '#bridge') App.useBridge();
    else if (/^https?:$/.test(G.location.protocol || '') && RS.Hub) {
      RS.Hub.detect('', 4000).then(function (st) { App.hubAvailable = true; App.hubFull = st; if (App.source.kind === 'none') App.connectHub(st); }, function () { /* not served by the hub */ }).then(autoTeamPack);
    } else autoTeamPack();
  };
})(typeof window !== 'undefined' ? window : globalThis);
