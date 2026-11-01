#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private nested-Hyalo look at the Rust dock (DOCK.md §8). Run via check-dock-headless.sh;
not a CI job. It starts a private Applications1, the dock and one client window, then
reads Hyalo's layers and takes a screenshot per dock position."""
import json
import os
from pathlib import Path
import subprocess
import time
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
RUN = Path(os.environ['NK_WIDGETS_RUN']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve() != RUN / 'runtime':
    raise RuntimeError('private check-headless.sh runtime required')
MSG = [os.environ['HYALO_BIN'], 'msg']
SHELL = os.environ['NK_DOCK_BIN']
SESSIOND = os.environ['NK_SESSIOND_BIN']
REPO = Path(__file__).resolve().parents[2]


def ipc(*args):
    out = subprocess.run([*MSG, *map(str, args)], capture_output=True, text=True, timeout=5).stdout
    return json.loads(out)


def focused_title():
    """The title of the window Hyalo says holds the focus."""
    for w in ipc('windows').get('ok', {}).get('windows', []):
        if w.get('focused'):
            return w.get('title')
    return None


def until(what, check, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.05)
    raise RuntimeError(f'timeout: {what}')


def docks():
    layers = ipc('layers').get('ok', {}).get('layers', [])
    return [l for l in layers if l.get('namespace') == 'nidara-dock']


def shot(path):
    """Hyalo's own screenshot needs a capture grant this checkout may not have; the
    private Cage under the nested Hyalo shows the same output, so grim reads Cage."""
    if 'ok' in ipc('screenshot', path):
        return
    subprocess.run(['grim', str(path)], check=True, timeout=10, env={**os.environ, 'WAYLAND_DISPLAY': 'wayland-0'})


def gsettings(key, value):
    subprocess.run(['gsettings', 'set', 'org.nidara.dock', key, value], check=True, timeout=5)


MINIMIZER = """
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib
app = Gtk.Application(application_id='org.nidara.DockCheckMinimizer')
def up(app):
    w = Gtk.ApplicationWindow(application=app, title='Minimized', default_width=480, default_height=320)
    w.set_child(Gtk.Label(label='A minimized window'))
    w.present()
    GLib.timeout_add(1500, lambda: (w.minimize(), False)[1])
app.connect('activate', up)
app.run()
"""

TWINS = """
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk
app = Gtk.Application(application_id='org.nidara.DockCheckTwins')
def up(app):
    for title in ('First twin', 'Second twin'):
        w = Gtk.ApplicationWindow(application=app, title=title, default_width=360, default_height=240)
        w.set_child(Gtk.Label(label=title))
        w.present()
app.connect('activate', up)
app.run()
"""

# A Unity sender (APPLICATIONS1-DOCK.md §5): the real LauncherEntry.Update SIGNAL, from a
# process that stays on the bus until it is stopped (losing it retires its entry).
UNITY = """
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
bus.emit_signal(None, '/org/nidara/DockCheck', 'com.canonical.Unity.LauncherEntry', 'Update',
                GLib.Variant('(sa{sv})', ('application://' + sys.argv[1], {
                    'count': GLib.Variant('x', 3), 'count-visible': GLib.Variant('b', True),
                    'progress': GLib.Variant('d', 0.5), 'progress-visible': GLib.Variant('b', True),
                    'urgent': GLib.Variant('b', True)})))
bus.flush_sync(None)
GLib.MainLoop().run()
"""

procs = []


def accessibility():
    """The private bus's own a11y bus and registry, as the kit's check sets them up."""
    session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None,
                                GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
    os.environ['AT_SPI_BUS_ADDRESS'] = address
    registry = next(p for p in [Path('/usr/lib/at-spi2-registryd'), Path('/usr/libexec/at-spi2-registryd')] if p.exists())
    start('registry', [str(registry)])
    time.sleep(.5)
    session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
                      GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))),
                      None, Gio.DBusCallFlags.NONE, 5000, None)


