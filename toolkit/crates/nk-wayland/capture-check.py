#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private nested-Hyalo check of window capture (SHELL-SURFACES.md §5): a layer root
captures a toplevel with a known translucent, coloured pattern, then shows the limits.
Deadline expiry, a late ready and TooLarge are unit tests (capture.rs): nested Hyalo
answers at once and its output is smaller than the source limit. Not a CI job."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
PROBE = Path(os.environ['NK_WIDGETS_BIN']).resolve().with_name('capture-probe')
TARGET = PROBE.with_name('capture-target')
HYALO = os.environ['HYALO_BIN']
ids, closed = LOG / 'capture.id', LOG / 'closed'


def wait(test, label, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if test():
            return
        time.sleep(.02)
    raise RuntimeError(f'timeout: {label}')


def windows():
    out = subprocess.run([HYALO, 'msg', 'windows'], capture_output=True, text=True, timeout=5).stdout
    return json.loads(out)['ok']['windows']


# Nested Hyalo stops drawing for seconds while its Xwayland starts: start after that, so
# deadlines (2 s for tokens and captures) measure the protocol, not the start-up stall.
wait(lambda: 'Xwayland ready' in (LOG / 'hyalo.log').read_text(), 'Xwayland ready', timeout=30)
env = {**os.environ, 'NK_CAPTURE_ID': str(ids), 'NK_CLOSED': str(closed)}
tlog, plog = LOG / 'target.log', LOG / 'probe.log'
target = subprocess.Popen([str(TARGET)], stdout=tlog.open('w'), stderr=subprocess.STDOUT, env=env)
probe = subprocess.Popen([str(PROBE)], stdout=plog.open('w'), stderr=subprocess.STDOUT, env=env)
try:
    wait(lambda: 'TARGET_READY' in tlog.read_text(), 'target painted')
    wait(lambda: any(w['app_id'] == 'nk-capture-target' for w in windows()), 'target listed')
    wid = next(w['id'] for w in windows() if w['app_id'] == 'nk-capture-target')
    ids.write_text(f'{wid:x}\n')
    wait(lambda: 'BATCH_DONE' in plog.read_text(), 'batch answered')
    target.terminate()
    target.wait(timeout=5)
    wait(lambda: not any(w['app_id'] == 'nk-capture-target' for w in windows()), 'target gone')
    closed.write_text('closed\n')
    wait(lambda: 'DONE' in plog.read_text().split('BATCH_DONE')[1], 'after-close answered')
    probe.wait(timeout=5)
finally:
    for p in (target, probe):
        if p.poll() is None:
            p.terminate()
text = plog.read_text()
m = re.search(r'IMAGE (\d+)x(\d+) left=\[(\d+), (\d+), (\d+), (\d+)\] right=\[(\d+), (\d+), (\d+), (\d+)\]', text)
assert m, f'no image:\n{text}'
w, h, *px = map(int, m.groups())
left, right = px[:4], px[4:]
assert (w, h) == (64, 36), f'not fitted to 64x64 with aspect kept: {w}x{h}'
assert all(abs(a - b) <= 2 for a, b in zip(left, [200, 100, 50, 128])), f'translucent half wrong: {left}'
assert right == [10, 200, 30, 255], f'opaque half wrong: {right}'
assert text.count('BATCH_REFUSED Busy') == 1, 'nine at once did not refuse exactly one'
results = re.findall(r'BATCH_RESULT cancelled=(\w+) (\w+)', text.split('BATCH_DONE')[0])
assert len(results) == 8, f'not one answer per accepted capture: {results}'
assert results.count(('true', 'Cancelled')) == 1 and all(r[1] == 'image' for r in results if r[0] == 'false'), results
assert 'UNKNOWN Err(NotFound)' in text
after = text.split('BATCH_DONE')[1]
assert re.search(r'AFTER_CLOSE NotFound|BATCH_RESULT cancelled=false Stopped', after), f'closed window still captured:\n{after}'
assert 'UNEXPECTED' not in text
result = {'image': [w, h], 'left': left, 'right': right, 'busy_refused': 1, 'answers': len(results),
          'cancelled': 1, 'unknown': 'NotFound', 'after_close': re.search(r'(NotFound|Stopped)', after)[1]}
(LOG / 'oracles.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
