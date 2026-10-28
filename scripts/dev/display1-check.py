#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Display1 private-bus integration. Run only against an isolated compositor.

The shell runner provides a fresh bus, runtime, config and headless host. This
checks real transport and recovery on winit, not DRM, multi-output scanout or lid
hardware acceptance. Geometry and profile multi-output cases live in unit tests.
"""
import json
import os
from pathlib import Path
import time
import sys
import socket
import xml.etree.ElementTree as ET
from gi.repository import Gio, GLib

NAME = 'org.nidara.Display'
PATH = '/org/nidara/Display'
IFACE = 'org.nidara.Display1'


def connection():
    return Gio.DBusConnection.new_for_address_sync(
        os.environ['DBUS_SESSION_BUS_ADDRESS'],
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)


def call(conn, method, args=None, iface=IFACE):
    return conn.call_sync(NAME, PATH, iface, method, args, None,
                          Gio.DBusCallFlags.NONE, 10000, None).unpack()


c = connection()
for _ in range(100):
    try:
        state = call(c, 'GetState')
        if state[3] and state[4][1]:
            break
    except GLib.Error:
        pass
    time.sleep(.05)
else:
    raise AssertionError('Display1 did not start')

mapping = call(c, 'GetHardwareState')
assert mapping[0] == state[0]
assert {o[0] for o in mapping[2]} == {o[0] for o in state[3]}
assert all(not o[3] and not o[4] and o[7] for o in mapping[2]), 'nested output invented physical mapping'

xml = call(c, 'Introspect', iface='org.freedesktop.DBus.Introspectable')[0]
node = ET.fromstring(xml).find(f"interface[@name='{IFACE}']")
assert node is not None
assert node.find("signal[@name='Changed']") is not None
preview_sig = '(' + ''.join(a.get('type') for a in node.find("method[@name='Preview']").findall('arg') if a.get('direction') == 'in') + ')'


def snapshot(conn=c):
    return call(conn, 'GetState')


def error(method, args, expected, conn=c):
    try:
        call(conn, method, args)
    except GLib.Error as e:
        assert expected in str(e), str(e)
    else:
        raise AssertionError(f'{method} accepted an invalid request')


def preview(scale, conn=c):
    s = snapshot(conn)
    primary, settings, mirrors = s[4]
    settings = [list(row) for row in settings]
    settings[0][3] = scale
    layout = (primary, [tuple(row) for row in settings], mirrors)
    return call(conn, 'Preview', GLib.Variant(preview_sig, (s[0], s[1], layout)))


def until(predicate, message, seconds=4):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.05)
    raise AssertionError(message)


def scale():
    return snapshot()[3][0][13]


def check(message):
    print('ok:', message, flush=True)

if '--restart' in sys.argv:
    until(lambda: abs(scale()-1.25)<.001 and snapshot()[5][0]=='', 'restart did not recover last confirmed profile')
    check('restart restores confirmed profile and does not replay unconfirmed preview')
    sys.exit(0)

# Wait for the asynchronous profile load to finish by retrying only Busy.
for _ in range(50):
    try:
        pending = preview(1.25)
        break
    except GLib.Error as e:
        if 'Busy' not in str(e) and 'StaleState' not in str(e):
            raise
        time.sleep(.05)
else:
    raise AssertionError('profiles did not become ready')
assert pending[1] == 'confirming' and pending[2] > 0
assert abs(scale() - 1.25) < .001
check('preview returns only after a successfully submitted frame')
other = connection()
error('Confirm', GLib.Variant('(s)', (pending[0],)), 'PermissionDenied', other)
error('Cancel', GLib.Variant('(s)', (pending[0],)), 'PermissionDenied', other)
check('another unique sender cannot confirm or cancel')
error('Preview', GLib.Variant(preview_sig, (state[0], state[1], state[4])), 'StaleState')
check('stale revision refused')
call(c, 'Cancel', GLib.Variant('(s)', (pending[0],)))
until(lambda: abs(scale() - 1) < .001, 'cancel did not restore scale')
error('Confirm', GLib.Variant('(s)', (pending[0],)), 'Expired')
check('cancel restores previous layout and invalidates token')

s = snapshot()
layout = list(s[4])
rows = [list(row) for row in layout[1]]
rows[0][1] = False
layout[1] = [tuple(row) for row in rows]
error('Preview', GLib.Variant(preview_sig, (s[0], s[1], tuple(layout))), 'InvalidLayout')
check('last output cannot be disabled')

pending = preview(1.5, other)
other.close_sync(None)
until(lambda: abs(scale() - 1) < .001, 'sender loss did not restore scale')
check('client disconnect restores layout without Settings')

s = snapshot()
call(c, 'Identify', GLib.Variant('(tt)', (s[0], s[1])))
# Passive Identify is captured from this isolated compositor, never the live session.
paths=list(Path(os.environ['XDG_RUNTIME_DIR']).glob('nidara-hyalo.*.sock'))
assert len(paths)==1
with socket.socket(socket.AF_UNIX) as ipc:
    ipc.connect(str(paths[0]))
    ipc.sendall((json.dumps({'request':'screenshot','path':str(Path(os.environ['DISPLAY1_OUT'])/'identify.png')})+'\n').encode())
    reply=ipc.makefile().readline()
    assert 'error' not in json.loads(reply), reply

error('SetLidState', GLib.Variant('(ttb)', (1, 1, True)), 'PermissionDenied')
c.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'RequestName', GLib.Variant('(su)', ('org.nidara.Session', 4)), None,
            Gio.DBusCallFlags.NONE, 1000, None)
call(c, 'SetLidState', GLib.Variant('(ttb)', (1, 2, False)))
error('SetLidState', GLib.Variant('(ttb)', (1, 1, False)), 'StaleState')
check('Identify transport and lid policy owner/sequence authorization')

pending = preview(1.25)
# Unconfirmed previews must not reach the profile file.
profile = Path(os.environ['DISPLAY1_PROFILES'])
assert not profile.exists()
profile.mkdir()
error('Confirm', GLib.Variant('(s)', (pending[0],)), 'PersistenceFailed')
assert snapshot()[5][0] == pending[0]
profile.rmdir()
check('failed durable save keeps recovery armed and permits confirmation retry')
call(c, 'Confirm', GLib.Variant('(s)', (pending[0],)))
body = json.loads(profile.read_text())
assert body['version'] == 1 and len(body['sets']) == 1
assert pending[0] not in profile.read_text()
assert snapshot()[5][0] == ''
check('confirmation durably saves a profile without the preview token')

pending = preview(1.5)
until(lambda: snapshot()[5][0] == '', '15-second preview did not expire', seconds=18)
assert abs(scale() - 1.25) < .001
check('compositor timeout restores last confirmed layout')
print('Display1 private-bus checks passed', flush=True)
