#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Manual private Nautilus DnD check, selected by check-drops-headless.sh."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

PDF_APP = 'org.nidara.DropChrome.desktop'
TG_APP = 'org.nidara.DropTelegram.desktop'


def catalogue(data):
    (data / 'mime').symlink_to('/usr/share/mime')
    for ident, name, types, dbus in [
        (PDF_APP, 'Drop Chrome', 'application/pdf;x-scheme-handler/https;', True),
        (TG_APP, 'Drop Telegram', 'x-scheme-handler/tg;', False),
    ]:
        (data / 'applications' / ident).write_text(
            '[Desktop Entry]\nType=Application\nName=' + name + '\nExec=/usr/bin/true %U\n'
            'Icon=application-pdf\nMimeType=' + types + '\nDBusActivatable=' + str(dbus).lower() + '\n')
    subprocess.run(['gsettings', 'set', 'org.nidara.dock', 'layout',
                    repr(['app:org.gnome.Nautilus.desktop', 'app:' + PDF_APP, 'app:' + TG_APP])], check=True)
    subprocess.run(['gsettings', 'set', 'org.nidara.dock', 'layout-version', '1'], check=True)
    subprocess.run(['gsettings', 'set', 'org.nidara.dock', 'magnification', 'false'], check=True)
    subprocess.run(['gsettings', 'set', 'org.nidara.dock', 'auto-hide', 'false'], check=True)


def receiver(path):
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    xml = '<node><interface name="org.freedesktop.Application"><method name="Open"><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/></method></interface></node>'
    info = Gio.DBusNodeInfo.new_for_xml(xml)
    def call(c, sender, obj, interface, method, args, inv):
        Path(path).write_text(json.dumps(args.unpack()[0]))
        inv.return_value(None)
    bus.register_object('/org/nidara/DropChrome', info.interfaces[0], call, None, None)
    result = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                          'RequestName', GLib.Variant('(su)', ('org.nidara.DropChrome', 4)),
                          None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    assert result == 1
    Path(path + '.ready').touch()
    GLib.MainLoop().run()


