#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""PHASE1 gates 1/2 on the actual app, real Config1/effects/legacy, physical keys, real Orca.

Only a disposable vkms session is accepted. No mock provider, injected speech,
AT-SPI mutation, action retry, or live-session fallback. A fault is caught only
at its baseline assertion after its actual application marker. Setup, process
exit and missing publication are infrastructure errors, never caught controls.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import gi
from matrix import OPERATIONS, CONTROLS, KEYS, KEY
from visible import row as visible_row, contains as visible_contains

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

ROOT = Path(__file__).resolve().parents[3]
BIN = Path(os.environ.get('NK_SETTINGS_BIN', ROOT / 'toolkit/target/release/nk-settings'))
LOG = Path(os.environ.get('NK_SETTINGS_GATE_LOG', ROOT / 'toolkit/target/settings-gates')).resolve() / str(time.time_ns())
FULL = os.environ.get('NK_REAL_FULL', 'true') == 'true'
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
IPC = os.environ.get('NK_SETTINGS_IPC', '/usr/bin/nidara-ipc')

class InfrastructureError(RuntimeError):
    pass

class OracleFailure(AssertionError):
    def __init__(self, stage, observed):
        self.stage = stage
        super().__init__(f'{stage}: {observed}')


def pump():
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)
    time.sleep(.01)


def wait(test, label, seconds=8):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = test()
        if value:
            return value
        pump()
    raise InfrastructureError('setup/publication deadline: ' + label)


def command(*argv):
    return subprocess.check_output(list(map(str, argv)), text=True, timeout=10)


def call(bus, service, path, iface, member, args=None):
    return bus.call_sync(service, path, iface, member, args, None,
                         Gio.DBusCallFlags.NONE, 5000, None).unpack()


def children(node):
    node.clear_cache()
    return [c for i in range(node.get_child_count()) if (c := node.get_child_at_index(i))]


def walk(node):
    return [node] + [n for c in children(node) for n in walk(c)]


def state(node, flag):
    node.clear_cache()
    return node.get_state_set().contains(flag)


def identity(node):
    return (node.get_process_id(), node.get_attributes().get('nidara-node-id', node.get_name()))


def applications(pid=None):
    apps = children(Atspi.get_desktop(0))
    return [a for a in apps if pid is None or a.get_process_id() == pid]


def dump(node):
    def one(n):
        row = {'name': n.get_name(), 'role': n.get_role_name(), 'id': identity(n),
               'checked': state(n, Atspi.StateType.CHECKED),
               'focused': state(n, Atspi.StateType.FOCUSED)}
        try:
            row['value'] = n.get_value_iface().get_current_value()
        except (GLib.Error, AttributeError):
            pass
        return row
    return [one(n) for n in walk(node)]


def values(node):
    result = []
    for n in walk(node):
        result.append(n.get_name())
        try:
            result.append(str(n.get_value_iface().get_current_value()))
        except (GLib.Error, AttributeError):
            pass
        if state(n, Atspi.StateType.CHECKED):
            result.append('checked:' + n.get_name())
        try:
            result.append(n.get_text_iface().get_text(0, -1))
        except (GLib.Error, AttributeError):
            pass
    return ' '.join(result).lower()


def labelled(n, label):
    return any(r.get_relation_type() == Atspi.RelationType.LABELLED_BY and
               any(r.get_target(i).get_name() == label for i in range(r.get_n_targets()))
               for r in n.get_relation_set())

# Independent persistent/effect readers. Config1/getConfig are NOT their own effect oracle.
PERSISTENCE = {
    'accessibility.reduceTransparency': ('org.nidara.appearance', 'reduce-transparency'),
    'appearance.darkMode': ('org.gnome.desktop.interface', 'color-scheme'),
    'appearance.accent': ('org.gnome.desktop.interface', 'accent-color'),
    'appearance.windowBackground': ('org.nidara.appearance', 'window-background'),
    'appearance.windowControls': ('org.gnome.desktop.wm.preferences', 'button-layout'),
    'appearance.gtkTheme': ('org.gnome.desktop.interface', 'gtk-theme'),
    'appearance.iconTheme': ('org.gnome.desktop.interface', 'icon-theme'),
    'appearance.interfaceIconTheme': ('org.nidara.appearance', 'interface-icon-theme'),
    'appearance.cursorTheme': ('org.gnome.desktop.interface', 'cursor-theme'),
    'appearance.interfaceFont': ('org.gnome.desktop.interface', 'font-name'),
    'appearance.monoFont': ('org.gnome.desktop.interface', 'monospace-font-name'),
    **{'nightlight.' + suffix: ('org.nidara.night-light', setting) for suffix, setting in
       [('enabled', 'enabled'), ('temperature', 'temperature'), ('scheduleEnabled', 'schedule-enabled'),
        ('scheduleFrom', 'schedule-from'), ('scheduleTo', 'schedule-to')]},
}


