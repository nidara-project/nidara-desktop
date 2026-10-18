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

KEYS = ('appearance.darkMode', 'appearance.windowTransparency',
        'appearance.windowBlur', 'appearance.windowControls')
DEFAULTS = dict(zip(KEYS, (False, True, True, 'right')))


def get_values():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    # Get(as keys) -> a{sv}, as ConfigService.ts serves it.
    values = bus.call_sync('org.nidara.Config', '/org/nidara/Config',
        'org.nidara.Config1', 'Get', GLib.Variant('(as)', (list(KEYS),)),
        GLib.VariantType.new('(a{sv})'), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    return {key: values[key] for key in KEYS}


def run(binary, control, folder):
    env = dict(os.environ, NK_SLICE_FRAME=str(folder / ('fault.argb' if control else 'baseline.argb')))
    proc = subprocess.Popen([binary] + (['--control-default-values'] if control else []),
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(s.rstrip()) for s in proc.stderr], daemon=True).start()
    seen, frame, ready, a11y = [], None, False, False
    try:
        deadline = time.monotonic() + 6
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
        if control and 'CONTROL_APPLIED default-values' not in seen:
            raise RuntimeError('control was not applied')
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
        return values
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
        baseline = run(binary, False, folder)
        if get_values() != expected:
            raise RuntimeError('setup: settings changed during baseline')
        assert baseline == expected, f'assert-values: pixels {baseline} != Config1.Get {expected}'
        fault = run(binary, True, folder)
        if get_values() != expected:
            raise RuntimeError('setup: settings changed during control')
        if fault == expected:
            raise AssertionError('assert-values: default-values control escaped')
        assert fault == DEFAULTS, f'control did not actually paint defaults: {fault}'
        print(f'PASS assert-values: pixels == Config1.Get {expected}')
        print(f'PASS control applied; assert-values rejected painted defaults {fault}')


if __name__ == '__main__':
    main()