def children(node):
    node.clear_cache()
    # A child can go between the count and the fetch (the tree updates under the walk).
    found = (node.get_child_at_index(i) for i in range(node.get_child_count()))
    return [c for c in found if c is not None]


def dock_node():
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            for node in children(app):
                if node and node.get_name() == 'Dock':
                    return node
        except GLib.Error:
            continue
    return None


def walk():
    """Every item as a reader sees it: role, name, description, states."""
    dock = dock_node()
    if not dock:
        return None
    items = []
    for n in children(dock):
        states = n.get_state_set()
        items.append({'role': n.get_role_name(), 'name': n.get_name(), 'description': n.get_description(),
                      'focused': states.contains(Atspi.StateType.FOCUSED),
                      'enabled': states.contains(Atspi.StateType.ENABLED)})
    return items


def menu_rows():
    """An open popup's rows, as the dock's tree carries them: (node, what a reader hears)."""
    dock = dock_node()
    found = []

    def visit(node, depth):
        for c in children(node):
            role = c.get_role_name()
            if 'menu item' in role:
                st = c.get_state_set()
                found.append((c, {'role': role, 'name': c.get_name(),
                                  'enabled': st.contains(Atspi.StateType.ENABLED),
                                  'checked': st.contains(Atspi.StateType.CHECKED)}))
            elif depth < 3:
                visit(c, depth + 1)
    if dock:
        visit(dock, 0)
    return found


def item_point(name):
    """The middle of a dock item, in global logical pixels."""
    layer = docks()[0]
    node = next(n for n in children(dock_node()) if n.get_name() == name)
    r = node.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
    return layer['x'] + r.x + r.width // 2, layer['y'] + r.y + r.height // 2


def shell1(method, args=None, quiet=True):
    """A Shell1 call on the private bus; None while nobody owns the name (quiet)."""
    try:
        reply = Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
            'org.nidara.Shell', '/org/nidara/Shell', 'org.nidara.Shell1', method, args,
            None, Gio.DBusCallFlags.NONE, 3000, None)
    except GLib.Error:
        if quiet:
            return None
        raise
    return reply.unpack()[0] if reply.n_children() == 1 else reply.unpack()


def start(name, argv, **env):
    out = (LOG / f'{name}.log').open('w')
    p = subprocess.Popen(argv, stdout=out, stderr=out, env={**os.environ, **env})
    procs.append(p)
    return p


def catalogue():
    """A small catalogue of real entries, so one odd system entry cannot stop the check."""
    data = RUN / 'apps'
    (data / 'applications').mkdir(parents=True)
    for name in ['kitty.desktop', 'org.gtk.Demo4.desktop', 'org.gnome.Nautilus.desktop',
                 'firefox.desktop', 'org.gnome.Zenity.desktop']:
        source = Path('/usr/share/applications') / name
        if source.exists():
            (data / 'applications' / name).write_bytes(source.read_bytes())
    (data / 'applications' / 'mimeapps.list').write_text(
        '[Default Applications]\ninode/directory=org.gnome.Nautilus.desktop\n')
    (data / 'icons').symlink_to('/usr/share/icons')
    (data / 'pixmaps').symlink_to('/usr/share/pixmaps')
    return str(data)


def schemas():
    """This checkout's schemas over the installed ones: A1's dock layout keys may be newer
    than what is installed."""
    out = RUN / 'schemas'
    out.mkdir()
    # The enums too: without them every schema that names one (org.gnome.desktop.interface,
    # the icon theme's home) is dropped, and the service resolves icons with no theme.
    installed = Path('/usr/share/glib-2.0/schemas')
    for f in [*installed.glob('*.gschema.xml'), *installed.glob('*.enums.xml')]:
        if f.name != 'org.nidara.gschema.xml':
            (out / f.name).symlink_to(f)
    (out / 'org.nidara.gschema.xml').symlink_to(REPO / 'config/gsettings/org.nidara.gschema.xml')
    subprocess.run(['glib-compile-schemas', str(out)], check=True, timeout=30)
    return str(out)


