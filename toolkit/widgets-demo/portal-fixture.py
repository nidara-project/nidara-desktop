#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Only for the private local headless demo check, never installed or CI evidence."""
import os
from pathlib import Path
import subprocess
import sys
import threading
from gi.repository import Gio, GLib

if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise SystemExit('private widget runtime required')
XML = '''<node><interface name="org.freedesktop.portal.Settings">
<method name="ReadAll"><arg direction="in" type="as"/><arg direction="out" type="a{sa{sv}}"/></method>
<signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal>
</interface></node>'''
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
if bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
                 GLib.Variant('(s)', ('org.freedesktop.portal.Desktop',)), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]:
    raise SystemExit('refusing an existing portal owner')


def call(connection, sender, path, interface, method, params, invocation):
    invocation.return_value(GLib.Variant('(a{sa{sv}})', ({
        'org.freedesktop.appearance': {'accent-color': GLib.Variant('(ddd)', (0., 136/255, 1.)),
                                     'color-scheme': GLib.Variant('u', 1), 'reduced-motion': GLib.Variant('u', 2)},
        'org.nidara.appearance': {'reduce-transparency': GLib.Variant('b', False),
                                  'window-background': GLib.Variant('s', 'opaque')},
        'org.gnome.desktop.interface': {'font-name': GLib.Variant('s', 'Noto Sans 11'),
                                        'text-scaling-factor': GLib.Variant('d', 1.)}},)))


bus.register_object('/org/freedesktop/portal/desktop', Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], call, None, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
              GLib.Variant('(su)', ('org.freedesktop.portal.Desktop', 4)), None, Gio.DBusCallFlags.NONE, 3000, None)
loop = GLib.MainLoop()
result = [1]


def run():
    result[0] = subprocess.call(sys.argv[sys.argv.index('--')+1:])
    GLib.idle_add(loop.quit)


threading.Thread(target=run, daemon=True).start()
loop.run()
sys.exit(result[0])
