#!/usr/bin/env python3
"""Stand-in for Al Kamel's LT2 server (SockJS + Meteor DDP), for testing the pit wall hub offline.

It plays a scripted race (JSON lines from make_feed.js) against a simulated clock and publishes it the way
LT2 does: livetimingFeed [series] -> feeds + events; sessions/sessionInfo/trackInfo [[feed session ids]];
per-session data sets take [session id] and refuse [[id]] ("Match failed"); unknown names get 404.

Control (plain HTTP on the same port): /_timesync  /_drop  /_pause  /_resume  /_stats
"""
import argparse, base64, hashlib, json, os, socket, struct, sys, threading, time

PUBS = {  # publication -> collection it feeds
    'standings': 'standings', 'sessionPitInfo': 'session_pit_info', 'sessionStatus': 'session_status',
    'raceControl': 'race_control', 'weather': 'weather', 'sessionEntry': 'session_entry', 'sessionClasses': 'session_classes',
}


class Clock(object):
    def __init__(self, epoch, speed):
        self.epoch, self.speed, self.t0, self.paused_at, self.lock = epoch, speed, time.time(), None, threading.Lock()

    def now(self):
        with self.lock:
            t = self.paused_at if self.paused_at is not None else time.time()
            return int(self.epoch + (t - self.t0) * 1000 * self.speed)

    def pause(self):
        with self.lock:
            if self.paused_at is None:
                self.paused_at = time.time()

    def resume(self):
        with self.lock:
            if self.paused_at is not None:
                self.t0 += time.time() - self.paused_at
                self.paused_at = None


class Conn(object):
    def __init__(self, srv, sock):
        self.srv, self.sock, self.lock, self.subs, self.alive, self.buf = srv, sock, threading.Lock(), {}, True, bytearray()

    def send_frame(self, text):
        data = text.encode('utf-8')
        n = len(data)
        hdr = bytearray([0x81])
        if n < 126:
            hdr.append(n)
        elif n < 65536:
            hdr.append(126); hdr += struct.pack('>H', n)
        else:
            hdr.append(127); hdr += struct.pack('>Q', n)
        with self.lock:
            if not self.alive:
                return
            try:
                self.sock.sendall(bytes(hdr) + data)
            except OSError:
                self.alive = False

    def send(self, msgs):
        if msgs:
            self.send_frame('a' + json.dumps([json.dumps(m, separators=(',', ':')) for m in msgs]))

    def close(self):
        with self.lock:
            self.alive = False
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()

    def read_frame(self):
        while True:
            b = self.buf
            if len(b) >= 2:
                op, n, i = b[0] & 0x0F, b[1] & 0x7F, 2
                if n == 126 and len(b) >= 4:
                    n = struct.unpack('>H', bytes(b[2:4]))[0]; i = 4
                elif n == 127 and len(b) >= 10:
                    n = struct.unpack('>Q', bytes(b[2:10]))[0]; i = 10
                elif n >= 126:
                    n = None
                if n is not None and len(b) >= i + 4 + n:
                    mk = bytes(b[i:i + 4]); p = bytes(b[i + 4:i + 4 + n]); del self.buf[:i + 4 + n]
                    p = bytes(x ^ mk[j % 4] for j, x in enumerate(p))
                    return op, p
            d = self.sock.recv(65536)
            if not d:
                raise ConnectionError('closed')
            self.buf += d


