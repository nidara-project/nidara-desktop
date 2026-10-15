#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""A real nk-phase0 on a test Hyalo. Input goes through HYALO_CONTROL and
input-method-v2. Every assertion observes IPC/pixels, never the app's text state.
Controls disable mapping, material, keyboard and preedit independently, and must
fail at that exact assertion. No live session: HYALO_CONTROL is mandatory.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import zlib

ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ.get('NK_PHASE0_LOG', '/tmp/hyalo/nk-phase0'))
LOG.mkdir(parents=True, exist_ok=True)
BIN = os.environ.get('NK_PHASE0_BIN', str(ROOT / 'toolkit/target/release/nk-phase0'))
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
CONTROL = os.environ['HYALO_CONTROL']
CONTROL_PIPE = open(CONTROL, 'w', buffering=1)


def msg(*args):
    return json.loads(subprocess.check_output([*MSG, *map(str, args)]))['ok']


def control(line):
    CONTROL_PIPE.write(line + '\n')
    CONTROL_PIPE.flush()


def wait(test, label, seconds=6):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError(label)


def window():
    return next((w for w in msg('windows')['windows'] if w['app_id'] == 'nk-phase0'), None)


def png(path, w, h, rgb):
    """Only stdlib needed on Arch and Ubuntu; also keep the PPM pixel evidence."""
    def chunk(tag, data):
        return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', zlib.crc32(tag + data))
    rows = b''.join(b'\0' + rgb[y*w*3:(y+1)*w*3] for y in range(h))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', w, h, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def shot(name):
    path = LOG / f'{name}.ppm'
    msg('screenshot', path)
    header, dims, depth, pixels = path.read_bytes().split(b'\n', 3)
    assert header == b'P6' and depth == b'255', 'bad Hyalo screenshot'
    w, h = map(int, dims.split())
    png(path.with_suffix('.png'), w, h, pixels)
    return w, h, pixels


def crop(image, win, box):
    w, h, pixels = image
    scale = msg('outputs')['outputs'][0]['scale']
    x, y, width, height = box
    x0, y0 = int((win['x']+x)*scale), int((win['y']+y)*scale)
    x1, y1 = int((win['x']+x+width)*scale), int((win['y']+y+height)*scale)
    assert 0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h, 'field outside screenshot'
    return b''.join(pixels[(row*w+x0)*3:(row*w+x1)*3] for row in range(y0, y1))


def ink(pixels):
    return sum(min(pixels[i:i+3]) > 175 for i in range(0, len(pixels), 3))


def differs(a, b):
    return sum(max(abs(a[j]-b[j]) for j in range(i, i+3)) > 20 for i in range(0, len(a), 3))


def chord(mod, key):
    control(f'keydown {mod}')
    control(f'key {key}')
    control(f'keyup {mod}')
    time.sleep(.15)


