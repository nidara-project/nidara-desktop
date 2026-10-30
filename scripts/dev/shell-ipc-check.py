#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Only run from check-shell-ipc-headless.sh's private session."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time

out = Path(os.environ['SHELL_IPC_OUT'])
cli = os.environ['SHELL_IPC_BIN']
rt = Path(os.environ['XDG_RUNTIME_DIR'])

def run(*args, ok=True):
    r = subprocess.run([cli, *args], capture_output=True, text=True, timeout=20)
    if ok:
        assert r.returncode == 0, (args, r.returncode, r.stdout, r.stderr)
    else:
        assert r.returncode == 1, (args, r.returncode, r.stdout, r.stderr)
    return r

def wait_for(f):
    until = time.monotonic() + 10
    while True:
        result = f()
        if result:
            return result
        assert time.monotonic() < until, 'private service did not become ready'
        time.sleep(.025)

sock = wait_for(lambda: next(rt.glob('nidara-hyalo.*.sock'), None))
os.environ['HYALO_SOCKET'] = str(sock)
def raw(value):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(3)
        s.connect(str(sock))
        s.sendall(json.dumps(value).encode() + b'\n')
        return json.loads(s.makefile('rb').readline())

def settings(key, value):
    subprocess.run(['gsettings', 'set', 'org.nidara.ai', key, str(value).lower()], check=True)

def policy(enabled):
    # Harmless invalid target; never retry an effect after an ambiguous reply.
    wait_for(lambda: (raw({'request': 'do', 'command': 'focus-window 4294967295'}).get('code') == 'AccessDenied') != enabled)

wait_for(lambda: subprocess.run([cli, 'describeConfig'], capture_output=True).returncode == 0)
assert isinstance(json.loads(run('listActions').stdout), dict)
assert json.loads(run('listWindows').stdout) == []
assert isinstance(json.loads(run('listWorkspaces').stdout), list)
state = json.loads(run('dumpState').stdout)
assert state['shell'] == {'available': False, 'capabilities': [], 'state': None}, state
for cmd in ['toggleCC', 'focusBar', 'listApps', 'launchApp']:
    assert 'Unavailable' in run(cmd, ok=False).stderr
assert 'Unavailable' in run('settingsWallpaper', 'preview', 'fade', ok=False).stderr
settings('allow-computer-control', False)
settings('allow-config-write', True)
policy(False)
assert 'AccessDenied' in run('setConfig', 'wallpaper.transition', 'fade', ok=False).stderr
assert 'AccessDenied' in run('focusWorkspace', '2', ok=False).stderr
settings('allow-computer-control', True)
policy(True)
# A real effect: one request, then read its confirmed state.
run('focusWorkspace', '2')
assert any(w['id'] == 2 and w['active'] for w in json.loads(run('listWorkspaces').stdout))
# Config1 observes the same private GSettings backend.
wait_for(lambda: subprocess.run([cli, 'setConfig', 'wallpaper.transition', 'fade'], capture_output=True).returncode == 0)
assert json.loads(run('getConfig', 'wallpaper.transition').stdout)['value'] == 'fade'
settings('allow-config-write', False)
wait_for(lambda: 'AccessDenied' in subprocess.run([cli, 'setConfig', 'wallpaper.transition', 'fade'], capture_output=True, text=True).stderr)
settings('allow-screenshot', False)
wait_for(lambda: raw({'request': 'screenshot', 'path': str(out/'not-written.png')}).get('code') == 'AccessDenied')
assert 'AccessDenied' in run('screenshot', str(out/'denied.png'), ok=False).stderr
assert not (out/'denied.png').exists()
settings('allow-screenshot', True)
# Wait with a harmless invalid destination; an actual screenshot is made only once.
wait_for(lambda: raw({'request': 'screenshot', 'path': '/nonexistent/nidara.png'}).get('code') != 'AccessDenied')
run('screenshot', str(out/'allowed.png'))
assert (out/'allowed.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
run('disableComputerControl')
policy(False)
assert 'AccessDenied' in run('focusWorkspace', '1', ok=False).stderr
assert 'AccessDenied' in run('setConfig', 'wallpaper.transition', 'fade', ok=False).stderr
run('reloadCompositor')
print('PASS: native CLI against real private Hyalo + Config1; reads, missing renderer, no Applications1/preview, grant, workspace effect/readback, config gate, screenshot gate + PNG, unconditional revoke, reload')
