#!/usr/bin/env python3
"""hyalo-layer-glass-check.py — a layer's own glass over its window's content, and a graded
blur (toolkit/PHASE1.md D7; hyalo/compositor/src/protocols/layers.rs `render_tree`,
render/glass_final.glsl `graded`). Only inside a test Hyalo started with HYALO_CONTROL, with
`hyalo-layer-glass-probe` in PATH.

The probe's window is 4 px white and black columns; a sidebar layer and a title-bar layer lie
over it, transparent, each with a material on its own surface (see the probe). How sharp the
columns are is their contrast along a row: the luminance's standard deviation, ≈ 127 sharp,
near 0 blurred. Each claim is checked, and then its control must break it:

  1. under the sidebar the columns are blurred, beside it they are sharp —
     control `--no-material`: the layer has no material, and they are sharp under it too;
  2. under the title bar the blur falls from its top edge to its bottom edge —
     control `--uniform`: not graded, as blurred at the bottom as at the top;
  3. the layers' glass shows nothing past the window's rounded corners (both layers reach the
     window's top corners): the pixel one px in from each top corner is what lies beside the
     window, not glass — control: a rule with `rounding = false` for the probe, whose square
     corners then show the glass there (as every layer's glass did before it was cut).
Exits 1 on failure."""
import json
import os
import statistics
import struct
import subprocess
import time
import zlib
from pathlib import Path

LOG = Path(os.environ.get('LAYER_GLASS_LOG', '/tmp/hyalo-layer-glass'))
LOG.mkdir(parents=True, exist_ok=True)
APP = 'hyalo-layer-glass-probe'
SHARP = 90     # a row of the bare pattern: ≈ 127
BLURRED = 40   # under the full blur (4 px offset, 3 passes over a 8 px period): near 0


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


def contrast(image, y, x0, x1):
    """The luminance's standard deviation along row y between x0 and x1 (physical)."""
    w, _, px = image
    lum = [0.2126 * px[(y * w + x) * 3] + 0.7152 * px[(y * w + x) * 3 + 1] + 0.0722 * px[(y * w + x) * 3 + 2]
           for x in range(x0, x1)]
    return statistics.pstdev(lum)


def pixel(image, x, y):
    w, _, px = image
    return tuple(px[(y * w + x) * 3:(y * w + x) * 3 + 3])


def measure(name, *args):
    """Run the probe with `args` and measure its rows."""
    out = LOG / f'{name}.log'
    with out.open('w') as stream:
        probe = subprocess.Popen([APP, *args], stdout=stream, stderr=stream)
    try:
        for _ in range(100):
            text = out.read_text()
            if 'READY' in text or 'NO_LAYERS' in text:
                break
            time.sleep(.05)
        text = out.read_text()
        assert 'NO_LAYERS' not in text, 'Hyalo offers no nidara-layers-v1 or nidara-material-v1'
        assert 'READY' in text, f'the probe never got ready: {text}'
        # Past the window's own opening animation (it grows out of its middle, 700 ms by default).
        time.sleep(1.5)
        win = next(w for w in msg('windows')['windows'] if w['app_id'] == APP)
        scale = msg('outputs')['outputs'][0]['scale']
        image = shot(name)
        x = lambda v: int((win['x'] + v) * scale)
        y = lambda v: int((win['y'] + v) * scale)
        return {
            'layers': win.get('layers', []),
            'sidebar': contrast(image, y(150), x(24), x(96)),
            'beside': contrast(image, y(150), x(200), x(380)),
            'title_top': contrast(image, y(4), x(150), x(370)),
            'title_bottom': contrast(image, y(57), x(150), x(370)),
            # One px in from the top corners, and the same row just beside the window.
            'corner_left': pixel(image, x(1), y(1)),
            'corner_right': pixel(image, x(win['width'] - 2), y(1)),
            'beside_left': pixel(image, x(-6), y(1)),
            'beside_right': pixel(image, x(win['width'] + 5), y(1)),
        }
    finally:
        probe.terminate()
        probe.wait()
        time.sleep(.5)


def sidebar_blurred(m):
    assert m['beside'] > SHARP, f'the pattern beside the layers is not sharp ({m["beside"]:.1f}): nothing to measure'
    assert m['sidebar'] < BLURRED, f'under the sidebar layer the columns are sharp ({m["sidebar"]:.1f}): its glass does not blur its window'


def title_graded(m):
    assert m['title_top'] < BLURRED, f'the title bar is not blurred at its top edge ({m["title_top"]:.1f})'
    assert m['title_bottom'] > SHARP, f'the title bar is blurred at its bottom edge ({m["title_bottom"]:.1f}): not graded'


def corners_cut(m):
    near = lambda a, b: all(abs(p - q) <= 12 for p, q in zip(a, b))
    for side in ('left', 'right'):
        corner, beside = m[f'corner_{side}'], m[f'beside_{side}']
        assert near(corner, beside), \
            f'the {side} top corner shows {corner}, not what lies beside the window {beside}: the layers\' glass reaches past its rounded corner'


def caught(label, claim, m):
    try:
        claim(m)
    except AssertionError as e:
        print(f'CAUGHT {label}: {e}', flush=True)
        return
    raise AssertionError(f'the control {label} was not caught: {m}')


def check():
    original = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    try:
        msg('do', 'workspace', 94)
        msg('do', 'set-workspace-mode', 94, 'floating')
        m = measure('glass')
        (LOG / 'glass.json').write_text(json.dumps(m, indent=2))
        assert len(m['layers']) == 2 and all(l['glass_shapes'] == 1 for l in m['layers']), \
            f'Hyalo does not list both layers with their glass: {m["layers"]}'
        sidebar_blurred(m)
        print(f'ok    under the sidebar the window\'s columns are blurred ({m["sidebar"]:.1f}), beside it sharp ({m["beside"]:.1f})', flush=True)
        title_graded(m)
        print(f'ok    under the title bar the blur falls from its top ({m["title_top"]:.1f}) to its bottom ({m["title_bottom"]:.1f})', flush=True)
        corners_cut(m)
        print(f'ok    the layers\' glass stops at the window\'s rounded corners ({m["corner_left"]} beside {m["beside_left"]}, {m["corner_right"]} beside {m["beside_right"]})', flush=True)

        bare = measure('no-material', '--no-material')
        (LOG / 'no-material.json').write_text(json.dumps(bare, indent=2))
        caught('--no-material', sidebar_blurred, bare)
        uniform = measure('uniform', '--uniform')
        (LOG / 'uniform.json').write_text(json.dumps(uniform, indent=2))
        caught('--uniform', title_graded, uniform)
        msg('settings', json.dumps({'rules': {'layer-glass-square': {'match': {'app_id': f'^{APP}$'}, 'rounding': False}}}))
        try:
            square = measure('square')
        finally:
            msg('settings', json.dumps({'rules': {'layer-glass-square': None}}))
        (LOG / 'square.json').write_text(json.dumps(square, indent=2))
        caught('rounding = false', corners_cut, square)
        print('LAYER GLASS CHECK PASSED', flush=True)
    finally:
        msg('do', 'workspace', original)


if __name__ == '__main__':
    check()