def run(label, flag=None, stop=None):
    directory = LOG / label
    directory.mkdir(exist_ok=True)
    with (directory / 'client.log').open('w') as stream:
        app = subprocess.Popen([BIN, *([flag] if flag else [])], stdout=stream, stderr=stream)
    ime = None
    try:
        def alive_window():
            assert app.poll() is None, f'client exited before mapping: {(directory / "client.log").read_text()}'
            return window()
        win = wait(alive_window, 'mapped: nk-phase0 did not map', seconds=2 if flag == '--control-unmapped' else 8)
        time.sleep(1)  # Past Hyalo's open animation, before comparing physical pixels.
        win = window()
        assert win and win['width'] > 300 and win['height'] > 250, 'mapped: window has no extent'
        before = shot(label+'-before')
        body = crop(before, win, (40, 240, min(win['width']-80, 300), 100))
        assert ink(body) > 100, 'mapped: no corpus text on screen'
        if stop == 'mapped':
            return
        (directory/'windows.json').write_text(json.dumps(msg('windows'), indent=2))
        glass = win.get('glass') or {}
        assert glass.get('compositor_paints') and glass.get('shapes', 0) > 0, 'glass: Hyalo has no committed panes'
        # Pixel evidence at the pane's unpainted margin: CPU buffer is alpha=0
        # here. With no material this is Hyalo's base window colour instead.
        assert ink(crop(before, win, (200, 230, 100, 2))) == 0, 'glass: unexpected client paint in pane margin'
        if stop == 'glass':
            return
        box = (43, 105, min(win['width']-90, 500), 96)
        def field(name, predicate, error):
            def attempt():
                pixels = crop(shot(label+'-'+name), win, box)
                return pixels if predicate(pixels) else None
            return wait(attempt, error, seconds=3)
        empty = crop(before, win, box)
        control(f"click {win['x']+48} {win['y']+125}")
        control('key 49')  # n
        control('key 37')  # k
        typed = field('typed', lambda p: ink(p) > ink(empty)+75 and differs(empty,p) > 100, 'keyboard: typed glyphs did not appear')
        if stop == 'keyboard':
            return
        with (directory / 'ime.log').open('w') as stream:
            ime = subprocess.Popen(['hyalo-ime-probe', '--script'], stdin=subprocess.PIPE,
                                   stdout=stream, stderr=stream, text=True)
        wait(lambda: 'STATE 1 ' in (directory/'ime.log').read_text(), 'IME never activated')
        def command(line):
            ime.stdin.write(line+'\n')
            ime.stdin.flush()
            wait(lambda: 'SENT '+line in (directory/'ime.log').read_text(), 'IME command not acknowledged')
            time.sleep(.15)
        command('preedit 日本')
        pre = field('preedit', lambda p: differs(typed,p) > 150 and ink(p) > ink(typed)+80, 'preedit: composition did not appear')
        wait(lambda: 'CAUSE 0' in (directory/'ime.log').read_text(), 'IME context echo was marked external')
        command('preedit 日本語')
        field('replaced', lambda p: differs(pre,p) > 80, 'preedit: composition was not replaced')
        command('cancel')
        field('cancelled', lambda p: differs(typed,p) < 5, 'preedit: cancel did not restore committed text')
        if stop == 'preedit':
            return
        command('commit 日本')
        committed = field('committed', lambda p: differs(typed,p) > 150, 'IME commit did not appear')
        # Clipboard receives its own selection through wl_data_device pipes.
        chord(29, 30)  # Ctrl+A
        chord(29, 46)  # Ctrl+C
        control('key 14')  # Backspace
        cleared = field('cleared', lambda p: ink(p) < ink(committed)-100, 'selection/backspace did not remove text')
        chord(29, 47)  # Ctrl+V
        field('pasted', lambda p: differs(committed,p) < 5, 'clipboard roundtrip changed text pixels')
        chord(29, 44)  # Ctrl+Z
        field('undone', lambda p: differs(cleared,p) < 5, 'undo did not undo paste')
        chord(29, 21)  # Ctrl+Y
        field('redone', lambda p: differs(committed,p) < 5, 'redo did not restore paste')
        print('PASS mapped, glass, keyboard, preedit/replace/cancel/commit, clipboard, undo/redo', flush=True)
    finally:
        for process in (ime, app):
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        wait(lambda: window() is None, 'test window did not go away')


if __name__ == '__main__':
    original = next(w['id'] for w in msg('workspaces')['workspaces'] if w['focused'])
    try:
        msg('do', 'workspace', 94)
        msg('do', 'set-workspace-mode', 94, 'floating')
        # Baseline proves every oracle is reachable before we break it.
        run('baseline')
        for label, flag, assertion in [('unmapped', '--control-unmapped', 'mapped'),
                                       ('no-material', '--control-no-material', 'glass'),
                                       ('no-keyboard', '--control-no-keyboard', 'keyboard'),
                                       ('no-preedit', '--control-no-preedit', 'preedit')]:
            try:
                run(label, flag, stop=assertion)
            except AssertionError as error:
                assert str(error).startswith(assertion+':'), f'inconclusive {label}: {error}'
                print(f'CONTROL PASS {label}: {error}', flush=True)
            else:
                raise AssertionError(f'{label}: broken path passed its oracle')
        output = msg('outputs')['outputs'][0]
        try:
            msg('output', output['name'], 'scale=1.25')
            time.sleep(.3)
            run('scale125')
        finally:
            msg('output', output['name'], f"scale={output['scale']}")
        # Human-review corpus screenshots: each case remains at one corpus width.
        for case in ('japanese', 'arabic-bidi', 'zwj-rainbow'):
            with (LOG / (case+'.log')).open('w') as stream:
                app = subprocess.Popen([BIN, '--case', case], stdout=stream, stderr=stream)
            try:
                wait(window, f'{case} window absent')
                time.sleep(1)
                image=shot('corpus-'+case)
                if case == 'zwj-rainbow':
                    win=window()
                    pixels=crop(image,win,(32,max(16,win['height']-180),win['width']-64,164))
                    red=sum(pixels[i]>150 and pixels[i+1]<120 and pixels[i+2]<120 for i in range(0,len(pixels),3))
                    blue=sum(pixels[i+2]>150 and pixels[i]<100 and pixels[i+1]<160 for i in range(0,len(pixels),3))
                    assert red>3 and blue>3, 'corpus: final colour emoji is outside the visible viewport'
            finally:
                app.terminate()
                app.wait(timeout=5)
                wait(lambda: window() is None, 'corpus window did not go away')
        costs = ['# One-window observations', '', 'Client log lines include font discovery, layout and CPU paint.', '']
        for name in ('baseline', 'scale125'):
            lines = (LOG/name/'client.log').read_text().splitlines()
            costs += [f'## {name}', '', *[f'- `{line}`' for line in lines if line.startswith('FIRST_FRAME')], '']
        (LOG/'cost.md').write_text('\n'.join(costs))
        print('\n'.join(costs), flush=True)
        print('NK PHASE0 CHECK PASSED', flush=True)
    finally:
        msg('do', 'workspace', original)
