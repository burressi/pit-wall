#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Zenith pit wall hub
===================
Runs on the strategy laptop. It connects once to Al Kamel live timing, follows the session that is
running, records every message, and serves the pit-wall screen to this laptop and to the crew's
phones. Every screen updates in real time (pushed, no refresh).

    py pitwall_hub.py                    follow the Zenith session that is running now
    py pitwall_hub.py --list             list the sessions on the feed and exit
    py pitwall_hub.py --series hsr       another Al Kamel feed (for a rehearsal)
    py pitwall_hub.py --session <id>     follow one session (ids come from --list)
    py pitwall_hub.py --tunnel           also give the crew an internet link (needs cloudflared)
    py pitwall_hub.py --learn <file>     learn the timing page's subscriptions from a capture or recording

Needs Python 3.8 or newer. Uses the websocket-client package when it is installed, otherwise its own
WebSocket code, so nothing else has to be installed.

Al Kamel's live timing data belongs to Al Kamel Systems. Keep the screen and the recordings inside the team.
"""
import argparse
import base64
import glob
import gzip
import hashlib
import http.server
import json
import os
import queue
import random
import re
import select
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

VERSION = '2026.11.23'
HOST = 'livetiming.alkamelsystems.com'
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, 'hub_state.json')

try:
    sys.stdout.reconfigure(errors='replace')
    sys.stderr.reconfigure(errors='replace')
except Exception:
    pass

# ---------------------------------------------------------------- clock
# A simulated clock is only used by the test harness (environment variables), never at the track.
_SIM_EPOCH = float(os.environ.get('ZS_SIM_EPOCH') or 0)
_SIM_T0 = float(os.environ.get('ZS_SIM_T0') or 0)
_SIM_SPEED = float(os.environ.get('ZS_SIM_SPEED') or 1)


def now_ms():
    if _SIM_EPOCH:
        return int(_SIM_EPOCH + (time.time() - _SIM_T0) * 1000 * _SIM_SPEED)
    return int(time.time() * 1000)


def say(msg):
    print(time.strftime('[%H:%M:%S] ') + msg, flush=True)


def local_time(ms):
    return time.strftime('%a %d %b %H:%M', time.localtime(ms / 1000.0)) if ms else '?'


# ---------------------------------------------------------------- WebSocket transports
class MiniWS(object):
    """Small RFC 6455 client: enough for one SockJS/DDP connection."""

    def __init__(self, url, timeout=20):
        u = urllib.parse.urlsplit(url)
        secure = u.scheme == 'wss'
        host = u.hostname
        port = u.port or (443 if secure else 80)
        path = (u.path or '/') + ('?' + u.query if u.query else '')
        sock = socket.create_connection((host, port), timeout=timeout)
        if secure:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        hostport = host if port in (80, 443) else '%s:%d' % (host, port)
        origin = '%s://%s' % ('https' if secure else 'http', hostport)
        req = ('GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nOrigin: %s\r\n'
               'User-Agent: Mozilla/5.0 (Zenith pit wall hub)\r\n\r\n') % (path, hostport, key, origin)
        sock.sendall(req.encode('ascii'))
        buf = b''
        while b'\r\n\r\n' not in buf:
            d = sock.recv(4096)
            if not d:
                raise ConnectionError('closed during the handshake')
            buf += d
            if len(buf) > 65536:
                raise ConnectionError('bad handshake')
        head, rest = buf.split(b'\r\n\r\n', 1)
        lines = head.decode('latin-1').split('\r\n')
        if len(lines[0].split()) < 2 or lines[0].split()[1] != '101':
            raise ConnectionError('server answered: ' + lines[0])
        hdr = {}
        for line in lines[1:]:
            if ':' in line:
                k, v = line.split(':', 1)
                hdr[k.strip().lower()] = v.strip()
        expect = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if hdr.get('sec-websocket-accept') != expect:
            raise ConnectionError('bad WebSocket accept key')
        self.sock = sock
        self.buf = bytearray(rest)
        self.frag = None
        self.lock = threading.Lock()
        sock.settimeout(timeout)

    def _frame(self, op, payload):
        n = len(payload)
        b = bytearray([0x80 | op])
        if n < 126:
            b.append(0x80 | n)
        elif n < 65536:
            b.append(0x80 | 126)
            b += struct.pack('>H', n)
        else:
            b.append(0x80 | 127)
            b += struct.pack('>Q', n)
        mask = os.urandom(4)
        b += mask
        if n:
            pm = (mask * (n // 4 + 1))[:n]
            b += (int.from_bytes(payload, 'big') ^ int.from_bytes(pm, 'big')).to_bytes(n, 'big')
        with self.lock:
            self.sock.sendall(bytes(b))

    def send(self, text):
        self._frame(0x1, text.encode('utf-8'))

    def _parse(self, out):
        while True:
            b = self.buf
            if len(b) < 2:
                return
            fin = b[0] & 0x80
            op = b[0] & 0x0F
            masked = b[1] & 0x80
            n = b[1] & 0x7F
            i = 2
            if n == 126:
                if len(b) < 4:
                    return
                n = struct.unpack('>H', bytes(b[2:4]))[0]
                i = 4
            elif n == 127:
                if len(b) < 10:
                    return
                n = struct.unpack('>Q', bytes(b[2:10]))[0]
                i = 10
            mk = None
            if masked:
                if len(b) < i + 4:
                    return
                mk = bytes(b[i:i + 4])
                i += 4
            if len(b) < i + n:
                return
            payload = bytes(b[i:i + n])
            del self.buf[:i + n]
            if mk and n:
                pm = (mk * (n // 4 + 1))[:n]
                payload = (int.from_bytes(payload, 'big') ^ int.from_bytes(pm, 'big')).to_bytes(n, 'big')
            if op == 0x8:
                code = struct.unpack('>H', payload[:2])[0] if len(payload) >= 2 else 1005
                raise ConnectionError('server closed the connection (%d %s)' % (code, payload[2:].decode('utf-8', 'replace')))
            if op == 0x9:
                self._frame(0xA, payload)
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2):
                if fin:
                    out.append(payload.decode('utf-8', 'replace'))
                else:
                    self.frag = bytearray(payload)
            elif op == 0x0 and self.frag is not None:
                self.frag += payload
                if fin:
                    out.append(bytes(self.frag).decode('utf-8', 'replace'))
                    self.frag = None

    def poll(self, timeout):
        out = []
        self._parse(out)
        if out:
            return out
        pending = isinstance(self.sock, ssl.SSLSocket) and self.sock.pending()
        if not pending:
            r, _, _ = select.select([self.sock], [], [], timeout)
            if not r:
                return out
        d = self.sock.recv(65536)
        if not d:
            raise ConnectionError('connection closed by the server')
        self.buf += d
        self._parse(out)
        return out

    def close(self):
        try:
            self._frame(0x8, struct.pack('>H', 1000))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class LibWS(object):
    """The websocket-client package (the one the recorder script used)."""

    def __init__(self, url, timeout=20):
        import websocket  # noqa
        self.mod = websocket
        self.ws = websocket.create_connection(url, timeout=timeout)

    def send(self, text):
        self.ws.send(text)

    def poll(self, timeout):
        self.ws.settimeout(timeout)
        try:
            m = self.ws.recv()
        except (self.mod.WebSocketTimeoutException, socket.timeout):
            return []
        except self.mod.WebSocketConnectionClosedException:
            raise ConnectionError('connection closed by the server')
        if m is None or m == '' or m == b'':
            raise ConnectionError('connection closed by the server')
        if isinstance(m, bytes):
            m = m.decode('utf-8', 'replace')
        return [m]

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def open_ws(url, builtin=False):
    if not builtin:
        try:
            import websocket  # noqa
            return LibWS(url)
        except ImportError:
            pass
    return MiniWS(url)


# ---------------------------------------------------------------- helpers
def oid(hexstr):
    return {'$type': 'oid', '$value': str(hexstr)}


def oid_str(v):
    if isinstance(v, dict):
        if '$value' in v:
            return str(v['$value'])
        if '_str' in v:
            return str(v['_str'])
        return ''
    return '' if v is None else str(v)


def doc_id(v):
    return json.dumps(v, separators=(',', ':'), sort_keys=True) if isinstance(v, (dict, list)) else str(v)


def rnd(n, chars):
    return ''.join(random.choice(chars) for _ in range(n))


def sockjs_url(host, scheme='wss'):
    return '%s://%s/sockjs/%s/%s/websocket' % (scheme, host, rnd(3, '0123456789'), rnd(8, 'abcdefghijklmnopqrstuvwxyz0123456789'))


def to_ms(v):
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, dict) and '$date' in v:
        return to_ms(v['$date'])
    if isinstance(v, str):
        try:
            return int(float(v))
        except ValueError:
            pass
    return None


def session_list(cols):
    ses = cols.get('sessions', {})
    ev = cols.get('events', {})
    out = []
    for sid, s in ses.items():
        e = ev.get(oid_str(s.get('event')), {})
        start, end = to_ms(s.get('date')), to_ms(s.get('endDate'))
        tz = s.get('UtcOffsetMin', s.get('utcOffsetMin'))
        label = ' | '.join(x for x in (str(e.get('champName') or '').strip(), str(e.get('name') or '').strip(), str(s.get('name') or '').strip()) if x)
        out.append({'id': sid, 'name': str(s.get('name') or '').strip(), 'event': str(e.get('name') or '').strip(),
                    'champ': str(e.get('champName') or '').strip(), 'start': start, 'end': end,
                    'closed': bool(s.get('closed') or s.get('isClosed') or s.get('finished')), 'utcOffsetMin': tz, 'label': label})
    out.sort(key=lambda x: x['start'] or 0)
    return out


def pick_live(lst, now, champ=None):
    """The session running now, else the next one within 30 min, else the last one that ended within 90 min."""
    if champ:
        c = champ.lower()
        lst = [s for s in lst if c in s['label'].lower()]
    if not lst:
        return None
    live = [s for s in lst if s['start'] and s['start'] - 10 * 60000 <= now and (not s['end'] or now <= s['end'] + 45 * 60000)]
    if live:
        open_ = [s for s in live if not s['closed']]
        return (open_ or live)[0]['id']
    nxt = [s for s in lst if s['start'] and now < s['start'] < now + 30 * 60000]
    if nxt:
        return nxt[0]['id']
    past = [s for s in lst if s['end'] and s['end'] < now and now - s['end'] < 90 * 60000]
    return past[-1]['id'] if past else None


# ---------------------------------------------------------------- subscription recipe
# The page subscribes to livetimingFeed [series] first; the feed lists the session ids; then
# sessions / sessionInfo / trackInfo take [[all feed sessions]] and the per-session data sets take the
# chosen session. Publication names follow the collection names in camelCase (session_classes ->
# sessionClasses, which is confirmed), so those are tried first; the others are fallbacks.
DEFAULT_RECIPE = {
    'feed': [{'name': 'livetimingFeed', 'params': ['$SERIES']}],
    'list': [{'name': 'sessions', 'params': ['$FEED_SESSIONS']},
             {'name': 'sessionInfo', 'params': ['$FEED_SESSIONS']},
             {'name': 'trackInfo', 'params': ['$FEED_SESSIONS']}],
    'session': [
        {'key': 'classes', 'names': ['sessionClasses'], 'params': ['$SESSION']},
        {'key': 'standings', 'names': ['standings', 'sessionStandings', 'liveStandings'], 'params': ['$SESSION']},
        {'key': 'pits', 'names': ['sessionPitInfo', 'pitInfo', 'sessionPits'], 'params': ['$SESSION']},
        {'key': 'status', 'names': ['sessionStatus', 'status'], 'params': ['$SESSION']},
        {'key': 'rc', 'names': ['raceControl', 'sessionRaceControl', 'raceControlMessages'], 'params': ['$SESSION']},
        {'key': 'weather', 'names': ['weather', 'sessionWeather'], 'params': ['$SESSION']},
        {'key': 'entry', 'names': ['sessionEntry', 'sessionEntries', 'entries'], 'params': ['$SESSION']},
        {'key': 'results', 'names': ['sessionResults', 'results'], 'params': ['$SESSION']},
    ]
}


def fill(params, ctx):
    out = []
    for p in params or []:
        if p == '$SERIES':
            out.append(ctx['series'])
        elif p == '$SESSION':
            out.append(oid(ctx['session']))
        elif p == '$FEED_SESSIONS':
            out.append([oid(x) for x in ctx['feed_sessions']])
        elif isinstance(p, list):
            out.append(fill(p, ctx))
        else:
            out.append(p)
    return out


def _is_oid(v):
    return isinstance(v, dict) and v.get('$type') == 'oid'


def generalise(subs):
    r = {'feed': [], 'list': [], 'session': [], 'learned': True}
    for s in subs:
        p = s.get('params') or []
        name = s['name']
        if len(p) == 1 and isinstance(p[0], str):
            r['feed'].append({'name': name, 'params': ['$SERIES']})
        elif name.lower() == 'events':
            continue
        elif len(p) == 1 and isinstance(p[0], list) and (len(p[0]) > 1 or name in ('sessions', 'sessionInfo', 'trackInfo')):
            r['list'].append({'name': name, 'params': ['$FEED_SESSIONS']})
        elif len(p) == 1 and isinstance(p[0], list) and len(p[0]) == 1 and _is_oid(p[0][0]):
            r['session'].append({'key': name, 'names': [name], 'params': [['$SESSION']]})
        elif len(p) >= 1 and _is_oid(p[0]):
            r['session'].append({'key': name, 'names': [name], 'params': ['$SESSION'] + p[1:]})
        else:
            r['session'].append({'key': name, 'names': [name], 'params': p, 'literal': True})
    if not r['feed']:
        r['feed'] = list(DEFAULT_RECIPE['feed'])
    if not r['list']:
        r['list'] = list(DEFAULT_RECIPE['list'])
    return r


def _scan_object(t, i):
    depth, ins, esc = 0, False, False
    for j in range(i, min(len(t), i + 20000)):
        ch = t[j]
        if ins:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                ins = False
        elif ch == '"':
            ins = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return t[i:j + 1]
    return None


def recipe_from_text(text):
    """Subscriptions from a WebSocket capture pasted from the browser, the bridge list, or a recording."""
    t = text.replace('\U0001F615', ':\\').replace('\U0001F641', ':[')
    found, seen = [], set()

    def push(m):
        if not isinstance(m, dict) or m.get('msg') != 'sub' or not m.get('name'):
            return
        n = m['name']
        if re.match(r'^(meteor|_roles$)', n, re.I) or n in seen:
            return
        seen.add(n)
        found.append({'name': n, 'params': m.get('params') or []})

    def walk(v, depth=0):
        if depth > 5:
            return
        if isinstance(v, dict):
            if v.get('msg') == 'sub':
                push(v)
            for x in v.values():
                walk(x, depth + 1)
        elif isinstance(v, list):
            for x in v:
                walk(x, depth + 1)
        elif isinstance(v, str) and 'sub' in v and v.lstrip()[:2] in ('a[', 'm"', '["', '[{', '{"'):
            s = v.lstrip()
            s = s[1:] if s[:1] in ('a', 'm') else s
            try:
                walk(json.loads(s), depth + 1)
            except ValueError:
                pass

    for line in t.splitlines():
        line = line.strip()
        if '"sub' not in line and '\\"sub' not in line:
            continue
        done = False
        for cand in (line, line[1:] if line[:1] == 'a' else None, re.split(r'\s{2,}|\t', line)[0]):
            if not cand:
                continue
            try:
                walk(json.loads(cand))
                done = True
                break
            except ValueError:
                pass
        if done:
            continue
        flat = line
        for _ in range(4):
            if '\\"' not in flat:
                break
            flat = flat.replace('\\\\', '\x00').replace('\\"', '"').replace('\x00', '\\')
        for mt in re.finditer(r'\{\s*"msg"\s*:\s*"sub"', flat):
            obj = _scan_object(flat, mt.start())
            if obj:
                try:
                    push(json.loads(obj))
                except ValueError:
                    pass
    return generalise(found) if found else None


# ---------------------------------------------------------------- the hub
class Hub(object):
    def __init__(self, args):
        self.args = args
        self.series = args.series
        self.cond = threading.Condition()
        self.cols = {}
        self.stopping = False
        self.started = now_ms()
        self.epoch_n = 0
        self.epoch = None
        self.session_id = None
        self.log = []
        self.rec_fh = None
        self.rec_path = None
        self.msg_total = 0
        self.last_data = None
        self.last_t = 0              # stamps never go backwards (clock adjustments, restarts)
        self.clock_offset = None
        self.clients = {}
        self.client_seq = 0
        self.tunnel_url = None
        self.state = self._load_state()
        self.settings_ver = 1
        self.rec_dir = os.path.abspath(args.record_dir)
        os.makedirs(self.rec_dir, exist_ok=True)
        self.upstream = None
        self.begin_epoch(None)

    # ---- persistent state (learned subscriptions, shared team settings)
    def _load_state(self):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                st = json.load(f)
                if isinstance(st, dict):
                    return st
        except Exception:
            pass
        return {}

    def save_state(self):
        try:
            tmp = STATE_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.state, f, indent=1)
            os.replace(tmp, STATE_FILE)
        except Exception as e:
            say('Could not save hub_state.json: %s' % e)

    def recipe(self):
        st = self.state
        r = st.get('recipe')
        if isinstance(r, dict) and r.get('session'):
            return r
        r = json.loads(json.dumps(DEFAULT_RECIPE))
        learned = st.get('learned') or {}
        for x in r['session']:
            ln = learned.get(x['key'])
            if ln and ln.get('name'):
                x['names'] = [ln['name']] + [n for n in x['names'] if n != ln['name']]
        return r

    # ---- mirror of the DDP collections
    def _apply(self, m):
        k = m.get('msg')
        col = m.get('collection')
        i = doc_id(m.get('id'))
        if k in ('added', 'addedBefore'):
            d = dict(m.get('fields') or {})
            d['_id'] = i
            self.cols.setdefault(col, {})[i] = d
        elif k == 'changed':
            d = self.cols.setdefault(col, {}).setdefault(i, {'_id': i})
            for f, v in (m.get('fields') or {}).items():
                d[f] = v
            for f in m.get('cleared') or []:
                d.pop(f, None)
        elif k == 'removed':
            self.cols.get(col, {}).pop(i, None)

    # ---- the per-session message log every screen replays
    def _base_lines(self, sid, t):
        lines = []
        for col, docs in self.cols.items():
            for i, d in docs.items():
                s = d.get('session', d.get('sessionId'))
                if s is not None and oid_str(s) and oid_str(s) != sid:
                    continue
                fields = {k: v for k, v in d.items() if k != '_id'}
                try:
                    did = json.loads(i) if i[:1] in '{[' else i
                except ValueError:
                    did = i
                lines.append(json.dumps({'t': t, 'm': {'msg': 'added', 'collection': col, 'id': did, 'fields': fields}}, separators=(',', ':'), ensure_ascii=False))
        return lines

    def begin_epoch(self, sid):
        """A new session: start a fresh log (current documents first) and a fresh recording file."""
        with self.cond:
            self._close_recording()
            self.epoch_n += 1
            self.epoch = '%d-%d' % (self.started, self.epoch_n)
            self.session_id = sid
            self.log = []
            resumed = 0
            if sid:
                resumed = self._open_recording(sid)
            t = self.last_t = max(now_ms(), self.last_t)
            self.log.extend(self._base_lines(sid, t))
            if self.rec_fh and not resumed:
                for line in self.log:
                    self.rec_fh.write(line + '\n')
            elif self.rec_fh:
                for line in self.log[resumed:]:
                    self.rec_fh.write(line + '\n')
            self.cond.notify_all()
        return resumed

    def _open_recording(self, sid):
        """Continue this session's recording if the hub was restarted mid-session; returns lines reloaded."""
        pat = os.path.join(self.rec_dir, '%s_%s_*.jsonl' % (self.series, sid))
        old = sorted(glob.glob(pat) + glob.glob(pat + '.gz'), key=os.path.getmtime)
        n = 0
        if old:
            path = old[-1]
            try:
                opener = gzip.open if path.endswith('.gz') else open
                with opener(path, 'rt', encoding='utf-8', errors='replace') as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith('{"t"'):
                            self.log.append(line)
                if self.log:
                    try:
                        self.last_t = max(self.last_t, int(json.loads(self.log[-1])['t']))
                    except (ValueError, KeyError, TypeError):
                        pass
                n = len(self.log)
                if path.endswith('.gz'):
                    plain = path[:-3]
                    with open(plain, 'w', encoding='utf-8') as f:
                        for line in self.log:
                            f.write(line + '\n')
                    os.remove(path)
                    path = plain
                self.rec_path = path
                self.rec_fh = open(path, 'a', encoding='utf-8')
                say('Picked up this session\'s recording: %s (%d messages)' % (os.path.basename(path), n))
                return n
            except Exception as e:
                say('Could not reopen %s: %s' % (os.path.basename(path), e))
                self.log = []
        self.rec_path = os.path.join(self.rec_dir, '%s_%s_%s.jsonl' % (self.series, sid, time.strftime('%Y%m%d_%H%M%S')))
        self.rec_fh = open(self.rec_path, 'w', encoding='utf-8')
        return 0

    def _close_recording(self):
        if self.rec_fh:
            try:
                self.rec_fh.close()
            except Exception:
                pass
            self.rec_fh = None

    def finish_recording_file(self, path):
        """Compress a finished session's recording in the background."""
        def run():
            try:
                with open(path, 'rb') as src, gzip.open(path + '.gz', 'wb', compresslevel=6) as dst:
                    while True:
                        b = src.read(1 << 20)
                        if not b:
                            break
                        dst.write(b)
                os.remove(path)
            except Exception as e:
                say('Could not compress %s: %s' % (os.path.basename(path), e))
        if path and os.path.exists(path):
            threading.Thread(target=run, daemon=True).start()

    def on_data(self, m):
        with self.cond:
            t = self.last_t = max(now_ms(), self.last_t)
            line = json.dumps({'t': t, 'm': m}, separators=(',', ':'), ensure_ascii=False)
            self._apply(m)
            self.log.append(line)
            if self.rec_fh:
                try:
                    self.rec_fh.write(line + '\n')
                except Exception:
                    pass
            self.msg_total += 1
            self.last_data = t
            self.cond.notify_all()

    def flush(self):
        with self.cond:
            if self.rec_fh:
                try:
                    self.rec_fh.flush()
                except Exception:
                    pass

    # ---- status for the screens
    def cars(self):
        sid = self.session_id
        n = 0
        for col, docs in self.cols.items():
            if 'standing' not in col.lower():
                continue
            for d in docs.values():
                s = d.get('session', d.get('sessionId'))
                if sid and s is not None and oid_str(s) != sid:
                    continue
                if isinstance(d.get('data'), str) and d['data'].count(';') >= 5:
                    n += 1
                else:
                    for v in d.values():
                        if isinstance(v, list):
                            n += sum(1 for x in v if isinstance(x, dict))
        return n

    def lan_urls(self):
        port = self.args.port
        ips = []
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('10.255.255.255', 1))
            ips.append(s.getsockname()[0])
            s.close()
        except Exception:
            pass
        try:
            for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
                if ip not in ips:
                    ips.append(ip)
        except Exception:
            pass
        return ['http://%s:%d/' % (ip, port) for ip in ips if not ip.startswith('127.') and not ip.startswith('169.254.')]

    def status(self, full=False, local=False):
        with self.cond:
            return self._status(full, local)

    def _status(self, full, local):
        up = self.upstream
        lst = session_list(self.cols)
        cur = next((s for s in lst if s['id'] == self.session_id), None)
        st = {
            'hub': True, 'version': VERSION, 'series': self.series, 'now': now_ms(),
            'state': up.state if up else 'starting', 'detail': up.detail if up else '',
            'epoch': self.epoch, 'session': cur or ({'id': self.session_id} if self.session_id else None),
            'auto': (up.mode == 'auto') if up else True, 'msgs': len(self.log), 'total': self.msg_total,
            'cars': self.cars(), 'lastData': self.last_data, 'clockOffset': self.clock_offset,
            'clients': len(self.clients), 'subs': up.sub_status() if up else {},
            'recording': os.path.basename(self.rec_path) if self.rec_path and self.session_id else None,
            'settingsVer': self.settings_ver, 'local': local,
        }
        if full:
            st['sessions'] = lst
            st['settings'] = self.state.get('settings') or None
            st['urls'] = {'local': 'http://localhost:%d/' % self.args.port, 'lan': self.lan_urls(), 'tunnel': self.tunnel_url}
            st['recipe'] = 'capture' if (self.state.get('recipe') or {}).get('session') else ('learned' if self.state.get('learned') else 'built-in')
        return st


