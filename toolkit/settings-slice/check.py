#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Short Hyalo-smoke check; real Config1.Get vs the submitted buffer's pixels.

Run after exporting settings-data and starting the shell + portal, on Hyalo:
  python toolkit/settings-slice/check.py toolkit/target/release/nk-settings-slice
No preferences are changed. The CI setup must supply at least one non-default
slice value; otherwise the control cannot discriminate and setup fails explicitly.
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from gi.repository import Gio, GLib

KEYS = ('appearance.darkMode', 'appearance.windowBackground', 'appearance.windowControls')
DEFAULTS = dict(zip(KEYS, (False, 'opaque', 'right')))


def get_values():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    # Get(as keys) -> a{sv}, as ConfigService.ts serves it.
    values = bus.call_sync('org.nidara.Config', '/org/nidara/Config',
        'org.nidara.Config1', 'Get', GLib.Variant('(as)', (list(KEYS),)),
        GLib.VariantType.new('(a{sv})'), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    return {key: values[key] for key in KEYS}


def hyalo_windows():
    out = subprocess.check_output([os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg', 'windows'])
    return json.loads(out)['ok']['windows']


def first_listing(pid, deadline):
    """The window as Hyalo first lists it: mapped, so with its first content commit."""
    while time.monotonic() < deadline:
        for w in hyalo_windows():
            if w.get('pid') == pid:
                return w
        time.sleep(.01)
    raise RuntimeError('setup: Hyalo never listed the slice window')


def run(binary, control, folder):
    env = dict(os.environ, NK_SLICE_FRAME=str(folder / ('fault.argb' if control else 'baseline.argb')))
    # The control also declares no window background (toolkit/PHASE1.md D6).
    proc = subprocess.Popen([binary] + (['--control-default-values', '--control-no-background'] if control else []),
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(s.rstrip()) for s in proc.stderr], daemon=True).start()
    seen, frame, ready, a11y = [], None, False, False
    try:
        deadline = time.monotonic() + 6
        # Hyalo draws the window's background from its first frame (D6): the first time it lists
        # the window — mapped, so with that frame — it has it.
        listed = first_listing(proc.pid, deadline)
        while time.monotonic() < deadline and not (ready and a11y):
            if proc.poll() is not None:
                raise RuntimeError(f'process exited {proc.returncode}: {seen}')
            try:
                line = lines.get(timeout=.05)
            except queue.Empty:
                continue
            seen.append(line)
            if line.startswith('SLICE_ERROR'):
                raise RuntimeError(line)
            if line.startswith('FRAME_EVIDENCE '):
                frame = json.loads(line.split(' ', 1)[1])
            ready |= line.startswith('CONTENT_READY commit=')
            a11y |= line == 'A11Y_READY'
        if not ready or not a11y or frame is None:
            raise RuntimeError(f'missing ready/a11y/frame (setup failure): {seen}')
        # The compositor told the scale before the first content commit, or that frame was
        # drawn at a guessed one and drawn again once told (Hyalo, until the open animation
        # ended: ~700 ms later).
        content = int(next(s for s in seen if s.startswith('CONTENT_READY commit=')).split('=')[1])
        told = [int(s.rsplit('=', 1)[1]) for s in seen if s.startswith('PREFERRED_SCALE ')]
        if not told or told[0] >= content:
            raise AssertionError(f'assert-scale: preferred scale after commits {told}, content is commit {content}')
        if control and 'CONTROL_APPLIED default-values' not in seen:
            raise RuntimeError('control was not applied')
        if control and 'CONTROL_APPLIED no-background' not in seen:
            raise RuntimeError('no-background control was not applied')
        background = listed.get('background')
        if not control and not (background and len(background['color']) == 3 and 0 < background['opacity'] <= 1):
            raise AssertionError(f'assert-background: Hyalo listed the window without its background: {background}')
        if control and background is not None:
            raise AssertionError(f'assert-background: the no-background control still has one: {background}')
        raw = Path(frame['path']).read_bytes()
        assert len(raw) == frame['width'] * frame['height'] * 4
        def pixel(point):
            x, y = point
            assert 0 <= x < frame['width'] and 0 <= y < frame['height']
            i = (y * frame['width'] + x) * 4
            n = int.from_bytes(raw[i:i+4], sys.byteorder)
            return ((n >> 16) & 255, (n >> 8) & 255, n & 255, n >> 24)
        values = {}
        # Every exported accent is chromatic. Neutral off tracks are achromatic;
        # alpha and the backdrop do not matter: these are the shm pixels, before
        # compositor glass. The one least chromatic accent, slate, still has 39
        # channels of spread at full opacity and > 5 in a selected segment.
        chroma = lambda p: max(p[:3]) - min(p[:3])
        for key in KEYS:
            sample = frame['samples'][key]
            if 'toggle' in sample:
                values[key] = chroma(pixel(sample['toggle'])) > 10
            else:
                segments = sample['segments']
                strengths = [chroma(pixel(s['point'])) for s in segments]
                if max(strengths) < 3 or strengths.count(max(strengths)) != 1:
                    raise RuntimeError(f'cannot read selected segment pixels: {strengths}')
                values[key] = segments[strengths.index(max(strengths))]['value']
        (folder / ('fault.log' if control else 'baseline.log')).write_text('\n'.join(seen) + '\n')
        return values, background
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def main():
    binary = str(Path(sys.argv[1]).resolve())
    expected = get_values()
    if expected == DEFAULTS:
        raise RuntimeError('setup: all values are defaults; seed a non-default value in disposable CI')
    with tempfile.TemporaryDirectory(prefix='nk-settings-slice-') as tmp:
        folder = Path(tmp)
        baseline, background = run(binary, False, folder)
        if get_values() != expected:
            raise RuntimeError('setup: settings changed during baseline')
        assert baseline == expected, f'assert-values: pixels {baseline} != Config1.Get {expected}'
        fault, _ = run(binary, True, folder)
        if get_values() != expected:
            raise RuntimeError('setup: settings changed during control')
        if fault == expected:
            raise AssertionError('assert-values: default-values control escaped')
        assert fault == DEFAULTS, f'control did not actually paint defaults: {fault}'
        print(f'PASS assert-values: pixels == Config1.Get {expected}')
        print(f'PASS control applied; assert-values rejected painted defaults {fault}')
        print('PASS assert-scale: preferred scale told before the first content commit')
        print(f'PASS assert-background: Hyalo draws the window background from its first frame {background}; the control has none')
        # An app's own level (set_window_background_level): the one Settings does not have.
        own = next(l for l in ('opaque', 'tinted', 'translucent') if l != background['level'])
        asked = subprocess.Popen([binary, '--window-level', own], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            listed = first_listing(asked.pid, time.monotonic() + 6).get('background') or {}
        finally:
            asked.terminate()
            asked.wait(timeout=5)
        if listed.get('level') != own or not listed.get('own_level'):
            raise AssertionError(f'assert-own-level: asked for {own} over the user\'s {background["level"]}, Hyalo shows {listed}')
        print(f'PASS assert-own-level: an app\'s own level ({own}) over the user\'s ({background["level"]})')


if __name__ == '__main__':
    main()
