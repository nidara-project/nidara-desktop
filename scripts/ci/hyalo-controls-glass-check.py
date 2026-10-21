#!/usr/bin/env python3
"""hyalo-controls-glass-check.py — the window controls are the shell's glass (toolkit/PHASE1.md
D7; hyalo/compositor/src/render/controls.rs `glass`, from the token export through
render/glass_tokens.rs): the bar capsules' glass, its tone, its ink tone and its ink, decided by
what Hyalo measures under it — not by the app. Only inside a test Hyalo started with
HYALO_CONTROL, with `hyalo-window-controls-probe` in PATH and the token export installed (or
HYALO_GLASS_TOKENS pointing at it in Hyalo's environment).

The probe's header (its top 60 rows) is 4 px white and black columns (HYALO_PROBE_STRIPES), or
the whole window one colour (HYALO_PROBE_HEADER); its controls sit on it. How sharp the columns are is their
contrast along a row: the luminance's standard deviation, ≈ 127 sharp, near 0 blurred.

  1. inside the capsule the columns are blurred, beside it they are sharp;
  2. the ink is the glass's: over a light header the glyphs are dark, over a dark one white —
     the app having said nothing about its header (no set_ink);
  3. in Hyalo's own title bar (an app that leaves its decorations to it) the same: over a light
     bar, the glass's light face and dark glyphs;
  4. the hovered close button is a red WASH in the glass (toolkit/CONTRACT.md, "Floating control
     capsule": the same state regions as the toolkit's controls), not a disc over it: red, and
     the header shows through it — it differs over the light and the dark header;
  5. the controls: `[windows.controls] glass = false` in the settings layer — the columns show
     through the plain capsule (claim 1 must fail), over the light header the glyphs stay
     white, nothing measuring it (claim 2 must fail), the bar's own capsule is darker than
     the bar (claim 3 must fail), and the plain capsule's hover is its opaque disc, the same
     over both headers (claim 4 must fail).
Exits 1 on failure."""
import json
import os
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
LIGHT_HEADER, DARK_HEADER = 'f0f0f0', '303030'


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


def pixel(image, x, y):
    w, _, px = image
    return tuple(px[(y * w + x) * 3:(y * w + x) * 3 + 3])


def lum(image, x, y):
    w, _, px = image
    i = (y * w + x) * 3
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]


def measure(name, env, app=APP, ready='PLACED', hover=False):
    """Run `app` with `env` and measure its capsule and the header beside it; with `hover`, the
    pointer over its close button."""
    out = LOG / f'{name}.log'
    with out.open('w') as stream:
        probe = subprocess.Popen([app], stdout=stream, stderr=stream, env={**os.environ, **env})
    try:
        for _ in range(80):
            if ready in out.read_text():
                break
            time.sleep(.1)
        assert ready in out.read_text(), f'{app} never got ready: {out.read_text()}'
        time.sleep(1.5)  # past the window's opening
        # The ink is measured on a drawing of the glass and applied when the GPU answers: a
        # first capture is such a drawing where no frame is drawn (a headless harness).
        shot(f'{name}-warm')
        time.sleep(.5)
        win = next(w for w in msg('windows')['windows'] if w['app_id'] == app)
        x, y, w, h = win['controls']
        scale = msg('outputs')['outputs'][0]['scale']
        # The close button: the rightmost of the capsule's circles, 24 across, 4 from its end
        # (render/controls.rs HOVER_R, EDGE).
        close = (x + w - 4 - 12, y + h / 2)
        if hover:
            Path(os.environ['HYALO_CONTROL']).write_text(f'move {close[0]} {close[1]}\n')
            time.sleep(.8)
            shot(f'{name}-hover-warm')
            time.sleep(.3)
        image = shot(name)
        p = lambda v: int(v * scale)
        # 5 px under the capsule's top: above the glyphs (14 px, centred), clear of its round ends.
        top = [lum(image, i, p(y + 5)) for i in range(p(x + 16), p(x + w - 16))]
        beside = [lum(image, i, p(y + 5)) for i in range(p(win['x'] + 12), p(x - 12))]
        # The header (or bar) near the window's left edge: clear of a centred title.
        edge = [lum(image, i, p(y + 5)) for i in range(p(win['x'] + 12), p(win['x'] + 60))]
        # The glyphs' row: through their middle.
        mid = [lum(image, i, p(y + h / 2)) for i in range(p(x + 6), p(x + w - 6))]
        return {
            'controls': [x, y, w, h],
            'inside': statistics.pstdev(top),
            'beside': statistics.pstdev(beside),
            'glass': statistics.fmean(top),
            'header': statistics.fmean(edge),
            'darkest': min(mid),
            'brightest': max(mid),
            'asked_ink': 'ASKED' in out.read_text(),
            # Inside the close button's circle, clear of its glyph (a 6 px cross).
            'close_wash': pixel(image, p(close[0] + 7), p(close[1] - 6)),
        }
    finally:
        probe.terminate()
        probe.wait()
        time.sleep(.5)


def blurred(m):
    assert m['beside'] > SHARP, f'the header beside the controls is not sharp ({m["beside"]:.1f}): nothing to measure'
    assert m['inside'] < BLURRED, f'inside the capsule the header is sharp ({m["inside"]:.1f}): no glass under the controls'


