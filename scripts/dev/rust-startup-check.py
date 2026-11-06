#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""#1017: factory startup and all default services, without the owner's buses/session."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from gi.repository import Gio, GLib

repo = Path(__file__).resolve().parents[2]
binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix='nidara-rust-startup-') as tmp:
    root = Path(tmp)
    env = os.environ.copy()
    for name in ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
                 'PIPEWIRE_RUNTIME_DIR', 'PULSE_RUNTIME_PATH']:
        env[name] = str(root / name)
        Path(env[name]).mkdir(mode=0o700)
    env.update(GSETTINGS_BACKEND='memory', HYALO_SOCKET=str(root / 'no-hyalo'),
               XDG_DATA_DIRS=str(root / 'no-apps'), GIO_USE_VFS='local',
               GIO_USE_VOLUME_MONITOR='unix')
    buses = []
    daemon = None
    try:
        # No service directories: private buses must not activate installed helpers.
        config = root / 'bus.conf'
        config.write_text('<busconfig><type>session</type><auth>EXTERNAL</auth>'
                          '<listen>unix:tmpdir=' + tmp + '</listen>'
                          '<policy context="default"><allow own="*"/>'
                          '<allow send_destination="*"/><allow receive_sender="*"/>'
                          '</policy></busconfig>')
        for name in ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS']:
            bus = subprocess.Popen(['dbus-daemon', '--config-file=' + str(config), '--nofork', '--print-address=1'],
                                   stdout=subprocess.PIPE, text=True, env=env)
            buses.append(bus)
            env[name] = bus.stdout.readline().strip()
            assert env[name], 'private bus address'
        conn = Gio.DBusConnection.new_for_address_sync(env['DBUS_SESSION_BUS_ADDRESS'],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
        def call(name, path, interface, method, args=None):
            return conn.call_sync(name, path, interface, method, args, None,
                                  Gio.DBusCallFlags.NO_AUTO_START, 2000, None).unpack()
        with (root / 'daemon.log').open('w+') as log:
            daemon = subprocess.Popen([binary], env=env, stdout=log, stderr=log)
            deadline = time.monotonic() + 20
            try:
                while not call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                               'org.freedesktop.DBus', 'NameHasOwner',
                               GLib.Variant('(s)', ('org.nidara.Session',)))[0]:
                    assert daemon.poll() is None, 'default daemon exited'
                    assert time.monotonic() < deadline, 'default daemon readiness'
                    time.sleep(.025)
                # Once systemd readiness is announced, every selected interface must exist.
                for service, owner in [('Config', 'Config'), ('Applications', 'Applications'),
                                       ('Network', 'Network'), ('Bluetooth', 'Bluetooth'),
                                       ('Audio', 'Session'), ('Media', 'Session'),
                                       ('Tray', 'Session'), ('Power', 'Session')]:
                    xml = call('org.nidara.' + owner, '/org/nidara/' + service,
                               'org.freedesktop.DBus.Introspectable', 'Introspect')[0]
                    assert 'org.nidara.' + service + '1' in xml, service
                assert call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                            'org.freedesktop.DBus', 'NameHasOwner',
                            GLib.Variant('(s)', ('org.freedesktop.Notifications',)))[0]
            except Exception:
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
        daemon.terminate()
        assert daemon.wait(timeout=5) == 0
        daemon = None
        # Execute the actual launcher with a command stub: never call the host systemctl.
        stub = root / 'systemctl'
        stub.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$STARTUP_CALLS"\n')
        stub.chmod(0o755)
        env['PATH'] = str(root) + ':' + env['PATH']
        env['STARTUP_CALLS'] = str(root / 'calls')
        subprocess.run(['sh', str(repo / 'hyalo/session/start-shell')], env=env, check=True)
        assert (root / 'calls').read_text().splitlines() == [
            '--user', 'start', 'nidara-rust-shell.service']
        unit = (repo / 'bin/nidara-rust-shell.service').read_text()
        assert 'ExecStart=/usr/bin/nidara-shell --bar' in unit
        assert 'Requires=nidara-sessiond.service' in unit
        assert 'After=graphical-session.target nidara-sessiond.service' in unit
        assert 'Conflicts=nidara.service nidara-dock.service' in unit
        legacy = (repo / 'bin/nidara-sessiond-legacy.service').read_text()
        assert 'ExecStart=/usr/bin/nidara-sessiond --media --power' in legacy
        assert 'Conflicts=nidara-sessiond.service' in legacy
        assert 'nidara-sessiond-legacy.service' in (repo / 'bin/nidara.service').read_text()
        print('PASS: all default interfaces ready; launcher starts one Rust unit, no TS/dock; legacy boot remains limited')
    finally:
        if daemon is not None:
            daemon.terminate()
            daemon.wait(timeout=5)
        for bus in buses:
            bus.terminate()
            bus.wait(timeout=5)
