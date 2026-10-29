#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Actual Unix peer ACL, consent, side-effect refusal and connection survival."""
import json
import os
from pathlib import Path
import socket
import shutil
import sys
import subprocess
import time

out = Path(os.environ['IPC_POLICY_OUT'])
runtime = Path(os.environ['XDG_RUNTIME_DIR'])
deadline = time.monotonic() + 15
while True:
    paths = list(runtime.glob('nidara-hyalo.*.sock'))
    if paths:
        break
    if time.monotonic() > deadline:
        raise AssertionError('Hyalo did not publish its private socket')
    time.sleep(.02)
assert len(paths) == 1
s = socket.socket(socket.AF_UNIX)
s.settimeout(5)
s.connect(str(paths[0]))
stream = s.makefile('rwb', buffering=0)

def call(req):
    stream.write(json.dumps(req).encode() + b'\n')
    reply = stream.readline()
    assert reply, 'socket closed after request'
    return json.loads(reply)

def denied(reply):
    assert reply.get('code') == 'AccessDenied', reply
    assert reply['error'], reply

if '--trusted-session' in sys.argv:
    for req in [{'request': 'power_wake'},
                {'request': 'settings', 'patch': {'idle': {'screen_off': 0}}},
                {'request': 'night_light', 'temperature': None}]:
        reply = call(req)
        assert reply.get('code') != 'AccessDenied', (req, reply)
    denied(call({'request': 'do', 'command': 'focus-window 4294967295'}))
    print('PASS: registered Session can wake/configure/night-light, not control windows')
    sys.exit(0)

if '--trusted-settings' in sys.argv or '--config-denied' in sys.argv:
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    until = time.monotonic() + 5
    while True:
        try:
            bus.call_sync('org.nidara.Config', '/org/nidara/Config', 'org.nidara.Config1', 'Snapshot', None, None, 0, 1000, None)
            break
        except GLib.Error:
            assert time.monotonic() < until
            time.sleep(.02)
    if '--config-denied' in sys.argv:
        bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.nidara.SettingsNative', 0)), None, 0, 1000, None)
    try:
        bus.call_sync('org.nidara.Config', '/org/nidara/Config', 'org.nidara.Config1', 'Set', GLib.Variant('(sv)', ('appearance.darkMode', GLib.Variant('b', True))), None, 0, 2000, None)
    except GLib.Error as error:
        assert '--config-denied' in sys.argv and 'AccessDenied' in str(error), error
    else:
        assert '--trusted-settings' in sys.argv, 'unregistered caller gained SettingsNative privilege'
    print('PASS: Config1 authenticates the exact registered executable; bus-name spoofing remains denied')
    sys.exit(0)

if '--trusted-shell' in sys.argv:
    # The namespace-only fixture grants this copied executable LegacyShell.
    # These are the actual request families sent by the existing TS shell.
    for req in [
        {'request': 'do', 'command': 'focus-window 4294967295'},
        {'request': 'minimize_targets', 'output': 'nonexistent', 'namespace': 'test', 'targets': {}},
        {'request': 'reload_config'},
        {'request': 'settings', 'patch': {'idle': {'screen_off': 0}}},
        {'request': 'night_light', 'temperature': None},
        {'request': 'set_output', 'name': 'nonexistent'},
        {'request': 'screenshot', 'path': str(out / 'trusted-shell.png')},
    ]:
        reply = call(req)
        assert reply.get('code') != 'AccessDenied', (req, reply)
    denied(call({'request': 'quit'}))
    denied(call({'request': 'do', 'command': 'spawn true'}))
    config = Path('/etc/nidara/access.d/dev-0.conf')
    original = config.read_text()
    req = {'request': 'do', 'command': 'focus-window 4294967295'}
    config.write_text('legacy-shell\t1\t/work/fixture/python\n')
    denied(call(req))
    config.write_text(original)
    assert call(req).get('code') != 'AccessDenied'
    saved = config.with_suffix('.saved')
    config.rename(saved)
    denied(call(req))
    saved.rename(config)
    assert call(req).get('code') != 'AccessDenied'
    executable = Path('/work/fixture/python')
    executable.chmod(0o777)
    denied(call(req))
    executable.chmod(0o755)
    assert call(req).get('code') != 'AccessDenied'
    replacement = executable.with_suffix('.replacement')
    shutil.copyfile('/proc/self/exe', replacement)
    replacement.chmod(0o755)
    replacement.replace(executable)
    denied(call(req))  # the old running executable is now deleted; no cached privilege
    print('PASS: explicitly registered LegacyShell can send every existing TS request family with control disabled; UID mismatch, revocation, unsafe mode and executable replacement deny on the same socket; quit/spawn remain denied')
    sys.exit(0)

