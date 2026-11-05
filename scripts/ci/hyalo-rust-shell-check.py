#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Rust-session checks INSIDE the disposable Hyalo smoke, never a live desktop."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from gi.repository import Gio, GLib

IPC = os.environ.get('NIDARA_IPC_BIN', '/usr/bin/nidara-ipc')
BUS = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(name, path, interface, method, args=None, bus=BUS):
    return bus.call_sync(name, path, interface, method, args, None,
                         Gio.DBusCallFlags.NO_AUTO_START, 2000, None).unpack()


def until(label, read, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        try:
            result = read()
            if result:
                return result
        except (GLib.Error, subprocess.SubprocessError, ValueError, StopIteration):
            pass
        if time.monotonic() >= deadline:
            raise AssertionError('timeout: ' + label)
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(.1)


def ipc(*args):
    return subprocess.check_output([IPC, *args], text=True, timeout=3)


def msg(*args, timeout=3):
    return json.loads(subprocess.check_output(
        ['nidara-hyalo', 'msg', *args], text=True, timeout=timeout))['ok']


def screenshot(path):
    # llvmpipe needs ~3 s just to render the CC on vkms, before PNG encoding/IPC.
    # A capture is one bounded request, never retried. Keep state reads at 3 s.
    started = time.monotonic()
    msg('screenshot', str(path), timeout=15)
    assert Path(path).read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), 'capture did not produce a PNG'
    print(f'ok screenshot in {time.monotonic() - started:.3f}s', flush=True)


def owned_by(name, pid):
    owner = call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                 'org.freedesktop.DBus', 'GetNameOwner', GLib.Variant('(s)', (name,)))[0]
    actual = call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                  'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                  GLib.Variant('(s)', (owner,)))[0]
    assert actual == pid, f'{name} belongs to {actual}, expected {pid}'
    return True


def ready(pid, session=False):
    def probe():
        os.kill(pid, 0)  # A catalogue response is not evidence that a renderer is alive.
        owned_by('org.nidara.Session' if session else 'org.nidara.Shell', pid)
        if session:
            for service, owner in [('Config', 'Config'), ('Applications', 'Applications'),
                                   ('Network', 'Network'), ('Bluetooth', 'Bluetooth'),
                                   ('Audio', 'Session'), ('Media', 'Session'),
                                   ('Tray', 'Session'), ('Power', 'Session')]:
                xml = call('org.nidara.' + owner, '/org/nidara/' + service,
                           'org.freedesktop.DBus.Introspectable', 'Introspect')[0]
                assert 'org.nidara.' + service + '1' in xml, service
            return True
        state = json.loads(ipc('dumpState'))
        return (state.get('session') == 'rust' and state['shell']['available'] is True
                and 'surface:app-grid' in state['shell']['capabilities']
                and state['shell']['state'] is not None)
    until('sessiond ready' if session else 'Shell1 ready', probe,
          float(os.environ.get('RUST_SHELL_READY_TIMEOUT', '30')))
    print('ok native sessiond readiness' if session else 'ok native Shell1 readiness', flush=True)


def layers():
    return msg('layers')['layers']


def layer(name):
    return next(l for l in layers() if l['namespace'] == name)


def glass(l):
    g = l.get('glass', {})
    return g.get('shapes', 0) if g.get('compositor_paints') else 0


def children(node):
    node.clear_cache()
    return [n for i in range(node.get_child_count()) if (n := node.get_child_at_index(i))]


def cc():
    # Shell1 does not expose surface:cc yet; click the real bar button by its AT-SPI bounds.
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    def button():
        for app in children(Atspi.get_desktop(0)):
            for root in children(app):
                if root.get_name() == 'Bar':
                    for node in children(root):
                        if node.get_name() == 'Control Center' and node.get_role_name() == 'button':
                            return node
    node = until('Control Center button', button)
    e = node.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
    bar = layer('nidara-bar')
    x, y = bar['x'] + e.x + e.width // 2, bar['y'] + e.y + e.height // 2
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        pipe.write(f'move {x} {y}\nmove {x + 1} {y}\n')
        time.sleep(.2)
        pipe.write(f'click {x} {y}\n')