# ---------------------------------------------------------------- Al Kamel connection
class Upstream(threading.Thread):
    def __init__(self, hub, url=None, mode='auto', builtin=False):
        threading.Thread.__init__(self, daemon=True)
        self.hub = hub
        self.fixed_url = url
        self.builtin = builtin
        self.mode = mode            # 'auto' or a session id
        self.cmds = queue.Queue()
        self.ws = None
        self.sockjs = True
        self.subs = {}
        self.next_id = 1
        self.state = 'starting'
        self.detail = ''
        self.retry = 0
        self.feed_sessions = []
        self.list_key = ''
        self.list_subs = []
        self.session_id = None
        self.session_subs = {}
        self.recipe = hub.recipe()
        self.sessions_dirty = True
        self.last_pick = 0
        self.sub_log = []

    # ---- state
    def set_state(self, s, detail=''):
        if s != self.state or detail != self.detail:
            self.state, self.detail = s, detail
            say('Al Kamel: %s%s' % (s, (' - ' + detail) if detail else ''))

    def url(self):
        if self.fixed_url:
            if '{rand}' in self.fixed_url:
                return self.fixed_url.replace('{rand}', '%s/%s' % (rnd(3, '0123456789'), rnd(8, 'abcdefghijklmnopqrstuvwxyz0123456789')))
            return self.fixed_url
        return sockjs_url(HOST)

    def run(self):
        while not self.hub.stopping:
            err = ''
            try:
                self.connect_once()
            except Exception as e:
                err = str(e) or e.__class__.__name__
            finally:
                if self.ws:
                    self.ws.close()
                    self.ws = None
            if self.hub.stopping:
                break
            wait = [1, 2, 5, 10, 15][min(self.retry, 4)]
            self.retry += 1
            self.set_state('reconnecting', 'in %d s (%s)' % (wait, err or 'connection dropped'))
            end = time.time() + wait
            while time.time() < end and not self.hub.stopping:
                self.process_cmds()
                time.sleep(0.2)

    def connect_once(self):
        url = self.url()
        self.sockjs = '/sockjs/' in url
        self.set_state('connecting', urllib.parse.urlsplit(url).netloc)
        for s in self.subs.values():
            s['ready'] = False
        self.ws = open_ws(url, self.builtin)
        if not self.sockjs:
            self.send({'msg': 'connect', 'version': '1', 'support': ['1', 'pre2', 'pre1']})
        last_rx = time.time()
        while not self.hub.stopping:
            self.process_cmds()
            texts = self.ws.poll(0.5)
            if texts:
                last_rx = time.time()
            elif time.time() - last_rx > 75:
                raise ConnectionError('nothing from the timing server for 75 s')
            for t in texts:
                self.on_frame(t)
            if self.state == 'connected':
                self.check_session()

    def send(self, m):
        s = json.dumps(m, separators=(',', ':'))
        self.ws.send(json.dumps([s]) if self.sockjs else s)

    def on_frame(self, t):
        if self.sockjs:
            if t == 'o':
                self.send({'msg': 'connect', 'version': '1', 'support': ['1', 'pre2', 'pre1']})
                return
            if t == 'h':
                return
            if t[:1] == 'c':
                raise ConnectionError('server closed the session ' + t[1:120])
            if t[:1] == 'a':
                arr = json.loads(t[1:])
            elif t[:1] == 'm':
                arr = [json.loads(t[1:])]
            else:
                return
        else:
            arr = [t]
        for x in arr:
            try:
                m = json.loads(x) if isinstance(x, str) else x
            except ValueError:
                continue
            if isinstance(m, list):
                for y in m:
                    self.on_msg(y)
            else:
                self.on_msg(m)

    def on_msg(self, m):
        if not isinstance(m, dict):
            return
        k = m.get('msg')
        if k == 'ping':
            self.send({'msg': 'pong', 'id': m['id']} if m.get('id') else {'msg': 'pong'})
            return
        if k == 'pong':
            return
        if k == 'connected':
            self.retry = 0
            self.state = 'connected'
            for sid, s in list(self.subs.items()):
                s['ready'] = False
                self.send({'msg': 'sub', 'id': sid, 'name': s['name'], 'params': s['params']})
            if not self.subs:
                for r in self.recipe['feed']:
                    self.subscribe(r['name'], fill(r['params'], self.ctx()), 'feed')
            self.set_state('connected', 'feed %s' % self.hub.series)
            return
        if k == 'failed':
            raise ConnectionError('server refused DDP version %s' % m.get('version'))
        if k == 'ready':
            for i in m.get('subs') or []:
                s = self.subs.get(i)
                if s:
                    s['ready'] = True
                    if s['group'] == 'session':
                        self.on_session_ready(s)
            return
        if k == 'nosub':
            s = self.subs.pop(m.get('id'), None)
            if s:
                e = m.get('error') or {}
                s['error'] = str(e.get('reason') or e.get('message') or e.get('error') or 'stopped')
                self.on_nosub(s)
            return
        if k == 'error':
            say('Al Kamel says: %s' % (m.get('reason') or m))
            return
        if k in ('added', 'changed', 'removed', 'addedBefore', 'movedBefore'):
            self.hub.on_data(m)
            if m.get('collection') in ('feeds', 'sessions', 'events'):
                self.sessions_dirty = True
                if m.get('collection') == 'feeds':
                    self.on_feed()

    # ---- subscriptions
    def ctx(self):
        return {'series': self.hub.series, 'feed_sessions': self.feed_sessions, 'session': self.session_id}

    def subscribe(self, name, params, group, key=None, extra=None):
        sid = 'zs%d' % self.next_id
        self.next_id += 1
        s = {'id': sid, 'name': name, 'params': params, 'group': group, 'key': key or name, 'ready': False, 'error': None}
        s.update(extra or {})
        self.subs[sid] = s
        self.sub_log.append('%s %s' % (name, json.dumps(params)[:90]))
        self.sub_log = self.sub_log[-60:]
        if self.state == 'connected' and self.ws:
            self.send({'msg': 'sub', 'id': sid, 'name': name, 'params': params})
        return sid

    def unsubscribe(self, sid):
        if self.subs.pop(sid, None) is not None and self.state == 'connected' and self.ws:
            try:
                self.send({'msg': 'unsub', 'id': sid})
            except Exception:
                pass

    def on_feed(self):
        feeds = self.hub.cols.get('feeds', {})
        mine = None
        for d in feeds.values():
            if mine is None or str(d.get('name', '')).lower() == self.hub.series.lower():
                mine = d
        if not mine or not isinstance(mine.get('sessions'), list):
            return
        lst = [x for x in (oid_str(v) for v in mine['sessions']) if x]
        key = ','.join(lst)
        if key and key != self.list_key:
            self.list_key = key
            self.feed_sessions = lst
            for sid in self.list_subs:
                self.unsubscribe(sid)
            self.list_subs = [self.subscribe(r['name'], fill(r['params'], self.ctx()), 'list') for r in self.recipe['list']]

    def check_session(self, force=False):
        if self.mode == 'list':
            return
        now = time.time()
        if not force and not self.sessions_dirty and now - self.last_pick < 5:
            return
        self.sessions_dirty = False
        self.last_pick = now
        if self.mode == 'auto':
            want = pick_live(session_list(self.hub.cols), now_ms() + (self.hub.clock_offset or 0), self.hub.args.champ)
        else:
            want = self.mode
        if want and want != self.session_id:
            self.use_session(want)

    def use_session(self, sid):
        old_path = self.hub.rec_path if self.session_id else None
        for k, x in list(self.session_subs.items()):
            for i in x.get('ids', []):
                self.unsubscribe(i)
        self.session_subs = {}
        self.session_id = sid
        resumed = self.hub.begin_epoch(sid)
        if old_path and old_path != self.hub.rec_path:
            self.hub.finish_recording_file(old_path)
        info = next((s for s in session_list(self.hub.cols) if s['id'] == sid), None)
        say('Following %s (%s, starts %s)%s' % (info['label'] if info else sid, sid, local_time(info['start']) if info else '?',
                                                ' - resumed %d recorded messages' % resumed if resumed else ''))
        for r in self.recipe['session']:
            self.try_session(r, 0)

    def try_session(self, r, ix):
        """Subscribe one per-session data set; both parameter shapes ([id] and [[id]]) are tried at once."""
        names = r['names']
        if ix >= len(names):
            self.session_subs[r['key']] = {'failed': True, 'tried': names, 'ids': []}
            say('Data set "%s": none of %s accepted' % (r['key'], ', '.join(names)))
            return
        name = names[ix]
        ids = []
        shapes = [0] if r.get('literal') else ([1] if r['params'] == [['$SESSION']] else [0, 1])
        for shape in shapes:
            params = [[oid(self.session_id)]] if shape == 1 else fill(r['params'], self.ctx())
            ids.append(self.subscribe(name, params, 'session', r['key'], {'shape': shape, 'r': r, 'ix': ix}))
        self.session_subs[r['key']] = {'name': name, 'ids': ids, 'ix': ix, 'r': r, 'errors': []}

    def on_session_ready(self, s):
        cur = self.session_subs.get(s['key'])
        if not cur or s['id'] not in cur.get('ids', []):
            return
        learned = self.hub.state.setdefault('learned', {})
        if learned.get(s['key'], {}).get('name') != s['name']:
            learned[s['key']] = {'name': s['name'], 'shape': s.get('shape', 0)}
            self.hub.save_state()
        say('Data set "%s" streaming (%s)' % (s['key'], s['name']))

    def on_nosub(self, s):
        if s['group'] != 'session':
            say('Subscription %s refused: %s' % (s['name'], s['error']))
            return
        cur = self.session_subs.get(s['key'])
        if not cur or s['id'] not in cur.get('ids', []):
            return
        cur['ids'] = [i for i in cur['ids'] if i != s['id']]
        cur['errors'].append(s['error'])
        if cur['ids']:
            return            # the other parameter shape is still open
        say('Data set "%s": %s refused (%s)' % (s['key'], s['name'], '; '.join(e for e in cur['errors'] if e)[:160]))
        self.try_session(cur['r'], cur['ix'] + 1)        # try the next name

    def sub_status(self):
        out = {}
        for k, x in list(self.session_subs.items()):
            if x.get('failed'):
                out[k] = 'refused (%s)' % '/'.join(x.get('tried', []))
                continue
            live = [y for y in (self.subs.get(i) for i in list(x.get('ids', []))) if y]
            if any(s['ready'] for s in live):
                out[k] = 'ok - ' + x['name']
            else:
                out[k] = 'waiting - ' + x['name']
        return out

    # ---- commands from the screens (run on this thread)
    def process_cmds(self):
        while True:
            try:
                cmd, arg = self.cmds.get_nowait()
            except queue.Empty:
                return
            try:
                if cmd == 'session':
                    self.mode = arg or 'auto'
                    if self.mode == 'auto':
                        self.check_session(force=True)
                    elif self.mode != self.session_id:
                        self.use_session(self.mode)
                elif cmd == 'recipe':
                    self.recipe = self.hub.recipe()
                    if self.session_id:
                        self.use_session(self.session_id)
                elif cmd == 'reconnect' and self.ws:
                    self.ws.close()
            except Exception as e:
                say('Command %s failed: %s' % (cmd, e))


