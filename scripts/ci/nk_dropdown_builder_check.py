# SPDX-License-Identifier: LGPL-3.0-or-later
"""Real Config1/manifest/renderer composition in the existing private native harness."""
import json
import os
import subprocess
from gi.repository import Gio, GLib, Atspi

KEY = 'appearance.cursorTheme'
XML = '''<node><interface name="org.nidara.Config1">
<method name="Snapshot"><arg direction="out" type="t"/><arg direction="out" type="t"/><arg direction="out" type="s"/></method>
<method name="Apply"><arg direction="in" type="s"/><arg direction="in" type="v"/><arg direction="out" type="t"/><arg direction="out" type="v"/></method>
<signal name="Updated"><arg type="t"/><arg type="t"/><arg type="a{sv}"/></signal>
</interface></node>'''


def check_builder(h):
    # Reuse the established registry/runtime/geometry helpers and process isolation.
    wait, walk, children, state, apps, ids = [h[k] for k in ('wait', 'walk', 'children', 'state', 'apps', 'ids')]
    logdir, binary, bus = h['LOG'], h['BIN'], h['session']
    dbus_args = ('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus')
    owned = bus.call_sync(*dbus_args, 'NameHasOwner', GLib.Variant('(s)', ('org.nidara.Config',)), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if owned:
        raise RuntimeError('private Config1 name is already owned')
    fixture = {}

    def call(connection, sender, path, interface, method, params, invocation):
        if method == 'Snapshot':
            fixture['snapshots'] += 1
            schema = {'schemaVersion': 1, 'keys': {KEY: {
                'type': 'enum', 'available': fixture['available'], 'writable': True,
                'value': fixture['value'], 'values': ['Adwaita', 'Qogir', 'Breeze'],
                'ui': {'control': 'dropdown', 'title': 'Cursor', 'subtitle': 'Choose cursor',
                       'options': [{'value': v, 'label': label} for v, label in
                                   [('Adwaita', 'English'), ('Qogir', 'Español'), ('Breeze', '日本語')]]}}}}
            invocation.return_value(GLib.Variant('(tts)', (41, fixture['revision'], json.dumps(schema))))
        elif method == 'Apply':
            key, value = params.unpack()
            fixture['calls'].append((key, value))
            if fixture['refuse']:
                invocation.return_dbus_error('org.nidara.Config1.Error.Invalid', 'fixture rejects this cursor')
            else:
                fixture['value'] = value
                fixture['revision'] += 1
                invocation.return_value(GLib.Variant('(tv)', (fixture['revision'], GLib.Variant('s', value))))
        else:
            invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)

    registration = bus.register_object('/org/nidara/Config', Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], call, None, None)
    reply = bus.call_sync(*dbus_args, 'RequestName', GLib.Variant('(su)', ('org.nidara.Config', 4)), None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if reply != 1:
        raise RuntimeError('Config1 name was not acquired')

    def run(stage, fault=''):
        if stage == 'portal':
            bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.nidara.TestPortal', 'ChangeScale', GLib.Variant('(d)', (1.0,)), None, Gio.DBusCallFlags.NONE, 3000, None)
        fixture.clear()
        fixture.update(value='Adwaita', revision=1, available=True, calls=[], snapshots=0, refuse=stage == 'refuse')
        stem = 'builder-' + stage + ('-' + fault if fault else '-baseline')
        log, finish = logdir / (stem + '.log'), logdir / (stem + '.finish')
        with log.open('w') as out, open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
            process = subprocess.Popen([str(binary)], stdout=out, stderr=out, env={**os.environ, 'WAYLAND_DEBUG': 'client', 'NK_DROPDOWN_FAULT': fault, 'NK_DROPDOWN_FINISH': str(finish)})
            try:
                wait(lambda: 'PARENT_READY' in log.read_text(), 'builder parent commit')
                app = wait(lambda: next(iter(apps()), None), 'builder provider')
                app.set_cache_mask(Atspi.Cache.NONE)
                root = children(app)[0]
                combo = next(n for n in walk(root) if n.get_role() == Atspi.Role.COMBO_BOX)
                before_ids = ids(root)
                combo_id = combo.get_attributes()['nidara-node-id']
                assert not fixture['calls'], 'initial schema read wrote Config1'
                pipe.write('key 15\nkey 28\n')
                wait(lambda: state(combo, Atspi.StateType.EXPANDED), 'builder modal publication')
                open_ids, provider_count = ids(root), len(apps())
                focused = [n.get_name() for n in walk(root) if state(n, Atspi.StateType.FOCUSED)]
                offset = len(log.read_text())
                if stage == 'cancel':
                    pipe.write('key 108\nkey 1\n')
                else:
                    if stage in ('updated', 'unavailable'):
                        fixture['revision'] = 3 if stage == 'unavailable' else 2
                        fixture['available'] = stage != 'unavailable'
                        if stage == 'updated':
                            fixture['value'] = 'Breeze'
                        # A revision gap forces a real fresh Snapshot for availability changes.
                        bus.emit_signal(None, '/org/nidara/Config', 'org.nidara.Config1', 'Updated', GLib.Variant('(tta{sv})', (41, fixture['revision'], {KEY: GLib.Variant('s', fixture['value'])})))
                        bus.flush_sync(None)
                        wait(lambda: 'CONFIG_POLLED' in log.read_text()[offset:], 'actual Client notice consumed')
                    elif stage == 'portal':
                        bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.nidara.TestPortal', 'ChangeScale', GLib.Variant('(d)', (1.125,)), None, Gio.DBusCallFlags.NONE, 3000, None)
                        wait(lambda: 'PORTAL_STAGED' in log.read_text()[offset:], 'actual portal signal consumed')
                    # If invalidation already closed it there is no active modal selection.
                    if state(combo, Atspi.StateType.EXPANDED):
                        Atspi.Selection.select_child(combo.get_selection_iface(), 1)
                def completed():
                    raw = log.read_text()[offset:]
                    return 'MODAL_RETURN' in raw and 'PARENT_RESULT' in raw and 'pending=false' in raw and 'PARENT_PUBLISHED' in raw
                wait(completed, 'builder input close, pending end, parent commit and publication')
                raw = log.read_text()
                # Snapshot current state only after independent transport/commit completion.
                selected = Atspi.Selection.get_selected_child(combo.get_selection_iface(), 0).get_name() if stage != 'unavailable' else None
                final_ids = ids(root)
                live_combo = next((n for n in walk(root) if n.get_attributes()['nidara-node-id'] == combo_id), None)
                collapsed = live_combo is None or not state(live_combo, Atspi.StateType.EXPANDED)
                restored = live_combo is not None and state(live_combo, Atspi.StateType.FOCUSED)
                names = [n.get_name() for n in walk(root)]
                calls = list(fixture['calls'])
                value, snapshots = fixture['value'], fixture['snapshots']
                finish.write_text('observation complete\n')
                process.wait(timeout=8)
                if process.returncode:
                    raise RuntimeError('builder process failed: ' + raw[-1500:])
                if fault and 'CONTROL_APPLIED ' + fault not in raw:
                    raise RuntimeError('fault was not applied')
                wait(lambda: not apps(), 'builder provider removal')
                expected_calls = 1 if stage in ('select', 'refuse') else 0
                assert len(calls) == expected_calls, stage + ' unexpected Apply count: ' + str(calls)
                assert value == ('Qogir' if stage == 'select' else 'Breeze' if stage == 'updated' else 'Adwaita'), 'wrong canonical Config1 value'
                assert collapsed, 'builder modal remains expanded'
                assert provider_count == 1 and before_ids == open_ids, 'builder changed IDs/provider when opening'
                if stage != 'unavailable':
                    assert final_ids == before_ids, 'builder replaced semantic IDs'
                    assert selected == ('Español' if stage == 'select' else '日本語' if stage == 'updated' else 'English'), 'wrong retained selected label'
                else:
                    assert combo_id not in final_ids and snapshots >= 2, 'unavailable schema did not hide row through fresh Snapshot'
                assert focused == ['English'], 'builder modal focus is not unique'
                assert restored == (stage in ('select', 'cancel', 'refuse')), 'focus restored to invalidated trigger'
                if stage == 'refuse':
                    assert 'fixture rejects this cursor' in names, 'Config1 refusal error was lost'
                if stage == 'portal':
                    assert 'PORTAL_APPLIED' in raw, 'staged appearance was not applied after modal return'
                return {'setup_complete': True, 'apply_calls': calls, 'canonical': value, 'selected': selected, 'restored_focus': restored, 'snapshots': snapshots, 'stable_ids_on_open': True, 'one_provider': True}
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)

    try:
        stages = os.environ.get('NK_DROPDOWN_BUILDER_STAGES', 'select,cancel,refuse,updated,unavailable,portal').split(',')
        if not set(stages) <= {'select', 'cancel', 'refuse', 'updated', 'unavailable', 'portal'}:
            raise RuntimeError('unknown builder stage')
        results = {}
        for stage in stages:
            results[stage] = {'baseline': run(stage)}
            (logdir / 'builder-partial.json').write_text(json.dumps(results, indent=2))
        for stage, fault in [('updated', 'ignore-config'), ('portal', 'ignore-portal')]:
            if stage not in stages:
                continue
            try:
                run(stage, fault)
            except AssertionError as error:
                if not str(error).startswith(stage + ' unexpected Apply count:'):
                    raise
                results[stage]['control'] = {'setup_complete': True, 'caught': str(error)}
            else:
                raise AssertionError('control escaped its own ' + stage + ' assertion')
        return results
    finally:
        bus.unregister_object(registration)
        bus.call_sync(*dbus_args, 'ReleaseName', GLib.Variant('(s)', ('org.nidara.Config',)), None, Gio.DBusCallFlags.NONE, 3000, None)
