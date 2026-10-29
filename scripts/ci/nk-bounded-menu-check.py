#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Local action-menu acceptance on disposable Cage/Hyalo, with applied controls."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
ROOT = Path(__file__).resolve().parents[2]
LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
BIN = Path(os.environ['NK_WIDGETS_BIN']).resolve()
HYALO = Path(os.environ['HYALO_BIN']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('private headless runtime required')
if LOG == Path('/tmp') or Path('/tmp') in LOG.parents:
    raise RuntimeError('evidence must stay on disk outside /tmp')
(LOG / 'environment.json').write_text(json.dumps({'revision': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(), 'probe_sha256': hashlib.sha256(BIN.read_bytes()).hexdigest(), 'hyalo_sha256': hashlib.sha256(HYALO.read_bytes()).hexdigest()}, indent=2))

def pump():
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)

def wait(fn, label, process=None, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump()
        result = fn()
        if result:
            return result
        if process is not None and process.poll() is not None:
            raise RuntimeError(f'probe exited before {label}: {process.returncode}')
        time.sleep(.02)
    raise RuntimeError('setup/publication timeout: ' + label)

def children(node):
    node.clear_cache()
    return [node.get_child_at_index(i) for i in range(node.get_child_count())]

def state(node, flag):
    node.clear_cache()
    return node.get_state_set().contains(flag)

def msg(*args):
    process = subprocess.run([str(HYALO), 'msg', *map(str, args)], text=True, capture_output=True)
    if not process.stdout.strip():
        raise RuntimeError(f'IPC {args} unavailable: {process.stderr}')
    result = json.loads(process.stdout)
    if process.returncode:
        raise RuntimeError(f'IPC {args}: {result} {process.stderr}')
    if 'error' in result:
        raise RuntimeError(result)
    return result['ok']

def find_root():
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            if app.get_name() == 'Bounded menu probe':
                return next((n for n in children(app) if n and n.get_name() == 'Bounded menu probe'), None)
        except GLib.Error:
            pass
    return None

def menus(root):
    return [n for n in children(root) if n and n.get_role() == Atspi.Role.MENU]

def frames(text):
    return re.findall(r'MENU_FRAME.*geometry=\[(-?\d+), (-?\d+), (\d+), (\d+)\] viewport=Rect \{ x: [^,]+, y: [^,]+, width: ([^,]+), height: ([^}]+) \}', text)

def geometry_by_id(text):
    return {int(i): list(map(int, (x,y,w,h))) for i,x,y,w,h in re.findall(r'MENU_FRAME id=PopupId\((\d+)\).*geometry=\[(-?\d+), (-?\d+), (\d+), (\d+)\]', text)}


session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
os.environ['AT_SPI_BUS_ADDRESS'] = address
registry_log = (LOG / 'registry.log').open('w')
registry = subprocess.Popen(['/usr/lib/at-spi2-registryd'], stdout=registry_log, stderr=registry_log)
private = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
wait(lambda: private.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)), None, Gio.DBusCallFlags.NONE, 1000, None).unpack()[0], 'registry')
reservation_file = LOG / 'reservations'
reservation_file.write_text('48 36')
reservation_log = (LOG / 'reservations.log').open('w')
preload = next(Path('/usr/lib').glob('libgtk4-layer-shell.so*'))
reservation = subprocess.Popen(['gjs', '-m', str(ROOT / 'scripts/ci/bounded-menu-reservations.js')], env={**os.environ, 'LD_PRELOAD': str(preload), 'GSK_RENDERER': 'cairo', 'GDK_DISABLE': 'dmabuf', 'NK_MENU_RESERVATIONS': str(reservation_file)}, stdout=reservation_log, stderr=reservation_log)

def layer_ready(top, bottom):
    try:
        layers = msg('layers')['layers']
    except RuntimeError:
        return False
    return any(l['namespace'] == 'bounded-menu-top' and l['height'] == top for l in layers) and any(l['namespace'] == 'bounded-menu-bottom' and l['height'] == bottom for l in layers)

wait(lambda: layer_ready(48, 36), 'real exclusive top/bottom layers', reservation)
PIPE = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)

