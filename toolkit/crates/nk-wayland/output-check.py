#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private nested-Hyalo check of SHELL-SURFACES.md §2: a layer root on the watcher's
output, ended from another thread by its Waker; an absent output id is refused.
Same-number re-add, hotplug and watcher loss are unit tests (outputs.rs): nested Hyalo
has one output and refuses to disable it. Not a CI job."""
import json
import os
from pathlib import Path
import re
import subprocess

LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
PROBE = Path(os.environ['NK_WIDGETS_BIN']).resolve().with_name('output-probe')
log = LOG / 'output.log'
with log.open('w') as out:
    rc = subprocess.run([str(PROBE)], stdout=out, stderr=out, timeout=30).returncode
text = log.read_text()
assert rc == 0, f'probe failed ({rc}):\n{text}'
first = re.search(r'ADDED id=(\d+) name=(\S+) logical=Some\(\[0, 0, (\d+), (\d+)\]\)', text)
assert first, 'the watcher reported no complete output'
assert f'DOCK_READY id={first[1]}' in text, 'no layer root on the reported output'
assert re.search(r'WOKE\n(.*\n)*WAKE_ENDED Ok\(\(\)\)', text), 'the Waker did not end the root cleanly'
assert 'WAKE_AFTER_END true' in text, 'waking an ended loop did not fail'
assert 'ABSENT_REFUSED' in text, 'an absent output id was not refused with OUTPUT_GONE'
result = {'output': first[2], 'id': int(first[1]), 'logical': [int(first[3]), int(first[4])],
          'wake_ended_cleanly': True, 'absent_refused': True}
(LOG / 'oracles.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