# ---------------------------------------------------------------- web server
class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != 'nt'     # POSIX: rebind straight after a restart; Windows: never share the port
    request_queue_size = 32


def find_page():
    # in the repository the page is index.html one level up; a stand-alone copy can keep it in web/
    for cand in (os.path.join(HERE, 'web', 'index.html'), os.path.join(HERE, '..', 'index.html'), os.path.join(HERE, 'index.html')):
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def find_team_pack():
    # private team data (race replays + fuel numbers); never part of the repository
    for cand in (os.path.join(HERE, '..', 'private', 'team-pack.json'), os.path.join(HERE, 'private', 'team-pack.json'),
                 os.path.join(HERE, 'team-pack.json'), os.path.join(HERE, '..', 'private', 'pit-wall-team-pack.json'),
                 os.path.join(HERE, '..', 'pit-wall-team-pack.json'), os.path.join(HERE, 'pit-wall-team-pack.json')):
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def make_handler(hub):
    page_cache = {}
    pack_cache = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'PitWallHub/' + VERSION

        def log_message(self, *a):
            pass

        def is_local(self):
            if self.headers.get('Cf-Connecting-Ip') or self.headers.get('X-Forwarded-For'):
                return False
            return self.client_address[0] in ('127.0.0.1', '::1', '::ffff:127.0.0.1')

        def _send(self, code, body, ctype, extra=None):
            if isinstance(body, str):
                body = body.encode('utf-8')
            if len(body) > 2048 and 'gzip' in (self.headers.get('Accept-Encoding') or '') and not ctype.startswith('image/'):
                body = gzip.compress(body, 5)
                extra = dict(extra or {})
                extra['Content-Encoding'] = 'gzip'
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, separators=(',', ':')), 'application/json; charset=utf-8')

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(u.query)
            p = u.path
            try:
                if p == '/api/team-pack':
                    path = find_team_pack()
                    if not path:
                        return self._send(404, 'no team pack', 'text/plain; charset=utf-8')
                    mt = os.path.getmtime(path)
                    if pack_cache.get('mt') != mt or pack_cache.get('path') != path:
                        with open(path, 'rb') as f:
                            raw = f.read()
                        pack_cache.update(mt=mt, path=path, raw=raw)
                    return self._send(200, pack_cache['raw'], 'application/json; charset=utf-8')
                if p in ('/', '/index.html'):
                    path = find_page()
                    if not path:
                        return self._send(500, 'index.html is missing (it belongs in the folder above pitwall_hub.py)', 'text/plain; charset=utf-8')
                    mt = os.path.getmtime(path)
                    if page_cache.get('mt') != mt:
                        with open(path, 'rb') as f:
                            raw = f.read()
                        page_cache.update(mt=mt, raw=raw, gz=gzip.compress(raw, 6))
                    if 'gzip' in (self.headers.get('Accept-Encoding') or ''):
                        body = page_cache['gz']
                        self.send_response(200)
                        self.send_header('Content-Type', 'text/html; charset=utf-8')
                        self.send_header('Content-Encoding', 'gzip')
                        self.send_header('Content-Length', str(len(body)))
                        self.send_header('Cache-Control', 'no-cache')
                        self.end_headers()
                        if self.command != 'HEAD':
                            self.wfile.write(body)
                        return
                    return self._send(200, page_cache['raw'], 'text/html; charset=utf-8')
                if p == '/api/hub':
                    return self._json(hub.status(full=True, local=self.is_local()))
                if p == '/api/log':
                    return self.send_log(q)
                if p == '/api/stream':
                    return self.stream(q)
                if p == '/api/recordings' and self.is_local():
                    files = sorted(os.listdir(hub.rec_dir))
                    return self._json([{'name': n, 'bytes': os.path.getsize(os.path.join(hub.rec_dir, n))} for n in files if '.jsonl' in n])
                if p.startswith('/recordings/') and self.is_local():
                    name = os.path.basename(urllib.parse.unquote(p[len('/recordings/'):]))
                    path = os.path.join(hub.rec_dir, name)
                    if '.jsonl' in name and os.path.isfile(path):
                        hub.flush()
                        with open(path, 'rb') as f:
                            data = f.read()
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/octet-stream')
                        self.send_header('Content-Disposition', 'attachment; filename="%s"' % name)
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                if p == '/favicon.ico':
                    return self._send(204, b'', 'image/x-icon')
                return self._send(404, 'not found', 'text/plain; charset=utf-8')
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def send_log(self, q):
            epoch = (q.get('epoch') or [''])[0]
            start = int((q.get('from') or ['0'])[0] or 0)
            limit = min(int((q.get('limit') or ['20000'])[0] or 20000), 100000)
            try:
                wait = min(max(float((q.get('wait') or ['0'])[0] or 0), 0), 25)
            except ValueError:
                wait = 0
            with hub.cond:
                # long-poll (links that cannot stream): hold the request until something new arrives
                end = time.time() + wait
                while wait and not hub.stopping and (not epoch or epoch == hub.epoch) and len(hub.log) <= start and time.time() < end:
                    hub.cond.wait(min(1.0, max(0.05, end - time.time())))
                if epoch and epoch != hub.epoch:
                    return self._json({'error': 'epoch', 'epoch': hub.epoch}, 409)
                total = len(hub.log)
                lines = hub.log[start:start + limit]
                ep = hub.epoch
            body = '\n'.join(lines) + ('\n' if lines else '')
            self._send(200, body, 'application/x-ndjson; charset=utf-8',
                       {'X-Epoch': ep, 'X-From': str(start), 'X-Next': str(start + len(lines)), 'X-Total': str(total), 'X-Now': str(now_ms())})

        def stream(self, q):
            epoch = (q.get('epoch') or [''])[0]
            idx = int((q.get('from') or ['0'])[0] or 0)
            last = self.headers.get('Last-Event-ID') or ''
            if '|' in last:
                e, _, n = last.partition('|')
                if e == epoch and n.isdigit():
                    idx = int(n)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            local = self.is_local()
            with hub.cond:
                hub.client_seq += 1
                cid = hub.client_seq
                hub.clients[cid] = {'ip': self.headers.get('Cf-Connecting-Ip') or self.client_address[0], 'since': now_ms(), 'local': local}
            w = self.wfile
            try:
                w.write(b'retry: 2000\n\n')
                w.flush()
                last_status = 0
                while not hub.stopping:
                    with hub.cond:
                        if hub.epoch == epoch and len(hub.log) <= idx:
                            hub.cond.wait(1.0)
                        changed = hub.epoch != epoch
                    if not changed and len(hub.log) > idx:
                        time.sleep(0.06)                  # gather a little more into one push
                    with hub.cond:
                        changed = hub.epoch != epoch
                        batch = [] if changed else hub.log[idx:idx + 4000]
                        ep = hub.epoch
                    out = []
                    if changed:
                        out.append('event: epoch\ndata: %s\n\n' % json.dumps({'epoch': ep}))
                    elif batch:
                        idx += len(batch)
                        out.append('id: %s|%d\nevent: m\ndata: {"now":%d,"n":%d,"msgs":[%s]}\n\n' % (epoch, idx, now_ms(), idx, ','.join(batch)))
                    if time.time() - last_status >= 2 or changed:
                        last_status = time.time()
                        out.append('event: s\ndata: %s\n\n' % json.dumps(hub.status(local=local), separators=(',', ':')))
                    if out:
                        w.write(''.join(out).encode('utf-8'))
                        w.flush()
                    if changed:
                        break
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                with hub.cond:
                    hub.clients.pop(cid, None)

        def do_POST(self):
            u = urllib.parse.urlsplit(self.path)
            n = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(n) if n else b''
            try:
                body = json.loads(raw.decode('utf-8') or '{}')
            except ValueError:
                body = {}
            if not self.is_local():
                return self._json({'error': 'Only the laptop running the hub can change this.'}, 403)
            p = u.path
            up = hub.upstream
            if p == '/api/session':
                up.cmds.put(('session', str(body.get('session') or 'auto')))
                return self._json({'ok': True})
            if p == '/api/settings':
                s = body.get('settings')
                if isinstance(s, dict):
                    hub.state['settings'] = s
                    hub.settings_ver += 1
                    hub.save_state()
                return self._json({'ok': True, 'settingsVer': hub.settings_ver})
            if p == '/api/recipe':
                r = body.get('recipe')
                if r is None:
                    hub.state.pop('recipe', None)
                    if body.get('forget'):
                        hub.state.pop('learned', None)
                elif isinstance(r, dict) and r.get('session'):
                    hub.state['recipe'] = r
                else:
                    return self._json({'error': 'no subscriptions in that recipe'}, 400)
                hub.save_state()
                up.cmds.put(('recipe', None))
                return self._json({'ok': True})
            if p == '/api/reconnect':
                up.cmds.put(('reconnect', None))
                return self._json({'ok': True})
            return self._json({'error': 'not found'}, 404)

    return Handler


