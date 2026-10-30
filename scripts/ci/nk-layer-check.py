#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private nested-Hyalo probe for the layer root (toolkit/SHELL-SURFACES.md §1)."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
BIN = Path(os.environ['NK_WIDGETS_BIN']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('private check-headless.sh runtime required')


def wait(log, needle, process, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if needle in log.read_text():
            return
        if process.poll() is not None:
            raise RuntimeError(f'probe exited before {needle}: {process.returncode}')
        time.sleep(.01)
    raise RuntimeError(f'timeout: {needle}')


def output_size():
    hyalo = os.environ['HYALO_BIN']
    out = subprocess.run([hyalo, 'msg', 'outputs'], capture_output=True, text=True, timeout=5).stdout
    outputs = json.loads(out)['ok']['outputs']
    if len(outputs) != 1:
        raise RuntimeError(f'expected one nested output: {out!r}')
    return tuple(outputs[0]['logical_size'])


log = LOG / 'layer.log'
W, H = output_size()
LONG, SHORT, GAP = 400, 64, 4
# (outside region, inside region) per step, in output coordinates.
mid_x, mid_y = W // 2, H // 2
points = [
    ((mid_x - LONG // 2 + 20, H - GAP - SHORT // 2), (mid_x, H - GAP - SHORT // 2)),
    ((GAP + SHORT // 2, mid_y - LONG // 2 + 20), (GAP + SHORT // 2, mid_y)),
    ((W - GAP - SHORT // 2, mid_y - LONG // 2 + 20), (W - GAP - SHORT // 2, mid_y)),
]
with log.open('w') as out, open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
    process = subprocess.Popen([str(BIN)], stdout=out, stderr=out, env={**os.environ, 'WAYLAND_DEBUG': 'client'})
    try:
        for step, (outside, inside) in enumerate(points):
            wait(log, f'READY step={step}', process)
            time.sleep(.2)  # the region rides the next root commit
            pipe.write(f'click {outside[0]} {outside[1]}\n')
            barrier = LOG / f'outside-{step}.delivered'
            pipe.write(f'barrier {barrier}\n')
            end = time.monotonic() + 8
            while not barrier.exists() and time.monotonic() < end:
                time.sleep(.01)
            assert barrier.exists(), 'input barrier timed out'
            time.sleep(.1)
            assert f'BUTTON step={step}' not in log.read_text(), f'click outside the input region arrived (step {step})'
            pipe.write(f'click {inside[0]} {inside[1]}\n')
            wait(log, f'BUTTON step={step}', process)
        process.wait(timeout=8)
        text = log.read_text()
        assert process.returncode == 0 and 'DONE' in text, 'probe did not finish'
        made = re.findall(r'zwlr_layer_shell_v1@\d+\.get_layer_surface\(zwlr_layer_surface_v1@(\d+), wl_surface@(\d+)', text)
        assert len(made) == 1, f'expected exactly one layer surface, got {made}'
        layer_id, surface_id = made[0]
        anchors = re.findall(rf'zwlr_layer_surface_v1@{layer_id}\.set_anchor\((\d+)\)', text)
        assert anchors == ['2', '4', '8'], f'anchors on the same layer surface: {anchors}'
        destroyed = text.find(f'wl_surface@{surface_id}.destroy(')
        assert destroyed == -1 or destroyed > text.index('DONE'), 'root surface destroyed before the end'
        configured = re.findall(rf'zwlr_layer_surface_v1@{layer_id}\.configure, \(\d+, (\d+), (\d+)\)', text)
        sizes = [(int(a), int(b)) for a, b in configured]
        for expected in [(LONG, SHORT), (SHORT, LONG)]:
            assert expected in sizes, f'no configure with {expected}: {sizes}'
        result = {'output': [W, H], 'layer_surface': int(layer_id), 'wl_surface': int(surface_id),
                  'anchors': anchors, 'configured': sizes, 'outside_region_clicks_blocked': 3}
        (LOG / 'oracles.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