def persisted(key):
    if key.startswith('wallpaper.'):
        return json.loads((Path(os.environ['XDG_CONFIG_HOME']) / 'nidara/wallpaper').read_text())[
            'path' if key.endswith('current') else 'transition']
    schema, field = PERSISTENCE[key]
    raw = Gio.Settings.new(schema).get_value(field).unpack()
    if key == 'appearance.darkMode':
        return raw == 'prefer-dark'
    if key == 'appearance.windowControls':
        return 'left' if raw.split(':')[0] else 'right'
    if key == 'appearance.interfaceIconTheme':
        return raw or 'nidara'
    if key == 'appearance.gtkTheme':
        return raw.removesuffix('-dark')
    return raw


def external(key, value):
    """An actual other writer, never Config1/Apply. Shell monitors must announce Updated."""
    if key.startswith('wallpaper.'):
        path = Path(os.environ['XDG_CONFIG_HOME']) / 'nidara/wallpaper'
        data = json.loads(path.read_text())
        data['path' if key.endswith('current') else 'transition'] = value
        pending = path.with_suffix('.gate-pending')
        pending.write_text(json.dumps(data))
        pending.replace(path)
        return
    schema, field = PERSISTENCE[key]
    settings = Gio.Settings.new(schema)
    if key == 'appearance.darkMode':
        value = 'prefer-dark' if value else 'default'
    elif key == 'appearance.windowControls':
        value = 'close,minimize,maximize:' if value == 'left' else ':minimize,maximize,close'
    elif key == 'appearance.interfaceIconTheme':
        value = '' if value == 'nidara' else value
    typ = settings.get_value(field).get_type_string()
    if not settings.set_value(field, GLib.Variant(typ, value)):
        raise InfrastructureError('external GSettings write refused: ' + key)
    Gio.Settings.sync()


