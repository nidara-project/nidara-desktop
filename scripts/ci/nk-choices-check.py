#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Radio groups (#882) through real libatspi on an isolated Hyalo: nk-widgets-demo --choices.

Every assertion runs on a baseline and again with its own fault applied (the demo logs
CONTROL_APPLIED); the fault must fail THAT assertion. A timeout, a crash or a fault that never
applied is an infrastructure error, never a caught control. Evidence lives below toolkit/target.

Local:  NK_WIDGETS_CHECK=nk-choices-check.py toolkit/widgets-demo/check-headless.sh
CI:     NK_WIDGETS_TEST=vkms (scripts/ci/hyalo-smoke.sh). NK_CHOICES_SCALES (default "1 1.25")
        and NK_REAL_CONTROLS=0 (baseline only) follow ci-scope's `full`, as the real gates do.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ.get('NK_WIDGETS_LOG', ROOT / 'toolkit/target/widgets-evidence')).resolve() / 'choices'
BIN = os.environ.get('NK_WIDGETS_BIN', str(ROOT / 'toolkit/target/release/nk-widgets-demo'))
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
SCALES = [float(s) for s in os.environ.get('NK_CHOICES_SCALES', '1 1.25').split()]
CONTROLS = os.environ.get('NK_REAL_CONTROLS', '1') != '0'
# Each assertion and the fault that must fail it.
STAGES = {'segmented': 'two-checked', 'swatch-name': 'swatch-name', 'radio-role': 'radio-role',
          'arrows': 'arrows'}
KEY_RIGHT, KEY_HOME = 106, 102
if os.environ.get('NK_WIDGETS_TEST') == 'vkms':
    if os.environ.get('XDG_RUNTIME_DIR') != '/run/hyalo-smoke':
        raise RuntimeError('private vkms runtime required')
elif Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('use toolkit/widgets-demo/check-headless.sh')
if Path('/tmp') in LOG.parents:
    raise RuntimeError('evidence must not use /tmp')
LOG.mkdir(parents=True, exist_ok=True)
PIPE = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)


class InfrastructureError(RuntimeError):
    pass


class OracleFailure(AssertionError):
    def __init__(self, stage, detail):
        super().__init__(f'{stage}: {detail}')
        self.stage = stage


def pump(seconds=.05):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(.005)


def barrier(test, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        pump()
    raise InfrastructureError(f'publication/setup timeout: {label}')


def children(node):
    node.clear_cache()
    return [node.get_child_at_index(i) for i in range(node.get_child_count())]


def walk(node):
    result = [node]
    for child in children(node):
        if child:
            result.extend(walk(child))
    return result


def app_tree():
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            for node in children(app):
                if node and node.get_name() == 'Nidara widgets demo':
                    return node
        except GLib.Error:
            continue
    return None


def state(node, kind):
    node.clear_cache()
    return node.get_state_set().contains(kind)


def labelled(node, name):
    return any(relation.get_relation_type() == Atspi.RelationType.LABELLED_BY
               and any(relation.get_target(i).get_name() == name
                       for i in range(relation.get_n_targets()))
               for relation in node.get_relation_set())


def ipc(*args):
    response = subprocess.run([*MSG, *map(str, args)], capture_output=True, text=True, check=True)
    return json.loads(response.stdout)['ok']


session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress',
                           None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
os.environ['AT_SPI_BUS_ADDRESS'] = address
registry_path = next(p for p in [Path('/usr/lib/at-spi2-registryd'), Path('/usr/libexec/at-spi2-registryd')] if p.exists())
registry_log = (LOG / 'registry.log').open('w')
registry = subprocess.Popen([str(registry_path)], stdout=registry_log, stderr=registry_log)
private_bus = Gio.DBusConnection.new_for_address_sync(
    address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
barrier(lambda: private_bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)), GLib.VariantType.new('(b)'),
        Gio.DBusCallFlags.NONE, 1000, None).unpack()[0], 'registry')
session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
                  GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))),
                  None, Gio.DBusCallFlags.NONE, 5000, None)


def group(root, name):
    """The radio group a row labels: the PANEL named by the row's label, holding radio buttons."""
    return next((n for n in walk(root) if n.get_name() == name and n.get_role() == Atspi.Role.PANEL
                 and any(c.get_role() in (Atspi.Role.RADIO_BUTTON, Atspi.Role.TOGGLE_BUTTON)
                         for c in children(n))), None)


