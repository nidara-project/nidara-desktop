#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""The kit gallery (toolkit/gallery, VIEW.md §13.3) on an isolated Hyalo, through real libatspi.

Every page is opened from its sidebar entry by a reader, as Orca would, and screenshotted at
two scales; the live samples are driven through their readers' actions and values, and each
must answer. A control run with NK_GALLERY_FAULT=inert (activations dropped) must be caught,
so the interaction oracles are shown able to fail. Evidence lives below toolkit/target.
Run it with toolkit/gallery/check-headless.sh, never against the live session.
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
LOG = Path(os.environ.get('NK_WIDGETS_LOG', ROOT / 'toolkit/target/gallery-evidence')).resolve()
BIN = os.environ.get('NK_WIDGETS_BIN', str(ROOT / 'toolkit/target/debug/nidara-kit-gallery'))
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
TITLE = 'Nidara Kit Gallery'
PAGES = [('status', 'Status'), ('button', 'Button'), ('switch', 'Switch'),
         ('check', 'Checkbox and radio'), ('slider', 'Slider'),
         ('field', 'Text field'), ('glass', 'Glass card'), ('text', 'Text'), ('icons', 'Icons'),
         ('layout', 'Layout'), ('scroll', 'Scroll'), ('overlay', 'Overlay'), ('grid', 'Grid'),
         ('reveal', 'Reveal')]
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('use toolkit/gallery/check-headless.sh')
if LOG == Path('/tmp') or Path('/tmp') in LOG.parents:
    raise RuntimeError('gallery evidence must not use /tmp')
LOG.mkdir(parents=True, exist_ok=True)
# Hyalo's control pipe, held open for the run as the other private checks do.
PIPE = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)


class InfrastructureError(RuntimeError):
    pass


class OracleFailure(AssertionError):
    pass


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
    raise InfrastructureError(f'timeout: {label}')


def children(node):
    node.clear_cache()
    return [node.get_child_at_index(i) for i in range(node.get_child_count())]


def walk(node):
    out = [node]
    for child in children(node):
        if child:
            out.extend(walk(child))
    return out


def app_tree():
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            for node in children(app):
                if node and node.get_name() == TITLE:
                    return node
        except GLib.Error:
            continue
    return None


def find(root, name, role=None):
    return next((n for n in walk(root) if n.get_name() == name
                 and (role is None or n.get_role() == role)), None)


def has_state(node, kind):
    node.clear_cache()
    return node.get_state_set().contains(kind)


def ipc(*args):
    r = subprocess.run([*MSG, *map(str, args)], capture_output=True, text=True)
    if r.returncode != 0:
        raise InfrastructureError(f'msg {args}: {r.stdout}{r.stderr}')
    return json.loads(r.stdout)['ok']


# The private session's consent (keyfile backend, this run's own config): the checker may
# capture the screen and drive outputs. Never the live user's settings.
for key in ('allow-computer-control', 'allow-screenshot'):
    subprocess.run(['gsettings', 'set', 'org.nidara.ai', key, 'true'], check=True)

session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress',
                           None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
os.environ['AT_SPI_BUS_ADDRESS'] = address
os.environ['NK_A11Y_TRACE'] = '1'
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