# ---------------------------------------------------------------- extras
def timesync_loop(hub):
    """Al Kamel's server clock (the timing page uses /_timesync for the same thing)."""
    while not hub.stopping:
        try:
            t0 = now_ms()
            with urllib.request.urlopen('https://%s/_timesync' % HOST, timeout=10) as r:
                srv = float(r.read().decode().strip())
            t1 = now_ms()
            if srv > 1e12:
                off = int(srv - (t0 + t1) / 2)
                if hub.clock_offset is None or abs(off - hub.clock_offset) > 250:
                    say('Clock: Al Kamel server is %+.1f s from this laptop' % (off / 1000.0))
                hub.clock_offset = off
        except Exception:
            pass
        for _ in range(600):
            if hub.stopping:
                return
            time.sleep(1)


def start_tunnel(hub, port, allow=None):
    exe = None
    for cand in (os.path.join(HERE, 'cloudflared.exe'), os.path.join(HERE, 'cloudflared')):
        if os.path.isfile(cand):
            exe = cand
    if not exe:
        from shutil import which
        exe = which('cloudflared')
    if not exe:
        say('Tunnel: cloudflared not found. Put cloudflared.exe next to pitwall_hub.py (see the guide). Carrying on without it.')
        return None
    try:
        cmd = [exe, 'tunnel', '--no-autoupdate', '--url', 'http://localhost:%d' % port]
        if allow:
            cmd += ['--allowed-mail', allow]
        p = subprocess.Popen(cmd,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, bufsize=1)
    except Exception as e:
        say('Tunnel: could not start cloudflared (%s)' % e)
        return None

    def read():
        for line in p.stdout:
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if m and not hub.tunnel_url:
                hub.tunnel_url = m.group(0) + '/'
                say('Crew internet link: %s' % hub.tunnel_url)
    threading.Thread(target=read, daemon=True).start()
    return p


