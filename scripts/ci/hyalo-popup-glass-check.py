#!/usr/bin/env python3
"""hyalo-popup-glass-check.py — an application's menu on Hyalo, as the toolkit's dropdown will
open it (#882): an xdg_popup of a toplevel, placed by its positioner, wearing a material of its
own, with a grab (hyalo/compositor/src/shell/mod.rs `unconstrain_popup`, `grab`; the popup's
glass through render/window.rs `push` → `push_tree` → `push_material`). Only inside a test Hyalo
started with HYALO_CONTROL, with `hyalo-popup-glass-probe` in PATH.

A click in the probe's window (4 px columns) opens a 240×260 popup anchored near its
bottom-right corner, gravity bottom-right, flip-y allowed (see the probe). Each claim is checked,
and then the probe dropping that one part must break it:

  1. it is placed on the output: with no room under the window it flips ABOVE its anchor, wholly
     on screen — control `--no-flip` (no adjustment allowed: it hangs past the output's edge);
  2. its glass is drawn, past the window's edge too: beyond the window's right edge the popup is
     its white-washed glass, lighter than the desktop beside it; over the window, the columns are
     blurred under it and sharp beside it — control `--no-material` (nothing of it shows);
  3. its grab: the keyboard enters the popup, and a click outside dismisses it (popup_done) —
     control `--no-grab` (neither).
Exits 1 on failure."""
import json
import os
import statistics
import struct
import subprocess
import time
import zlib
from pathlib import Path

LOG = Path(os.environ.get('POPUP_GLASS_LOG', '/tmp/hyalo-popup-glass'))
LOG.mkdir(parents=True, exist_ok=True)
APP = 'hyalo-popup-glass-probe'
SHARP, BLURRED = 90, 40
PW, PH = 240, 260   # the popup, logical px


