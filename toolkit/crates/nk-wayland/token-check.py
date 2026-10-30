#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private nested-Hyalo check of the activation-token producer (SHELL-SURFACES.md §4):
a token made from a real click on a layer root lets a background window come to the
front; a made-up token does not. Run via check-layer-headless.sh; not a CI job."""
import json
import os
from pathlib import Path
import subprocess
import time

LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
PROBE = Path(os.environ['NK_WIDGETS_BIN']).resolve()
TARGET = PROBE.with_name('token-target')
HYALO = os.environ['HYALO_BIN']
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('private check-headless.sh runtime required')


def msg(*args):
    return json.loads(subprocess.run([HYALO, 'msg', *args], capture_output=True, text=True, timeout=5).stdout)['ok']


# Generous: nested Xwayland's start stalls software Hyalo for several seconds.
def wait(test, label, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if test():
            return
        time.sleep(.02)
    raise RuntimeError(f'timeout: {label}')


def focused():
    return [w['app_id'] for w in msg('windows')['windows'] if w.get('focused')]


def scenario(name, real):
    token_file = LOG / f'{name}.token'
    logs = {k: (LOG / f'{name}-{k}.log') for k in ('target', 'other', 'dock')}
    env = {**os.environ, 'NK_TOKEN_FILE': str(token_file)}
    procs = []
    try:
        with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
            procs.append(subprocess.Popen([str(TARGET), 'nk-token-target'], stdout=logs['target'].open('w'), stderr=subprocess.STDOUT, env=env))
            wait(lambda: 'TARGET_READY' in logs['target'].read_text(), 'target mapped')
            procs.append(subprocess.Popen([str(TARGET), 'nk-token-other'], stdout=logs['other'].open('w'), stderr=subprocess.STDOUT, env=env))
            wait(lambda: 'TARGET_READY' in logs['other'].read_text(), 'other mapped')
            wait(lambda: focused() == ['nk-token-other'], 'other window took focus')
            if real:
                procs.append(subprocess.Popen([str(PROBE), '--token'], stdout=logs['dock'].open('w'), stderr=subprocess.STDOUT, env=env))
                wait(lambda: 'READY step=0' in logs['dock'].read_text(), 'dock ready')
                time.sleep(.2)
                W, H = msg('outputs')['outputs'][0]['logical_size']
                pipe.write(f'click {W // 2} {H - 4 - 32}\n')
                wait(lambda: 'TOKEN_DONE' in logs['dock'].read_text(), 'token made')
                dock = logs['dock'].read_text()
                assert 'TOKEN_UNDELIVERED Err(UndeliveredSerial)' in dock, 'undelivered serial was not refused'
                assert 'ActivationToken(<private>)' in dock, 'token not private in Debug'
            else:
                token_file.write_text('not-a-token-from-hyalo')
            wait(lambda: 'ACTIVATE' in logs['target'].read_text(), 'target consumed the token')
            if real:
                # Wait for the outcome, not a guess at how long Hyalo takes.
                try:
                    wait(lambda: focused() == ['nk-token-target'], 'target focused', timeout=5)
                except RuntimeError:
                    pass
            else:
                # A refusal has no event to wait for: give it the same time to go wrong.
                time.sleep(2)
            return focused()
    finally:
        for p in procs:
            p.terminate()
            p.wait(timeout=5)


# Nested Hyalo stops drawing for seconds while its Xwayland starts: start after that, so
# deadlines (2 s for tokens and captures) measure the protocol, not the start-up stall.
wait(lambda: 'Xwayland ready' in (LOG / 'hyalo.log').read_text(), 'Xwayland ready', timeout=30)
real = scenario('real', True)
assert real == ['nk-token-target'], f'real token did not bring the target forward: {real}'
fake = scenario('fake', False)
assert fake == ['nk-token-other'], f'a made-up token changed focus: {fake}'
result = {'real_token_focused': real, 'made_up_token_focused': fake, 'undelivered_serial_refused': True}
(LOG / 'oracles.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
