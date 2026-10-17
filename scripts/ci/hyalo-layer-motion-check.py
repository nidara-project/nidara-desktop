#!/usr/bin/env python3
"""hyalo-layer-motion-check.py — layers Hyalo animates for their app (nidara-layers-v1,
hyalo/compositor/src/protocols/layers.rs): test 5 of the toolkit's phase 0 (#818,
toolkit/CONTRACT.md). Only inside a test Hyalo started with HYALO_CONTROL, with
`hyalo-layer-motion-probe` in PATH.

The probe gives layers A (red) and B (blue) a 2 s linear transition to x = 300, then blocks
for 1.5 s, reading and committing nothing. Meanwhile:

  1. two screenshots, a few hundred ms apart, show A and B each further right than before and
     than where they started: Hyalo moves them while their app does nothing;
  2. a click at the MODEL position of A — where it will end, not where it is — does not reach A
     (the control: a compositor that hit-tests where a layer ends, or where its app last placed
     it, sends that click to A);
  3. a click where A is SEEN, found in a fresh screenshot, reaches A, inside it;
  4. when the probe wakes it gets both clicks, and once the transitions have run, `done` for
     both serials.
Exits 1 on failure."""
import json
import os
import signal
import struct
import zlib
import subprocess
import time
from pathlib import Path

LOG = Path(os.environ.get('LAYER_MOTION_LOG', '/tmp/hyalo-layer-motion'))
LOG.mkdir(parents=True, exist_ok=True)
CONTROL = os.environ['HYALO_CONTROL']
OUT = LOG / 'probe.log'
RED, BLUE = (224, 32, 32), (32, 64, 224)
ORIGINAL = None


def msg(*args):
    return json.loads(subprocess.check_output([os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg', *map(str, args)]))['ok']


def control(line):
    with open(CONTROL, 'w') as fifo:
        fifo.write(line + '\n')


def lines():
    return OUT.read_text().splitlines() if OUT.exists() else []


def wait_line(test, label, tries=100):
    for _ in range(tries):
        if any(test(l) for l in lines()):
            return
        time.sleep(.05)
    raise AssertionError(f'{label}; the probe said: {lines()}')


def save_preview(path, image):
    w, h, pixels = image
    def chunk(tag, data):
        return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', zlib.crc32(tag + data))
    rows = b''.join(b'\0' + pixels[y*w*3:(y+1)*w*3] for y in range(h))
    path.with_suffix('.png').write_bytes(b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('!2I5B', w,h,8,2,0,0,0))
        + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def shot(name, preview=True):
    path = LOG / f'{name}.ppm'
    msg('screenshot', str(path))
    header, dims, depth, pixels = path.read_bytes().split(b'\n', 3)
    assert header == b'P6' and depth == b'255', 'not a raw screenshot'
    w, h = map(int, dims.split())
    image = w, h, pixels
    if preview:
        save_preview(path, image)
    return image


def span(image, y, colour):
    """The first and last x of `colour` on row y (physical), or None."""
    w, _, px = image
    xs = [x for x in range(w) if max(abs(px[(y * w + x) * 3 + i] - colour[i]) for i in range(3)) <= 6]
    return (xs[0], xs[-1]) if xs else None


def check():
    global ORIGINAL
    try:
        ORIGINAL = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
        msg('do', 'workspace', 95)
        msg('do', 'set-workspace-mode', 95, 'floating')
        with OUT.open('w') as stream:
            probe = subprocess.Popen(['hyalo-layer-motion-probe'], stdout=stream, stderr=stream)
        wait_line(lambda l: l in ('READY', 'NO_LAYERS'), 'the probe never got ready')
        assert 'NO_LAYERS' not in lines(), 'Hyalo offers no nidara-layers-v1'
        # Past the window's own opening animation (it grows out of its middle, 700 ms by default).
        time.sleep(1.2)
        win = next(w for w in msg('windows')['windows'] if w['app_id'] == 'hyalo-layer-motion-probe')
        scale = msg('outputs')['outputs'][0]['scale']
        ya, yb = int((win['y'] + 70) * scale), int((win['y'] + 210) * scale)
        phys = lambda x: int((win['x'] + x) * scale)
        before = shot('before')
        a0, b0 = span(before, ya, RED), span(before, yb, BLUE)
        assert a0 and b0, f'the layers are not where the probe placed them: A {a0}, B {b0}'
        assert abs(a0[0] - phys(20)) <= 2, f'A starts at {a0}, not at x = 20 of the window'
        print('ok    both layers are where their app placed them', flush=True)

        probe.send_signal(signal.SIGUSR1)
        wait_line(lambda l: l == 'MOVED', 'the probe never committed its transitions')
        t0 = time.monotonic()
        time.sleep(.25)
        s1 = shot('during-1')
        time.sleep(.3)
        s2 = shot('during-2')
        a1, a2, b1, b2 = span(s1, ya, RED), span(s2, ya, RED), span(s1, yb, BLUE), span(s2, yb, BLUE)
        assert 'AWAKE' not in lines(), 'the probe woke before the screenshots: they prove nothing'
        assert a1 and a2 and b1 and b2, f'a layer is missing mid-way: A {a1} {a2}, B {b1} {b2}'
        assert a0[0] < a1[0] < a2[0] and b0[0] < b1[0] < b2[0], f'not moving: A {a0} {a1} {a2}, B {b0} {b1} {b2}'
        assert a2[0] < phys(300) - 20, f'A is already at its end ({a2}): no transition ran'
        print(f'ok    Hyalo moves both layers while their app is blocked (A at {a0[0]} → {a1[0]} → {a2[0]})', flush=True)

        # 2. Where A will END: not A yet.
        control(f'click {phys(300) + int(40 * scale)} {ya}')
        time.sleep(.05)
        # 3. Where A is SEEN now.
        now = span(shot('during-3'), ya, RED)
        assert now, 'A is missing'
        control(f'click {(now[0] + now[1]) // 2} {ya}')
        assert time.monotonic() - t0 < 1.4, 'the clicks came after the probe woke: run again'
        assert 'AWAKE' not in lines(), 'the probe woke before the clicks'

        wait_line(lambda l: l == 'AWAKE', 'the probe never woke')
        wait_line(lambda l: l.startswith('PRESS') and len([p for p in lines() if p.startswith('PRESS')]) >= 2,
                  'the probe did not get both clicks')
        presses = [l.split() for l in lines() if l.startswith('PRESS')]
        assert presses[0][1] != 'A', f'the click where A ends reached A: {presses[0]} (hit-tested at the model)'
        assert presses[1][1] == 'A', f'the click where A is seen did not reach it: {presses[1]}'
        x, y = float(presses[1][2]), float(presses[1][3])
        assert 0 <= x <= 80 and 0 <= y <= 60, f'A got the click outside itself: {x}, {y}'
        print('ok    a click where A will end is not A\'s; one where it is seen is, inside it', flush=True)

        wait_line(lambda l: l == 'DONE 1', 'no done for A', tries=80)
        wait_line(lambda l: l == 'DONE 2', 'no done for B', tries=20)
        end = span(shot('after'), ya, RED)
        assert end and abs(end[0] - phys(300)) <= 2, f'A did not end at x = 300: {end}'
        print('ok    both transitions end where their app said, and it is told', flush=True)
        print('LAYER MOTION CHECK PASSED', flush=True)
    finally:
        if 'probe' in locals() and probe.poll() is None:
            probe.terminate()
            probe.wait(timeout=5)
        if ORIGINAL is not None:
            msg('do', 'workspace', ORIGINAL)


if __name__ == '__main__':
    check()