class Run:
    def __init__(self, fault=None, scale=1):
        self.fault = fault
        self.target = CONTROLS.get(fault)
        self.path = LOG / ('scale' + str(scale)) / (fault or 'baseline')
        self.path.mkdir(parents=True, exist_ok=False)
        self.streams, self.procs, self.rows = [], [], []
        self.pipe = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.schema = self.snapshot()
        self.original = {k: self.schema[k]['value'] for k in KEYS | {'accessibility.reduceTransparency'}}
        self.control = self.path / 'control'
        self.control.write_text('builder' if fault == 'builder' else '')
        root = Path(os.environ.get('NK_SETTINGS_DATA', '/usr/share/nidara/settings-data'))
        self.strings = json.loads((root / 'i18n/en.json').read_text())
        self.log = self.path / 'client.log'
        self.app = None
        self.debug = self.path / 'orca-debug.log'
        self.updated = []
        self.subscription = self.bus.signal_subscribe('org.nidara.Config', 'org.nidara.Config1', 'Updated', '/org/nidara/Config',
                                  None, Gio.DBusSignalFlags.NONE,
                                  lambda _b, _s, _p, _i, _m, params: self.updated.append(params.unpack()))

    def snapshot(self):
        schema = json.loads(call(self.bus, 'org.nidara.Config', '/org/nidara/Config',
                                 'org.nidara.Config1', 'Snapshot')[2])
        return schema['keys']

    def get(self, key):
        return json.loads(command(IPC, 'getConfig', key))['value']

    def start(self, args, filename, env=None):
        stream = (self.path / filename).open('w')
        self.streams.append(stream)
        p = subprocess.Popen(list(map(str, args)), stdout=stream, stderr=subprocess.STDOUT, env=env)
        self.procs.append(p)
        return p

    def alive(self):
        if any(p.poll() is not None for p in self.procs):
            raise InfrastructureError('client/legacy/reader/speech process exited; inspect ' + str(self.path))
        return True

    def raw(self):
        self.alive()
        return self.log.read_text()

    def oracle(self, stage, predicate, detail, seconds=6):
        until = time.monotonic() + seconds
        while True:
            self.alive()
            if predicate():
                self.rows.append({'stage': stage, 'status': 'PASS'})
                return
            if time.monotonic() >= until:
                raise OracleFailure(stage, detail())
            pump()

    def key(self, key):
        self.pipe.write('key ' + str(KEY.get(key, key)) + '\n')
        self.pipe.flush()

    def chord(self, modifier, key):
        self.pipe.write('keydown ' + str(modifier) + '\n')
        self.key(key)
        self.pipe.write('keyup ' + str(modifier) + '\n')
        self.pipe.flush()

    def type_ascii(self, text):
        # evdev US layout; failures/unknown chars are explicit, never paste/SetText.
        alphabet = 'qwertyuiopasdfghjklzxcvbnm'
        codes = [16,17,18,19,20,21,22,23,24,25,30,31,32,33,34,35,36,37,38,44,45,46,47,48,49,50]
        mapping = dict(zip(alphabet, codes)) | dict(zip('1234567890', range(2,12))) | {' ':57, '/':53, '.':52, '-':12, '_':12}
        for c in text:
            if c.lower() not in mapping:
                raise InfrastructureError('unsupported test keyboard character: ' + repr(c))
            if c.isupper() or c == '_':
                self.chord(42, mapping[c.lower()])
            else:
                self.key(mapping[c.lower()])

    def native_root(self):
        app = next(iter(applications(self.app.pid)), None)
        return children(app)[0] if app and children(app) else None

    def label(self, op):
        if op.kind == 'time':
            label = self.strings['settings.appearance.night-light-' + ('from' if op.key.endswith('From') else 'to')]
            return label + ', ' + self.strings['settings.appearance.time.' + op.part]
        return self.strings[op.label] if op.label else self.schema[op.key].get('ui', {}).get('title', '')

    def control_node(self, op, root=None):
        root = root or self.native_root()
        label = self.label(op)
        nodes = walk(root)
        roles = {
            'toggle': {Atspi.Role.TOGGLE_BUTTON, Atspi.Role.CHECK_BOX}, 'combo': {Atspi.Role.COMBO_BOX},
            'slider': {Atspi.Role.SLIDER}, 'time': {Atspi.Role.SPIN_BUTTON},
            'radio': {Atspi.Role.PANEL}, 'gallery': {Atspi.Role.PANEL}, 'image': {Atspi.Role.IMAGE},
            'font': {Atspi.Role.PUSH_BUTTON}, 'file': {Atspi.Role.PUSH_BUTTON},
        }[op.kind]
        if op.kind == 'image':
            prefix = self.strings['settings.appearance.group.wallpaper'] + ':'
            return next((n for n in nodes if n.get_role() in roles and n.get_name().startswith(prefix)), None)
        if op.kind == 'gallery':
            return next((n for n in nodes if n.get_role() in roles and n.get_name() == self.strings['settings.appearance.group.wallpaper']
                         and any(c.get_role() == Atspi.Role.RADIO_BUTTON for c in children(n))), None)
        return next((n for n in nodes if n.get_role() in roles and
                     (n.get_name() == label or labelled(n, label))), None)

    def focus(self, node):
        if node.get_role() == Atspi.Role.PANEL:
            node = next((n for n in children(node) if state(n, Atspi.StateType.CHECKED)), children(node)[0])
        for _ in range(160):
            if state(node, Atspi.StateType.FOCUSED):
                return node
            before = self.raw().count('SETTINGS_GATE_INPUT_DONE')
            self.key('tab')
            wait(lambda: self.raw().count('SETTINGS_GATE_INPUT_DONE') > before, 'Tab handled')
        raise InfrastructureError('keyboard Tab cannot reach ' + node.get_name())

    def spoken(self, offset):
        delta = self.debug.read_bytes()[offset:].decode(errors='replace')
        return ' '.join(re.findall(r"SPEECH OUTPUT: '(.*?)'(?=\{)", delta)).lower().replace(',', '')

    def set_fault(self, value):
        pending = self.control.with_suffix('.pending')
        pending.write_text(value)
        pending.replace(self.control)

    def arm(self, stage):
        if self.target == stage and self.fault != 'builder':
            self.set_fault(self.fault)

    def barrier(self, before):
        wait(lambda: self.raw().count('SETTINGS_GATE_INPUT_DONE') > before or
             ('SETTINGS_GATE_CONTROL_APPLIED ' + str(self.fault)) in self.raw(), 'actual key or fault branch')

    def setup(self):
        # Preconditions use independent writer BEFORE launching the client; not acceptance.
        external('nightlight.scheduleEnabled', False)
        external('accessibility.reduceTransparency', False)
        wait(lambda: self.get('nightlight.scheduleEnabled') is False, 'schedule prerequisite')
        address = call(self.bus, 'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress')[0]
        os.environ['AT_SPI_BUS_ADDRESS'] = address
        registry = next(p for p in ['/usr/lib/at-spi2-registryd', '/usr/libexec/at-spi2-registryd'] if Path(p).exists())
        a11y = Gio.DBusConnection.new_for_address_sync(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        if not call(a11y, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                    'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)))[0]:
            self.registry = self.start([registry], 'registry.log')
        wait(lambda: call(a11y, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                          'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)))[0], 'AT-SPI registry')
        call(self.bus, 'org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
             GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))))
        if not re.search(r'^default_driver\s*=\s*null\s*$', Path('/etc/libao.conf').read_text(), re.M):
            raise InfrastructureError('disposable null libao configuration required')
        speech = self.path / 'speech'
        speech.mkdir()
        if len(str(speech / 'socket').encode()) >= 108:
            raise InfrastructureError('speech socket path too long; choose a short evidence path')
        (speech / 'speechd.conf').write_text(f'LogDir "{speech}"\nAudioOutputMethod "libao"\nAddModule "dummy" "sd_dummy"\nDefaultModule dummy\n')
        os.environ['SPEECHD_ADDRESS'] = 'unix_socket:' + str(speech / 'socket')
        self.start(['speech-dispatcher', '-s', '-C', speech, '-S', speech/'socket', '-P', speech/'pid', '-t', '0'], 'speechd.log')
        wait(lambda: (speech/'socket').exists(), 'speech socket')
        self.orca = self.start(['orca', '--debug-file', self.debug], 'orca.log')
        wait(lambda: self.debug.exists() and 'SPEECH OUTPUT:' in self.debug.read_text(), 'real Orca')
        legacy = Path(os.environ.get('NK_SETTINGS_LEGACY_BIN', '/usr/bin/nidara-settings-legacy'))
        if not legacy.exists():
            legacy = Path('/usr/bin/nidara-settings')
        self.legacy = self.start([legacy], 'legacy.log')
        self.legacy_app = wait(lambda: next((a for a in applications() if a.get_name() == 'Nidara Settings'), None), 'legacy AT-SPI app')
        call(self.bus, 'org.nidara.Settings', '/org/nidara/Settings', 'org.nidara.Settings', 'Request',
             GLib.Variant('(as)', (['page', 'appearance'],)))
        environment = os.environ | {'NK_SETTINGS_GATE_CONTROL': str(self.control), 'LANG':'en_US.UTF-8'}
        environment.pop('NK_SETTINGS_OPAQUE_PREVIEW', None)
        self.app = self.start([BIN], 'client.log', environment)
        wait(lambda: 'CONTENT_READY' in self.raw() and 'A11Y_READY' in self.raw(), 'native authoritative content')
        wait(self.native_root, 'native AT-SPI frame')
        windows = json.loads(command(*MSG, 'windows'))['ok']['windows']
        window = next((w for w in windows if w.get('pid') == self.app.pid), None)
        if window is None or len(window.get('layers', [])) < 3 or 'background' not in window:
            raise InfrastructureError('native window did not map with real D7 layers/background')
        self.schema = self.snapshot()
        (self.path/'environment.json').write_text(json.dumps({
            'revision': command('git', '-c', 'safe.directory=*', '-C', ROOT, 'rev-parse', 'HEAD').strip(),
            'client_sha256': hashlib.sha256(BIN.read_bytes()).hexdigest(),
            'client_pid': self.app.pid, 'legacy_pid': self.legacy_app.get_process_id(),
            'schema': self.schema, 'fault': self.fault}, indent=2))

    def displayed(self, op, expected, root=None):
        node = self.control_node(op, root)
        if node is None:
            return False
        if op.kind == 'toggle':
            return state(node, Atspi.StateType.CHECKED) == expected
        if op.kind in ('slider', 'time'):
            if op.kind == 'time':
                expected = int(expected.split(':')[0 if op.part == 'hour' else 1])
            return abs(node.get_value_iface().get_current_value() - float(expected)) < .01
        if op.kind in ('radio', 'gallery'):
            chosen = [n for n in children(node) if state(n, Atspi.StateType.CHECKED)]
            return len(chosen) == 1 and self.option_label(op.key, expected).lower() in chosen[0].get_name().lower()
        return str(expected).lower() in values(node)

    def option_label(self, key, value):
        options = self.schema[key].get('ui', {}).get('options', [])
        return next((x['label'] for x in options if x['value'] == value), str(value))

    def legacy_shows(self, op, expected):
        # GTK's painted sliders do not expose the new toolkit's Value interface.
        # queryUI observes the actual rendered label/state/bounds, not ConfigRegistry.
        raw = call(self.bus, 'org.nidara.Settings', '/org/nidara/Settings', 'org.nidara.Settings',
                   'Request', GLib.Variant('(as)', (['queryUI'],)))[0]
        snapshot = json.loads(raw)
        if 'error' in snapshot or snapshot.get('count', 0) > len(snapshot.get('nodes', [])):
            raise InfrastructureError('legacy queryUI failed or was truncated')
        label = self.label(op)
        if op.kind == 'time':
            label = self.strings['settings.appearance.night-light-' + ('from' if op.key.endswith('From') else 'to')]
        if op.kind == 'gallery':
            label = self.strings['settings.appearance.group.wallpaper']
        region = visible_row(snapshot['nodes'], label)
        (self.path/(op.id+'-legacy.json')).write_text(json.dumps({'snapshot':snapshot,'row':region}, indent=2))
        return visible_contains(region, op.kind, self.option_label(op.key, expected)) if op.kind not in ('toggle','slider','time') else visible_contains(region, op.kind, expected)

    def effect(self, key, expected):
        if persisted(key) != expected:
            return False
        if key == 'appearance.windowBackground':
            return json.loads(command(*MSG, 'config'))['ok']['config']['windows']['background']['level'] == expected
        if key == 'wallpaper.current':
            return str(expected) in command('awww', 'query')
        return True

    def choose(self, op, node):
        old = self.get(op.key)
        expected = old
        if op.kind == 'toggle':
            expected = not old
            self.key('space')
        elif op.kind in ('radio', 'combo', 'gallery'):
            if op.kind == 'gallery':
                candidates = self.schema[op.key].get('catalogue', [])
                candidates = [x if isinstance(x, str) else x['path'] for x in candidates]
                target = next((x for x in candidates if x != old), None)
            else:
                candidates = self.schema[op.key].get('values', [])
                target = next((x for x in candidates if x != old), None)
            if target is None:
                raise InfrastructureError(op.id + ': fewer than two installed choices; acceptance fixture missing')
            if op.kind == 'combo':
                self.key('space')
                wait(lambda: state(node, Atspi.StateType.EXPANDED), 'dropdown open')
            self.key('home')
            for _ in range(candidates.index(target)):
                self.key('right' if op.kind != 'combo' else 'down')
            if op.kind == 'combo':
                self.key('enter')
            expected = target
        elif op.kind == 'slider':
            v = node.get_value_iface()
            step = v.get_minimum_increment()
            right = old + step <= v.get_maximum_value()
            expected = old + (step if right else -step)
            self.key('right' if right else 'left')
        elif op.kind == 'time':
            h, m = map(int, old.split(':'))
            h, m = ((h + 1) % 24, m) if op.part == 'hour' else (h, (m + 1) % 60)
            expected = f'{h:02}:{m:02}'
            self.key('up')
        elif op.kind == 'font':
            self.key('enter')
            wait(lambda: any(n.get_role() == Atspi.Role.DIALOG for n in walk(self.native_root())), 'font dialog')
            # Every family/style/size/search/select/cancel control must exist in the real dialog.
            dialog = next(n for n in walk(self.native_root()) if n.get_role() == Atspi.Role.DIALOG)
            roles = [n.get_role() for n in walk(dialog)]
            self.oracle('dialog:' + op.id, lambda: all(r in roles for r in
                        [Atspi.Role.ENTRY, Atspi.Role.LIST, Atspi.Role.SPIN_BUTTON, Atspi.Role.PUSH_BUTTON]), lambda: dump(dialog))
            search = next(n for n in walk(dialog) if n.get_role() == Atspi.Role.ENTRY)
            self.focus_dialog(search)
            self.chord(29, 30)  # Ctrl+A, physical typing in the real chooser search.
            desired_family = 'JetBrains Mono' if op.key == 'appearance.monoFont' else 'Noto Sans'
            self.type_ascii(desired_family)
            families = next(n for n in walk(dialog) if n.get_name() == self.strings['settings.native.font.families'])
            wait(lambda: children(families), 'font family results')
            family = next((n for n in children(families) if n.get_name() == desired_family), None)
            if family is None:
                raise OracleFailure('dialog:' + op.id, 'required family not in real filtered catalogue: ' + desired_family)
            self.focus_dialog(family)
            self.key('enter')
            styles = next(n for n in walk(dialog) if n.get_name() == self.strings['settings.native.font.styles'])
            wait(lambda: children(styles), 'font styles')
            self.focus_dialog(children(styles)[0])
            self.key('home')
            self.key('enter')
            size = next(n for n in walk(dialog) if n.get_role() == Atspi.Role.SPIN_BUTTON)
            self.focus_dialog(size)
            self.key('up')
            # Confirm using only Tab and Return, never an accessibility action.
            select = next(n for n in walk(dialog) if n.get_name() == self.strings['settings.native.select'])
            self.focus_dialog(select)
            self.key('enter')
            wait(lambda: not any(n.get_role() == Atspi.Role.DIALOG for n in walk(self.native_root())), 'font dialog return')
            self.arm('focus:' + op.id)
            self.oracle('focus:' + op.id, lambda: state(node, Atspi.StateType.FOCUSED), lambda: dump(self.native_root()))
            # Canonical service reply remains the source for parsing Pango point formats;
            # independent persistence and legacy checks below must agree and differ from old.
            expected = wait(lambda: (v if (v := self.get(op.key)) != old else None), 'font canonical change')
            # Reopen/cancel proves focus return for the other dismissal too.
            self.key('enter')
            wait(lambda: any(n.get_role() == Atspi.Role.DIALOG for n in walk(self.native_root())), 'font reopened')
            dialog = next(n for n in walk(self.native_root()) if n.get_role() == Atspi.Role.DIALOG)
            cancel = next(n for n in walk(dialog) if n.get_name() == self.strings['settings.native.cancel'])
            self.focus_dialog(cancel)
            self.key('enter')
            wait(lambda: not any(n.get_role() == Atspi.Role.DIALOG for n in walk(self.native_root())), 'font cancelled')
            self.oracle('focus-cancel:' + op.id, lambda: state(node, Atspi.StateType.FOCUSED), lambda: dump(self.native_root()))
        elif op.kind == 'file':
            self.key('enter')
            chooser = wait(lambda: next((n for a in applications() for n in walk(a)
                                        if n.get_role() == Atspi.Role.FILE_CHOOSER), None), 'real portal file chooser')
            self.oracle('dialog:' + op.id, lambda: bool(chooser.get_name()), lambda: dump(chooser))
            filename = str(ROOT / 'toolkit/settings/tests/fixtures/images/sample.png')
            self.chord(29, 38)  # Ctrl+L, then physical filename typing.
            self.type_ascii(filename)
            self.key('enter')
            expected = filename
            wait(lambda: self.get(op.key) == filename, 'file chooser accepted')
            self.oracle('focus:' + op.id, lambda: state(node, Atspi.StateType.FOCUSED), lambda: dump(self.native_root()))
            self.key('enter')
            wait(lambda: any(n.get_role() == Atspi.Role.FILE_CHOOSER for a in applications() for n in walk(a)), 'file chooser reopened')
            self.key('escape')
            wait(lambda: not any(n.get_role() == Atspi.Role.FILE_CHOOSER for a in applications() for n in walk(a)), 'file chooser cancelled')
            self.oracle('focus-cancel:' + op.id, lambda: state(node, Atspi.StateType.FOCUSED), lambda: dump(self.native_root()))
        return expected

    def focus_dialog(self, node):
        # One real Tab at a time: the observed focus must change before the next.
        def focused():
            return next((identity(n) for n in walk(self.native_root())
                         if state(n, Atspi.StateType.FOCUSED)), None)
        for _ in range(160):
            if state(node, Atspi.StateType.FOCUSED):
                return
            previous = focused()
            self.key('tab')
            wait(lambda: focused() is not None and focused() != previous, 'dialog Tab focus transition')
        raise InfrastructureError('dialog keyboard traversal cannot reach ' + node.get_name())

    def operation(self, op):
        self.schema = self.snapshot()
        entry = self.schema[op.key]
        if not entry.get('available', True):
            raise OracleFailure('structure:' + op.id, 'required D1 operation unavailable')
        if op.kind == 'time' and self.get('nightlight.scheduleEnabled') is False:
            external('nightlight.scheduleEnabled', True)
            wait(lambda: self.control_node(op), 'visible schedule fields')
        # Missing builder must fail the operation's structural assertion after CONTENT_READY.
        self.oracle('structure:' + op.id, lambda: self.control_node(op) is not None, lambda: dump(self.native_root()))
        node = self.control_node(op)
        old = self.get(op.key)
        if op.kind == 'image':
            self.oracle('display:' + op.id, lambda: self.displayed(op, old), lambda: dump(node))
            return
        if self.fault and self.target not in ['apply:' + op.id, 'external:' + op.id, 'speech:' + op.id, 'focus:' + op.id]:
            return
        offset = self.debug.stat().st_size
        node = self.focus(node)
        self.arm('apply:' + op.id)
        self.arm('speech:' + op.id)
        # Arm focus failure before the actual dismiss; never after return.
        if self.target == 'focus:' + op.id:
            self.set_fault(self.fault)
        before = self.raw().count('SETTINGS_GATE_INPUT_DONE')
        expected = self.choose(op, node)
        self.barrier(before)
        stage = 'apply:' + op.id
        self.oracle(stage, lambda: self.get(op.key) == expected and expected != old,
                    lambda: {'old': old, 'expected': expected, 'getConfig': self.get(op.key)})
        self.oracle('effect:' + op.id, lambda: self.effect(op.key, expected),
                    lambda: {'expected':expected, 'persistent':persisted(op.key)})
        self.oracle('legacy:' + op.id, lambda: self.legacy_shows(op, expected), lambda: dump(self.legacy_app))
        self.oracle('display:' + op.id, lambda: self.displayed(op, expected), lambda: dump(self.native_root()))
        if op.key == 'wallpaper.current':
            preview = next(o for o in OPERATIONS if o.kind == 'image')
            self.oracle('preview:' + op.id, lambda: self.displayed(preview, expected), lambda: dump(self.native_root()))
        speech_value = (('checked' if expected else 'not checked') if op.kind == 'toggle' else self.option_label(op.key, expected)).lower()
        if isinstance(expected, (int, float)) and not isinstance(expected, bool):
            speech_value = format(expected, 'g')
        if op.kind == 'time':
            speech_value = str(int(expected.split(':')[0 if op.part == 'hour' else 1]))
        role = {'radio':'radio button', 'gallery':'radio button', 'combo':'combo box',
                'slider':'slider', 'time':'spin button', 'font':'button', 'file':'button', 'toggle':'toggle button'}[op.kind]
        self.oracle('speech:' + op.id, lambda: role in self.spoken(offset) and speech_value in self.spoken(offset)
                    and (self.label(op).lower() in self.spoken(offset) or node.get_name().lower() in self.spoken(offset)),
                    lambda: {'speech':self.spoken(offset), 'role':role, 'value':speech_value})
        (self.path/(op.id+'-speech.log')).write_bytes(self.debug.read_bytes()[offset:])
        self.arm('external:' + op.id)
        seen = len(self.updated)
        external(op.key, old)
        wait(lambda: any(op.key in values and values[op.key] == old for _, _, values in self.updated[seen:]), 'real Updated from other writer')
        self.oracle('external:' + op.id, lambda: self.displayed(op, old), lambda: dump(self.native_root()))
        if op.key == 'wallpaper.current':
            preview = next(o for o in OPERATIONS if o.kind == 'image')
            self.oracle('external-preview:' + op.id, lambda: self.displayed(preview, old), lambda: dump(self.native_root()))
        if self.target and any(r['stage'] == self.target for r in self.rows):
            raise InfrastructureError('armed fault escaped its own assertion: ' + self.target)

    def close(self):
        self.set_fault('')
        self.bus.signal_unsubscribe(self.subscription)
        for p in reversed(self.procs):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)
        # Restore every key even after a failed assertion; only the private session is allowed.
        errors = []
        for key, value in self.original.items():
            try:
                external(key, value)
            except Exception as error:
                errors.append(f'{key}: {error}')
        for stream in self.streams:
            stream.close()
        self.pipe.close()
        if errors:
            raise InfrastructureError('restoration failed: ' + '; '.join(errors))

    def run(self):
        try:
            self.setup()
            for op in OPERATIONS:
                self.operation(op)
            if self.fault:
                raise InfrastructureError('control escaped without its target assertion')
            return {'status':'PASS', 'rows':self.rows}
        except OracleFailure as error:
            self.rows.append({'stage':error.stage, 'status':'FAIL', 'detail':str(error)})
            marker = 'SETTINGS_GATE_CONTROL_APPLIED ' + str(self.fault)
            if self.fault and error.stage == self.target and marker in self.raw():
                return {'status':'CAUGHT', 'stage':error.stage, 'detail':str(error), 'applied':marker, 'rows':self.rows}
            raise
        finally:
            (self.path/'rows.json').write_text(json.dumps(self.rows, indent=2))
            self.close()


