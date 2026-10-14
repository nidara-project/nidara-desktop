#!/usr/bin/env python3
"""Only inside a test Hyalo. Real pointer edges, splits, minima and overflow."""
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
LOG = Path(os.environ.get('RESIZE_LOG', '/tmp/hyalo-resize'))
LOG.mkdir(parents=True, exist_ok=True)
CONTROL = os.environ['HYALO_CONTROL']
CLIENTS = []
COLORS = [(180, 50, 60), (40, 160, 70), (40, 80, 200), (200, 140, 30),
          (130, 60, 180), (30, 160, 170), (190, 80, 150), (90, 160, 40),
          (130, 120, 70), (70, 100, 160), (170, 90, 40)]
ORIGINAL = None


def msg(*args):
    return json.loads(subprocess.check_output(['nidara-hyalo', 'msg', *map(str, args)]))['ok']


def act(*args):
    msg('do', *args)
    time.sleep(.2)


def windows():
    return msg('windows')['windows']


def wait_for(test, label):
    for _ in range(100):
        if test():
            print('ok   ', label, flush=True)
            return
        time.sleep(.05)
    raise AssertionError(label)


def win(pid):
    return next((w for w in windows() if w['pid'] == pid), None)


def open_window(fixed=False):
    log = LOG / f'client-{len(CLIENTS)}.log'
    color = '#%02x%02x%02x' % COLORS[len(CLIENTS)]
    with log.open('w') as stream:
        p = subprocess.Popen(['gjs', '-m', str(HERE / 'hyalo-resize-probe.js'),
                              'fixed' if fixed else 'normal'], stdout=stream, stderr=stream,
                             env={**os.environ, 'GDK_BACKEND': 'wayland', 'HYALO_PROBE_COLOR': color})
    CLIENTS.append((p, log))
    wait_for(lambda: win(p.pid), 'GTK window mapped')
    time.sleep(.3)
    return p


def control(line):
    with open(CONTROL, 'w') as fifo:
        fifo.write(line + '\n')
    time.sleep(.12)


def drag(x, y, dx, dy):
    control(f'press {x} {y} 272')
    control(f'move {x+dx} {y+dy}')
    control('release 272')
    time.sleep(.25)


def rect(w):
    return tuple(w[k] for k in ('x', 'y', 'width', 'height'))


try:
    ORIGINAL = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    act('workspace', 94)
    act('set-workspace-mode', 94, 'floating')
    p = open_window()
    before = win(p.pid)
    drag(before['x']+before['width']-1, before['y']+before['height']//2, 70, 0)
    wait_for(lambda: win(p.pid)['width'] == before['width']+70, 'undecorated GTK right edge resizes')
    before = win(p.pid)
    drag(before['x'], before['y']+before['height']//2, -40, 0)
    wait_for(lambda: win(p.pid)['x'] == before['x']-40 and
             win(p.pid)['width'] == before['width']+40, 'left resize keeps opposite edge still')
    before = win(p.pid)
    drag(before['x']+before['width']-1, before['y']+before['height']-1, 30, 30)
    wait_for(lambda: win(p.pid)['width'] == before['width']+30 and
             win(p.pid)['height'] == before['height']+30, 'corner resizes both dimensions')
    # A fixed-size app offers no resize, even though Hyalo sees its border.
    fixed = open_window(True)
    before = win(fixed.pid)
    drag(before['x']+before['width']-1, before['y']+before['height']//2, 80, 0)
    assert rect(win(fixed.pid)) == rect(before), 'fixed-size window changed size'
    fixed.terminate(); fixed.wait()
    act('set-workspace-mode', 94, 'tiling')
    q = open_window()
    a, b = sorted([win(p.pid), win(q.pid)], key=lambda w: w['x'])
    drag(a['x']+a['width']-1, a['y']+a['height']//2, 80, 0)
    wait_for(lambda: win(a['pid'])['width'] > a['width'] and win(b['pid'])['width'] < b['width'],
             'tile edge moves shared split')
    a = win(a['pid'])
    drag(a['x']+a['width']-1, a['y']+a['height']//2, 4000, 0)
    wait_for(lambda: win(b['pid'])['width'] < 400, 'split may shrink a tile below GTK minimum')
    # Repeated insertion eventually exceeds the display: never silently overlap tiles.
    for _ in range(8):
        open_window()
    # GTK may allocate its minimum; Hyalo must keep the smaller cell and crop it.
    ours = [win(p.pid) for p, _ in CLIENTS if p.poll() is None]
    tiled = [w for w in ours if not w['floating']]
    assert len(tiled) == len(ours), 'a window unexpectedly left tiling'
    for i, a in enumerate(tiled):
        assert a['width'] > 0 and a['height'] > 0
        for b in tiled[i+1:]:
            assert (a['x']+a['width'] <= b['x'] or b['x']+b['width'] <= a['x'] or
                    a['y']+a['height'] <= b['y'] or b['y']+b['height'] <= a['y']), 'tiles overlap'
    # Click each small cell: an older client's oversized GTK input region must
    # never steal another tile's click (test it in both focus/stacking orders).
    for order in (tiled, list(reversed(tiled))):
        for a in order:
            control(f"click {a['x']+a['width']//2} {a['y']+a['height']//2}")
            assert win(a['pid'])['focused'], f"tile click stolen: {a}"
    control('move 0 0')
    msg('screenshot', str(LOG / 'tiles.png'))
    msg('screenshot', str(LOG / 'tiles.ppm'))
    header, dimensions, depth, pixels = (LOG / 'tiles.ppm').read_bytes().split(b'\n', 3)
    assert header == b'P6' and depth == b'255'
    width, height = map(int, dimensions.split())
    scale = msg('outputs')['outputs'][0]['scale']
    for i, (p, _) in enumerate(CLIENTS):
        if p.poll() is not None:
            continue
        a = win(p.pid)
        x, y = int((a['x']+a['width']/2)*scale), int((a['y']+a['height']/2)*scale)
        offset = (y*width+x)*3
        actual = tuple(pixels[offset:offset+3])
        assert max(abs(v-e) for v, e in zip(actual, COLORS[i])) <= 3, (a, actual, COLORS[i])
    print('ok    every tile draws its own pixels, including cells below GTK minimum', flush=True)
    print('RESIZE CHECK PASSED', flush=True)
finally:
    for p, _ in CLIENTS:
        if p.poll() is None:
            p.terminate()
            p.wait(timeout=5)
    if ORIGINAL is not None:
        act('workspace', ORIGINAL)