def run(scale, fault=''):
    stem = f'scale-{scale}' + ('-' + fault if fault else '')
    output = msg('outputs')['outputs'][0]
    if output['scale'] != scale:
        msg('output', output['name'], f'scale={scale}')
    reservation_file.write_text('48 36')
    wait(lambda: layer_ready(48, 36), 'reset reservation')
    log = LOG / (stem + '.log')
    finish = LOG / (stem + '.finish')
    with log.open('w') as out:
        process = subprocess.Popen([str(BIN)], stdout=out, stderr=out, env={**os.environ, 'WAYLAND_DEBUG': 'client', 'NK_MENU_FINISH': str(finish), 'NK_MENU_FAULT': fault})
        def key(code):
            PIPE.write(f'key {code}\n')
            PIPE.flush()
        def text():
            return log.read_text()
        def barrier(send, tag=None):
            marker='RESULT_PUBLISHED '+tag if tag else 'A11Y_PUBLISHED'
            previous=text().count(marker)
            send()
            wait(lambda: text().count(marker) > previous, 'new provider publication '+marker, process)
        def key_barrier(code):
            symbols={28:65293,107:65367,102:65360,106:65363,105:65361,66:65477,1:65307}
            barrier(lambda:key(code),'key:'+str(symbols[code]))
        try:
            wait(lambda: 'PARENT_READY' in text(), 'parent frame', process)
            root = wait(find_root, 'real AT-SPI provider', process)
            win = wait(lambda: next((w for w in msg('windows')['windows'] if w['title'] == 'Bounded menu probe'), None), 'normal xdg parent', process)
            msg('do', 'float', win['id'])
            key_barrier(28)
            menu = wait(lambda: next(iter(menus(root)), None), 'action menu role', process)
            wait(lambda: frames(text()), 'confirmed popup frame', process)
            actual = frames(text())[-1]
            assert float(actual[4]) <= int(actual[2]) and float(actual[5]) <= int(actual[3]), 'clamp: viewport exceeds confirmed configure'
            first = menu.get_child_at_index(0)
            last = menu.get_child_at_index(999)
            assert first.get_role() == Atspi.Role.MENU_ITEM, 'action menu used dropdown Selection semantics'
            assert menu.get_child_at_index(1).get_role() == Atspi.Role.CHECK_MENU_ITEM
            assert menu.get_child_at_index(2).get_role() == Atspi.Role.RADIO_MENU_ITEM
            assert menu.get_child_at_index(3).get_role() == Atspi.Role.SEPARATOR
            # Evaluate the result after the common publication barrier, never wait
            # for the oracle state (a wrong implementation must finish setup too).
            key_barrier(107)
            assert state(last, Atspi.StateType.FOCUSED) and state(last, Atspi.StateType.SHOWING), 'reveal: End did not reveal the final row'
            if fault:
                raise AssertionError('control did not fail its intended oracle')
            msg('screenshot', LOG / (stem + '.png'))
            parent_commits=text().count('PARENT_COMMIT')
            barrier(lambda: msg('do', 'resize', -80, -60, win['id']))
            wait(lambda: text().count('PARENT_COMMIT') > parent_commits, 'parent repaints with menu still open', process)
            assert menus(root), 'parent resize dismissed the menu'
            # Font/appearance changes still reach both parent and popup.
            barrier(lambda: session.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.nidara.TestPortal', 'ChangeScale', GLib.Variant('(d)', (1.1,)), None, Gio.DBusCallFlags.NONE, 5000, None), 'appearance')
            assert 'APPEARANCE_CHANGED' in text()
            # Output scale/geometry changes while the menu remains open.
            for live_scale in (1.25 if scale == 1.0 else 1.0, scale):
                before=len(frames(text()))
                msg('output', msg('outputs')['outputs'][0]['name'], f'scale={live_scale}')
                wait(lambda: len(frames(text())) > before and float(re.findall(r'MENU_FRAME[^\n]* scale=([0-9.]+)', text())[-1]) == live_scale, 'live output scale reaches popup', process)
                barrier(lambda:key(67), 'server:99')
                assert menus(root), 'live output change dismissed the menu'
            # Passive output reservation update: no host hint/reposition request.
            before=len(frames(text()))
            reservation_file.write_text('80 60')
            wait(lambda: layer_ready(80, 60), 'changed exclusive reservations', reservation)
            wait(lambda: len(frames(text())) > before, 'reactive configure after workarea change', process)
            # Both reservations are logical pixels, including at fractional scale.
            current=frames(text())[-1]
            current_win=next(w for w in msg('windows')['windows'] if w['id'] == win['id'])
            output=msg('outputs')['outputs'][0]
            bottom=output['logical_size'][1] - 60
            y=current_win['y']+int(current[1])
            assert y >= 80 and y+int(current[3]) <= bottom+1, 'workarea: popup configure crosses exclusive layers'
            key_barrier(102) # Home -> first row/submenu
            key_barrier(106) # Right opens a real child popup
            child=wait(lambda: menus(root)[-1] if len(menus(root)) == 2 else None, 'submenu popup', process)
            child_last=child.get_child_at_index(99)
            key_barrier(107)
            assert state(child_last, Atspi.StateType.SHOWING) and state(child_last, Atspi.StateType.FOCUSED), 'submenu final row unreachable'
            counts={i:text().count(f'MENU_FRAME id=PopupId({i})') for i in (1,2)}
            reservation_file.write_text('100 80')
            wait(lambda: layer_ready(100, 80), 'changed reservation with submenu open', reservation)
            wait(lambda: all(text().count(f'MENU_FRAME id=PopupId({i})') > counts[i] for i in (1,2)), 'both popup levels commit new geometry', process)
            barrier(lambda:key(67), 'server:99')
            geometry=geometry_by_id(text())
            current_win=next(w for w in msg('windows')['windows'] if w['id'] == win['id'])
            output=msg('outputs')['outputs'][0]
            root_y=current_win['y']+geometry[1][1]
            child_y=root_y+geometry[2][1]
            assert root_y >= 100 and root_y+geometry[1][3] <= output['logical_size'][1]-80, 'root popup crosses changed reservations'
            assert child_y >= 100 and child_y+geometry[2][3] <= output['logical_size'][1]-80, 'submenu crosses changed reservations'

            key_barrier(105) # Left returns to parent menu.
            assert len(menus(root)) == 1, 'Left did not return to parent menu'
            menu=menus(root)[0]
            last=menu.get_child_at_index(999)
            # AT-SPI focus uses the same retained reveal path.
            barrier(lambda: last.get_component_iface().grab_focus(), 'request:'+last.get_attributes()['nidara-node-id'])
            assert state(last, Atspi.StateType.SHOWING), 'AT-SPI focus did not reveal final row'
            key_barrier(102)
            # Real Wayland wheel at the menu's confirmed global position.
            current=frames(text())[-1]
            current_win=next(w for w in msg('windows')['windows'] if w['id'] == win['id'])
            x=current_win['x']+int(current[0])+int(current[2])/2
            y=current_win['y']+int(current[1])+int(current[3])/2
            output=msg('outputs')['outputs'][0]
            barrier(lambda: subprocess.run(['/usr/bin/nidara-input', 'scroll', str(int(x)), str(int(y)), str(int(output['logical_size'][0])), str(int(output['logical_size'][1])), '0', '2500'], check=True))
            wait(lambda: state(last, Atspi.StateType.SHOWING), 'last row after real wheel', process)
            key_barrier(66) # F8 hint and reposition request.
            wait(lambda: 'REPOSITIONED 71' in text(), 'reposition acknowledgement', process)
            wait(lambda: int(frames(text())[-1][3]) <= 140, 'hint-bounded configured height', process)
            key_barrier(1)
            assert not menus(root), 'Escape did not close the popup stack'
            key(30)
            wait(lambda: 'PARENT_KEY 97' in text(), 'new physical key reaches parent after close', process)
            assert 'PARENT_KEY 65307' not in text(), 'dismissal Escape replayed into parent'
            return {'scale': scale, 'parent_live': True, 'workarea': True, 'keyboard': True, 'wheel': True, 'submenu': True, 'atspi': True, 'reposition': 71, 'dynamic_output': True, 'submenu_workarea': True}
        finally:
            finish.write_text('finish\n')
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)

result = {}
try:
    for scale in (1.0, 1.25):
        result[str(scale)] = run(scale)
    for fault, oracle in [('no-clamp', 'clamp:'), ('no-reveal', 'reveal:')]:
        try:
            run(1.0, fault)
        except AssertionError as error:
            log = (LOG / ('scale-1.0-' + fault + '.log')).read_text()
            if not str(error).startswith(oracle) or 'CONTROL_APPLIED ' + fault not in log:
                raise
            result[fault] = 'CAUGHT'
        else:
            raise AssertionError('control not caught: ' + fault)
    (LOG / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2), flush=True)
finally:
    PIPE.close()
    reservation.terminate()
    reservation.wait(timeout=5)
    reservation_log.close()
    registry.terminate()
    registry.wait(timeout=5)
    registry_log.close()