def run(scale, fault=None, stop=None):
    directory = LOG / f'scale{scale}' / (fault or 'baseline')
    directory.mkdir(parents=True, exist_ok=True)
    log = directory / 'client.log'
    with log.open('w') as output:
        process = subprocess.Popen([BIN, '--choices', *([f'--fault={fault}'] if fault else [])],
                                   stdout=output, stderr=output)

        def text():
            if process.poll() is not None:
                raise InfrastructureError(f'demo exited {process.returncode}: {log.read_text()}')
            return log.read_text()

        def check(stage, condition, detail):
            if not condition:
                raise OracleFailure(stage, detail)
            return stop == stage

        try:
            barrier(lambda: 'CONTENT_READY' in text() and 'A11Y_READY' in text(), 'demo readiness', 15)
            root = barrier(app_tree, 'AT-SPI frame')
            nodes = walk(root)
            (directory / 'tree.json').write_text(json.dumps([
                {'name': n.get_name(), 'role': n.get_role_name(),
                 'states': [str(s) for s in n.get_state_set().get_states()]}
                for n in nodes], ensure_ascii=False, indent=2))
            controls = barrier(lambda: group(root, 'Window controls'), 'segmented group')
            segments = children(controls)
            checked = [s.get_name() for s in segments if state(s, Atspi.StateType.CHECKED)]
            if check('segmented', labelled(controls, 'Window controls')
                     and [s.get_role() for s in segments] == [Atspi.Role.RADIO_BUTTON] * 3
                     and [s.get_name() for s in segments] == ['Left', 'Right', 'Hidden']
                     and checked == ['Right'],
                     f'segmented group: one radio of three chosen, got {checked}'):
                return 'PASS'
            accents = barrier(lambda: group(root, 'Accent colour'), 'swatch group')
            swatches = children(accents)
            if check('swatch-name', len(swatches) == 9 and all(s.get_name() for s in swatches)
                     and sum(state(s, Atspi.StateType.CHECKED) for s in swatches) == 1,
                     f'swatches unnamed or not one chosen: {[s.get_name() for s in swatches]}'):
                return 'PASS'
            if check('radio-role', all(s.get_role() == Atspi.Role.RADIO_BUTTON for s in swatches),
                     'a swatch is not a radio button'):
                return 'PASS'
            # The arrows: from the chosen segment, Right chooses and focuses the next, Home the first.
            right = segments[1]
            before = text().count('A11Y_PUBLISHED')
            right.get_component_iface().grab_focus()
            barrier(lambda: text().count('A11Y_PUBLISHED') > before and state(right, Atspi.StateType.FOCUSED),
                    'focus on the chosen segment')
            for code in (KEY_RIGHT, KEY_HOME):
                before = text().count('A11Y_PUBLISHED')
                PIPE.write(f'key {code}\n')
                # Causal: the demo published the key's result, or the fault logged swallowing it.
                barrier(lambda: text().count('A11Y_PUBLISHED') > before or f'CONTROL_APPLIED {fault}' in text(),
                        f'key {code} handled')
                pump(.1)
                if code == KEY_RIGHT:
                    moved = state(segments[2], Atspi.StateType.CHECKED) and state(segments[2], Atspi.StateType.FOCUSED) \
                        and not state(segments[1], Atspi.StateType.CHECKED)
            first = state(segments[0], Atspi.StateType.CHECKED) and state(segments[0], Atspi.StateType.FOCUSED)
            if check('arrows', moved and first, 'Right/Home did not move the choice and the focus'):
                return 'PASS'
            if not fault and os.environ.get('NK_WIDGETS_SCREENSHOTS') == '1':
                pump(1)
                ipc('screenshot', directory / 'demo.png')
            return 'PASS'
        except OracleFailure as error:
            if not fault or error.stage != stop:
                raise
            if f'CONTROL_APPLIED {fault}' not in text():
                raise InfrastructureError(f'unapplied control {fault}: {log}') from error
            (directory / 'caught.json').write_text(json.dumps({'assertion': error.stage, 'applied': True,
                                                            'failure': str(error)}, indent=2))
            return 'CAUGHT'
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            pump(.1)


output = ipc('outputs')['outputs'][0]
workspace = next(w['id'] for w in ipc('workspaces')['workspaces'] if w['focused'])
result = {}
try:
    ipc('do', 'workspace', 93)
    ipc('do', 'set-workspace-mode', 93, 'floating')
    for scale in SCALES:
        ipc('output', output['name'], f'scale={scale}')
        if run(scale) != 'PASS':
            raise InfrastructureError('baseline did not pass')
        print(f'scale{scale}: baseline PASS ({", ".join(STAGES)})', flush=True)
        if not CONTROLS:
            continue
        for stage, fault in STAGES.items():
            if run(scale, fault=fault, stop=stage) != 'CAUGHT':
                raise InfrastructureError(f'{stage}: control {fault} passed its assertion')
            print(f'scale{scale} {stage}: applied control {fault} CAUGHT', flush=True)
        result[f'scale{scale}'] = 'baseline PASS, all controls caught'
    (LOG / 'result.json').write_text(json.dumps({'stages': STAGES, 'scales': SCALES, 'controls': CONTROLS,
                                              'result': result}, indent=2))
finally:
    try:
        ipc('output', output['name'], f"scale={output['scale']}")
        ipc('do', 'workspace', workspace)
    finally:
        registry.terminate()
        registry.wait(timeout=3)
        registry_log.close()
        PIPE.close()