def run(directory, fault=None, shots=True):
    directory.mkdir(parents=True, exist_ok=True)
    log = directory / 'client.log'
    env = dict(os.environ)
    if fault:
        env['NK_GALLERY_FAULT'] = fault
    with log.open('w') as output:
        process = subprocess.Popen([BIN], stdout=output, stderr=output, env=env)

        def text():
            if process.poll() is not None:
                raise InfrastructureError(f'gallery exited {process.returncode}: {log.read_text()}')
            return log.read_text()

        def published(action):
            before = text().count('A11Y_PUBLISHED')
            action()
            barrier(lambda: text().count('A11Y_PUBLISHED') > before, 'semantic publication')
            pump(.1)

        def activate(name, role):
            node = barrier(lambda: find(root, name, role), f'{name} in the tree')
            published(lambda: node.get_action_iface().do_action(0))

        def check(stage, ok, detail):
            if not ok:
                raise OracleFailure(f'{stage}: {detail}')
            print(f'  {stage}: PASS', flush=True)

        def sidebar_open():
            # A narrow window starts with it closed, and a choice there closes it again.
            if find(root, 'Show sidebar', Atspi.Role.PUSH_BUTTON):
                activate('Show sidebar', Atspi.Role.PUSH_BUTTON)
                barrier(lambda: find(root, 'Hide sidebar', Atspi.Role.PUSH_BUTTON)
                        and find(root, PAGES[0][1], Atspi.Role.TOGGLE_BUTTON), 'sidebar opened')

        def marked_page():
            return next((p for p, t in PAGES
                         if (n := find(root, t, Atspi.Role.TOGGLE_BUTTON))
                         and (has_state(n, Atspi.StateType.CHECKED) or has_state(n, Atspi.StateType.PRESSED))), None)

        try:
            barrier(lambda: 'CONTENT_READY' in text() and 'A11Y_READY' in text(), 'gallery readiness', 15)
            root = barrier(app_tree, 'AT-SPI window')
            hashes = {}
            for page, title in PAGES:
                sidebar_open()
                entry = barrier(lambda: find(root, title, Atspi.Role.TOGGLE_BUTTON), f'sidebar entry {title}')
                if page != 'status':
                    before = text().count(f'PAGE {page} ')
                    published(lambda: entry.get_action_iface().do_action(0))
                    barrier(lambda: text().count(f'PAGE {page} ') > before, f'page {page} committed')
                    pump(.3)
                sidebar_open()
                entry = barrier(lambda: find(root, title, Atspi.Role.TOGGLE_BUTTON), f'sidebar entry {title}')
                check(f'{page}/marked', has_state(entry, Atspi.StateType.CHECKED)
                      or has_state(entry, Atspi.StateType.PRESSED), 'its sidebar entry is not marked')
                others = [t for p, t in PAGES if p != page]
                marked = [t for t in others
                          if (n := find(root, t, Atspi.Role.TOGGLE_BUTTON))
                          and (has_state(n, Atspi.StateType.CHECKED) or has_state(n, Atspi.StateType.PRESSED))]
                check(f'{page}/alone', not marked, f'other entries marked: {marked}')
                if shots:
                    png = directory / f'{page}.png'
                    ipc('screenshot', png)
                    hashes[page] = hashlib.sha256(png.read_bytes()).hexdigest()
                if page == 'button':
                    activate('Press me', Atspi.Role.PUSH_BUTTON)
                    check('button/press', find(root, 'Pressed 1 times') is not None,
                          'a press did not reach the model')
                elif page == 'switch':
                    live = find(root, 'Wi-Fi', Atspi.Role.TOGGLE_BUTTON)
                    was = has_state(live, Atspi.StateType.CHECKED) or has_state(live, Atspi.StateType.PRESSED)
                    activate('Wi-Fi', Atspi.Role.TOGGLE_BUTTON)
                    live = find(root, 'Wi-Fi', Atspi.Role.TOGGLE_BUTTON)
                    now = has_state(live, Atspi.StateType.CHECKED) or has_state(live, Atspi.StateType.PRESSED)
                    check('switch/flip', was != now, f'the switch stayed {now}')
                elif page == 'check':
                    def ticked(name, role):
                        n = find(root, name, role)
                        return n is not None and has_state(n, Atspi.StateType.CHECKED)
                    was = ticked('Show hidden files', Atspi.Role.CHECK_BOX)
                    activate('Show hidden files', Atspi.Role.CHECK_BOX)
                    now = ticked('Show hidden files', Atspi.Role.CHECK_BOX)
                    check('check/flip', was != now, f'the checkbox stayed {now}')
                    activate('Large', Atspi.Role.RADIO_BUTTON)
                    chosen = [n for n in ('Small', 'Medium', 'Large') if ticked(n, Atspi.Role.RADIO_BUTTON)]
                    check('check/choose', chosen == ['Large'] and find(root, 'Try it: hidden files shown, size Large')
                          is not None, f'chosen {chosen}')
                elif page == 'slider':
                    node = find(root, 'Volume', Atspi.Role.SLIDER)
                    published(lambda: node.get_value_iface().set_current_value(80.))
                    check('slider/value', find(root, 'Try it: 80 %') is not None,
                          'a value set by a reader did not reach the model')
                elif page == 'reveal':
                    activate('Open', Atspi.Role.PUSH_BUTTON)
                    check('reveal/open', find(root, 'Revealed') is not None, 'the reveal did not open')
            # The band: back and forward walk the pages visited, the toggle hides the sidebar.
            activate('Back', Atspi.Role.PUSH_BUTTON)
            sidebar_open()
            check('band/back', marked_page() == PAGES[-2][0], f'back went to {marked_page()}')
            activate('Forward', Atspi.Role.PUSH_BUTTON)
            sidebar_open()
            check('band/forward', marked_page() == PAGES[-1][0], f'forward went to {marked_page()}')
            activate('Hide sidebar', Atspi.Role.PUSH_BUTTON)
            barrier(lambda: find(root, 'Show sidebar', Atspi.Role.PUSH_BUTTON), 'sidebar hidden')
            # Once it has slid out, its entries leave the tree.
            gone = time.monotonic() + 3
            while find(root, PAGES[0][1], Atspi.Role.TOGGLE_BUTTON) and time.monotonic() < gone:
                pump(.1)
            check('band/hide', find(root, PAGES[0][1], Atspi.Role.TOGGLE_BUTTON) is None,
                  'the sidebar\'s entries are still there')
            if shots:
                ipc('screenshot', directory / 'sidebar-hidden.png')
            sidebar_open()
            check('band/show', find(root, PAGES[0][1], Atspi.Role.TOGGLE_BUTTON) is not None,
                  'the sidebar did not come back')
            if shots:
                same = len(set(hashes.values())) != len(hashes)
                check('pages/distinct', not same, 'two pages drew the same picture')
            return 'PASS'
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            pump(.1)


output = ipc('outputs')['outputs'][0]
results = {}
try:
    for scale in (1, 1.25):
        ipc('output', output['name'], f'scale={scale}')
        print(f'scale {scale}', flush=True)
        results[f'scale{scale}'] = run(LOG / f'scale{scale}')
    print('control: activations dropped', flush=True)
    try:
        run(LOG / 'control-inert', fault='inert', shots=False)
        raise InfrastructureError('the inert control passed: the oracles cannot fail')
    except OracleFailure as e:
        print(f'  control CAUGHT: {e}', flush=True)
        results['control'] = 'CAUGHT'
    (LOG / 'result.json').write_text(json.dumps(results, indent=2))
finally:
    try:
        ipc('output', output['name'], f"scale={output['scale']}")
    finally:
        registry.terminate()
        registry.wait(timeout=3)
        registry_log.close()
        PIPE.close()