for req in [
    {'request': 'do', 'command': f'spawn touch {out}/unexpected-effect'},
    {'request': 'do', 'command': 'quit'},
    {'request': 'quit'},
    {'request': 'reload_config'},
    {'request': 'settings', 'patch': {'idle': {'screen_off': 15}}},
    {'request': 'screenshot', 'path': str(out / 'denied.png')},
    {'request': 'night_light', 'temperature': 4500},
    {'request': 'output_power', 'on': False},
    {'request': 'set_output', 'name': 'nonexistent'},
    {'request': 'minimize_targets', 'output': 'nonexistent', 'namespace': 'fake', 'targets': {}},
    {'request': 'debug_overlay', 'on': True},
]:
    denied(call(req))
assert not (out / 'unexpected-effect').exists()
assert not (out / 'denied.png').exists()
assert not (out / 'config/hyalo-settings.toml').exists()
assert 'ok' in call({'request': 'windows'}), 'read failed after multiple denials'

# The compositor's own CLI executable is NOT a privileged caller.
cli = subprocess.run([os.environ['IPC_POLICY_BIN'], 'msg', 'raw', json.dumps({'request': 'quit'})],
                     env={**os.environ, 'HYALO_SOCKET': str(paths[0])}, capture_output=True, text=True)
assert cli.returncode == 1, cli
assert json.loads(cli.stdout)['code'] == 'AccessDenied', cli.stdout

def control(value):
    subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-computer-control', str(value).lower()], check=True)

def wait_policy(allowed):
    # An invalid window is harmless: permission passes => actual target validation.
    until = time.monotonic() + 5
    while True:
        reply = call({'request': 'do', 'command': 'focus-window 4294967295'})
        error = reply.get('error')
        is_denied = reply.get('code') == 'AccessDenied'
        if is_denied != allowed:
            if allowed:
                assert isinstance(error, str), reply
            return
        if time.monotonic() > until:
            raise AssertionError(f'consent did not become {allowed}: {reply}')
        time.sleep(.02)

control(True)
wait_policy(True)
# General control never grants public session termination, even when enabled.
denied(call({'request': 'quit'}))
denied(call({'request': 'do', 'command': 'quit'}))
# An actual allowed effect, on this same private connection.
assert 'ok' in call({'request': 'do', 'command': f'spawn touch {out}/allowed-effect'})
until = time.monotonic() + 5
while not (out / 'allowed-effect').exists():
    assert time.monotonic() < until, 'authorized spawn did not produce its effect'
    time.sleep(.02)
# Specific gates still apply with general control enabled.
subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-config-write', 'false'], check=True)
# Observe the config gate via harmless invalid patch until the notification lands.
until = time.monotonic() + 5
while True:
    reply = call({'request': 'settings', 'patch': {'invalid_key': 0}})
    if reply.get('code') == 'AccessDenied':
        denied(reply)
        break
    assert time.monotonic() < until
    time.sleep(.02)
control(False)
wait_policy(False)
assert 'ok' in call({'request': 'workspaces'})
if Path('/nidara-access-fixture').exists():
    subprocess.run(['/work/fixture/python', __file__, '--trusted-shell'], check=True)
    subprocess.run(['/work/fixture/session', __file__, '--trusted-session'], check=True)
    with (out / 'sessiond.log').open('w') as log:
        daemon = subprocess.Popen(['/repo/session/target/debug/nidara-sessiond', '--config'], stdout=log, stderr=log)
        try:
            subprocess.run(['/usr/bin/python3', __file__, '--config-denied'], check=True)
            subprocess.run(['/work/fixture/settings', __file__, '--trusted-settings'], check=True)
        finally:
            daemon.terminate()
            try:
                daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
print('PASS: mutations denied before effects; CLI untrusted; reads survive; consent grant/revoke on same socket; config-specific gate')