def panels():
    bar = until('bar glass', lambda: (l := layer('nidara-bar')) and glass(l) >= 3 and l)
    dock = until('dock glass', lambda: (l := layer('nidara-dock')) and glass(l) > 0 and l)
    for l in [bar, dock]:
        assert l['glass']['toned'] == glass(l), l
    assert bar['y'] == 0 and bar['height'] < msg('outputs')['outputs'][0]['logical_size'][1] / 2, bar
    cc()
    opened = until('CC glass/placement', lambda: (l := layer('nidara-bar'))
                   and l['height'] > bar['height'] and glass(l) > glass(bar) and l)
    assert any(s['kind'] == 'veil' and s['shapes'] > 1 for s in opened['glass']['scrims']), opened
    time.sleep(1)
    screenshot('/tmp/hyalo/control-center.png')
    cc()
    until('CC closed', lambda: layer('nidara-bar')['height'] == bar['height'])
    ipc('toggleAppGrid')
    apps = until('native Apps glass', lambda: (l := layer('nidara-apps')) and glass(l) > 0 and l)
    assert apps['glass']['toned'] == glass(apps), apps
    ipc('toggleAppGrid')
    until('Apps closed', lambda: not any(l['namespace'] == 'nidara-apps' for l in layers()))
    print('ok native bar/dock tones, CC glass/veil/growing surface, Apps glass and close', flush=True)


def config():
    name, path, interface = 'org.nidara.Config', '/org/nidara/Config', 'org.nidara.Config1'
    def cfg(method, args=None, bus=BUS):
        return call(name, path, interface, method, args, bus)
    epoch, rev, raw = cfg('Snapshot')
    state = json.loads(raw)
    assert epoch > 0 and state['schemaVersion'] == 1
    key = 'appearance.darkMode'
    original = state['keys'][key]['value']
    assert state['keys'][key]['available'] is True
    assert cfg('Get', GLib.Variant('(as)', ([key],)))[0][key] == original
    updates = []
    proxy = Gio.DBusProxy.new_sync(BUS, Gio.DBusProxyFlags.DO_NOT_AUTO_START, None,
                                  name, path, interface, None)
    proxy.connect('g-signal', lambda _p, _s, n, v: updates.append(v.unpack()) if n == 'Updated' else None)
    def apply(value, bus=BUS):
        return cfg('Apply', GLib.Variant('(sv)', (key, GLib.Variant('b', value))), bus)
    try:
        new_rev, canon = apply(not original)
        assert new_rev > rev and canon == (not original)
        until('Config1 Updated', lambda: any(e == epoch and r == new_rev and key in v
                                             for e, r, v in updates))
        assert apply(not original) == (new_rev, canon), 'no-op changed revision'
        ipc('setConfig', key, str(original).lower())
        assert cfg('Get', GLib.Variant('(as)', ([key],)))[0][key] == original
        try:
            cfg('Apply', GLib.Variant('(sv)', (key, GLib.Variant('s', 'invalid'))))
        except GLib.Error as e:
            assert '.Invalid' in e.message, e
        else:
            raise AssertionError('invalid typed value accepted')
        # Owning SettingsNative is NOT executable identity and grants no privilege.
        peer = Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
        call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
             'RequestName', GLib.Variant('(su)', ('org.nidara.SettingsNative', 4)), peer)
        subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-config-write', 'false'], check=True)
        time.sleep(.5)
        for bus in [BUS, peer]:
            try:
                apply(not original, bus)
            except GLib.Error as e:
                assert '.AccessDenied' in e.message, e
            else:
                raise AssertionError('config write accepted with consent off')
        peer.close_sync(None)
    finally:
        subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-config-write', 'true'], check=True)
        time.sleep(.5)
        apply(original)
    print('ok Config1 Snapshot/Get/Apply/Updated/no-op, native IPC, validation, consent and forged-name denial')


mode = sys.argv[1]
if mode == 'a11y':
    # Activation is confined to the smoke container's bus.
    addr = BUS.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress',
                         None, None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
    BUS.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
                  GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))),
                  None, Gio.DBusCallFlags.NONE, 5000, None)
    registry = next(p for p in ['/usr/lib/at-spi2-registryd', '/usr/libexec/at-spi2-registryd'] if Path(p).exists())
    with open('/tmp/hyalo/a11y-registry.log', 'w') as log:
        proc = subprocess.Popen([registry], env=dict(os.environ, AT_SPI_BUS_ADDRESS=addr),
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    Path('/tmp/hyalo/a11y-registry.pid').write_text(str(proc.pid))
    a11y = Gio.DBusConnection.new_for_address_sync(addr,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
    until('private AT-SPI registry', lambda: call('org.freedesktop.DBus', '/org/freedesktop/DBus',
          'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)), a11y)[0])
    print(addr)
elif mode in ('ready', 'session'):
    ready(int(sys.argv[2]), mode == 'session')
elif mode == 'panels':
    panels()
elif mode == 'cc':
    cc()
elif mode == 'config':
    config()
elif mode == 'placement':
    before = json.loads(sys.argv[2])
    until('bar/dock placement after real lock', lambda:
          sorted([{'namespace': l['namespace'], 'y': l['y']} for l in layers()
                  if l['namespace'] in ('nidara-bar', 'nidara-dock')], key=lambda l: l['namespace']) == before)
    assert len(before) == 2
    print('ok Rust bar/dock remain mapped at the same positions after actual lock/unlock')
else:
    raise SystemExit('unknown check: ' + mode)
