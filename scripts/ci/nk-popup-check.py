#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private nested-Hyalo transport probe, not a widget/Orca/presentation gate."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
BIN = Path(os.environ['NK_WIDGETS_BIN']).resolve()
HYALO = Path(os.environ['HYALO_BIN']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('private check-headless.sh runtime required')
if Path('/tmp') in LOG.parents or LOG == Path('/tmp'):
    raise RuntimeError('evidence must not use /tmp')
if any(p.name not in {'cage.log', 'hyalo.log', 'check.log'} for p in LOG.iterdir()):
    raise RuntimeError('use a fresh evidence directory')
(LOG / 'environment.json').write_text(json.dumps({
    'revision': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
    'probe_sha256': hashlib.sha256(BIN.read_bytes()).hexdigest(),
    'hyalo_sha256': hashlib.sha256(HYALO.read_bytes()).hexdigest(),
}, indent=2))


def wait(test, label, process, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if test():
            return
        if process.poll() is not None:
            raise RuntimeError(f'probe exited before {label}: {process.returncode}')
        time.sleep(.01)
    raise RuntimeError(f'setup timeout: {label}')


def run(control):
    log = LOG / ('control.log' if control else 'baseline.log')
    finish = LOG / ('control.finish' if control else 'baseline.finish')
    with log.open('w') as out, open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        process = subprocess.Popen([str(BIN), *(['--toplevel-control'] if control else [])],
                                   stdout=out, stderr=out, env={**os.environ, 'WAYLAND_DEBUG': 'client', 'NK_POPUP_FINISH': str(finish)})
        try:
            wait(lambda: 'PARENT_READY' in log.read_text(), 'parent root commit', process)
            pipe.write('key 28\n')
            wait(lambda: 'CHILD_READY' in log.read_text(), 'child root commit', process)
            wait(lambda: 'REPOSITION_REQUEST' in log.read_text(), 'reposition dispatch attempted', process)
            # A common protocol-ordering barrier works for both popup and wrong-role
            # control; renderer speed is not evidence that an acknowledgement is absent.
            wait(lambda: 'REPOSITION_BARRIER' in log.read_text(), 'reposition protocol barrier', process)
            # Same input in baseline and control. Outside click dismisses the grabbing popup;
            # A diagnostic end file lets a wrong role complete setup independently too.
            pipe.write('click 0 0\n')
            delivered = log.with_suffix('.input-delivered')
            pipe.write(f'barrier {delivered}\n')
            end = time.monotonic() + 8
            while not delivered.exists() and time.monotonic() < end:
                time.sleep(.01)
            if not delivered.exists():
                raise RuntimeError('input delivery barrier timed out')
            finish.write_text('end bounded observation\n')
            process.wait(timeout=8)
            text = log.read_text()
            if process.returncode or 'PARENT_RESUMED' not in text:
                raise RuntimeError('child/parent lifecycle did not complete')
            if not re.search(r'OPEN_FROM_KEY serial=Some\(\d+\)', text):
                raise RuntimeError('no physical input serial')
            # Setup above is independent of role/expected configure/reposition results.
            assert 'get_popup(' in text, 'child used a toplevel instead of xdg_popup'
            assert re.search(r'xdg_popup[^\n]*\.grab\(', text), 'popup never requested an input grab'
            assert 'REPOSITIONED 17' in text, 'compositor did not acknowledge reposition'
            assert 'POPUP_DONE' in text, 'outside click did not dismiss the popup'
            assert 'CONFIGURE child=true size=(200, 120)' in text, 'configured popup size not applied'
            assert re.search(r'xdg_popup[^\n]*\.destroy\(', text), 'popup role was not destroyed'
            wire = re.findall(r'<- xdg_popup[^\n]*\.configure, \((-?\d+), (-?\d+), (\d+), (\d+)\)', text)
            observed = re.findall(r'POPUP_GEOMETRY child=true rect=Some\(\[(-?\d+), (-?\d+), (\d+), (\d+)\]\)', text)
            assert len(wire) >= 2 and observed == wire, 'popup geometry differs from acknowledged compositor rectangles'
            assert all(value == 'None' for value in re.findall(r'POPUP_GEOMETRY child=false rect=(.*)', text)), 'toplevel reported popup geometry'

            return {'setup_complete': True, 'role': 'xdg_popup', 'reposition_token': 17, 'popup_done': True, 'configured_geometry': observed}
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


result = {'baseline': run(False)}
try:
    run(True)
except AssertionError as error:
    if str(error) != 'child used a toplevel instead of xdg_popup':
        raise
    result['toplevel_control'] = {'setup_complete': True, 'caught': str(error)}
else:
    raise AssertionError('toplevel substitution escaped its own role assertion')
# Error recovery on the shared connection: a failed child callback must destroy
# the popup before returning control to its still-live parent.
error_log = LOG / 'child-error.log'
with error_log.open('w') as out, open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
    process = subprocess.Popen([str(BIN), '--child-error'], stdout=out, stderr=out,
                               env={**os.environ, 'WAYLAND_DEBUG': 'client'})
    try:
        wait(lambda: 'PARENT_READY' in error_log.read_text(), 'error probe parent commit', process)
        pipe.write('key 28\n')
        process.wait(timeout=8)
        text = error_log.read_text()
        if process.returncode or 'CHILD_ERROR_CAUGHT' not in text or 'PARENT_RESUMED' not in text:
            raise RuntimeError('child error did not return to parent')
        destroyed = re.search(r'xdg_popup[^\n]*\.destroy\(', text)
        assert destroyed and destroyed.start() < text.index('CHILD_ERROR_CAUGHT'), 'child popup leaked on callback error'
        result['child_error'] = {'caught': True, 'destroyed_before_return': True}
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
(LOG / 'oracles.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