def run(ctx):
    from gi.repository import Atspi
    run_dir, log = ctx['RUN'], ctx['LOG']
    until, ipc, start = ctx['until'], ctx['ipc'], ctx['start']
    point, children, shot = ctx['item_point'], ctx['children'], ctx['shot']
    source = run_dir / 'drop-source'
    source.mkdir()
    folder, pdf = source / 'folder-for-drop', source / 'example.pdf'
    folder.mkdir()
    pdf.write_bytes(b'%PDF-1.4\n')
    received = str(log / 'opened-uris.json')
    start('drop-receiver', [sys.executable, str(Path(__file__).resolve()), '--receiver', received])
    until('private PDF receiver', lambda: Path(received + '.ready').exists())
    original_layout = subprocess.check_output(['gsettings', 'get', 'org.nidara.dock', 'layout'], text=True)
    nautilus = start('nautilus', ['nautilus', '--new-window', str(source)],
                     GDK_BACKEND='wayland', GSK_RENDERER='cairo', GDK_DISABLE='gl,vulkan',
                     WAYLAND_DEBUG='client', GTK_A11Y='atspi')
    until('private Nautilus window', lambda: any(w['app_id'] == 'org.gnome.Nautilus'
          for w in ipc('windows').get('ok', {}).get('windows', [])))
    until('dock targets', lambda: (v := ctx['walk']()) and all(
        any(n['name'] == name for n in v) for name in ['Files', 'Drop Chrome', 'Drop Telegram', 'Trash']))
    time.sleep(.5)

    def source_point(name):
        window = next(w for w in ipc('windows')['ok']['windows'] if w['app_id'] == 'org.gnome.Nautilus')
        def find(node, depth=0):
            if depth > 32:
                return None
            if node.get_role_name() == 'table cell' and node.get_name().startswith(name + '. '):
                r = node.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
                if r.width > 5 and r.height > 5:
                    return window['x'] + r.x + r.width // 2, window['y'] + r.y + r.height // 2
            for child in children(node):
                if result := find(child, depth + 1):
                    return result
        for app in children(Atspi.get_desktop(0)):
            if result := find(app):
                return result

    ansi = re.compile(r'\x1b\[[0-9;]*m')
    def feedback():
        text = ansi.sub('', (log / 'hyalo.log').read_text())
        return re.findall(r'drag destination feedback hint=(\w+).*?cursor=Named\((\w+)\)', text)
    def ended_count():
        return (log / 'hyalo.log').read_text().count('drag destination ended')
    def last_feedback(wanted, after):
        history = feedback()
        return len(history) > after and history[-1] == wanted

    pipe = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)
    def move_to(p):
        pipe.write(f'move {p[0]} {p[1]}\n')
    def over(name, intent, cursor):
        before = len(feedback())
        def ready():
            move_to(point(name))
            return last_feedback((intent, cursor), before)
        until(f'{name}: {intent}/{cursor}', ready)
    def begin(name, target, intent, cursor):
        try:
            p = until('Nautilus item ' + name, lambda: source_point(name))
        except RuntimeError:
            rows = []
            def dump(node, depth=0):
                if depth > 32 or len(rows) > 1000:
                    return
                rows.append((depth, node.get_role_name(), node.get_name()))
                for child in children(node):
                    dump(child, depth + 1)
            for app in children(Atspi.get_desktop(0)):
                dump(app)
            (log / 'source-tree.json').write_text(json.dumps(rows, indent=2))
            (log / 'source-windows.json').write_text(json.dumps(ipc('windows'), indent=2))
            shot(log / 'source-missing.png')
            raise
        move_to(p)
        time.sleep(.15)
        pipe.write(f'press {p[0]} {p[1]} 272\n')
        time.sleep(.1)
        move_to((p[0] + 20, p[1] + 2))
        time.sleep(.2)
        over(target, intent, cursor)
    def cancel():
        before = ended_count()
        # End over the background: no destination may commit a reference.
        # Escape cancellation is compositor keyboard policy, outside this check.
        move_to((20, 20))
        time.sleep(.1)
        pipe.write('release 272\n')
        until('refused drag ended without a stuck Alias', lambda: ended_count() > before)

    try:
        begin(folder.name, 'Files', 'Open', 'Copy')
        over('Drop Chrome', 'None', 'Default')
        # Move through an accepted target so the next refusal is an actual transition.
        over('Files', 'Open', 'Copy')
        over('Drop Telegram', 'None', 'Default')
        over('Trash', 'Pin', 'Alias')
        shot(log / 'drop-folder-pin-alias.png')
        cancel()
        assert subprocess.check_output(['gsettings', 'get', 'org.nidara.dock', 'layout'], text=True) == original_layout
        assert not Path(received).exists(), 'hover/cancel launched a file'

        begin(pdf.name, 'Drop Chrome', 'Open', 'Copy')
        over('Drop Telegram', 'None', 'Default')
        over('Drop Chrome', 'Open', 'Copy')
        shot(log / 'drop-pdf-open-copy.png')
        before = ended_count()
        pipe.write('release 272\n')
        until('PDF delivered to the selected application', lambda: Path(received).exists())
        assert json.loads(Path(received).read_text()) == [pdf.as_uri()]
        until('open drop ended', lambda: ended_count() > before)

        begin(folder.name, 'Trash', 'Pin', 'Alias')
        before = ended_count()
        pipe.write('release 272\n')
        until('original folder pinned as a reference', lambda: folder.as_uri() in subprocess.check_output(
            ['gsettings', 'get', 'org.nidara.dock', 'layout'], text=True))
        until('pin drop ended', lambda: ended_count() > before)
        assert folder.is_dir() and pdf.read_bytes() == b'%PDF-1.4\n', 'source data changed'

        source_log = (log / 'nautilus.log').read_text()
        actions = re.findall(r'wl_data_source[^\n]*\.set_actions\((\d+)\)', source_log)
        assert actions and all(int(mask) & 1 for mask in actions), actions
        shell_log = (log / 'shell.log').read_text()
        receives = re.findall(r'wl_data_offer[^\n]*\.receive\(Some\("text/uri-list"\)', shell_log)
        assert len(receives) == 3, f'expected one pre-read for each of three offers, got {len(receives)}'
        report = {'nautilus_wire_actions': actions, 'uri_reads': len(receives), 'feedback': feedback(),
                  'pdf_delivered': json.loads(Path(received).read_text()), 'pin_reference': folder.as_uri(),
                  'source_unchanged': True, 'layout_before': original_layout}
        (log / 'drops.json').write_text(json.dumps(report, indent=2))
        print('PASS #1031: real Nautilus MIME refusals, Copy/Open, Alias/Pin, refused/drop cleanup, one pre-read, PDF delivery and original-folder reference', flush=True)
        print(json.dumps(report, indent=2), flush=True)
    finally:
        pipe.write('key 1\nrelease 272\n')
        pipe.close()


if __name__ == '__main__' and sys.argv[1:2] == ['--receiver']:
    receiver(sys.argv[2])
