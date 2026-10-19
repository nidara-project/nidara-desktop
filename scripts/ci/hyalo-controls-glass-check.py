#!/usr/bin/env python3
"""hyalo-controls-glass-check.py — the window controls use the shell's glass (toolkit/PHASE1.md
D7; hyalo/compositor/src/render/controls.rs `glass`, from the token export through
render/glass_tokens.rs). Only inside a test Hyalo started with HYALO_CONTROL, with
`hyalo-window-controls-probe` in PATH and the token export installed (or HYALO_GLASS_TOKENS
pointing at it in Hyalo's environment).

The probe's header is 4 px white and black columns (HYALO_PROBE_STRIPES); its controls sit on
it. How sharp the columns are is their contrast along a row: the luminance's standard
deviation, ≈ 127 sharp, near 0 blurred.

  1. inside the capsule the columns are blurred, beside it they are sharp;
  2. the glass's face follows the app's ink: asking for dark ink (a light header) gives the
     light face, brighter than the dark one;
  3. the control: `[windows.controls] glass = false` in the settings layer, and the columns show
     through the plain capsule — claim 1 must fail.
Exits 1 on failure."""
import json
import os
import signal
import statistics
import struct
import subprocess
import time
import zlib
from pathlib import Path

LOG = Path(os.environ.get('CONTROLS_GLASS_LOG', '/tmp/hyalo-controls-glass'))
LOG.mkdir(parents=True, exist_ok=True)
APP = 'hyalo-window-controls-probe'
SHARP = 90
BLURRED = 40


def msg(*args):
    return json.loads(subprocess.check_output([os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg', *map(str, args)]))['ok']


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


def row(image, y, x0, x1):
    w, _, px = image
    return [0.2126 * px[(y * w + x) * 3] + 0.7152 * px[(y * w + x) * 3 + 1] + 0.0722 * px[(y * w + x) * 3 + 2]
            for x in range(x0, x1)]


def measure(name):
    """The capsule's row and the header beside it."""
    time.sleep(.6)
    win = next(w for w in msg('windows')['windows'] if w['app_id'] == APP)
    x, y, w, h = win['controls']
    scale = msg('outputs')['outputs'][0]['scale']
    image = shot(name)
    p = lambda v: int(v * scale)
    # 5 px under the capsule's top: above the glyphs (14 px, centred), clear of its round ends.
    inside = row(image, p(y + 5), p(x + 16), p(x + w - 16))
    beside = row(image, p(y + 5), p(win['x'] + 12), p(x - 12))
    return {
        'controls': [x, y, w, h],
        'inside': statistics.pstdev(inside),
        'inside_mean': statistics.fmean(inside),
        'beside': statistics.pstdev(beside),
    }


def blurred(m):
    assert m['beside'] > SHARP, f'the header beside the controls is not sharp ({m["beside"]:.1f}): nothing to measure'
    assert m['inside'] < BLURRED, f'inside the capsule the header is sharp ({m["inside"]:.1f}): no glass under the controls'


def check():
    original = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    out = LOG / 'probe.log'
    probe = None
    try:
        msg('do', 'workspace', 93)
        msg('do', 'set-workspace-mode', 93, 'floating')
        with out.open('w') as stream:
            probe = subprocess.Popen([APP], stdout=stream, stderr=stream, env={**os.environ, 'HYALO_PROBE_STRIPES': '1'})
        for _ in range(80):
            if 'PLACED' in out.read_text():
                break
            time.sleep(.1)
        assert 'PLACED' in out.read_text(), f'the probe never placed its controls: {out.read_text()}'
        time.sleep(1.0)  # past the window's opening

        light = measure('glass')
        blurred(light)
        print(f'ok    inside the capsule the header is blurred ({light["inside"]:.1f}), beside it sharp ({light["beside"]:.1f})', flush=True)

        asked = out.read_text().count('ASKED')
        probe.send_signal(signal.SIGWINCH)
        for _ in range(40):
            if out.read_text().count('ASKED') > asked:
                break
            time.sleep(.1)
        dark = measure('dark-ink')
        blurred(dark)
        assert dark['inside_mean'] > light['inside_mean'] + 10, \
            f'dark ink asked, and the glass is no lighter ({dark["inside_mean"]:.1f} against {light["inside_mean"]:.1f}): its face does not follow the ink'
        print(f'ok    the face follows the ink: light under dark glyphs ({dark["inside_mean"]:.1f}), dark under white ({light["inside_mean"]:.1f})', flush=True)
        probe.send_signal(signal.SIGWINCH)

        msg('settings', json.dumps({'windows': {'controls': {'glass': False}}}))
        plain = measure('plain')
        (LOG / 'measured.json').write_text(json.dumps({'glass': light, 'dark_ink': dark, 'plain': plain}, indent=2))
        try:
            blurred(plain)
        except AssertionError as e:
            print(f'CAUGHT glass = false: {e}', flush=True)
        else:
            raise AssertionError(f'the control glass = false was not caught: {plain}')
        print('CONTROLS GLASS CHECK PASSED', flush=True)
    finally:
        subprocess.run([os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg', 'settings', json.dumps({'windows': None})],
                       capture_output=True)
        if probe and probe.poll() is None:
            probe.terminate()
            probe.wait()
        msg('do', 'workspace', original)


if __name__ == '__main__':
    check()
