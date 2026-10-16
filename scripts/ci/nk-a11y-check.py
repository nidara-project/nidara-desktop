#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Test 3 from an AT-SPI client, on a private test Hyalo (never the live bus).
The app's model/log is not the oracle. Keyboard uses HYALO_CONTROL; Unicode
comes through input-method-v2. Every broken path must fail its named assertion.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ.get('NK_PHASE0_LOG', '/tmp/hyalo/nk-phase0')) / 'a11y'
LOG.mkdir(parents=True, exist_ok=True)
BIN = os.environ.get('NK_PHASE0_BIN', str(ROOT / 'toolkit/target/release/nk-phase0'))
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
PIPE = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)
EVENTS = []
SOURCES = {}


def pump(seconds=.05):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(.005)


def wait(test, stage, seconds=5):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump()
        result = test()
        if result:
            return result
    raise AssertionError(stage)


def control(command):
    PIPE.write(command + '\n')
    PIPE.flush()
    pump(.1)


def key(code):
    control(f'key {code}')


def chord(modifiers, code):
    for mod in modifiers:
        control(f'keydown {mod}')
    key(code)
    for mod in reversed(modifiers):
        control(f'keyup {mod}')


def children(node):
    node.clear_cache()
    return [node.get_child_at_index(i) for i in range(node.get_child_count())]


def walk(node):
    result=[]
    todo=[node]
    while todo:
        current=todo.pop(0)
        result.append(current)
        SOURCES[hash(current)] = (current.get_name(), current)
        todo.extend(c for c in children(current) if c)
    return result


def app_tree():
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            for node in walk(app):
                if node.get_name() == 'Nidara accessibility form':
                    return node
        except GLib.Error:
            continue
    return None


def named(root, name):
    return next((n for n in walk(root) if n.get_name() == name), None)


def focused(root):
    return next((n for n in walk(root) if n.get_state_set().contains(Atspi.StateType.FOCUSED)), None)


def focus_is(root, name, role):
    n = focused(root)
    return n and n.get_name() == name and n.get_role() == role


def event(event, *_):
    try:
        EVENTS.append({'type': event.type, 'name': SOURCES.get(hash(event.source), ('?', None))[0],
                       'detail1': event.detail1, 'detail2': event.detail2,
                       'data': str(event.any_data)})
    except GLib.Error:
        pass


# Start the registry explicitly. On a developer machine its service file may
# delegate to the LIVE systemd user manager, which is outside this private bus.
session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus',
                           'GetAddress', None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
os.environ['AT_SPI_BUS_ADDRESS'] = address
registry_path = next(p for p in [Path('/usr/lib/at-spi2-registryd'),Path('/usr/libexec/at-spi2-registryd')] if p.exists())
registry_log = (LOG/'registry.log').open('w')
registry = subprocess.Popen([str(registry_path)],stdout=registry_log,stderr=registry_log)
private_bus=Gio.DBusConnection.new_for_address_sync(address,Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
wait(lambda: private_bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',('org.a11y.atspi.Registry',)),GLib.VariantType.new('(b)'),Gio.DBusCallFlags.NONE,1000,None).unpack()[0], 'registry start')
listener = Atspi.EventListener.new(event)
for category in ['object:text-changed', 'object:text-caret-moved',
                 'object:text-selection-changed', 'object:state-changed',
                 'object:children-changed', 'object:property-change',
                 'window:activate', 'window:deactivate']:
    assert listener.register(category), category
session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties',
                  'Set', GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))),
                  None, Gio.DBusCallFlags.NONE, 5000, None)

STAGES = ['tree', 'name', 'role', 'geometry', 'active', 'focus', 'text', 'caret', 'selection', 'password',
          'expanded', 'dropdown', 'collapse', 'state', 'dialog', 'error', 'restore', 'action']


