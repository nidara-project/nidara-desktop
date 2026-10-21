#!/usr/bin/env python3
"""hyalo-control-material-check.py — a control on glass answers its backdrop (toolkit/CONTRACT.md,
"Floating control capsule"; nidara-material-v1 set_response, add_state_region, set_ink_colors,
add_ink_coverage; hyalo/compositor/src/protocols/material.rs `Presenting`, render/glass.rs,
render/glass_final.glsl, render/window.rs `Inked`). Only inside a test Hyalo started with
HYALO_CONTROL, with `hyalo-control-material-probe` in PATH.

The probe's window is one colour, white or black; a capsule layer lies over it with the
compositor's glass, the shell's dark control tone and its light ink tone, a shadow, an answer to
the backdrop, a red wash in a rounded rectangle, white and black inks, and two green glyph squares
in its buffer — A inside an ink coverage rectangle, B outside any (see the probe). Each claim is
checked, and then a control — the probe dropping that one part — must break it:

  1. the coverage is ink: A is not green, B still is — control `--no-ink` (no inks: A green);
  2. the ink answers the backdrop: over the white page A is dark, over the black page white —
     control `--no-response` (over white, A stays the light ink);
  3. so does the tone: over the white page the glass inside the capsule is the light ink tone,
     brighter than the dark tone could make white (≈185) — control `--no-ink-tone`;
  4. and the shadow: just under the capsule, over the white page, darker than the shadow's own
     opacity (0.3) could make it — control `--no-shadow-gain`;
  5. the wash: inside its rectangle the glass is redder than beside it, and the backdrop still
     shows through it (it differs between the white and the black page) — control `--no-state`;
  6. overlapping coverage is the protocol error invalid_region — control: the probe without the
     overlap gets no error (every run above);
  7. Hyalo reports the answer it shows (`msg windows`, the layer's `answers`): measured, settled,
     r ≈ 1 over the white page and ≈ 0 over the black one — control `--no-response` (none).
     Every capture waits for that report, never on a sleep.
CONTROL_MATERIAL_CONTROLS=0 leaves the five probe controls (seven runs) out: a PR that touches
nothing they check (scripts/ci/ci-scope.sh `full`); the nightly run has them.
Exits 1 on failure."""
import json
import os
import struct
import subprocess
import time
import zlib
from pathlib import Path

LOG = Path(os.environ.get('CONTROL_MATERIAL_LOG', '/tmp/hyalo-control-material'))
LOG.mkdir(parents=True, exist_ok=True)
APP = 'hyalo-control-material-probe'
X, Y = 100, 100   # the capsule in the window, logical px; 160×40


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


def lum(p):
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]


def run(name, *args):
    """Run the probe with `args`; its output, and the capsule's pixels if it got ready."""
    out = LOG / f'{name}.log'
    with out.open('w') as stream:
        probe = subprocess.Popen([APP, *args], stdout=stream, stderr=stream)
    try:
        for _ in range(100):
            text = out.read_text()
            if 'READY' in text or 'ERROR' in text or 'NO_LAYERS' in text or probe.poll() is not None:
                break
            time.sleep(.05)
        text = out.read_text()
        assert 'NO_LAYERS' not in text, 'Hyalo offers no nidara-layers-v1 or nidara-material-v1'
        if 'READY' not in text:
            return {'log': text}
        # Past the window's opening; then a first capture, which is a drawing of the glass that
        # measures its backdrop — the answer is applied when the GPU hands it back.
        time.sleep(1.5)
        shot(f'{name}-warm')
        # Until Hyalo says the answer it shows is measured and settled (`msg windows`, the layer's
        # `answers`) — not a sleep: a capture before it would see the glass before its answer.
        answers = None
        for _ in range(50):
            win = next(w for w in msg('windows')['windows'] if w['app_id'] == APP)
            answers = next((l.get('answers') for l in win.get('layers', []) if l.get('answers')), None)
            shapes = (answers or {}).get('shapes', [])
            if not shapes or all(a['measured'] and a['settled'] for a in shapes):
                break
            shot(f'{name}-warm')
            time.sleep(.1)
        scale = msg('outputs')['outputs'][0]['scale']
        image = shot(name)
        at = lambda x, y: pixel(image, int((win['x'] + X + x) * scale), int((win['y'] + Y + y) * scale))
        return {
            'log': text,
            'glyph_a': at(28, 20),
            'glyph_b': at(132, 20),
            # The glass clear of the glyphs, the wash and the rim; the wash's middle.
            'glass': at(108, 20),
            'wash': at(76, 20),
            # 3 px under the capsule's bottom edge: inside its shadow (6 px down, 4 px blur).
            'shadow': at(80, 43),
            'answers': answers,
        }
    finally:
        probe.terminate()
        probe.wait()
        time.sleep(.5)


def green(p):
    return p[1] > 200 and p[0] < 80 and p[2] < 80


def coverage_inked(m):
    assert green(m['glyph_b']), f'B, outside any coverage, is {m["glyph_b"]}: not drawn as painted'
    assert not green(m['glyph_a']), f'A, inside the coverage, is still green {m["glyph_a"]}: not drawn in the ink'