class Server(object):
    def __init__(self, args):
        self.args = args
        self.meta = None
        self.script = []
        with open(args.script, encoding='utf-8') as f:
            for line in f:
                o = json.loads(line)
                if 'meta' in o:
                    self.meta = o['meta']
                else:
                    self.script.append(o)
        self.start = self.meta['start']
        self.clock = Clock(args.sim_epoch or (self.start - 120000), args.speed)
        if args.t0:
            self.clock.t0 = args.t0
        self.store = {}          # collection -> id -> fields
        self.conns = []
        self.lock = threading.RLock()
        self.pos = 0
        self.stats = {'conns': 0, 'subs': [], 'nosub': [], 'sent': 0, 'drops': 0}
        self.feed_doc = {'name': args.series, 'owner': 'x', 'running': True, 'sessions': [{'$type': 'oid', '$value': s} for s in self.meta['feeds']],
                         'logo': 'data:image/png;base64,' + 'A' * 5000}
        self.static = {
            'events': {'ev1': {'id': 459, 'index': self.start, 'champName': 'ZENITH RACING SERIES', 'name': 'HOMESTEAD-MIAMI', 'championship': {'$type': 'oid', '$value': 'c1'}}},
            'sessions': {
                self.meta['sid0']: {'id': 2445, 'name': 'Qualifying ', 'UtcOffsetMin': -240, 'date': self.start - 86400000, 'endDate': self.start - 86400000 + 1800000, 'event': {'$type': 'oid', '$value': 'ev1'}},
                self.meta['sid']: {'id': 2446, 'name': 'Endurance Race ', 'UtcOffsetMin': -240, 'date': self.start, 'endDate': self.start + self.meta['durationMs'], 'event': {'$type': 'oid', '$value': 'ev1'}}},
            'session_info': {'si1': {'session': {'$type': 'oid', '$value': self.meta['sid']}, 'closed': False}},
            'track_info': {'ti1': {'name': 'Homestead-Miami Speedway', 'length': 3.7, 'sectors': [{'distance': 1200}, {'distance': 2500}]}},
        }

    # ---- script
    def feeder(self):
        while True:
            now = self.clock.now()
            out = []
            with self.lock:
                while self.pos < len(self.script) and self.start + self.script[self.pos]['o'] <= now:
                    m = self.effective(self.script[self.pos]['m'])
                    self.pos += 1
                    if m:
                        out.append(m)
                if out:
                    for c in list(self.conns):
                        mine = [m for m in out if self.subscribed(c, m['collection'])]
                        if mine:
                            c.send(mine)
                            self.stats['sent'] += len(mine)
            time.sleep(0.004)

    def effective(self, m):
        col, i = m['collection'], m['id']
        docs = self.store.setdefault(col, {})
        if m['msg'] == 'added':
            if i in docs:
                ch = {k: v for k, v in m['fields'].items() if docs[i].get(k) != v}
                if not ch:
                    return None
                docs[i].update(ch)
                return {'msg': 'changed', 'collection': col, 'id': i, 'fields': ch}
            docs[i] = dict(m['fields'])
            return m
        if m['msg'] == 'changed':
            docs.setdefault(i, {}).update(m.get('fields') or {})
            return m
        if m['msg'] == 'removed':
            docs.pop(i, None)
            return m

    def subscribed(self, c, col):
        return any(s['col'] == col for s in c.subs.values())

    # ---- DDP
    def on_msg(self, c, m):
        k = m.get('msg')
        if k == 'connect':
            c.send([{'msg': 'connected', 'session': 'fake%d' % id(c)}])
        elif k == 'ping':
            c.send([{'msg': 'pong', 'id': m.get('id')}] if m.get('id') else [{'msg': 'pong'}])
        elif k == 'unsub':
            c.subs.pop(m.get('id'), None)
            c.send([{'msg': 'nosub', 'id': m.get('id')}])
        elif k == 'sub':
            self.on_sub(c, m)

    def on_sub(self, c, m):
        name, p, sid = m.get('name'), m.get('params') or [], m.get('id')
        self.stats['subs'].append(name + ' ' + json.dumps(p)[:60])
        out = []
        if name == 'livetimingFeed':
            out.append({'msg': 'added', 'collection': 'feeds', 'id': 'Z9PcE6kjsSqroG98D', 'fields': self.feed_doc})
            out += [{'msg': 'added', 'collection': 'events', 'id': i, 'fields': d} for i, d in self.static['events'].items()]
        elif name in ('sessions', 'sessionInfo', 'trackInfo'):
            if not (len(p) == 1 and isinstance(p[0], list)):
                c.send([{'msg': 'nosub', 'id': sid, 'error': {'error': 400, 'reason': 'Match failed', 'message': 'Match failed [400]'}}]); return
            col = {'sessions': 'sessions', 'sessionInfo': 'session_info', 'trackInfo': 'track_info'}[name]
            out += [{'msg': 'added', 'collection': col, 'id': i, 'fields': d} for i, d in self.static[col].items()]
        elif name in PUBS:
            if not (len(p) >= 1 and isinstance(p[0], dict) and p[0].get('$type') == 'oid'):
                self.stats['nosub'].append(name)
                c.send([{'msg': 'nosub', 'id': sid, 'error': {'error': 400, 'reason': 'Match failed', 'message': 'Match failed [400]'}}]); return
            col = PUBS[name]
            with self.lock:
                c.subs[sid] = {'name': name, 'col': col}
                out += [{'msg': 'added', 'collection': col, 'id': i, 'fields': d} for i, d in self.store.get(col, {}).items()]
                out.append({'msg': 'ready', 'subs': [sid]})
                c.send(out)
            return
        else:
            self.stats['nosub'].append(name)
            c.send([{'msg': 'nosub', 'id': sid, 'error': {'error': 404, 'reason': "Subscription '%s' not found" % name, 'message': "Subscription '%s' not found [404]" % name}}])
            return
        c.subs[sid] = {'name': name, 'col': None}
        out.append({'msg': 'ready', 'subs': [sid]})
        c.send(out)

    # ---- sockets
    def handle(self, sock):
        try:
            buf = b''
            while b'\r\n\r\n' not in buf:
                d = sock.recv(4096)
                if not d:
                    return
                buf += d
            head, rest = buf.split(b'\r\n\r\n', 1)
            lines = head.decode('latin-1').split('\r\n')
            path = lines[0].split()[1]
            hdr = {l.split(':', 1)[0].strip().lower(): l.split(':', 1)[1].strip() for l in lines[1:] if ':' in l}
            if hdr.get('upgrade', '').lower() != 'websocket':
                return self.http(sock, path)
            key = hdr['sec-websocket-key']
            acc = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            sock.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n' % acc).encode())
            c = Conn(self, sock)
            c.buf += rest
            sockjs = '/sockjs/' in path
            with self.lock:
                self.conns.append(c)
                self.stats['conns'] += 1
            if sockjs:
                c.send_frame('o')
            hb = threading.Thread(target=self.heartbeat, args=(c,), daemon=True); hb.start()
            while c.alive:
                op, p = c.read_frame()
                if op == 8:
                    break
                if op == 9:
                    continue
                txt = p.decode('utf-8')
                arr = json.loads(txt) if sockjs else [txt]
                for s in arr:
                    self.on_msg(c, json.loads(s))
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            with self.lock:
                self.conns = [x for x in self.conns if x.sock is not sock]
            try:
                sock.close()
            except OSError:
                pass

    def heartbeat(self, c):
        while c.alive:
            time.sleep(10)
            c.send_frame('h')

    def http(self, sock, path):
        body, code = '', 200
        if path.startswith('/_timesync'):
            body = str(self.clock.now())
        elif path.startswith('/_drop'):
            with self.lock:
                cs = list(self.conns)
                self.stats['drops'] += 1
            for c in cs:
                c.close()
            body = 'dropped %d' % len(cs)
        elif path.startswith('/_pause'):
            self.clock.pause(); body = str(self.clock.now())
        elif path.startswith('/_resume'):
            self.clock.resume(); body = str(self.clock.now())
        elif path.startswith('/_stats'):
            with self.lock:
                body = json.dumps({'now': self.clock.now(), 'raceMs': self.clock.now() - self.start, 'pos': self.pos, 'len': len(self.script), 'conns': len(self.conns),
                                   'stats': {k: (v[-40:] if isinstance(v, list) else v) for k, v in self.stats.items()}})
        else:
            code, body = 404, 'not found'
        b = body.encode()
        sock.sendall(('HTTP/1.1 %d X\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n' % (code, len(b))).encode() + b)
        sock.close()

    def serve(self):
        ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        ls.bind(('127.0.0.1', self.args.port))
        ls.listen(50)
        threading.Thread(target=self.feeder, daemon=True).start()
        print('fake Al Kamel on', self.args.port, 'script', len(self.script), 'messages', flush=True)
        while True:
            s, _ = ls.accept()
            threading.Thread(target=self.handle, args=(s,), daemon=True).start()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=9411)
    ap.add_argument('--script', required=True)
    ap.add_argument('--speed', type=float, default=600)
    ap.add_argument('--sim-epoch', type=float, default=0)
    ap.add_argument('--t0', type=float, default=0)
    ap.add_argument('--series', default='zenith')
    Server(ap.parse_args()).serve()