def run(backend, broken=None, stop=None):
    directory = LOG / (backend + '-' + (broken or 'baseline'))
    directory.mkdir(exist_ok=True)
    EVENTS.clear()
    output = (directory / 'client.log').open('w')
    app = subprocess.Popen([BIN, '--a11y', backend, *([f'--control-a11y={broken}'] if broken else [])], stdout=output, stderr=output)
    ime = None
    completed = {}
    costs = {}
    def check(stage, predicate):
        try:
            wait(predicate, stage)
            completed[stage]='PASS'
        except AssertionError:
            completed[stage]='FAIL'
            if stop==stage or stage not in ('expanded','error'):
                raise
        if stop == stage:
            raise StopIteration
    try:
        root = wait(app_tree, 'tree', 10)
        check('tree', lambda: root.get_child_count() >= 5)
        if not broken: subprocess.run([*MSG,'screenshot',str(directory/'form.png')],check=True,stdout=subprocess.DEVNULL)
        pump(.5)
        costs['rss_kib']=int(next(l.split()[1] for l in Path(f'/proc/{app.pid}/status').read_text().splitlines() if l.startswith('VmRSS:')))
        (directory / 'tree.json').write_text(json.dumps([
            {'name': n.get_name(), 'role': n.get_role_name(), 'states': [str(s) for s in n.get_state_set().get_states()]}
            for n in walk(root)], ensure_ascii=False, indent=2))
        check('name', lambda: named(root, 'Name'))
        check('role', lambda: named(root, 'Remember me').get_role() == Atspi.Role.CHECK_BOX)
        def geometry():
            r=Atspi.Component.get_extents(named(root,'Name').get_component_iface(), Atspi.CoordType.WINDOW)
            return r.x==44 and r.y==56 and r.width>300 and r.height==54
        check('geometry',geometry)
        # Orca rejects focus inside a frame that is not ACTIVE (#835), and learns it
        # from window:activate, not only from a state it would have to poll.
        check('active', lambda: root.get_state_set().contains(Atspi.StateType.ACTIVE)
              and any(e['type']=='window:activate' for e in EVENTS))
        roles = [('Name', Atspi.Role.ENTRY), ('Password', Atspi.Role.PASSWORD_TEXT),
                 ('Language', Atspi.Role.COMBO_BOX), ('Remember me', Atspi.Role.CHECK_BOX), ('Review', Atspi.Role.PUSH_BUTTON)]
        # Password's control deliberately exposes ordinary text; test privacy,
        # not the earlier role assertion, when testing that negative control.
        if broken != 'password':
            assert all(named(root, name).get_role() == role for name, role in roles), 'role'
        for name, role in roles[1:] + roles[:1]:
            key(15)
            if broken == 'password' and name == 'Password':
                continue
            wait(lambda: focus_is(root, name, role), 'focus')
        check('focus', lambda: focus_is(root, 'Name', Atspi.Role.ENTRY))
        name = named(root, 'Name')
        text = name.get_text_iface()
        assert text is not None, 'text'
        # Japanese + non-BMP emoji enter through the real text-input-v3 bridge.
        ime_log = (directory / 'ime.log').open('w')
        ime = subprocess.Popen(['hyalo-ime-probe', '--script'], stdin=subprocess.PIPE, stdout=ime_log, stderr=ime_log, text=True)
        wait(lambda: 'STATE 1 ' in (directory/'ime.log').read_text(), 'text')
        def commit(value):
            ime.stdin.write('commit ' + value + '\n')
            ime.stdin.flush()
            wait(lambda: 'SENT commit '+value in (directory/'ime.log').read_text(), 'text')
        EVENTS.clear()
        commit('日本🙂 word')
        check('text', lambda: Atspi.Text.get_text(text, 0, -1) == '日本🙂 word' and any(
            e['name'] == 'Name' and e['type'].startswith('object:text-changed:insert')
            and e['detail1'] == 0 and e['detail2'] == 8 and '日本🙂 word' in e['data'] for e in EVENTS))
        before = len(EVENTS)
        key(14)  # delete d, a character offset of 7 (not byte 14)
        wait(lambda: Atspi.Text.get_text(text, 0, -1) == '日本🙂 wor', 'caret')
        wait(lambda: any(e['type'].startswith('object:text-changed:delete') and e['name']=='Name'
                         and e['detail1']==7 and e['detail2']==1 for e in EVENTS[before:]), 'caret')
        check('caret', lambda: text.get_caret_offset()==7 and any(e['name']=='Name' and e['type']=='object:text-caret-moved' and e['detail1']==7 for e in EVENTS[before:]))
        costs['events_per_backspace'] = len([e for e in EVENTS[before:] if e['name']=='Name'])
        key(32)  # correct d
        wait(lambda: Atspi.Text.get_text(text, 0, -1)=='日本🙂 word', 'selection')
        before=len(EVENTS)
        chord([29,42],105)  # Ctrl+Shift+Left selects word
        check('selection', lambda: text.get_n_selections()==1 and (Atspi.Text.get_selection(text,0).start_offset,Atspi.Text.get_selection(text,0).end_offset)==(4,8)
              and any(e['name']=='Name' and e['type']=='object:text-selection-changed' for e in EVENTS[before:]))
        word = text.get_string_at_offset(5, Atspi.TextGranularity.WORD)
        assert word.content == 'word' and word.start_offset == 4 and word.end_offset == 8, 'selection'
        key(15)
        password = named(root,'Password')
        before=len(EVENTS)
        for code in [31,18,46,19,18,20]: key(code)  # secret
        def private():
            for n in walk(root):
                if 'secret' in n.get_name() or 'secret' in n.get_description(): return False
                t=n.get_text_iface()
                if t and 'secret' in Atspi.Text.get_text(t, 0,-1): return False
            t=password.get_text_iface()
            if t and t.get_character_count()!=0: return False
            return not any('secret' in e['data'] or (e['name']=='Password' and e['type'].startswith(('object:text-changed','object:text-caret-moved'))) for e in EVENTS[before:])
        # Negative assertions get a settling interval; waiting for a transient
        # absence could pass before asynchronous events arrive.
        pump(.3)
        assert private(), 'password'
        completed['password']='PASS'
        if stop=='password': raise StopIteration
        key(15);key(57)  # Language, Space opens
        check('expanded', lambda: named(root,'Language').get_state_set().contains(Atspi.StateType.EXPANDED))
        if not broken: subprocess.run([*MSG,'screenshot',str(directory/'dropdown.png')],check=True,stdout=subprocess.DEVNULL)
        key(108)
        check('dropdown',lambda: named(root,'Chinese') and named(root,'Chinese').get_state_set().contains(Atspi.StateType.SELECTED))
        key(28)
        check('collapse', lambda: named(root,'Language').get_child_count()==0)
        key(15);key(57)
        check('state',lambda: named(root,'Remember me').get_state_set().contains(Atspi.StateType.CHECKED))
        key(15);key(28)
        check('dialog',lambda: named(root,'Correct error') and named(root,'Correct error').get_role()==Atspi.Role.DIALOG)
        check('error',lambda: focus_is(root,'Confirmation',Atspi.Role.ENTRY) and named(root,'Confirmation').get_state_set().contains(Atspi.StateType.INVALID_ENTRY))
        if not broken: subprocess.run([*MSG,'screenshot',str(directory/'dialog.png')],check=True,stdout=subprocess.DEVNULL)
        # Invalid Save must keep the dialog and allow returning to the error.
        key(15);key(28)
        assert named(root,'Correct error'), 'error'
        chord([42],15)
        chord([29],30)
        for code in [46,24,19,19,18,46,20]: key(code)  # correct
        wait(lambda: Atspi.Text.get_text(named(root,'Confirmation').get_text_iface(),0,-1)=='correct','error')
        key(15);key(28)
        check('restore',lambda: named(root,'Correct error') is None and focus_is(root,'Review',Atspi.Role.PUSH_BUTTON))
        chord([42],15)
        wait(lambda: focus_is(root,'Remember me',Atspi.Role.CHECK_BOX),'restore')
        assert named(root,'Remember me').get_action_iface().do_action(0),'action'
        check('action',lambda: not named(root,'Remember me').get_state_set().contains(Atspi.StateType.CHECKED))
        # Close by Escape in a second dialog, then verify the opener again.
        key(15);key(28)
        wait(lambda: focus_is(root,'Confirmation',Atspi.Role.ENTRY),'restore')
        key(1)
        wait(lambda:named(root,'Correct error') is None and focus_is(root,'Review',Atspi.Role.PUSH_BUTTON),'restore')
        # An AT's EditableText request goes through the same app callback.
        assert named(root,'Name').get_editable_text_iface().set_text_contents('AT 日本🙂'),'action'
        wait(lambda:Atspi.Text.get_text(named(root,'Name').get_text_iface(),0,-1)=='AT 日本🙂','action')
        logs=(directory/'client.log').read_text()
        costs['init']=next((l for l in logs.splitlines() if l.startswith('A11Y_INIT')),'')
        return completed,costs
    except AssertionError:
        try:
            (directory/'failure-tree.json').write_text(json.dumps([{'name':n.get_name(),'role':n.get_role_name(),'states':[str(s) for s in n.get_state_set().get_states()]} for n in walk(root)],ensure_ascii=False,indent=2))
            subprocess.run([*MSG,'screenshot',str(directory/'failure.ppm')],check=True,stdout=subprocess.DEVNULL)
        except Exception:pass
        raise
    except StopIteration:
        return completed,costs
    finally:
        (directory/'checks.json').write_text(json.dumps(completed,indent=2))
        (directory/'events.json').write_text(json.dumps(EVENTS,ensure_ascii=False,indent=2))
        if ime:
            ime.terminate();ime.wait(timeout=5)
        app.terminate();app.wait(timeout=5);output.close()
        pump(.2)