try:
    os.environ['GSETTINGS_SCHEMA_DIR'] = schemas()
    accessibility()
    # The dock menu writes its preferences through Config1; an unidentified development
    # binary is External there, so the private session grants the consent gates.
    subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-computer-control', 'true'], check=True, timeout=5)
    subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-config-write', 'true'], check=True, timeout=5)
    start('sessiond', [SESSIOND, '--applications', '--config'], XDG_DATA_DIRS=catalogue())
    def snapshot():
        r = subprocess.run(['busctl', '--user', '--json=short', 'call', 'org.nidara.Applications',
                            '/org/nidara/Applications', 'org.nidara.Applications1', 'GetSnapshot'],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and r.stdout
    (LOG / 'snapshot.json').write_text(until('Applications1 answering', snapshot))
    result = {}
    # The Trash's art comes from the icon theme (GetTrashIcon), both looks.
    epoch = json.loads((LOG / 'snapshot.json').read_text())['data'][0]
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    result['trash_art'] = {}
    for full in (False, True):
        try:
            _, w, h, px = bus.call_sync(
                'org.nidara.Applications', '/org/nidara/Applications', 'org.nidara.Applications1',
                'GetTrashIcon', GLib.Variant('(tbud)', (epoch, full, 64, 1.0)),
                GLib.VariantType('(suuay)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()
            result['trash_art']['full' if full else 'empty'] = f'{w}x{h}'
        except GLib.Error as e:
            result['trash_art']['full' if full else 'empty'] = e.message
    assert result['trash_art'] == {'empty': '64x64', 'full': '64x64'}, result['trash_art']
    shell = start('shell', [SHELL])
    first = until('a dock layer', docks)
    # Shell1 (crates/nidara-shell-ipc): this process owns the name, says what it can do,
    # and refuses what it cannot rather than doing nothing.
    until('Shell1 answering', lambda: shell1('GetState') is not None)
    state = shell1('GetState')
    assert state == (False, [], ''), state
    for surface, error in [('bar', 'Unavailable'), ('Dock', 'Invalid')]:
        try:
            shell1('FocusSurface', GLib.Variant('(s)', (surface,)), quiet=False)
            raise AssertionError(f'FocusSurface({surface}) was accepted')
        except GLib.Error as e:
            assert f'org.nidara.Shell1.Error.{error}' in e.message, e.message
    result['shell1'] = {'state': list(state), 'refusals': 'bar Unavailable, Dock Invalid'}
    # Software Hyalo cannot take a GL client's dmabufs here (it crashes); draw on the CPU.
    start('client', ['gtk4-demo'], GDK_BACKEND='wayland', GSK_RENDERER='cairo', GDK_DISABLE='gl,vulkan')
    until('a client window', lambda: ipc('windows').get('ok', {}).get('windows'))
    time.sleep(1.5)  # icons, the running dot and the glass settle
    result['first'] = first
    for position in ['bottom', 'left', 'right']:
        gsettings('position', position)
        time.sleep(1.0)
        result[position] = docks()
        shot(LOG / f'dock-{position}.png')
    gsettings('position', 'bottom')
    gsettings('icon-size', '48')
    time.sleep(1.0)
    result['icon48'] = docks()
    shot(LOG / 'dock-48.png')
    # Keyboard (DOCK.md §7): focus:dock over Shell1 — through the real CLI when one is
    # given (NK_IPC_BIN, built from session/), else straight on the bus — Right, Escape.
    gsettings('icon-size', '64')
    time.sleep(1.0)
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        if os.environ.get('NK_IPC_BIN'):
            r = subprocess.run([os.environ['NK_IPC_BIN'], '--session=rust', 'focusDock'],
                               capture_output=True, text=True, timeout=10)
            assert r.returncode == 0, (r.returncode, r.stdout, r.stderr)
            result['shell1']['cli'] = 'nidara-ipc --session=rust focusDock'
        else:
            shell1('FocusSurface', GLib.Variant('(s)', ('dock',)), quiet=False)
        until('the dock takes the keyboard', lambda: 'takes the keyboard' in (LOG / 'shell.log').read_text())
        time.sleep(.5)
        pipe.write('key 106\n')  # Right: the ring moves to kitty
        until('Right moves the focus to kitty', lambda: any(
            i['focused'] and i['name'] == 'kitty' for i in (walk() or [])))
        shot(LOG / 'dock-keyboard.png')
        pipe.write('key 1\n')  # Escape
        until('the dock lets the keyboard go', lambda: 'lets the keyboard go' in (LOG / 'shell.log').read_text())
        # The keyboard goes back to the window: a key now reaches the client, not the dock.
    result['keyboard'] = {'took': True, 'escape_released': True}
    # The screen reader's view: one button per item, the app's window running, and Activate
    # on the running app asks Hyalo to focus its window (as a click does).
    items = until('the dock in AT-SPI', lambda: (w := walk()) and len(w) >= 6 and w)
    result['atspi'] = items
    names = [i['name'] for i in items if i['role'] in ('push button', 'button')]
    assert names[:2] == ['Files', 'kitty'] and names[-1] == 'Trash', items
    assert any(i['description'] == 'running' for i in items), items
    # The Trash says whether it holds anything (or that it cannot tell), never nothing.
    trash = next(i for i in items if i['name'] == 'Trash')
    assert trash['description'].split(',')[0] in ('empty', 'empty in the home folder'), trash
    # Filling it (the check's own file, into the private session's Trash) is seen and said.
    junk = RUN / 'junk.txt'
    junk.write_text('x')
    subprocess.run(['gio', 'trash', str(junk)], check=True, timeout=10)
    until('the Trash says it holds items', lambda: any(
        i['name'] == 'Trash' and i['description'].startswith('contains items')
        for i in (walk() or [])))
    shot(LOG / 'dock-trash-full.png')
    result['trash'] = 'empty, then contains items'
    # Unity (D2, DOCK.md §6): a count, a progress and urgency reach kitty's slot through
    # Applications1, painted and said; the sender's exit takes them all away.
    def kitty():
        return next((i['description'] for i in (walk() or []) if i['name'] == 'kitty'), '')
    unity = start('unity', ['python3', '-I', '-c', UNITY, 'kitty.desktop'])
    until('kitty says its count, progress and attention', lambda: all(
        w in kitty() for w in ('3 pending', '50% done', 'wants attention')))
    time.sleep(.5)  # a lift of the bounce, mid-way
    shot(LOG / 'dock-unity-bounce.png')
    time.sleep(3)  # the bounce is over: the still mark stays
    shot(LOG / 'dock-unity.png')
    result['unity'] = {'said': kitty()}
    unity.terminate()
    unity.wait(timeout=5)
    until('the sender gone, nothing stale stays', lambda: 'pending' not in kitty()
          and 'attention' not in kitty())
    result['unity']['after_exit'] = kitty()
    # Tooltip (D2): resting on an item names it beside the dock after the dwell; it takes
    # no input (no grab), so the dock's own walk and clicks are unchanged under it.
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        x, y = item_point('kitty')
        pipe.write(f'move {x} {y}\nmove {x + 1} {y}\n')
        time.sleep(1.2)
        shot(LOG / 'dock-tooltip.png')
        bx, by = item_point('Trash')
        pipe.write(f'move {bx} {by}\n')
        time.sleep(.4)  # warm: the next item at once
        shot(LOG / 'dock-tooltip-next.png')
        pipe.write(f'move {bx} {by - 200}\n')
    result['tooltip'] = 'shown, see dock-tooltip.png'
    # Magnification (D2): resting on an item grows it toward the configured maximum, its
    # neighbours making room; the reader's bounds follow what is drawn; leaving undoes it.
    def extent(name):
        node = next(n for n in children(dock_node()) if n.get_name() == name)
        return node.get_component_iface().get_extents(Atspi.CoordType.WINDOW).width
    rest = extent('kitty')
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        x, y = item_point('kitty')
        pipe.write(f'move {x} {y}\nmove {x + 1} {y}\n')
        grown = until('kitty grows under the pointer', lambda: (e := extent('kitty')) > rest * 1.5 and e)
        time.sleep(.3)
        shot(LOG / 'dock-magnified.png')
        layer = docks()[0]
        pipe.write(f'move {x} {layer["y"] - 300}\n')
        until('kitty back at rest', lambda: extent('kitty') == rest)
    result['magnification'] = {'rest': rest, 'grown': grown}
    # Menus (D2, DOCK.md §8): a right click opens the item's menu on the dock's own popup,
    # its rows in the dock's tree; Escape closes it; the dock's own menu writes through
    # Config1 and shows what Config1 took.
    result['menus'] = {}
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        def open_menu(x, y, what):
            # A hand moves there first: Hyalo ends a closed menu's pointer grab on the first
            # motion, which the dock then does not see (hyalo shell/mod.rs).
            pipe.write(f'move {x} {y}\nmove {x + 1} {y}\n')
            time.sleep(.3)  # the pointer is the dock's again before the press
            pipe.write(f'rclick {x} {y}\n')
            return until(what, lambda: (r := menu_rows()) and r)

        def close_menu():
            pipe.write('key 1\n')  # Escape
            until('the menu closes', lambda: not menu_rows())

        rows = open_menu(*item_point('Trash'), 'the Trash menu')
        shot(LOG / 'dock-menu-trash.png')
        heard = [r for _, r in rows]
        empty = next((r for r in heard if r["name"] in ("Vaciar papelera", "Empty trash", "Empty Trash")), None)
        assert empty, heard
        assert empty['enabled'], heard
        result['menus']['trash'] = heard
        close_menu()
        rows = open_menu(*item_point('kitty'), 'the kitty menu')
        shot(LOG / 'dock-menu-app.png')
        heard = [r for _, r in rows]
        names = [r['name'] for r in heard]
        assert names[0] in ('Abrir', 'Open') or 'kitty' in (LOG / 'shell.log').read_text(), heard
        assert any(n in ('Desanclar del dock', 'Unpin from dock') for n in names), heard
        result['menus']['app'] = heard
        close_menu()
        # The separator opens the dock's own menu (the surface's edges are room for
        # magnification, outside the glass, and take no input).
        # Read it at rest: under the pointer the strip is magnified around it.
        layer = docks()[0]
        pipe.write(f'move {layer["x"] + layer["width"] // 2} {layer["y"] - 300}\n')
        until('the dock at rest', lambda: extent('kitty') == rest)
        sep = next(n for n in children(dock_node()) if n.get_role_name() == 'separator')
        r = sep.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
        rows = open_menu(layer['x'] + r.x + r.width // 2, layer['y'] + r.y + r.height // 2,
                         'the dock menu')
        shot(LOG / 'dock-menu-dock.png')
        result['menus']['dock'] = [r for _, r in rows]
        left = next(n for n, r in rows if r['name'] in ('Izquierda', 'Left'))
        left.get_action_iface().do_action(0)
        until('Config1 moves the dock left', lambda: (d := docks()) and d[0]['height'] > d[0]['width'])
        stored = subprocess.run(['gsettings', 'get', 'org.nidara.dock', 'position'],
                                capture_output=True, text=True, timeout=5).stdout.strip()
        assert stored == "'left'", stored
        until('the menu closed after its choice', lambda: not menu_rows())
        shot(LOG / 'dock-menu-left.png')
        result['menus']['chosen'] = 'left, through Config1'
    gsettings('position', 'bottom')
    time.sleep(1.0)
    dock = dock_node()
    running = next(n for n in children(dock) if n.get_description() == 'running')
    # A click focuses the window, or puts it away when it already has the focus (D1).
    def demo():
        return next(w for w in ipc('windows')['ok']['windows'] if w.get('title') == 'GTK Demo')
    had_focus = demo()['focused']
    running.get_action_iface().do_action(0)  # "click": Activate
    if had_focus:
        until('the click puts the focused demo away', lambda: demo()['minimized'])
        result['activate'] = 'minimized the focused window'
    else:
        until('the click focuses the demo', lambda: demo()['focused'])
        result['activate'] = 'focused the window'
    # Minimized: the window gets its own slot, drawn from its picture (thumbs.rs), and no
    # capture fails on the way.
    # (Hyalo's own `do minimize` is refused to an unidentified caller in this harness: the
    # window minimizes itself, as its minimize button would.)
    start('minimizer', ['python3', '-I', '-c', MINIMIZER], GDK_BACKEND='wayland',
          GSK_RENDERER='cairo', GDK_DISABLE='gl,vulkan')
    until('a minimized slot', lambda: any(
        i['description'] == 'minimized window' for i in (walk() or [])))
    time.sleep(1)
    log = (LOG / 'shell.log').read_text()
    assert 'no picture of window' not in log and 'window picture failed' not in log, log[-2000:]
    shot(LOG / 'dock-minimized.png')
    result['minimized'] = 'slot with its picture'
    # The chooser (D2): a click on an app with two visible windows offers both, by picture
    # and title, as a list of buttons in the dock's tree; choosing one focuses it.
    start('twins', ['python3', '-I', '-c', TWINS], GDK_BACKEND='wayland',
          GSK_RENDERER='cairo', GDK_DISABLE='gl,vulkan')

    def twins():
        return next((n for n in children(dock_node())
                     if 'twin' in (n.get_name() or '').lower()), None)

    def chooser():
        for c in children(dock_node()):
            if c.get_role_name() == 'list':
                return {b.get_name(): b for b in children(c)}
        return None
    until('both twins mapped', lambda: {'First twin', 'Second twin'} <= {
        w.get('title') for w in ipc('windows')['ok']['windows']})
    until('the twins in the dock', twins)
    time.sleep(1)
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        # Measured at rest: the dock anchors magnification at the pointer within its rest
        # slot, so a point read from the rest strip stays on its item once the strip grows.
        layer = docks()[0]
        pipe.write(f'move {layer["x"] + layer["width"] // 2} {layer["y"] - 300}\n')
        until('the dock at rest', lambda: extent('kitty') == rest)
        x, y = item_point(twins().get_name())
        pipe.write(f'move {x} {y}\nmove {x + 1} {y}\n')
        time.sleep(.3)  # after a grab ends, Hyalo gives the pointer back on motion
        pipe.write(f'click {x} {y}\n')
        try:
            offered = until('the chooser offers both windows',
                            lambda: (c := chooser()) and {'First twin', 'Second twin'} <= set(c) and c)
        except RuntimeError:
            # What the dock and Hyalo held when the click did not offer a choice.
            (LOG / 'chooser-failed.json').write_text(json.dumps(
                {'dock': walk(), 'windows': ipc('windows'), 'focused': focused_title()}, indent=2))
            shot(LOG / 'dock-chooser-failed.png')
            raise
        time.sleep(4)  # the pictures (software Hyalo is slow to draw them)
        shot(LOG / 'dock-chooser.png')
        pipe.write('key 1\n')  # Escape
        until('Escape closes the chooser', lambda: not chooser())
        pipe.write(f'move {x} {y}\nmove {x + 1} {y}\n')
        time.sleep(.3)  # after a grab ends, Hyalo gives the pointer back on motion
        pipe.write(f'click {x} {y}\n')
        try:
            offered = until('the chooser again', lambda: (c := chooser()) and len(c) == 2 and c)
        except RuntimeError:
            (LOG / 'chooser-again-failed.json').write_text(json.dumps(
                {'dock': walk(), 'windows': ipc('windows'), 'focused': focused_title()}, indent=2))
            shot(LOG / 'dock-chooser-again-failed.png')
            raise
        other = next(t for t in ('First twin', 'Second twin') if t != focused_title())
        offered[other].get_action_iface().do_action(0)
        until('the chooser closes on a choice', lambda: not chooser())
        until('the chosen window is focused', lambda: focused_title() == other)
    result['chooser'] = sorted(offered)
    assert shell.poll() is None, 'the dock exited'
    (LOG / 'layers.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
finally:
    for p in reversed(procs):
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