def ink_answers(white, black):
    assert lum(white['glyph_a']) < 70, f'over the white page A is {white["glyph_a"]}: not the dark ink'
    assert lum(black['glyph_a']) > 185, f'over the black page A is {black["glyph_a"]}: not the light ink'


def tone_answers(white):
    assert lum(white['glass']) > 225, \
        f'over the white page the glass is {white["glass"]} (lum {lum(white["glass"]):.0f}): the dark tone, not mixed towards the light one'


def shadow_answers(white):
    assert lum(white['shadow']) < 140, \
        f'under the capsule over the white page the shadow is {white["shadow"]} (lum {lum(white["shadow"]):.0f}): no stronger than its own opacity makes it'


def washed(white, black):
    w, g = white['wash'], white['glass']
    assert w[0] - w[1] > 40 and w[0] - w[1] > (g[0] - g[1]) + 40, f'the wash {w} is not redder than the glass beside it {g}'
    assert abs(lum(white['wash']) - lum(black['wash'])) > 30, \
        f'the wash is the same over the white page {white["wash"]} and the black one {black["wash"]}: the backdrop does not show through'


def reported(white, black):
    def answer(m):
        shapes = (m['answers'] or {}).get('shapes', [])
        assert shapes and all(a['measured'] and a['settled'] for a in shapes), \
            f'Hyalo reports no measured, settled answer: {m["answers"]}'
        return shapes[0]['r']
    assert answer(white) > 0.9 and answer(black) < 0.1, \
        f'Hyalo reports r {answer(white):.2f} over the white page and {answer(black):.2f} over the black one'


def protocol_error(m):
    assert 'ERROR nidara_material_v1 0' in m['log'], f'no invalid_region error: {m["log"]!r}'


def caught(label, claim, *m):
    try:
        claim(*m)
    except AssertionError as e:
        print(f'CAUGHT {label}: {e}', flush=True)
        return
    raise AssertionError(f'the control {label} was not caught: {m}')


def check():
    original = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    results = {}
    try:
        msg('do', 'workspace', 92)
        msg('do', 'set-workspace-mode', 92, 'floating')
        results['white'] = white = run('white')
        results['black'] = black = run('black', '--page', 'black')
        for m in (white, black):
            assert 'glyph_a' in m, f'the probe never got ready: {m["log"]!r}'
        coverage_inked(white)
        print(f'ok    the coverage is ink: A {white["glyph_a"]}, B as painted {white["glyph_b"]}', flush=True)
        ink_answers(white, black)
        print(f'ok    the ink answers the backdrop: A {white["glyph_a"]} over white, {black["glyph_a"]} over black', flush=True)
        tone_answers(white)
        print(f'ok    the tone answers it: the glass {white["glass"]} over white', flush=True)
        shadow_answers(white)
        print(f'ok    the shadow answers it: {white["shadow"]} under the capsule over white', flush=True)
        washed(white, black)
        print(f'ok    the wash is in the glass: {white["wash"]} beside {white["glass"]}, {black["wash"]} over black', flush=True)
        reported(white, black)
        print(f'ok    Hyalo reports the answer it shows (msg windows): r {white["answers"]["shapes"][0]["r"]:.2f} over white, '
              f'{black["answers"]["shapes"][0]["r"]:.2f} over black, settled', flush=True)
        results['overlap'] = overlap = run('overlap', '--overlap')
        protocol_error(overlap)
        print('ok    overlapping coverage is invalid_region', flush=True)

        if os.environ.get('CONTROL_MATERIAL_CONTROLS', '1') == '0':
            caught('no overlap', protocol_error, white)
            caught('--no-response (report)', reported, *[run(f'no-response-{p}', '--no-response', '--page', p) for p in ('white', 'black')])
            print('controls left to the nightly run (CONTROL_MATERIAL_CONTROLS=0)', flush=True)
            print('CONTROL MATERIAL CHECK PASSED', flush=True)
            return
        for flag, pages, claims in (
                ('--no-ink', ('white',), [('--no-ink', coverage_inked)]),
                ('--no-response', ('white', 'black'), [('--no-response', ink_answers), ('--no-response (report)', reported)]),
                ('--no-ink-tone', ('white',), [('--no-ink-tone', tone_answers)]),
                ('--no-shadow-gain', ('white',), [('--no-shadow-gain', shadow_answers)]),
                ('--no-state', ('white', 'black'), [('--no-state', washed)])):
            ms = []
            for page in pages:
                name = f'{flag[2:]}-{page}'
                results[name] = m = run(name, flag, '--page', page)
                assert 'glyph_a' in m, f'the probe never got ready ({flag}): {m["log"]!r}'
                ms.append(m)
            for label, claim in claims:
                caught(label, claim, *ms)
        caught('no overlap', protocol_error, white)
        print('CONTROL MATERIAL CHECK PASSED', flush=True)
    finally:
        (LOG / 'measured.json').write_text(json.dumps(results, indent=2, default=str))
        msg('do', 'workspace', original)


if __name__ == '__main__':
    check()