def main():
    (LOG/'environment.json').write_text(json.dumps({
        'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),
        'atspi':subprocess.check_output(['pkg-config','--modversion','atspi-2'],text=True).strip(),
        'binary':BIN, 'binary_sha256':hashlib.sha256(Path(BIN).read_bytes()).hexdigest(), 'source_base':subprocess.check_output(['git','-c','safe.directory=*','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip(),
        'hyalo_binary':MSG[0],
        'hyalo_binary_sha256':hashlib.sha256(Path(MSG[0]).read_bytes()).hexdigest() if Path(MSG[0]).is_file() else 'see PATH',
        'cargo_lock_sha256':hashlib.sha256((ROOT/'toolkit/Cargo.lock').read_bytes()).hexdigest()
    },indent=2))
    report={}
    failures=[]
    # Same form/layout/pixels, without either platform adapter. Sample after map.
    with (LOG/'no-backend.log').open('w') as stream:
        baseline=subprocess.Popen([BIN,'--a11y','none'],stdout=stream,stderr=stream)
    try:
        wait(lambda:'FIRST_FRAME_CALLBACK_MS' in (LOG/'no-backend.log').read_text(),'cost baseline',10)
        pump(.5)
        baseline_rss=int(next(l.split()[1] for l in Path(f'/proc/{baseline.pid}/status').read_text().splitlines() if l.startswith('VmRSS:')))
    finally:
        baseline.terminate();baseline.wait(timeout=5);pump(.2)

    controls=['tree','name','role','geometry','active','focus','text','caret','selection','password','expanded','dropdown','collapse','state','dialog','error','restore','action']
    for backend in os.environ.get('NK_A11Y_BACKENDS','atspi').split():
        report[backend]={'controls':{},'checks':{},'costs':{}}
        if os.environ.get('NK_A11Y_CONTROLS','1')!='0':
            for stage in controls:
                try:
                    run(backend,stage,stage)
                except AssertionError as e:
                    if str(e)==stage:
                        report[backend]['controls'][stage]='caught'
                        continue
                    failures.append(f'{backend} control {stage} failed at {e}')
                except Exception as e:
                    failures.append(f'{backend} control {stage}: {e!r}')
                else:
                    failures.append(f'{backend} control {stage} was not caught')
                report[backend]['controls'][stage]='FAIL'
        try:
            completed,costs=run(backend)
            report[backend]['checks']=completed
            for stage,status in completed.items():
                if status!='PASS' and report[backend]['controls'].get(stage)=='caught':
                    report[backend]['controls'][stage]='FAIL: baseline also fails; discrimination not proved'
            failures.extend(f'{backend} {stage}: FAIL' for stage,status in completed.items() if status!='PASS')
            costs['no_backend_rss_kib']=baseline_rss
            costs['rss_added_kib']=costs['rss_kib']-baseline_rss
            report[backend]['costs']=costs
        except Exception as e:
            failures.append(f'{backend} baseline: {e!r}')
            report[backend]['checks']=json.loads((LOG/(backend+'-baseline')/'checks.json').read_text())
            report[backend]['checks']['fatal']=f'FAIL: {e!r}'
    (LOG/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
    if failures:
        raise AssertionError('\n'.join(failures))

if __name__=='__main__':
    try:main()
    finally:
        registry.terminate(); registry.wait(timeout=5)
