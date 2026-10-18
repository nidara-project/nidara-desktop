#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Development fixture on a PRIVATE dbus-run-session bus, never live evidence.

  dbus-run-session -- python toolkit/settings-slice/fixture.py -- CHECK COMMAND...
Implements only the slice's read contract. Does not touch the shell or preferences.
"""
import json
import os
import subprocess
import sys
import threading
from gi.repository import Gio, GLib

if os.environ.get('DBUS_SESSION_BUS_ADDRESS') == os.environ.get('DBUS_STARTER_ADDRESS'):
    raise SystemExit('Run this fixture under dbus-run-session on a private bus')

CONFIG = '''<node><interface name="org.nidara.Config1">
<method name="Snapshot"><arg direction="out" type="t"/><arg direction="out" type="t"/><arg direction="out" type="s"/></method>
<method name="Get"><arg direction="in" type="as"/><arg direction="out" type="a{sv}"/></method>
<signal name="Updated"><arg type="t"/><arg type="t"/><arg type="a{sv}"/></signal>
</interface></node>'''
PORTAL = '''<node><interface name="org.freedesktop.portal.Settings">
<method name="ReadAll"><arg direction="in" type="as"/><arg direction="out" type="a{sa{sv}}"/></method>
<signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal>
</interface></node>'''
values = {'appearance.darkMode': True, 'appearance.windowTransparency': False,
          'appearance.windowBlur': False, 'appearance.windowControls': 'left',
          'appearance.interfaceFont': 'Noto Sans 11', 'appearance.interfaceIconTheme': 'nidara',
          'accessibility.reduceTransparency': False}
titles = ['Dark mode', 'Window transparency', 'Window blur', 'Window controls']
keys = list(values)
schema = {'schemaVersion': 1, 'keys': {k: {'value': v, 'available': True} for k, v in values.items()}}
for key, title in zip(keys, titles):
    schema['keys'][key]['ui'] = {'title': title, 'subtitle': 'Development fixture: authoritative test value',
                               'control': 'toggle' if isinstance(values[key], bool) else 'segmented'}
schema['keys']['appearance.windowControls']['ui']['options'] = [
    {'value': 'left', 'label': 'Left'}, {'value': 'right', 'label': 'Right'}]

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
# Refuse an existing owner: this guard also makes an accidental live-bus invocation
# harmless. The portal's existing owner is checked before claiming EITHER name.
for name in ('org.nidara.Config', 'org.freedesktop.portal.Desktop'):
    exists = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', (name,)),
        None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if exists:
        raise SystemExit(f'refusing existing owner {name}; use a PRIVATE dbus-run-session')


def variant(v):
    return GLib.Variant('b' if isinstance(v, bool) else 's', v)


def call(connection, sender, path, iface, method, params, invocation):
    if method == 'Snapshot' and os.environ.get('NK_FIXTURE_STALL'):
        GLib.timeout_add(10000, lambda: (invocation.return_value(GLib.Variant('(tts)', (42, 1, json.dumps(schema)))), False)[1])
    elif method == 'Snapshot':
        invocation.return_value(GLib.Variant('(tts)', (42, 1, json.dumps(schema))))
    elif method == 'Get':
        invocation.return_value(GLib.Variant('(a{sv})', ({k: variant(values[k]) for k in params.unpack()[0]},)))
    else:
        invocation.return_value(GLib.Variant('(a{sa{sv}})', ({
            'org.freedesktop.appearance': {'accent-color': GLib.Variant('(ddd)', (1., 0., 0.) if os.environ.get('NK_FIXTURE_UNKNOWN_ACCENT') else (0., 136/255, 1.)),
                                          'color-scheme': GLib.Variant('u', 1)},
            'org.nidara.appearance': {'reduce-transparency': GLib.Variant('b', False),
                                      'window-transparency': GLib.Variant('b', False)}},)))


for path, xml in [('/org/nidara/Config', CONFIG), ('/org/freedesktop/portal/desktop', PORTAL)]:
    bus.register_object(path, Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], call, None, None)
for name in ('org.nidara.Config', 'org.freedesktop.portal.Desktop'):
    bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                  'RequestName', GLib.Variant('(su)', (name, 4)), None,
                  Gio.DBusCallFlags.NONE, 3000, None)
# A private session has no systemd user activation. Start its real registry
# directly; the provider still uses the real AT-SPI service and backend.
address = bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus',
    'GetAddress', None, None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
registry = subprocess.Popen(['/usr/lib/at-spi2-registryd'],
    env=dict(os.environ, AT_SPI_BUS_ADDRESS=address))
loop = GLib.MainLoop()
code = [1]
command = sys.argv[sys.argv.index('--')+1:]


def run():
    code[0] = subprocess.call(command)
    GLib.idle_add(loop.quit)


threading.Thread(target=run, daemon=True).start()
try:
    loop.run()
finally:
    registry.terminate()
    registry.wait(timeout=3)
sys.exit(code[0])
