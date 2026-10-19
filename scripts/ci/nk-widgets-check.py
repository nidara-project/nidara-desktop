#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Structural widgets through real libatspi on an isolated Hyalo.
Every named oracle runs a baseline and its own applied mutation. An assertion
is evaluated AFTER an independent publication barrier; timeouts and crashes
are infrastructure errors, never discriminating-control successes.
All new evidence lives below toolkit/target, never /tmp.
"""
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import time
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ.get('NK_WIDGETS_LOG', ROOT / 'toolkit/target/widgets-evidence')).resolve()
BIN = os.environ.get('NK_WIDGETS_BIN', str(ROOT / 'toolkit/target/release/nk-widgets-demo'))
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
DATA = Path(os.environ.get('NK_SETTINGS_DATA', ROOT / 'build/settings-data'))
CONTENT_WIDTH = json.loads((DATA / 'tokens/static.json').read_text())['ts']['WINDOW_LAYOUT']['contentFloor']
STAGES = ['frame', 'sidebar', 'selected', 'scroll', 'group', 'group-label', 'row-label',
          'switch-role', 'switch-name', 'button', 'hidden', 'at-rest', 'tab', 'checked', 'offscreen',
          'reveal', 'under-sidebar', 'under-title', 'layers']
NEW_STAGES = ['sidebar-reveal', 'collapse', 'overlay']
if os.environ.get('NK_WIDGETS_TEST') == 'vkms':
    if os.environ.get('XDG_RUNTIME_DIR') != '/run/hyalo-smoke':
        raise RuntimeError('private vkms runtime required')
else:
    if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
        raise RuntimeError('use toolkit/widgets-demo/check-headless.sh')
if LOG == Path('/tmp') or Path('/tmp') in LOG.parents:
    raise RuntimeError('nk-widgets evidence must not use /tmp')
LOG.mkdir(parents=True, exist_ok=True)
(LOG / 'environment.json').write_text(json.dumps({
    'revision': subprocess.check_output(['git', '-c', 'safe.directory=*', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
    'demo_sha256': hashlib.sha256(Path(BIN).read_bytes()).hexdigest(),
    'compositor_sha256': hashlib.sha256(Path(MSG[0] if '/' in MSG[0] else shutil.which(MSG[0])).read_bytes()).hexdigest(),
    'runtime': os.environ['XDG_RUNTIME_DIR'],
    'selected_stages': os.environ.get('NK_WIDGETS_STAGES', 'FULL'),
}, indent=2))
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


def find(root, name, role=None):
    return next((n for n in walk(root) if n.get_name() == name
                 and (role is None or n.get_role() == role)), None)


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


# Explicit registry on THIS bus, never the live user's systemd service.
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


SCALE = 1


def run(fault=None, stop=None):
    directory = LOG / f'scale{SCALE}' / (fault or (f'baseline-{stop}' if stop else 'baseline'))
    directory.mkdir(parents=True, exist_ok=True)
    log = directory / 'client.log'
    with log.open('w') as output:
        process = subprocess.Popen([BIN, f'--content-width={CONTENT_WIDTH}', *(['--narrow'] if stop == 'overlay' else []), *([f'--fault={fault}'] if fault else [])], stdout=output, stderr=output)
        completed = []
        def text():
            if process.poll() is not None:
                raise InfrastructureError(f'demo exited {process.returncode}: {log.read_text()}')
            return log.read_text()

        def published(action):
            before = text().count('A11Y_PUBLISHED')
            action()
            barrier(lambda: text().count('A11Y_PUBLISHED') > before, 'semantic publication')
            # Complete D-Bus calls on the consumer after the provider's update finished.
            pump(.1)

        def key(code, shift=False):
            def send():
                if shift:
                    PIPE.write('keydown 42\n')
                PIPE.write(f'key {code}\n')
                if shift:
                    PIPE.write('keyup 42\n')
                PIPE.flush()
            published(send)

        def action(name):
            node = find(root, name, Atspi.Role.PUSH_BUTTON)
            if not node:
                raise InfrastructureError(f'fixture action missing: {name}')
            published(lambda: node.get_action_iface().do_action(0))

        def check(stage, condition, detail):
            if not condition:
                raise OracleFailure(stage, detail)
            completed.append(stage)
            if stop == stage:
                return True
            return False

        try:
            barrier(lambda: 'CONTENT_READY' in text() and 'A11Y_READY' in text(), 'demo readiness', 15)
            root = barrier(app_tree, 'AT-SPI frame')
            if stop in NEW_STAGES:
                sidebar = find(root, 'Pages', Atspi.Role.LIST)
                serialize = lambda r: {key: getattr(r, key) for key in ('x', 'y', 'width', 'height')}
                rect = lambda node: node.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
                if stop == 'sidebar-reveal':
                    last = find(root, 'Demo page 19')
                    before = rect(last)
                    published(lambda: last.get_component_iface().grab_focus())
                    after = rect(last)
                    top = rect(find(root, 'Widget foundations', Atspi.Role.LABEL)).height
                    (directory / 'observations.json').write_text(json.dumps({'before': serialize(before), 'after': serialize(after), 'root': serialize(rect(root))}, indent=2))
                    check(stop, before.y + before.height > rect(root).height
                          and state(last, Atspi.StateType.FOCUSED) and state(last, Atspi.StateType.SHOWING)
                          and after.y >= top and after.y + after.height <= rect(root).height,
                          'last sidebar page was not revealed within the short window')
                else:
                    row = find(root, 'Enable feature', Atspi.Role.TOGGLE_BUTTON).get_parent()
                    before = rect(row)
                    initial_sidebar = state(sidebar, Atspi.StateType.SHOWING)
                    reports = text().count('LAYOUT ')
                    action('Sidebar')
                    # Wait for the clock, never for the assertion's geometry.
                    barrier(lambda: text().count('LAYOUT ') > reports
                            and [line for line in text().splitlines() if line.startswith('LAYOUT ')][-1].endswith('resting=true'),
                            'sidebar motion settled')
                    pump(.1)
                    after = rect(row)
                    width = rect(root).width
                    (directory / 'observations.json').write_text(json.dumps({'before': serialize(before), 'after': serialize(after), 'root': serialize(rect(root)), 'initial_sidebar': initial_sidebar, 'final_sidebar': state(sidebar, Atspi.StateType.SHOWING)}, indent=2))
                    centred = abs(2 * after.x + after.width - width) <= 2
                    if stop == 'collapse':
                        check(stop, initial_sidebar and not state(sidebar, Atspi.StateType.SHOWING)
                              and after.x < before.x and after.width > before.width and centred,
                              'collapsed content did not reclaim its inset and reflow symmetrically')
                    else:
                        check(stop, not initial_sidebar and state(sidebar, Atspi.StateType.SHOWING)
                              and centred and (before.x, before.width) == (after.x, after.width),
                              'narrow overlay displaced content or did not open over it')
                return completed
            nodes = walk(root)
            (directory / 'tree.json').write_text(json.dumps([
                {'name': n.get_name(), 'role': n.get_role_name(),
                 'states': [str(s) for s in n.get_state_set().get_states()]}
                for n in nodes], ensure_ascii=False, indent=2))
            if check('frame', root.get_role() == Atspi.Role.FRAME, 'window role'): return completed
            sidebar = find(root, 'Pages')
            if check('sidebar', sidebar and sidebar.get_role() == Atspi.Role.LIST, 'page-list role/name'): return completed
            page = find(root, 'Appearance')
            if check('selected', page and state(page, Atspi.StateType.SELECTED), 'selected page'): return completed
            scroll = find(root, 'Content')
            if check('scroll', scroll and scroll.get_role() == Atspi.Role.SCROLL_PANE, 'scroll-pane role/name'): return completed
            header = find(root, 'General', Atspi.Role.LABEL)
            group = header.get_parent() if header else None
            if check('group', group and group.get_role() == Atspi.Role.PANEL, 'group panel role'): return completed
            if check('group-label', group and labelled(group, 'General'), 'group header relation'): return completed
            toggle = find(root, 'Enable feature', Atspi.Role.TOGGLE_BUTTON)
            # Mutated roles are located by their row position, so switch-role has
            # its own assertion rather than failing row-label first.
            control = next(n for n in nodes if n.get_name() in ('Enable feature', 'Wrong label')
                           and state(n, Atspi.StateType.FOCUSABLE))
            if check('row-label', labelled(control, 'Enable feature'), 'row control label relation'): return completed
            if check('switch-role', control.get_role() == Atspi.Role.TOGGLE_BUTTON, 'toggle-button role'): return completed
            if check('switch-name', toggle and toggle.get_name() == 'Enable feature', 'accessible switch name'): return completed
            button = find(root, 'Scroll away')
            # Prefer the control over its sibling label, even when role is broken.
            button = next((n for n in nodes if n.get_name() == 'Scroll away'
                           and state(n, Atspi.StateType.FOCUSABLE)), button)
            if check('button', button and button.get_role() == Atspi.Role.PUSH_BUTTON, 'push-button role/name'): return completed
            if check('hidden', find(root, 'Hidden feature') is None, 'hidden row remains in tree'): return completed
            if check('at-rest', toggle and state(toggle, Atspi.StateType.SHOWING)
                     and state(button, Atspi.StateType.SHOWING), 'normal controls are outside the viewport at rest'): return completed
            if stop is None or stop == 'tab':
                order = [n for n in walk(root) if state(n, Atspi.StateType.FOCUSABLE)]
                published(lambda: order[0].get_component_iface().grab_focus())
                observed = []
                for expected in order[1:] + order[:1]:
                    key(15)
                    current = [n for n in order if state(n, Atspi.StateType.FOCUSED)]
                    observed.append([n.get_name() for n in current])
                key(15, shift=True)
                backwards = [n.get_name() for n in order if state(n, Atspi.StateType.FOCUSED)]
                if check('tab', observed == [[n.get_name()] for n in order[1:] + order[:1]]
                         and backwards == [order[-1].get_name()], 'Tab/Shift+Tab order or unique focus'): return completed
            if stop is None or stop == 'checked':
                published(lambda: toggle.get_component_iface().grab_focus())
                key(57)
                if check('checked', state(toggle, Atspi.StateType.CHECKED), 'Space did not publish checked'): return completed
            if stop is None or stop in ('offscreen', 'reveal'):
                action('Reset scroll')
                last = find(root, 'Extra feature 19', Atspi.Role.TOGGLE_BUTTON)
                if check('offscreen', last and state(last, Atspi.StateType.VISIBLE)
                         and not state(last, Atspi.StateType.SHOWING), 'offscreen row not retained/visible/non-showing'): return completed
            if stop is None or stop == 'reveal':
                published(lambda: last.get_component_iface().grab_focus())
                if check('reveal', state(last, Atspi.StateType.SHOWING), 'focused row was not scrolled into view'): return completed
            probe = find(root, 'Probe', Atspi.Role.TOGGLE_BUTTON).get_parent()
            if stop is None or stop == 'under-sidebar':
                action('Under sidebar')
                probe = find(root, 'Probe', Atspi.Role.TOGGLE_BUTTON).get_parent()
                bounds = probe.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
                sidebar_bounds = sidebar.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
                if check('under-sidebar', state(probe, Atspi.StateType.VISIBLE)
                         and not state(probe, Atspi.StateType.SHOWING)
                         and bounds.x + bounds.width <= sidebar_bounds.width,
                         'row under sidebar reported SHOWING or fixture not occluded'): return completed
            if stop is None or stop == 'under-title':
                action('Under title')
                if check('under-title', state(probe, Atspi.StateType.VISIBLE)
                         and not state(probe, Atspi.StateType.SHOWING), 'row under title reported SHOWING'): return completed
            windows = ipc('windows')['windows']
            window = next(w for w in windows if w['app_id'] == 'nk-widgets-demo')
            (directory / 'windows.json').write_text(json.dumps(windows, indent=2))
            # D7 observability is supplied by Claude's Hyalo change. This is
            # deliberately strict: layer-shell's `msg layers` is NOT this protocol.
            layers = window.get('layers', [])
            panes = [sidebar.get_component_iface().get_extents(Atspi.CoordType.WINDOW),
                     find(root, 'Widget foundations', Atspi.Role.LABEL).get_component_iface().get_extents(Atspi.CoordType.WINDOW)]
            matches = lambda layer, pane: all(abs(layer.get(key, -100000) - getattr(pane, key)) <= 1
                                             for key in ('x', 'y', 'width', 'height')) and layer.get('glass_shapes', 0) > 0
            if check('layers', len(layers) == 2 and all(any(matches(layer, pane) for layer in layers) for pane in panes),
                     'sidebar/titlebar are not two committed material layers at their widget bounds'): return completed
            return completed
        except OracleFailure as error:
            if not fault or error.stage != stop:
                raise
            applied = f'CONTROL_APPLIED {fault}' in text()
            if not applied:
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
try:
    ipc('do', 'workspace', 94)
    ipc('do', 'set-workspace-mode', 94, 'floating')
    selected = os.environ.get('NK_WIDGETS_STAGES', '').split()
    stages = selected or STAGES + NEW_STAGES
    for SCALE in (1, 1.25):
        ipc('output', output['name'], f'scale={SCALE}')
        if selected:
            for stage in stages:
                run(stop=stage)
        else:
            run()
            for stage in NEW_STAGES:
                run(stop=stage)
        for stage in stages:
            result = run(fault=stage, stop=stage)
            if result != 'CAUGHT':
                raise InfrastructureError(f'{stage}: control passed its assertion')
            print(f'scale{SCALE} {stage}: baseline PASS, applied control CAUGHT', flush=True)
    (LOG / 'result.json').write_text(json.dumps({'stages': stages, 'scales': [1, 1.25],
                                              'controls': 'all caught'}, indent=2))
finally:
    try:
        ipc('output', output['name'], f"scale={output['scale']}")
        ipc('do', 'workspace', workspace)
    finally:
        registry.terminate()
        registry.wait(timeout=3)
        registry_log.close()
        PIPE.close()
