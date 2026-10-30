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


procs = []


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
    for f in Path('/usr/share/glib-2.0/schemas').glob('*.gschema.xml'):
        if f.name != 'org.nidara.gschema.xml':
            (out / f.name).symlink_to(f)
    (out / 'org.nidara.gschema.xml').symlink_to(REPO / 'config/gsettings/org.nidara.gschema.xml')
    subprocess.run(['glib-compile-schemas', str(out)], check=True, timeout=30)
    return str(out)


try:
    os.environ['GSETTINGS_SCHEMA_DIR'] = schemas()
    start('sessiond', [SESSIOND, '--applications'], XDG_DATA_DIRS=catalogue())
    def snapshot():
        r = subprocess.run(['busctl', '--user', '--json=short', 'call', 'org.nidara.Applications',
                            '/org/nidara/Applications', 'org.nidara.Applications1', 'GetSnapshot'],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and r.stdout
    (LOG / 'snapshot.json').write_text(until('Applications1 answering', snapshot))
    shell = start('shell', [SHELL])
    first = until('a dock layer', docks)
    # Software Hyalo cannot take a GL client's dmabufs here (it crashes); draw on the CPU.
    start('client', ['gtk4-demo'], GDK_BACKEND='wayland', GSK_RENDERER='cairo', GDK_DISABLE='gl,vulkan')
    until('a client window', lambda: ipc('windows').get('ok', {}).get('windows'))
    time.sleep(1.5)  # icons, the running dot and the glass settle
    result = {'first': first}
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
