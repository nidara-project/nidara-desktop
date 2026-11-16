#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""The kit gallery (toolkit/gallery, VIEW.md §13.3) on an isolated Hyalo, through real libatspi.

Every page is opened from its sidebar entry by a reader, as Orca would, and screenshotted at
two scales; the live samples are driven through their readers' actions and values, and each
must answer. A control run with NK_GALLERY_FAULT=inert (activations dropped) must be caught,
so the interaction oracles are shown able to fail. Evidence lives below toolkit/target.
Run it with toolkit/gallery/check-headless.sh, never against the live session. The scheduled
Hyalo nightly and explicit workflow_dispatch runs also execute it in their disposable
vkms container; PR jobs do not add this matrix. duration.json records measured check time.
"""
import hashlib
import json
import os
import struct
import zlib
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
         ('check', 'Checkbox and radio'), ('dropdown', 'Dropdown'),
         ('segmented', 'Segmented choice'), ('swatches', 'Swatches'), ('row', 'Setting row'), ('slider', 'Slider'),
         ('field', 'Text field'), ('glass', 'Glass card'), ('text', 'Text'), ('icons', 'Icons'),
         ('layout', 'Layout'), ('scroll', 'Scroll'), ('overlay', 'Overlay'), ('grid', 'Grid'),
         ('reveal', 'Reveal'), ('disclosure', 'Disclosure'), ('entry','Editable field'), ('search','Search'), ('list','Long list')]
if os.environ.get('NK_GALLERY_TEST') == 'vkms':
    # Only the disposable hyalo-smoke container's unprivileged test session.
    if (os.getuid() == 0
            or Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path('/run/hyalo-smoke')
            or Path(os.environ['HYALO_CONTROL']).resolve() != Path('/tmp/hyalo/control')):
        raise RuntimeError('use the private hyalo-smoke vkms session')
else:
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


def app_tree(pid):
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            # The registry can briefly retain the previous scale/control client.
            # A matching title alone is not evidence that this is our new process.
            if app.get_process_id() != pid:
                continue
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


def run(directory, fault=None, shots=True, editor_only=False, list_only=False):
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

        def key(code):
            PIPE.write(f'key {code}\n')
            PIPE.flush()

        def chord(mod, code):
            PIPE.write(f'keydown {mod}\nkey {code}\nkeyup {mod}\n')
            PIPE.flush()

        def text_of(name):
            node = find(root, name, Atspi.Role.ENTRY)
            return Atspi.Text.get_text(node.get_text_iface(), 0, -1) if node else None

        def content_ready():
            # Keyboard/pointer walks enter the content through the public frame control.
            # This is also the user path in a narrow window, where the sidebar overlays it.
            if find(root, 'Hide sidebar', Atspi.Role.PUSH_BUTTON):
                activate('Hide sidebar', Atspi.Role.PUSH_BUTTON)
                barrier(lambda: find(root, PAGES[0][1], Atspi.Role.TOGGLE_BUTTON) is None,
                        'sidebar no longer covers content')

        def entry_pixels(stage):
            node = find(root, 'Editable text', Atspi.Role.ENTRY)
            box = node.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
            win = next(w for w in ipc('windows')['windows'] if w['app_id'] == 'nidara-kit-gallery')
            output = ipc('outputs')['outputs'][0]
            scale = output['scale']
            path = directory / f'entry-{stage}.ppm'
            ipc('screenshot', path)
            head, dims, depth, pixels = path.read_bytes().split(b'\n', 3)
            if head != b'P6' or depth != b'255':
                raise InfrastructureError('expected PPM screenshot')
            w, h = map(int, dims.split())
            x0 = int((win['x'] + box.x + 14) * scale)
            y0 = int((win['y'] + box.y + 2) * scale)
            x1 = int((win['x'] + box.x + box.width - 14) * scale)
            y1 = int((win['y'] + box.y + box.height - 2) * scale)
            if not (0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h):
                raise InfrastructureError(f'entry screenshot outside output: {box}, {win}')
            rgb = b''.join(pixels[(y*w+x0)*3:(y*w+x1)*3] for y in range(y0,y1))
            def chunk(tag, data):
                return struct.pack('!I',len(data)) + tag + data + struct.pack('!I',zlib.crc32(tag+data))
            rows = b''.join(b'\0'+rgb[y*(x1-x0)*3:(y+1)*(x1-x0)*3] for y in range(y1-y0))
            path.with_suffix('.png').write_bytes(b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR',struct.pack('!2I5B',x1-x0,y1-y0,8,2,0,0,0))
                + chunk(b'IDAT',zlib.compress(rows)) + chunk(b'IEND',b''))
            return rgb

        def pixel_change(stage, reference, changed):
            def sample():
                pixels = entry_pixels(stage)
                if len(pixels) != len(reference):
                    raise InfrastructureError('entry extent changed during input')
                different = sum(max(abs(pixels[j]-reference[j]) for j in range(i,i+3)) > 20
                                for i in range(0,len(pixels),3))
                return pixels if (different > 20 if changed else different < 5) else None
            try:
                pixels = barrier(sample, f'entry/{stage} pixels')
            except InfrastructureError as error:
                raise OracleFailure(f'entry/{stage}: {error}') from error
            check(f'entry/{stage}', True, '')
            return pixels

        def input_text(stage, value):
            try:
                barrier(lambda: text_of('Editable text') == value, f'entry/{stage} committed text')
            except InfrastructureError as error:
                raise OracleFailure(f'entry/{stage}: {error}') from error
            check(f'entry/{stage}', True, '')

        def entry_walk():
            content_ready()
            field = find(root, 'Editable text', Atspi.Role.ENTRY)
            published(lambda: field.get_editable_text_iface().set_text_contents(''))
            published(lambda: field.get_component_iface().grab_focus())
            input_text('reader', '')
            empty = entry_pixels('empty')
            key(49)  # n, as in phase0's keyboard path.
            input_text('first-key', 'n')
            first = pixel_change('first-key-painted',empty,True)
            key(37)  # k
            input_text('second-key','nk')
            typed = pixel_change('second-key-painted',first,True)
            ime_log = directory / 'ime.log'
            with ime_log.open('w') as stream:
                ime = subprocess.Popen([os.environ.get('HYALO_IME_PROBE_BIN','hyalo-ime-probe'),'--script'],stdin=subprocess.PIPE,
                                       stdout=stream,stderr=stream,text=True)
            try:
                barrier(lambda: 'STATE 1 ' in ime_log.read_text(), 'entry IME activated')
                def command(line):
                    count = ime_log.read_text().count('SENT '+line)
                    ime.stdin.write(line+'\n'); ime.stdin.flush()
                    barrier(lambda: ime_log.read_text().count('SENT '+line) > count,
                            'IME acknowledged '+line)
                command('preedit 日本')
                pre = pixel_change('preedit',typed,True)
                check('entry/preedit-not-committed',text_of('Editable text')=='nk','preedit leaked into the model')
                command('preedit 日本語')
                pixel_change('replace',pre,True)
                command('cancel')
                pixel_change('cancel',typed,False)
                command('commit 日本')
                input_text('commit','nk日本')
                committed = pixel_change('commit-painted',typed,True)
            finally:
                ime.terminate()
                try: ime.wait(timeout=3)
                except subprocess.TimeoutExpired: ime.kill(); ime.wait()
            chord(29,30)  # Ctrl+A
            try:
                barrier(lambda: (n:=find(root,'Editable text',Atspi.Role.ENTRY))
                        and Atspi.Text.get_n_selections(n.get_text_iface())==1, 'entry/select range')
            except InfrastructureError as error:
                raise OracleFailure(f'entry/select: {error}') from error
            pixel_change('select',committed,True)
            chord(29,46)  # Ctrl+C through the real Wayland data device.
            key(14)  # Remove selection without replacing the clipboard.
            input_text('copy-cleared','')
            pixel_change('copy-cleared-painted',empty,False)
            chord(29,47)
            input_text('copy','nk日本')
            pixel_change('copy-painted',committed,False)
            chord(29,30)
            barrier(lambda: Atspi.Text.get_n_selections(find(root,'Editable text',Atspi.Role.ENTRY).get_text_iface())==1,
                    'entry selected again for cut')
            chord(29,45)  # Ctrl+X
            input_text('cut','')
            cleared = pixel_change('cut-painted',empty,False)
            chord(29,47)  # Ctrl+V
            input_text('paste','nk日本')
            pixel_change('paste-painted',committed,False)
            chord(29,44)  # Ctrl+Z
            input_text('undo','')
            pixel_change('undo-painted',cleared,False)
            PIPE.write('keydown 29\nkeydown 42\nkey 44\nkeyup 42\nkeyup 29\n'); PIPE.flush()
            input_text('redo','nk日本')
            pixel_change('redo-painted',committed,False)
            key(28)  # Enter is the submission action, not a text change.
            try: barrier(lambda: find(root,'Submitted: 1'), 'entry submitted')
            except InfrastructureError as error: raise OracleFailure(f'entry/submit: {error}') from error
            check('entry/submit',text_of('Editable text')=='nk日本','submission changed the text')

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
            root = barrier(lambda: app_tree(process.pid), 'AT-SPI window for current PID')
            hashes = {}
            for page, title in ([p for p in PAGES if p[0]=="entry"] if editor_only
                                else [p for p in PAGES if p[0]=="list"] if list_only else PAGES):
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
                if page == 'entry':
                    entry_walk()
                elif page == 'search':
                    content_ready()
                    field = find(root,'Search text',Atspi.Role.ENTRY)
                    published(lambda: field.get_editable_text_iface().set_text_contents('needle'))
                    barrier(lambda: text_of('Search text')=='needle' and find(root,'Clear search',Atspi.Role.PUSH_BUTTON), 'search filled')
                    published(lambda: field.get_component_iface().grab_focus())
                    key(1)  # Escape clears before the host closes the sidebar/window.
                    barrier(lambda: text_of('Search text')=='', 'search Escape cleared')
                    check('search/escape',find(root,'Clear search',Atspi.Role.PUSH_BUTTON) is None,'clear control remained after clearing')
                    field = find(root,'Search text',Atspi.Role.ENTRY)
                    published(lambda: field.get_editable_text_iface().set_text_contents('again'))
                    barrier(lambda: text_of('Search text')=='again', 'search refilled')
                    activate('Clear search',Atspi.Role.PUSH_BUTTON)
                    barrier(lambda: text_of('Search text')=='', 'search clear control')
                    check('search/clear-focus',has_state(find(root,'Search text',Atspi.Role.ENTRY),Atspi.StateType.FOCUSED),'clear did not return focus')
                elif page == 'list':
                    content_ready()
                    def records(): return find(root,'Records',Atspi.Role.LIST_BOX)
                    palette=json.loads((Path(os.environ['NK_SETTINGS_DATA'])/'tokens/colors.json').read_text())
                    appearance=session.call_sync('org.freedesktop.portal.Desktop','/org/freedesktop/portal/desktop',
                        'org.freedesktop.portal.Settings','ReadAll',GLib.Variant('(as)',(['org.freedesktop.appearance'],)),
                        GLib.VariantType.new('(a{sa{sv}})'),Gio.DBusCallFlags.NONE,5000,None).unpack()[0]
                    accent=bytes(round(v*255) for v in appearance['org.freedesktop.appearance']['accent-color'])
                    if accent not in [bytes.fromhex(v.lstrip('#')) for v in palette['accents'].values()]:
                        raise InfrastructureError('portal accent is outside the exported palette')
                    def painted_selection(stage):
                        selected=records().get_selection_iface().get_selected_child(0)
                        box=selected.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
                        win=next(w for w in ipc('windows')['windows'] if w['app_id']=='nidara-kit-gallery')
                        scale=ipc('outputs')['outputs'][0]['scale']
                        path=directory/f'list-{stage}.ppm';ipc('screenshot',path)
                        head,dims,depth,rgb=path.read_bytes().split(b'\n',3)
                        w,h=map(int,dims.split());x=int((win['x']+box.x+box.width/2)*scale);y=int((win['y']+box.y+box.height/2)*scale)
                        return 0<=x<w and 0<=y<h and rgb[(y*w+x)*3:(y*w+x+1)*3]==accent
                    live=barrier(records,'list container')
                    check('list/bounded', 1 <= len(children(live)) <= 20, 'constructed all records')
                    check('list/size', live.get_attributes().get('setsize')=='5000', 'reader has no total size')
                    selected=live.get_selection_iface().get_selected_child(0)
                    check('list/initial',selected.get_name()=='Record 1' and selected.get_attributes().get('posinset')=='1','wrong initial selection')
                    published(lambda: live.get_component_iface().grab_focus())
                    for code, expected, stage in [(107,5000,'end'),(103,4999,'up'),(102,1,'home'),(108,2,'down'),(109,8,'page-down'),(104,2,'page-up')]:
                        key(code)
                        try: barrier(lambda: find(root,f'Selected: {expected} · Opened: 0'),'list/'+stage)
                        except InfrastructureError as error: raise OracleFailure(f'list/{stage}: {error}') from error
                        live=records();selected=live.get_selection_iface().get_selected_child(0)
                        check('list/'+stage,selected.get_name()==f'Record {expected}' and has_state(selected,Atspi.StateType.SHOWING),'selection not revealed')
                        check('list/'+stage+'-bounded',len(children(live))<=20,'range did not stay bounded')
                        if stage in ('end','home'):
                            try: barrier(lambda: painted_selection(stage),'list/'+stage+' pixels')
                            except InfrastructureError as error: raise OracleFailure(f'list/{stage}-paint: {error}') from error
                            check('list/'+stage+'-paint',True,'')
                            if shots: ipc('screenshot',directory/f'list-{stage}.png')
                    key(28)
                    try: barrier(lambda: find(root,'Selected: 2 · Opened: 1'),'list/open')
                    except InfrastructureError as error: raise OracleFailure(f'list/open: {error}') from error
                    check('list/open',True,'')
                    key(57);pump(.1)
                    check('list/space',find(root,'Selected: 2 · Opened: 1') is not None,'Space opened a row')
                    disabled=find(root,'Disabled records',Atspi.Role.LIST_BOX)
                    check('list/disabled',not has_state(disabled,Atspi.StateType.ENABLED) and len(children(disabled))>=2,'disabled list is active or empty')
                    empty=find(root,'Empty records',Atspi.Role.LIST_BOX)
                    check('list/empty',len(children(empty))==0,'empty list has options')
                    pump(.3)
                    if shots: ipc('screenshot',directory/'list-selected.png')
                elif page == 'button':
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
                elif page == 'dropdown':
                    def live():
                        return find(root, 'Animation speed', Atspi.Role.COMBO_BOX)
                    combo = barrier(live, 'the live dropdown')
                    check('dropdown/closed', not has_state(combo, Atspi.StateType.EXPANDED)
                          and has_state(combo, Atspi.StateType.EXPANDABLE)
                          and [n.get_name() for n in children(combo)] == ['Slow', 'Normal', 'Fast'],
                          'the dropdown is not a closed combo box holding its options')
                    published(lambda: combo.get_action_iface().do_action(0))
                    barrier(lambda: (n := live()) and has_state(n, Atspi.StateType.EXPANDED),
                            'the list opened')
                    pump(.3)
                    if shots:
                        ipc('screenshot', directory / 'dropdown-open.png')
                    fast = find(live(), 'Fast', Atspi.Role.LIST_ITEM)
                    check('dropdown/open', fast is not None and fast.get_extents(Atspi.CoordType.WINDOW).height > 0,
                          'its options have no place in the open list')
                    published(lambda: fast.get_action_iface().do_action(0))
                    barrier(lambda: (n := live()) and not has_state(n, Atspi.StateType.EXPANDED),
                            'the list closed')
                    chosen = [n.get_name() for n in children(live())
                              if has_state(n, Atspi.StateType.SELECTED)]
                    check('dropdown/choose', chosen == ['Fast']
                          and find(root, 'Try it: speed Fast') is not None,
                          f'chosen {chosen}, or the choice did not reach the model')
                elif page == 'segmented':
                    def segment(name):
                        # The live group's: the states above hold segments of the same names.
                        return next((n for n in walk(root) if n.get_name() == name
                                     and n.get_role() == Atspi.Role.RADIO_BUTTON
                                     and n.get_description() == 'Dock size'), None)
                    sizes = ('Small', 'Medium', 'Large')
                    group = [segment(n) for n in sizes]
                    check('segmented/group', all(group)
                          and [has_state(n, Atspi.StateType.CHECKED) for n in group] == [False, True, False],
                          'the live group is not three radio buttons named for it, Medium chosen')
                    published(lambda: group[2].get_action_iface().do_action(0))
                    chosen = [n for n in sizes
                              if (x := segment(n)) and has_state(x, Atspi.StateType.CHECKED)]
                    check('segmented/choose', chosen == ['Large']
                          and find(root, 'Try it: dock size Large') is not None,
                          f'chosen {chosen}, or the choice did not reach the model')
                elif page == 'swatches':
                    group = [n for n in walk(root) if n.get_role() == Atspi.Role.RADIO_BUTTON
                             and n.get_description() == 'Accent colour']
                    check('swatches/group', len(group) >= 2
                          and sum(has_state(n, Atspi.StateType.CHECKED) for n in group) == 1,
                          'the live colours are not a radio group with one chosen')
                    target = next(n for n in group if not has_state(n, Atspi.StateType.CHECKED))
                    name = target.get_name()
                    published(lambda: target.get_action_iface().do_action(0))
                    chosen = [n.get_name() for n in walk(root) if n.get_role() == Atspi.Role.RADIO_BUTTON
                              and n.get_description() == 'Accent colour' and has_state(n, Atspi.StateType.CHECKED)]
                    check('swatches/choose', chosen == [name]
                          and find(root, f'Try it: accent {name}') is not None,
                          f'chosen {chosen}, or the colour did not reach the model')
                    if shots:
                        # Keep the model's chosen state as visual evidence too.
                        pump(.3)
                        ipc('screenshot', directory / 'swatches-chosen.png')
                elif page == 'row':
                    check('row/inert', find(root, 'Title only', Atspi.Role.PUSH_BUTTON) is None
                          and find(root, 'Ending in a switch', Atspi.Role.TOGGLE_BUTTON) is not None,
                          'a row that is not activatable became a control, or lost its switch')
                    activate('Displays', Atspi.Role.PUSH_BUTTON)
                    check('row/open', find(root, 'Try it: opened 1 times, Bluetooth off') is not None,
                          'an activatable row did not reach the model')
                    activate('Bluetooth', Atspi.Role.TOGGLE_BUTTON)
                    flipped = find(root, 'Bluetooth', Atspi.Role.TOGGLE_BUTTON)
                    check('row/flip', flipped is not None and has_state(flipped, Atspi.StateType.CHECKED)
                          and find(root, 'Try it: opened 1 times, Bluetooth on') is not None,
                          'the whole row did not flip its setting')
                elif page == 'slider':
                    node = find(root, 'Volume', Atspi.Role.SLIDER)
                    published(lambda: node.get_value_iface().set_current_value(80.))
                    check('slider/value', find(root, 'Try it: 80 %') is not None,
                          'a value set by a reader did not reach the model')
                    row = find(root, 'Brightness', Atspi.Role.SLIDER)
                    published(lambda: row.get_value_iface().set_current_value(25.))
                    check('slider/row', find(root, '25 %') is not None
                          and find(root, 'Plain', Atspi.Role.PUSH_BUTTON) is None,
                          'a slider row did not show its value, or its row became a control')
                elif page == 'disclosure':
                    header = find(root, 'Advanced', Atspi.Role.TOGGLE_BUTTON)
                    check('disclosure/role', header is not None
                          and has_state(header, Atspi.StateType.EXPANDABLE),
                          'the header is not an expandable toggle button')
                    check('disclosure/closed', not has_state(header, Atspi.StateType.EXPANDED)
                          and find(root, 'Revealed action', Atspi.Role.PUSH_BUTTON) is None,
                          'collapsed content remained in the reader tree')
                    activate('Advanced', Atspi.Role.TOGGLE_BUTTON)
                    barrier(lambda: find(root, 'Revealed action', Atspi.Role.PUSH_BUTTON),
                            'disclosure content in the reader tree')
                    header = find(root, 'Advanced', Atspi.Role.TOGGLE_BUTTON)
                    check('disclosure/open', has_state(header, Atspi.StateType.EXPANDED),
                          'expansion did not reach the model')
                    disabled = find(root, 'Disabled', Atspi.Role.TOGGLE_BUTTON)
                    check('disclosure/disabled', disabled is not None
                          and not has_state(disabled, Atspi.StateType.ENABLED),
                          'the disabled header became enabled')
                    activate('Advanced', Atspi.Role.TOGGLE_BUTTON)
                    barrier(lambda: find(root, 'Revealed action', Atspi.Role.PUSH_BUTTON) is None,
                            'collapsed disclosure content removed')
                    check('disclosure/close', not has_state(
                        find(root, 'Advanced', Atspi.Role.TOGGLE_BUTTON), Atspi.StateType.EXPANDED),
                          'collapse did not reach the model')
                elif page == 'reveal':
                    activate('Open', Atspi.Role.PUSH_BUTTON)
                    check('reveal/open', find(root, 'Revealed') is not None, 'the reveal did not open')
            if editor_only or list_only:
                return "PASS"
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
started = time.monotonic()
try:
    for scale in (1, 1.25):
        ipc('output', output['name'], f'scale={scale}')
        print(f'scale {scale}', flush=True)
        results[f'scale{scale}'] = run(LOG / f'scale{scale}')
    print('controls: editor paths independently disabled', flush=True)
    # Each control must fail an oracle in its own input phase, never an infrastructure wait.
    for fault, stage in [('editor-no-keyboard','first-key'), ('editor-no-ime','preedit'),
                         ('editor-no-replace','replace'), ('editor-no-cancel','cancel'),
                         ('editor-no-commit','commit'), ('editor-no-select','select'),
                         ('editor-no-copy','copy'), ('editor-no-cut','cut'), ('editor-no-paste','paste'),
                         ('editor-no-undo','undo'), ('editor-no-redo','redo')]:
        try:
            run(LOG / fault,fault=fault,shots=False,editor_only=True)
            raise InfrastructureError(f'editor control {fault} passed')
        except OracleFailure as error:
            if 'entry/'+stage not in str(error):
                raise InfrastructureError(f'{fault} failed the wrong oracle: {error}') from error
            print(f'  control CAUGHT {fault}: {error}',flush=True)
            results[fault]='CAUGHT'
    print('control: activations dropped', flush=True)
    try:
        run(LOG / 'control-inert', fault='inert', shots=False)
        raise InfrastructureError('the inert control passed: the oracles cannot fail')
    except OracleFailure as e:
        print(f'  control CAUGHT: {e}', flush=True)
        results['control'] = 'CAUGHT'
    print('control: list selection dropped', flush=True)
    try:
        run(LOG / 'control-list-inert', fault='inert', shots=False, list_only=True)
        raise InfrastructureError('the inert list control passed')
    except OracleFailure as error:
        if 'list/end:' not in str(error):
            raise InfrastructureError(f'list control failed the wrong oracle: {error}') from error
        print(f'  control CAUGHT list: {error}', flush=True)
        results['list-control'] = 'CAUGHT'
    (LOG / 'result.json').write_text(json.dumps(results, indent=2))
finally:
    (LOG / 'duration.json').write_text(json.dumps({'elapsed_seconds': time.monotonic() - started}, indent=2))
    try:
        ipc('output', output['name'], f"scale={output['scale']}")
    finally:
        registry.terminate()
        registry.wait(timeout=3)
        registry_log.close()
        PIPE.close()
