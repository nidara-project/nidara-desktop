#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Private nested-Hyalo check of the coherent observation (ipc/observe.rs, #959 H1):
snapshot barrier and contiguous serials under concurrent start-up, launch correlation by
an opaque number for new and shown windows, foreign and stale tokens, a refused activation
that asks for attention without taking the focus, the usage-idle, sleep and lock
boundaries, and a subscriber that falls behind. Run via check-observe-headless.sh; not a CI
job."""
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time

LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
PROBE = Path(os.environ['NK_WIDGETS_BIN']).resolve()
TARGET = PROBE.with_name('token-target')
SOCKET = os.environ['HYALO_SOCKET']
CONTROL = os.environ['HYALO_CONTROL']
IDLE_MS = int(os.environ['HYALO_TEST_USAGE_IDLE_MS'])
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('private check-headless.sh runtime required')
procs = []
results = {}


def request(obj):
    with socket.socket(socket.AF_UNIX) as s:
        s.connect(SOCKET)
        s.sendall((json.dumps(obj) + '\n').encode())
        return json.loads(s.makefile().readline())


def ok(obj):
    reply = request(obj)
    if 'ok' not in reply:
        raise RuntimeError(f'{obj}: {reply}')
    return reply['ok']


def windows():
    return ok({'request': 'windows'})['windows']


def by_app(app):
    return [w for w in windows() if w['app_id'] == app]


def focused():
    return [w['app_id'] for w in windows() if w.get('focused')]


def wait(test, label, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if test():
            return
        time.sleep(.02)
    raise RuntimeError(f'timeout: {label}')


class Stream:
    """One event_stream connection, read on a thread unless `read` is False."""

    def __init__(self, snapshot=True, read=True):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(SOCKET)
        self.sock.sendall((json.dumps({'request': 'event_stream', 'snapshot': snapshot}) + '\n').encode())
        self.file = self.sock.makefile()
        assert 'ok' in json.loads(self.file.readline())
        self.events = []
        self.closed = False
        if read:
            self.start()

    def start(self):
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        for line in self.file:
            self.events.append(json.loads(line))
        self.closed = True

    def named(self, name):
        return [e for e in self.events if e['event'] == name]

    def wait_for(self, label, test, timeout=20):
        found = []

        def seen():
            found[:] = [e for e in self.events if test(e)]
            return bool(found)
        wait(seen, label, timeout)
        return found[0]


def contiguous(events, label):
    serials = [e['serial'] for e in events]
    assert serials == list(range(serials[0], serials[0] + len(serials))), f'{label}: a serial gap {serials}'
    assert len({e['epoch'] for e in events}) == 1, f'{label}: the epoch changed within one Hyalo'
    times = [e['time_us'] for e in events]
    assert times == sorted(times), f'{label}: time went backwards'


def spawn(args, log, **env):
    p = subprocess.Popen([str(a) for a in args], stdout=(LOG / log).open('w'), stderr=subprocess.STDOUT,
                         env={**os.environ, **env})
    procs.append(p)
    return p


def target(app, log, **env):
    spawn([TARGET, app], log, **env)
    wait(lambda: 'TARGET_READY' in (LOG / log).read_text(), f'{app} shown')


# A launched GTK app: GTK takes XDG_ACTIVATION_TOKEN from its environment and asks with it
# as it presents the window, before the first frame — the path of a window not shown yet.
GTK_APP = """
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gio, Gtk
app = Gtk.Application(application_id='org.nidara.ObserveTarget', flags=Gio.ApplicationFlags.NON_UNIQUE)
app.connect('activate', lambda a: (Gtk.ApplicationWindow(application=a, default_width=400, default_height=300).present(), print('GTK_SHOWN', flush=True)))
app.run([])
"""
GTK_ID = 'org.nidara.ObserveTarget'


def gtk_launched(token, log):
    # Cairo: shm buffers. A GL client's dmabufs, through nested software Hyalo, have crashed
    # Mesa's llvmpipe inside Hyalo (libgallium) as such a window went away.
    spawn(['python3', '-c', GTK_APP], log, XDG_ACTIVATION_TOKEN=token, GSK_RENDERER='cairo')
    wait(lambda: by_app(GTK_ID), 'GTK window shown')


def click(pipe, x, y):
    pipe.write(f'click {x} {y}\n')


def centre(w):
    """A point of `w` no other window covers (floating windows cascade over each other)."""
    others = [o for o in windows() if o['id'] != w['id'] and o['visible']]

    def inside(o, x, y):
        top = o['y'] - o.get('title_bar', 0)
        return o['x'] <= x < o['x'] + o['width'] and top <= y < o['y'] + o['height']
    for fx, fy in ((.5, .5), (.1, .1), (.9, .1), (.1, .9), (.9, .9), (.03, .5), (.03, .97), (.5, .97)):
        x, y = w['x'] + int(w['width'] * fx), w['y'] + int(w['height'] * fy)
        if not any(inside(o, x, y) for o in others):
            return x, y
    raise RuntimeError(f'window {w["id"]} is covered everywhere: ' + json.dumps([(o['id'], o['app_id'], o['x'], o['y'], o['width'], o['height'], o['floating'], o['workspace']) for o in windows()]))


def token(pipe, name):
    """A real token, made from a click on a layer surface (a dock's click)."""
    log = f'{name}-dock.log'
    file = LOG / f'{name}.token'
    p = spawn([PROBE, '--token'], log, NK_TOKEN_FILE=str(file))
    wait(lambda: 'READY step=0' in (LOG / log).read_text(), 'dock ready')
    time.sleep(.2)
    W, H = ok({'request': 'outputs'})['outputs'][0]['logical_size']
    click(pipe, W // 2, H - 4 - 32)
    wait(lambda: 'TOKEN_DONE' in (LOG / log).read_text(), 'token made')
    p.terminate()
    p.wait(timeout=5)
    return file, file.read_text()


def outcome(stream, launch, label, timeout=20):
    return stream.wait_for(label, lambda e: e['event'] == 'launch_outcome' and e['launch'] == launch, timeout)


# Nested Hyalo stops drawing for seconds while its Xwayland starts.
wait(lambda: 'Xwayland ready' in (LOG / 'hyalo.log').read_text(), 'Xwayland ready', timeout=30)

with open(CONTROL, 'w', buffering=1) as pipe:
    # 1. The barrier under concurrent start-up: three windows start while a subscriber joins.
    for n in range(3):
        spawn([TARGET, f'nk-obs-{n}'], f'obs-{n}.log')
    first = Stream()
    wait(lambda: len([w for w in windows() if w['app_id'].startswith('nk-obs-')]) == 3, 'three windows shown')
    time.sleep(.5)
    later = Stream()
    pipe.write(f'move 1 1\nbarrier {LOG / "settle.barrier"}\n')
    wait(lambda: (LOG / 'settle.barrier').exists(), 'settled')
    time.sleep(.3)
    snap = first.events[0]
    assert snap['event'] == 'snapshot', f'the first event is not the snapshot: {snap["event"]}'
    contiguous(first.events, 'first subscriber')
    shown = {w['id'] for w in snap['windows']}
    for e in first.events[1:]:
        if e['event'] == 'windows_changed':
            shown = {w['id'] for w in e['windows']}
    final = {w['id'] for w in windows()}
    assert shown == final, f'snapshot + events {shown} != windows {final}'
    # One counter for every subscriber: the later one's snapshot is as of a serial the first
    # one saw, and it then gets the very same events.
    s2 = later.events[0]
    assert s2['event'] == 'snapshot' and s2['epoch'] == snap['epoch']
    contiguous(later.events, 'later subscriber')
    mine = {e['serial']: e['event'] for e in first.events if e['serial'] > s2['serial']}
    theirs = {e['serial']: e['event'] for e in later.events[1:]}
    assert theirs and all(mine.get(k) == v for k, v in theirs.items()), 'the subscribers disagree'
    results['barrier'] = {'epoch': snap['epoch'], 'snapshot_serial': snap['serial'],
                          'events_after_snapshot': len(first.events) - 1, 'reconstructed_windows': len(final)}
    for p in procs:
        p.terminate()
        p.wait(timeout=5)
    procs.clear()
    wait(lambda: not [w for w in windows() if w['app_id'].startswith('nk-obs-')], 'windows gone')

    # 2. Foreign tokens: not observable, and a window asking with one changes nothing.
    assert 'error' in request({'request': 'observe_launch', 'token': 'not-a-token-from-hyalo'})
    target('nk-other', 'other.log')
    target('nk-token-target', 'fake-target.log', NK_TOKEN_FILE=str(LOG / 'fake.token'))
    click(pipe, *centre(by_app('nk-other')[0]))
    wait(lambda: focused() == ['nk-other'], 'other focused')
    (LOG / 'fake.token').write_text('not-a-token-from-hyalo')
    wait(lambda: 'ACTIVATE' in (LOG / 'fake-target.log').read_text(), 'made-up token used')
    time.sleep(1)
    assert focused() == ['nk-other'] and not by_app('nk-token-target')[0]['demands_attention']
    results['foreign_token'] = 'not observable; no focus, no attention'

    # 3. A shown window raised by a real token: `activated`, by number, never the token.
    s = Stream()
    file, tok = token(pipe, 'shown')
    reply = ok({'request': 'observe_launch', 'token': tok})
    assert reply['kind'] == 'launch_observed' and reply['already'] is None
    launch = reply['launch']
    spawn([TARGET, 'nk-token-target'], 'shown-target.log', NK_TOKEN_FILE=str(file))
    e = outcome(s, launch, 'activated outcome')
    tid = [w['id'] for w in by_app('nk-token-target') if w['id'] == e.get('window')]
    assert e['outcome'] == 'activated' and tid, e
    wait(lambda: by_app('nk-token-target') and any(w['focused'] for w in by_app('nk-token-target')), 'target focused')
    stream_text = json.dumps(s.events)
    assert tok not in stream_text and tok not in (LOG / 'hyalo.log').read_text(), 'the token leaked'
    results['shown_window'] = e
    for p in procs:
        p.terminate()
        p.wait(timeout=5)
    procs.clear()
    wait(lambda: not by_app('nk-token-target') and not by_app('nk-other'), 'targets gone')

    # 4. A new window with the token before it is shown: `window`, honoured. Asked after the
    # use, the answer comes in the reply instead.
    file, tok = token(pipe, 'new')
    launch = ok({'request': 'observe_launch', 'token': tok})['launch']
    gtk_launched(tok, 'new-gtk.log')
    e = outcome(s, launch, 'window outcome')
    assert e['outcome'] == 'window' and e['honoured'] is True and e['window'] == by_app(GTK_ID)[0]['id'], e
    results['new_window'] = e
    for p in procs:
        p.terminate()
        p.wait(timeout=5)
    procs.clear()
    wait(lambda: not by_app(GTK_ID), 'GTK window gone')
    file, tok = token(pipe, 'late-ask')
    gtk_launched(tok, 'late-ask-gtk.log')
    time.sleep(.5)
    reply = ok({'request': 'observe_launch', 'token': tok})
    assert reply['already'] and reply['already']['outcome'] == 'window', reply
    results['asked_after_use'] = reply
    for p in procs:
        p.terminate()
        p.wait(timeout=5)
    procs.clear()
    wait(lambda: not by_app(GTK_ID), 'GTK window gone')

    # 5. A stale token: the launch expires, and the late request is refused — the window asks
    # for attention and the focus stays where the user is. Their click answers it.
    target('nk-token-target', 'stale-target.log', NK_TOKEN_FILE=str(LOG / 'stale.token'))
    target('nk-other', 'other2.log')
    file, tok = token(pipe, 'stale-made')
    (LOG / 'stale-made.token').rename(LOG / 'stale.pending')
    launch = ok({'request': 'observe_launch', 'token': tok})['launch']
    click(pipe, *centre(by_app('nk-other')[0]))
    wait(lambda: focused() == ['nk-other'], 'other focused')
    e = outcome(s, launch, 'expired outcome', timeout=15)
    assert e['outcome'] == 'expired', e
    (LOG / 'stale.pending').rename(LOG / 'stale.token')
    tid = by_app('nk-token-target')[0]['id']
    a = s.wait_for('attention', lambda e: e['event'] == 'attention_changed' and e['id'] == tid and e['demands'])
    time.sleep(.5)
    assert focused() == ['nk-other'], f'a refused activation took the focus: {focused()}'
    assert by_app('nk-token-target')[0]['demands_attention']
    click(pipe, *centre(by_app('nk-token-target')[0]))
    cleared = s.wait_for('attention cleared', lambda e: e['event'] == 'attention_changed' and e['id'] == tid and not e['demands'])
    assert not by_app('nk-token-target')[0]['demands_attention']
    results['stale_token'] = {'launch': e, 'attention': a['serial'], 'cleared_by_focus': cleared['serial']}

    # 6. A subscriber that does not read is closed, never thinned: what it got is contiguous.
    slow = Stream(read=False)
    other = by_app('nk-other')[0]
    mine = by_app('nk-token-target')[0]
    for n in range(150):
        click(pipe, *centre(other if n % 2 else mine))
    pipe.write(f'barrier {LOG / "slow.barrier"}\n')
    wait(lambda: (LOG / 'slow.barrier').exists(), 'clicks delivered', timeout=60)
    slow.start()
    wait(lambda: slow.closed, 'the slow subscriber was closed')
    got = [e for e in slow.events]
    contiguous(got, 'slow subscriber')
    assert got[-1]['serial'] < s.events[-1]['serial'], 'it was not dropped before the end'
    again = Stream()
    wait(lambda: again.events, 'resubscribed')
    assert again.events[0]['serial'] > got[-1]['serial'] and again.events[0]['epoch'] == got[0]['epoch']
    results['slow_subscriber'] = {'received': len(got), 'last_serial': got[-1]['serial'],
                                  'resync_snapshot_serial': again.events[0]['serial']}

    # 7. Usage idle: no input for HYALO_TEST_USAGE_IDLE_MS, then input again.
    pipe.write('move 5 5\n')
    moved = time.monotonic()
    idle = s.wait_for('idle', lambda e: e['event'] == 'idle_changed' and e['idle'] and e['time_us'] > moved * 1e6,
                      timeout=IDLE_MS / 1000 + 10)
    waited = idle['time_us'] - idle['since_us']
    assert waited >= IDLE_MS * 1000, f'idle after {waited} µs'
    assert abs(idle['since_us'] / 1e6 - moved) < .5, 'since_us is not the last input'
    pipe.write('move 9 9\n')
    back = s.wait_for('active', lambda e: e['event'] == 'idle_changed' and not e['idle'] and e['serial'] > idle['serial'])
    results['usage_idle'] = {'idle_after_us': waited, 'back': back['serial']}

    # 8. Sleep: the boundary each way, and the lock it brings (no lock client here: Hyalo's
    # guard). The snapshot of a new subscriber says the same.
    pipe.write('sleep 1\n')
    sl = s.wait_for('sleeping', lambda e: e['event'] == 'sleep_changed' and e['sleeping'])
    lk = s.wait_for('locked', lambda e: e['event'] == 'lock_changed' and e['locked'], timeout=15)
    during = Stream()
    wait(lambda: during.events, 'snapshot while asleep')
    assert during.events[0]['sleeping'] and during.events[0]['locked']
    pipe.write('sleep 0\n')
    wk = s.wait_for('awake', lambda e: e['event'] == 'sleep_changed' and not e['sleeping'])
    contiguous(s.events, 'main subscriber')
    results['sleep_lock'] = {'sleep': sl['serial'], 'locked': lk['serial'], 'awake': wk['serial']}
    names = sorted({e['event'] for e in s.events})
    results['events_seen'] = names

for p in procs:
    p.terminate()
    p.wait(timeout=5)
(LOG / 'oracles.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