def main():
    if os.environ.get('NK_SETTINGS_TEST') != 'vkms' or os.environ.get('XDG_RUNTIME_DIR') != '/run/hyalo-smoke':
        raise InfrastructureError('run only inside the disposable Hyalo smoke session; no live fallback')
    if Path('/tmp') in LOG.parents:
        raise InfrastructureError('evidence must live under toolkit/target, never /tmp')
    os.environ.setdefault('XDG_CONFIG_HOME', str(Path.home()/'.config'))
    os.environ.setdefault('XDG_DATA_HOME', str(Path.home()/'.local/share'))
    LOG.mkdir(parents=True, exist_ok=False)
    # Fail before launching if an existing native Settings instance would receive our request.
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    if call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', GLib.Variant('(s)', ('org.nidara.SettingsNative',)))[0]:
        raise InfrastructureError('native Settings already running')
    outputs = json.loads(command(*MSG, 'outputs'))['ok']['outputs']
    output = next(o for o in outputs if o.get('enabled'))
    original_scale = output['scale']
    scales = [1, 1.25] if FULL else [1]
    results = {'scales':{}, 'controls_full':FULL, 'status':'FAIL'}
    try:
        for scale in scales:
            command(*MSG, 'output', output['name'], 'scale=' + str(scale))
            case = {'baseline':None, 'controls':{}}
            results['scales'][str(scale)] = case
            case['baseline'] = Run(scale=scale).run()
            for fault in (CONTROLS if FULL else []):
                result = Run(fault, scale).run()
                if result['status'] != 'CAUGHT':
                    raise InfrastructureError('control was not caught: ' + fault)
                case['controls'][fault] = result
        results['status'] = 'PASS'
    except Exception as error:
        results['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        command(*MSG, 'output', output['name'], 'scale=' + str(original_scale))
        for case in results['scales'].values():
            case['not_run_controls'] = [f for f in CONTROLS if f not in case['controls']]
        (LOG/'summary.json').write_text(json.dumps(results, indent=2))
        (LOG/'summary.md').write_text('# Appearance gates 1/2\n\n```json\n'+json.dumps(results, indent=2)+'\n```\n')
        print(json.dumps(results))

if __name__ == '__main__':
    main()