def keep_awake():
    if os.name == 'nt':
        try:
            import ctypes
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
            return True
        except Exception:
            return False
    return False


def list_sessions(args):
    hub = Hub(args)
    up = Upstream(hub, args.upstream, mode='list', builtin=args.builtin_ws)
    hub.upstream = up
    up.start()
    deadline = time.time() + 25
    last_n, stable = -1, 0
    while time.time() < deadline:
        time.sleep(1)
        n = len(session_list(hub.cols))
        stable = stable + 1 if n == last_n and n else 0
        last_n = n
        if stable >= 3:
            break
    hub.stopping = True
    lst = session_list(hub.cols)
    if not lst:
        print('No sessions found on the "%s" feed (state: %s %s).' % (args.series, up.state, up.detail))
        return 1
    now = now_ms()
    for s in lst:
        flag = 'LIVE ' if s['start'] and s['start'] - 600000 <= now <= (s['end'] or s['start']) + 2700000 else '     '
        print('%s%s  %s  %s' % (flag, local_time(s['start']), s['id'], s['label']))
    print('\nRun:  py pitwall_hub.py --series %s            (follows whichever session is running)' % args.series)
    print('  or  py pitwall_hub.py --series %s --session <id>' % args.series)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='Zenith pit wall hub: Al Kamel live timing to the pit wall screen and the crew phones.')
    ap.add_argument('--series', default='zenith', help='Al Kamel feed name (the part after livetiming.alkamelsystems.com/), default zenith')
    ap.add_argument('--session', default='auto', help='session id from --list, or auto (default) to follow the running session')
    ap.add_argument('--champ', default=None, help='only follow sessions whose name contains this text (e.g. ZR3) when several run')
    ap.add_argument('--port', type=int, default=8765, help='web port (default 8765)')
    ap.add_argument('--list', action='store_true', help='list the sessions on the feed and exit')
    ap.add_argument('--tunnel', action='store_true', help='also open an internet link for crew off the local network (needs cloudflared)')
    ap.add_argument('--tunnel-allow', metavar='EMAILS', default=None, help='internet link only for these e-mail addresses (comma separated; one-time PIN by e-mail)')
    ap.add_argument('--learn', metavar='FILE', help='learn the subscription list from a WebSocket capture, bridge list or recording')
    ap.add_argument('--forget', action='store_true', help='forget learned subscriptions and use the built-in list')
    ap.add_argument('--no-browser', action='store_true', help='do not open the pit wall in the browser')
    ap.add_argument('--record-dir', default=os.path.join(HERE, 'recordings'), help='where recordings go')
    ap.add_argument('--upstream', default=None, help=argparse.SUPPRESS)
    ap.add_argument('--builtin-ws', action='store_true', help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    args.series = re.sub(r'[^A-Za-z0-9_-]', '', re.sub(r'^.*alkamelsystems\.com/', '', args.series.strip())) or 'zenith'

    if args.list:
        return list_sessions(args)

    hub = Hub(args)
    if args.forget:
        hub.state.pop('recipe', None)
        hub.state.pop('learned', None)
        hub.save_state()
        say('Forgot the learned subscriptions.')
    if args.learn:
        opener = gzip.open if args.learn.lower().endswith('.gz') else open
        try:
            with opener(args.learn, 'rt', encoding='utf-8', errors='replace') as f:
                r = recipe_from_text(f.read())
        except Exception as e:
            say('Could not read %s: %s' % (args.learn, e))
            r = None
        if r and r.get('session'):
            hub.state['recipe'] = r
            hub.save_state()
            say('Learned %d per-session data sets: %s' % (len(r['session']), ', '.join(x['names'][0] for x in r['session'])))
        else:
            say('No subscriptions found in %s - using the built-in list.' % args.learn)

    httpd = None
    for attempt in range(8):
        try:
            httpd = Server(('0.0.0.0', args.port), make_handler(hub))
            break
        except OSError as e:
            err = e
            time.sleep(1.5)
    if httpd is None:
        print('Port %d is in use (%s). Is the hub already running in another window? Otherwise start it with --port 8766.' % (args.port, err))
        return 2
    up = Upstream(hub, args.upstream, mode=args.session, builtin=args.builtin_ws)
    hub.upstream = up
    up.start()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    if not args.upstream:
        threading.Thread(target=timesync_loop, args=(hub,), daemon=True).start()
    tunnel = start_tunnel(hub, args.port, args.tunnel_allow) if (args.tunnel or args.tunnel_allow) else None
    awake = keep_awake()

    print('')
    print('  Pit wall hub %s   feed: %s   %s' % (VERSION, args.series, 'following: ' + ('the running session' if args.session == 'auto' else args.session)))
    print('  On this laptop:  http://localhost:%d/' % args.port)
    for u in hub.lan_urls():
        print('  Crew phones:     %s   (same Wi-Fi or hotspot as this laptop)' % u)
    if args.tunnel or args.tunnel_allow:
        print('  Crew internet link: starting...' + ('  (only for: %s)' % args.tunnel_allow if args.tunnel_allow else ''))
    print('  Recordings:      %s' % hub.rec_dir)
    tp = find_team_pack()
    print('  Team pack:       %s' % (tp if tp else 'none (put pit-wall-team-pack.json in the private folder for replays and fuel numbers)'))
    if not find_page():
        print('  WARNING: index.html is missing - it belongs in the folder above this one.')
    if awake:
        print('  This laptop will not go to sleep while the hub runs (keep it plugged in).')
    print('  Leave this window open. Press Ctrl+C to stop.')
    print('')
    if not args.no_browser:
        try:
            webbrowser.open('http://localhost:%d/' % args.port)
        except Exception:
            pass

    last = 0
    try:
        while True:
            time.sleep(1)
            hub.flush()
            if time.time() - last >= 30:
                last = time.time()
                st = hub.status()
                sess = st['session']
                age = (now_ms() - hub.last_data) / 1000.0 if hub.last_data else None
                say('%s | %s | %d cars | %d messages | %d screens | last data %s' % (
                    st['state'].upper(), (sess or {}).get('label') or (sess or {}).get('id') or 'no session yet',
                    st['cars'], st['msgs'], st['clients'], ('%.0f s ago' % age) if age is not None else '-'))
                if st['subs']:
                    say('  data sets: ' + ', '.join('%s %s' % (k, v) for k, v in st['subs'].items()))
    except KeyboardInterrupt:
        print('\nStopping...')
    hub.stopping = True
    with hub.cond:
        hub.cond.notify_all()
        hub._close_recording()
    if tunnel:
        try:
            tunnel.terminate()
        except Exception:
            pass
    try:
        httpd.shutdown()
    except Exception:
        pass
    print('Stopped. Recordings are in %s' % hub.rec_dir)
    return 0


if __name__ == '__main__':
    sys.exit(main())
