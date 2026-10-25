#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Shared private-compositor helpers for the #832/#835 prerequisite probes.

This is deliberately not the complete phase-0 matrix. A failed prerequisite is
reported as a failure; subsequent requirements remain explicitly NOT RUN.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from types import SimpleNamespace
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

ROOT = Path(__file__).resolve().parents[2]
BIN = os.environ.get('NK_PHASE0_BIN', str(ROOT / 'toolkit/target/release/nk-phase0'))
MSG = [os.environ.get('HYALO_BIN', str(ROOT / 'hyalo/target/release/nidara-hyalo')), 'msg']


def wait(predicate, label, seconds=8):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = predicate()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError(label)


class Probe:
    def __init__(self, name):
        # Both the live desktop's bus and compositor must stay out of this test.
        if os.environ.get('NK_PHASE0_TEST') != 'vkms':
            run = Path(os.environ['NK_PHASE0_RUN']).resolve()
            runtime = Path(os.environ['XDG_RUNTIME_DIR']).resolve()
            assert runtime == run / 'runtime', 'use toolkit/phase0/check-headless.sh'
        else:
            assert os.environ['XDG_RUNTIME_DIR'] == '/run/hyalo-smoke', 'private CI runtime required'
        self.pipe = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)
        self.log = Path(os.environ['NK_PHASE0_LOG']).resolve() / name
        self.log.mkdir(parents=True, exist_ok=True)
        self.procs = []
        self.streams = []
        self.rows = []
        self.bus = None
        self.restore_numlock = False
        self.original_workspace = next(w['id'] for w in self.msg('workspaces')['workspaces'] if w['focused'])
        self.msg('do', 'workspace', 96)
        self.msg('do', 'set-workspace-mode', 96, 'floating')
        for key, directory in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                               ('XDG_CACHE_HOME', 'cache'), ('XDG_STATE_HOME', 'state')]:
            path = self.log / directory
            path.mkdir(exist_ok=True)
            os.environ[key] = str(path)
        os.environ['LC_ALL'] = 'C.UTF-8'
        # Config stays private, and no activation delegates writes to live dconf.
        os.environ['GSETTINGS_BACKEND'] = 'keyfile'
        self.environment = {
            'client_sha256': hashlib.sha256(Path(BIN).read_bytes()).hexdigest(),
            'compositor_sha256': hashlib.sha256(Path(MSG[0]).read_bytes()).hexdigest(),
            'revision': subprocess.check_output(['git', '-c', 'safe.directory=*', '-C', str(ROOT),
                                                 'rev-parse', 'HEAD'], text=True).strip(),
            'package_overlay': Path(os.environ['NK_PREFLIGHT_PACKAGE_MANIFEST']).read_text() if os.environ.get('NK_PREFLIGHT_PACKAGE_MANIFEST') else None,
            'atspi': subprocess.check_output(['pkg-config', '--modversion', 'atspi-2'], text=True).strip(),
        }

    def msg(self, *args):
        return json.loads(subprocess.check_output([*MSG, *map(str, args)], timeout=10))['ok']

    def control(self, command, pause=None):
        if pause is None:
            pause = .4 if os.environ.get('NK_PHASE0_TEST') == 'vkms' else .15
        self.pipe.write(command + '\n')
        self.pipe.flush()
        time.sleep(pause)

    def key(self, code):
        self.control(f'key {code}')

    def chord(self, modifiers, code):
        for mod in modifiers:
            self.control(f'keydown {mod}', .03)
        self.key(code)
        for mod in reversed(modifiers):
            self.control(f'keyup {mod}', .03)

    def start(self, argv, path, env=None, **kwargs):
        stream = path.open('w')
        self.streams.append(stream)
        proc = subprocess.Popen(argv, stdout=stream, stderr=subprocess.STDOUT, env=env, **kwargs)
        self.procs.append(proc)
        return proc

    def stop(self, proc):
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    def row(self, step, passed, why='', status=None, **details):
        status = status or ('PASS' if passed else 'FAIL')
        self.rows.append(dict(step=step, status=status, why=why, **details))
        print(f'{status} {step}: {why}', flush=True)

    def save(self, pending, complete=False):
        report = dict(environment=self.environment, rows=self.rows,
                      not_run=pending, complete_matrix=complete)
        (self.log / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        lines = ['| Baseline assertion | Result | Reason |', '| --- | --- | --- |']
        for row in self.rows:
            reason = row['why'].replace('|', '\\|').replace('\n', ' ')
            lines.append(f"| {row['step']} | {row['status']} | {reason} |")
        lines += ['', 'Requirements still pending:', '']
        lines += ['- ' + step for step in pending]
        for step in pending:
            print('PENDING: ' + step, flush=True)
        summary = '\n'.join(lines) + '\n'
        (self.log / 'summary.md').write_text(summary)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
                stream.write(summary)

    def close(self):
        if self.restore_numlock:
            self.key(69)  # restore the private compositor's original lock state
        for proc in reversed(self.procs):
            self.stop(proc)
        for stream in self.streams:
            stream.close()
        self.msg('do', 'workspace', self.original_workspace)
        self.pipe.close()
        if self.bus:
            self.bus.close_sync(None)


def call(bus, service, path, interface, method, args=None):
    return bus.call_sync(service, path, interface, method, args, None,
                         Gio.DBusCallFlags.NONE, 5000, None).unpack()


def start_reader(p):
    """Real Orca on a private speech server and accessibility registry, its typing echo on and
    Num Lock observed off through its own log. The bus and the lock's state live on the probe,
    which closes and restores them."""
    debug = p.log / 'orca-debug.log'
    # An explicit guard prevents accidentally giving dummy a real sound device.
    assert re.search(r'^default_driver\s*=\s*null\s*$', Path('/etc/libao.conf').read_text(), re.M), \
        'configure libao default_driver=null inside a disposable test container'
    p.environment['packages'] = subprocess.run(
        ['pacman', '-Q', 'orca', 'speech-dispatcher', 'libao'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.strip()
    # Orca 51 moved its preferences to relocatable GSettings schemas.
    # Fail if the schema changes, rather than silently disabling typing echo.
    for key in ['character-echo', 'word-echo']:
        subprocess.run(['gsettings', 'set',
                        'org.gnome.Orca.TypingEcho:/org/gnome/orca/default/typing-echo/',
                        key, 'true'], check=True, timeout=5)
    sd = p.log / 'speech'
    sd.mkdir(exist_ok=True)
    assert len(str(sd / 'socket').encode()) < 108, 'NK_PHASE0_LOG too long for a Unix speech socket'
    (sd / 'speechd.conf').write_text(
        f'LogLevel 5\nLogDir "{sd}"\nAudioOutputMethod "libao"\n'
        'AddModule "dummy" "sd_dummy"\nDefaultModule dummy\n')
    os.environ['SPEECHD_ADDRESS'] = 'unix_socket:' + str(sd / 'socket')
    speechd = p.start(['speech-dispatcher', '-s', '-C', str(sd), '-S', str(sd / 'socket'),
                       '-P', str(sd / 'pid'), '-t', '0'], p.log / 'speechd.log')
    wait(lambda: speechd.poll() is not None or (sd / 'socket').exists(), 'speech dispatcher socket')
    assert speechd.poll() is None, 'speech dispatcher exited'
    session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    address = call(session, 'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress')[0]
    os.environ['AT_SPI_BUS_ADDRESS'] = address
    registry = next(path for path in ['/usr/lib/at-spi2-registryd', '/usr/libexec/at-spi2-registryd'] if Path(path).exists())
    p.start([registry], p.log / 'registry.log')
    bus = p.bus = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
    wait(lambda: call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                      'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)))[0], 'private registry')
    call(session, 'org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
         GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))))
    names = {label: call(conn, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                          'org.freedesktop.DBus', 'ListNames')[0]
             for label, conn in [('session', session), ('accessibility', bus)]}
    (p.log / 'bus-names.json').write_text(json.dumps(names, indent=2))
    # Let libatspi select its normal Wayland backend; never force its legacy
    # registry backend, synthesize monitor events, or inject into Orca.
    device = Atspi.Device.new_full('org.nidara.ToolkitPreflight')
    refused = False
    try:
        call(session, 'org.freedesktop.a11y.Manager', '/org/freedesktop/a11y/Manager',
             'org.freedesktop.a11y.KeyboardMonitor', 'WatchKeyboard')
    except GLib.Error as error:
        refused = 'org.freedesktop.DBus.Error.AccessDenied' in str(error)
    caps = device.get_capabilities()
    p.environment['device_capabilities'] = int(caps)
    key_events = []
    device.connect('key-pressed', lambda *args: key_events.append(str(args)))
    orca = p.start(['orca', '--debug-file', str(debug)], p.log / 'orca.log')
    wait(lambda: debug.exists() and 'SPEECH OUTPUT:' in debug.read_text(), 'Orca speech startup', 15)
    time.sleep(.5)
    assert orca.poll() is None, 'Orca exited'
    # Prove that the speech server connection works before testing silence.
    server_log = sd / 'speech-dispatcher.log'
    wait(lambda: server_log.exists() and 'SET self CLIENT_NAME' in server_log.read_text(), 'Orca speech-dispatcher connection')
    # The shared vkms settings check enables Num Lock. Observe the actual
    # lock modifier through Orca before the app exists; KP_8 would insert text
    # instead of invoking KP_Up. No synthetic AT-SPI events or speech retry.
    setup_start = debug.stat().st_size

    def numlock_state():
        before = debug.stat().st_size
        p.key(42)  # harmless Shift_L press/release, through the real seat

        def observed():
            delta = debug.read_bytes()[before:].decode(errors='replace')
            events = re.findall(
                r"KEYBOARD_EVENT:  type=ATSPI_KEY_RELEASED_EVENT\s+"
                r"id=\d+\s+hw_code=50\s+modifiers=(\d+)", delta)
            return events[-1] if events else None

        modifiers = int(wait(observed, 'Orca Shift release modifiers'))
        return bool(modifiers & (1 << Atspi.ModifierType.NUMLOCK))

    restore_numlock = p.restore_numlock = numlock_state()
    if restore_numlock:
        p.key(69)  # Num_Lock, only if its observed state was on
    normalized = numlock_state()
    p.environment['numlock'] = dict(initial=restore_numlock, normalized=normalized)
    (p.log / 'numlock-setup.log').write_bytes(debug.read_bytes()[setup_start:])
    assert not normalized, 'Num Lock must be off for real Orca KP_Up flat review'
    # The device is returned so it lives: dropped, its key-pressed handler goes with it and an
    # empty key_events would prove nothing.
    return SimpleNamespace(debug=debug, orca=orca, speechd=speechd, refused=refused,
                           device=device, key_events=key_events, caps=caps)


def start_ime(p, engine, label, log, env):
    """Real fcitx5, fresh profile and classicui theme shared by both IME matrices."""
    config = p.log / 'config' / label / 'fcitx5'
    config.mkdir(parents=True, exist_ok=True)
    (config / 'profile').write_text(
        '[Groups/0]\nName=Default\nDefault Layout=us\nDefaultIM=' + engine +
        '\n\n[Groups/0/Items/0]\nName=keyboard-us\nLayout=\n\n[Groups/0/Items/1]\nName=' + engine +
        '\nLayout=\n\n[GroupOrder]\n0=Default\n')
    (config / 'config').write_text('[Behavior]\nActiveByDefault=True\n')
    conf = config / 'conf'
    conf.mkdir(exist_ok=True)
    (conf / 'classicui.conf').write_text('Theme=preflight\nUseDarkTheme=False\nUseAccentColor=False\n')
    theme = p.log / 'data/fcitx5/themes/preflight'
    theme.mkdir(parents=True, exist_ok=True)
    (theme / 'theme.conf').write_text(
        '[Metadata]\nName=Preflight diagnostic\nVersion=1\n'
        '[InputPanel]\nNormalColor=#000000\nHighlightColor=#ffffff\n'
        '[InputPanel/TextMargin]\nLeft=5\nRight=5\nTop=5\nBottom=5\n'
        '[InputPanel/Background]\nColor=#ffffff\n'
        '[InputPanel/Highlight]\nColor=#0080ff\n')
    ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin',
                   '--verbose=key_trace=5'], log, env | {'XDG_CONFIG_HOME': str(config.parent)})
    wait(lambda: b'true' in subprocess.check_output(
        ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus',
         '--object-path', '/org/freedesktop/DBus', '--method',
         'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5'], timeout=2), 'fcitx5 controller')
    return ime
