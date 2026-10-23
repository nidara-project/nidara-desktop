#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Shared-provider/controller diagnostic, not real Orca/Config1 acceptance."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
BIN = Path(os.environ['NK_WIDGETS_BIN']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('private runtime required')
if Path('/tmp') in LOG.parents or any(p.name not in {'cage.log', 'hyalo.log', 'check.log'} for p in LOG.iterdir()):
    raise RuntimeError('fresh evidence outside /tmp required')
(LOG / 'environment.json').write_text(json.dumps({'parent_revision': subprocess.check_output(['git', '-c', 'safe.directory=*', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(), 'probe_sha256': hashlib.sha256(BIN.read_bytes()).hexdigest(), 'hyalo_sha256': hashlib.sha256(Path(os.environ['HYALO_BIN']).read_bytes()).hexdigest()}, indent=2))
def wait(test, label):
    end = time.monotonic() + 8
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(.01)
    raise RuntimeError('setup timeout: ' + label)
def children(node):
    node.clear_cache()
    return [node.get_child_at_index(i) for i in range(node.get_child_count())]
def walk(node):
    result = [node]
    for child in children(node):
        if child:
            result.extend(walk(child))
    return result
def apps():
    return [a for a in children(Atspi.get_desktop(0)) if a.get_name() == 'Dropdown provider probe']
def state(node, value):
    node.clear_cache()
    return node.get_state_set().contains(value)
def ids(root):
    return sorted(n.get_attributes()['nidara-node-id'] for n in walk(root))
session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
os.environ['AT_SPI_BUS_ADDRESS'] = address
registry_path = next(p for p in [Path('/usr/lib/at-spi2-registryd'), Path('/usr/libexec/at-spi2-registryd')] if p.exists())
registry_log = (LOG / 'registry.log').open('w')
registry = subprocess.Popen([str(registry_path)], stdout=registry_log, stderr=registry_log)
private_bus = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
wait(lambda: private_bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)), GLib.VariantType.new('(b)'), Gio.DBusCallFlags.NONE, 1000, None).unpack()[0], 'registry')

def run(stage, fault=''):
    stem = stage + ('-' + fault if fault else '-baseline')
    log, finish, abort = [LOG / (stem + suffix) for suffix in ('.log', '.finish', '.abort')]
    with log.open('w') as out, open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        process = subprocess.Popen([str(BIN)], stdout=out, stderr=out, env={**os.environ, 'WAYLAND_DEBUG': 'client', 'NK_DROPDOWN_FAULT': fault, 'NK_DROPDOWN_FINISH': str(finish), 'NK_DROPDOWN_ABORT': str(abort)})
        try:
            wait(lambda: 'PARENT_READY' in log.read_text(), 'parent commit')
            app = wait(lambda: next(iter(apps()), None), 'provider')
            app.set_cache_mask(Atspi.Cache.NONE)
            root = children(app)[0]
            combo = next(n for n in walk(root) if n.get_role() == Atspi.Role.COMBO_BOX)
            old_ids = ids(root)
            pipe.write('key 15\nkey 28\n')
            wait(lambda: state(combo, Atspi.StateType.EXPANDED), 'modal snapshot')
            open_ids = ids(root)
            app_count = len(apps())
            # Inspect current snapshot; do not await the focus/value being tested.
            focused = [n.get_name() for n in walk(root) if state(n, Atspi.StateType.FOCUSED)]
            first = children(combo)[0]
            bounds = Atspi.Component.get_extents(first.get_component_iface(), Atspi.CoordType.WINDOW)
            configured = re.findall(r'<- xdg_popup[^\n]*\.configure, \((-?\d+), (-?\d+), (\d+), (\d+)\)', log.read_text())
            if not configured:
                raise RuntimeError('no popup configure geometry')
            x, y, width, height = map(int, configured[-1])
            geometry_ok = bounds.x >= x and bounds.y >= y and bounds.x + bounds.width <= x + width and bounds.y + bounds.height <= y + height and bounds.width > 0 and bounds.height > 0
            if stage == 'cancel':
                pipe.write('key 108\nkey 1\n')
            else:
                if stage == 'invalidate':
                    abort.write_text('external model/visibility invalidated\n')
                accepted = Atspi.Selection.select_child(combo.get_selection_iface(), 1)
                if stage == 'select' and not accepted:
                    raise RuntimeError('SelectChild not accepted by provider')
            wait(lambda: 'PARENT_RESULT' in log.read_text() and 'PARENT_PUBLISHED' in log.read_text(), 'completed input, new parent commit and publication')
            combo.clear_cache()
            selected = Atspi.Selection.get_selected_child(combo.get_selection_iface(), 0).get_name()
            final_ids = ids(root)
            collapsed = not state(combo, Atspi.StateType.EXPANDED)
            restored_focus = state(combo, Atspi.StateType.FOCUSED)
            raw = log.read_text()
            finish.write_text('observation complete\n')
            process.wait(timeout=8)
            if process.returncode:
                raise RuntimeError('probe process failed')
            if fault and 'CONTROL_APPLIED ' + fault not in raw:
                raise RuntimeError('fault branch was not applied: ' + fault)
            wait(lambda: not apps(), 'provider removal')
            assert geometry_ok, 'modal option bounds do not use configured parent-relative popup geometry'
            assert app_count == 1 and old_ids == open_ids == final_ids, 'provider or semantic IDs changed across popup'
            assert focused == ['English'], 'modal option focus was not published uniquely'
            assert collapsed, 'dismissal did not collapse combo'
            assert re.search(r'xdg_popup[^\n]*\.grab\(', raw), 'no physical popup grab'
            expected = 'Español' if stage == 'select' else 'English'
            assert selected == expected, stage + ' selected wrong value: ' + selected
            assert restored_focus == (stage != 'invalidate'), 'dismissal restored an invalidated trigger or lost available focus'
            return {'setup_complete': True, 'selected': selected, 'one_provider': True, 'stable_ids': True, 'restored_focus': restored_focus}
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
results = {}
try:
    if os.environ.get('NK_DROPDOWN_BUILDER') == '1':
        sys.dont_write_bytecode = True
        from nk_dropdown_builder_check import check_builder
        results = check_builder(globals())
    for stage, fault in ([] if os.environ.get('NK_DROPDOWN_BUILDER') == '1' else [('select', 'ignore-selection'), ('cancel', 'commit-on-cancel'), ('invalidate', 'ignore-invalidation')]):
        results[stage] = {'baseline': run(stage)}
        try:
            run(stage, fault)
        except AssertionError as error:
            if not str(error).startswith(stage + ' selected wrong value:'):
                raise
            results[stage]['control'] = {'setup_complete': True, 'caught': str(error)}
        else:
            raise AssertionError('control escaped its own ' + stage + ' assertion')
    (LOG / 'oracles.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results))
finally:
    registry.terminate()
    registry.wait(timeout=5)
    registry_log.close()