def msg(*args):
    return json.loads(subprocess.check_output([os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg', *map(str, args)]))['ok']


def control(line):
    Path(os.environ['HYALO_CONTROL']).write_text(line + '\n')


def save_preview(path, image):
    """A PNG beside the raw capture: what the smoke keeps as an artifact."""
    w, h, pixels = image
    def chunk(tag, data):
        return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', zlib.crc32(tag + data))
    rows = b''.join(b'\0' + pixels[y*w*3:(y+1)*w*3] for y in range(h))
    path.with_suffix('.png').write_bytes(b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('!2I5B', w, h, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def shot(name):
    path = LOG / f'{name}.ppm'
    msg('screenshot', str(path))
    header, dims, depth, pixels = path.read_bytes().split(b'\n', 3)
    assert header == b'P6' and depth == b'255', 'not a raw screenshot'
    w, h = map(int, dims.split())
    save_preview(path, (w, h, pixels))
    return w, h, pixels


def lum_at(image, x, y):
    w, h, px = image
    x, y = min(max(x, 0), w - 1), min(max(y, 0), h - 1)
    i = (y * w + x) * 3
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]


def contrast(image, y, x0, x1):
    return statistics.pstdev([lum_at(image, x, y) for x in range(x0, x1)])


def wait_for(out, word, tries=40):
    for _ in range(tries):
        if word in out.read_text():
            return True
        time.sleep(.1)
    return False


def run(name, *args):
    out = LOG / f'{name}.log'
    with out.open('w') as stream:
        probe = subprocess.Popen([APP, *args], stdout=stream, stderr=stream)
    try:
        assert wait_for(out, 'READY'), f'the probe never got ready: {out.read_text()}'
        time.sleep(1.5)  # past the window's opening
        win = next(w for w in msg('windows')['windows'] if w['app_id'] == APP)
        o = msg('outputs')['outputs'][0]
        scale = o['scale']
        out_w, out_h = o['logical_size']
        control(f'click {win["x"] + 40} {win["y"] + 40}')
        assert wait_for(out, 'POPUP'), f'no popup opened: {out.read_text()}'
        line = next(l for l in out.read_text().splitlines() if l.startswith('POPUP'))
        px, py, pw, ph = map(int, line.split()[1:])
        time.sleep(1.0)
        shot(f'{name}-warm')
        time.sleep(.5)
        image = shot(name)
        p = lambda v: int(v * scale)
        gx, gy = win['x'] + px, win['y'] + py
        mid = gy + ph // 2
        m = {
            'log': out.read_text(),
            'window': [win['x'], win['y'], 400, 300],
            'output': [out_w, out_h],
            'popup': [gx, gy, pw, ph],
            # Beyond the window's right edge: the popup, and the desktop past the popup.
            'outside': lum_at(image, p(win['x'] + 400 + 40), p(mid)),
            'desktop': lum_at(image, p(gx + pw + 12), p(mid)),
            # Over the window: under the popup, and beside it (left of it).
            'under': contrast(image, p(max(mid, win['y'] + 20)), p(gx + 16), p(win['x'] + 392)),
            'beside': contrast(image, p(max(mid, win['y'] + 20)), p(win['x'] + 8), p(gx - 8)),
        }
        # A click far from the popup and the window: the grab dismisses it.
        control(f'click {max(20, win["x"] - 200) if win["x"] > 220 else min(out_w - 20, gx + pw + 60)} {20}')
        time.sleep(.6)
        m['log'] = out.read_text()
        return m
    finally:
        probe.terminate()
        probe.wait()
        time.sleep(.5)


def placed(m):
    x, y, w, h = m['popup']
    wx, wy, _, _ = m['window']
    out_w, out_h = m['output']
    assert wy + 300 + PH > out_h, f'there is room under the window ({m}): nothing to flip'
    assert y < wy + 280, f'the popup at y {y} is not above its anchor (window at {wy}): not flipped'
    assert x >= 0 and y >= 0 and x + w <= out_w and y + h <= out_h, f'the popup {m["popup"]} is not wholly on the output {m["output"]}'


def glassed(m):
    assert m['outside'] > m['desktop'] + 30, \
        f'past the window\'s edge the popup ({m["outside"]:.0f}) is not its glass over the desktop ({m["desktop"]:.0f})'
    assert m['beside'] > SHARP, f'the columns beside the popup are not sharp ({m["beside"]:.1f}): nothing to measure'
    assert m['under'] < BLURRED, f'the columns under the popup are sharp ({m["under"]:.1f}): no glass'


def grabbed(m):
    assert 'KEYBOARD POPUP' in m['log'], f'the keyboard never entered the popup: {m["log"]!r}'
    assert 'DONE' in m['log'], f'a click outside did not dismiss the popup: {m["log"]!r}'


def caught(label, claim, m):
    try:
        claim(m)
    except AssertionError as e:
        print(f'CAUGHT {label}: {e}', flush=True)
        return
    raise AssertionError(f'the control {label} was not caught: {m}')


def check():
    original = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    results = {}
    try:
        msg('do', 'workspace', 91)
        msg('do', 'set-workspace-mode', 91, 'floating')
        results['popup'] = m = run('popup')
        placed(m)
        print(f'ok    the popup flips above its anchor and stays on the output: {m["popup"]}', flush=True)
        glassed(m)
        print(f'ok    its glass is drawn past the window\'s edge ({m["outside"]:.0f} over the desktop\'s {m["desktop"]:.0f}), '
              f'blurring the window under it ({m["under"]:.1f}, beside {m["beside"]:.1f})', flush=True)
        grabbed(m)
        print('ok    its grab: the keyboard enters it, a click outside dismisses it', flush=True)
        for flag, claim in (('--no-flip', placed), ('--no-material', glassed), ('--no-grab', grabbed)):
            results[flag] = c = run(flag[2:], flag)
            caught(flag, claim, c)
        print('POPUP GLASS CHECK PASSED', flush=True)
    finally:
        (LOG / 'measured.json').write_text(json.dumps(results, indent=2))
        msg('do', 'workspace', original)


if __name__ == '__main__':
    check()