def inked(light, dark):
    assert not light['asked_ink'] and not dark['asked_ink'], 'the probe asked for an ink: the check proves nothing'
    assert light['darkest'] < 70, \
        f'over a light header the glyphs are not dark (darkest {light["darkest"]:.0f}, glass {light["glass"]:.0f}): the glass did not take the ink'
    assert dark['brightest'] > 170, \
        f'over a dark header the glyphs are not white (brightest {dark["brightest"]:.0f}, glass {dark["glass"]:.0f})'


def hover_washed(light, dark):
    """The hovered close button over a light and a dark header: red, and not the same."""
    for m in (light, dark):
        r, g, b = m['close_wash']
        assert r > 120 and r - g > 60, f'the hovered close button is {m["close_wash"]}: not red'
    l = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    assert abs(l(light['close_wash']) - l(dark['close_wash'])) > 6, \
        f'the hovered close button is {light["close_wash"]} over a light header and {dark["close_wash"]} over a dark one: opaque, not a wash in the glass'


def bar_glass(m):
    """Hyalo's title bar over a light app: the same capsule as over a light header — the
    glass's light face over the bar, brighter than it, and dark glyphs."""
    assert m['glass'] > m['header'] + 4, \
        f'the capsule ({m["glass"]:.0f}) is not the light glass over the bar ({m["header"]:.0f})'
    assert m['darkest'] < 70, f'the glyphs on the bar are not dark ({m["darkest"]:.0f})'


def check():
    original = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    results = {}
    try:
        msg('do', 'workspace', 93)
        msg('do', 'set-workspace-mode', 93, 'floating')
        results['stripes'] = s = measure('stripes', {'HYALO_PROBE_STRIPES': '1'})
        blurred(s)
        print(f'ok    inside the capsule the header is blurred ({s["inside"]:.1f}), beside it sharp ({s["beside"]:.1f})', flush=True)

        results['light'] = light = measure('light-header', {'HYALO_PROBE_HEADER': LIGHT_HEADER})
        results['dark'] = dark = measure('dark-header', {'HYALO_PROBE_HEADER': DARK_HEADER})
        inked(light, dark)
        print(f'ok    the ink is the glass\'s: dark glyphs over a light header ({light["darkest"]:.0f}), '
              f'white over a dark one ({dark["brightest"]:.0f}), the app saying nothing', flush=True)

        results['hover_light'] = hl = measure('hover-light', {'HYALO_PROBE_HEADER': LIGHT_HEADER}, hover=True)
        results['hover_dark'] = hd = measure('hover-dark', {'HYALO_PROBE_HEADER': DARK_HEADER}, hover=True)
        hover_washed(hl, hd)
        print(f'ok    the hovered close button is a wash in the glass: {hl["close_wash"]} over a light header, '
              f'{hd["close_wash"]} over a dark one', flush=True)

        # Hyalo's own title bar (an app that left its decorations to it, light at its top): the
        # same controls as over our apps' headers.
        results['title_bar'] = tb = measure('title-bar', {}, app='hyalo-title-bar-probe', ready='SHOWN')
        bar_glass(tb)
        print(f'ok    in Hyalo\'s title bar the same glass: {tb["glass"]:.0f} over the bar\'s {tb["header"]:.0f}, '
              f'dark glyphs ({tb["darkest"]:.0f})', flush=True)

        msg('settings', json.dumps({'windows': {'controls': {'glass': False}}}))
        results['plain'] = plain = measure('plain', {'HYALO_PROBE_STRIPES': '1'})
        try:
            blurred(plain)
        except AssertionError as e:
            print(f'CAUGHT glass = false: {e}', flush=True)
        else:
            raise AssertionError(f'the control glass = false was not caught: {plain}')
        # Without the glass nothing measures the header: the glyphs keep the app's ink, white.
        results['plain_light'] = plain_light = measure('plain-light-header', {'HYALO_PROBE_HEADER': LIGHT_HEADER})
        try:
            inked(plain_light, dark)
        except AssertionError as e:
            print(f'CAUGHT glass = false (ink): {e}', flush=True)
        else:
            raise AssertionError(f'the control glass = false (ink) was not caught: {plain_light}')
        results['plain_title_bar'] = plain_tb = measure('plain-title-bar', {}, app='hyalo-title-bar-probe', ready='SHOWN')
        try:
            bar_glass(plain_tb)
        except AssertionError as e:
            print(f'CAUGHT glass = false (title bar): {e}', flush=True)
        else:
            raise AssertionError(f'the control glass = false (title bar) was not caught: {plain_tb}')
        results['plain_hover_light'] = phl = measure('plain-hover-light', {'HYALO_PROBE_HEADER': LIGHT_HEADER}, hover=True)
        results['plain_hover_dark'] = phd = measure('plain-hover-dark', {'HYALO_PROBE_HEADER': DARK_HEADER}, hover=True)
        try:
            hover_washed(phl, phd)
        except AssertionError as e:
            print(f'CAUGHT glass = false (hover): {e}', flush=True)
        else:
            raise AssertionError(f'the control glass = false (hover) was not caught: {phl} {phd}')
        print('CONTROLS GLASS CHECK PASSED', flush=True)
    finally:
        (LOG / 'measured.json').write_text(json.dumps(results, indent=2))
        subprocess.run([os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg', 'settings', json.dumps({'windows': None})],
                       capture_output=True)
        msg('do', 'workspace', original)


if __name__ == '__main__':
    check()
