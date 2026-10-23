#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Local private two-client capture walk; no new CI job.

Run through check-headless.sh with NK_WIDGETS_CHECK pointing here, immutable
NK_WIDGETS_BIN/HYALO_BIN and NK_WIDGETS_HYALO_CONFIG disabling fixture-window
backdrops. CAPSULE_EXTERNAL_SCALE selects1 or1.25. A fault is applied only to the
capsule client; capture setup never waits for the ink value an oracle will assert.
Material measurement is driven by warmup captures and must be settled, matching
the new external background, before the final capture. No control is caught here;
capsule-oracles.py evaluates the independent baseline/control artifacts.
"""
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import time
from capsule_capture import publish_command, answer_revisions, material_ready
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
ROOT = Path(os.environ['NK_WIDGETS_REPO'])
LOG = Path(os.environ.get('NK_WIDGETS_LOG', ROOT / 'toolkit/target/capsule-external-evidence')).resolve()
BIN = os.environ.get('NK_WIDGETS_BIN', str(ROOT / 'toolkit/target/release/nk-widgets-demo'))
MSG = [os.environ.get('HYALO_BIN', 'nidara-hyalo'), 'msg']
DATA = Path(os.environ.get('NK_SETTINGS_DATA', ROOT / 'build/settings-data'))
CONTENT_WIDTH = json.loads((DATA / 'tokens/static.json').read_text())['ts']['WINDOW_LAYOUT']['contentFloor']
if os.environ.get('NK_WIDGETS_TEST') == 'vkms':
    if os.environ.get('XDG_RUNTIME_DIR') != '/run/hyalo-smoke':
        raise RuntimeError('private vkms runtime required')
elif Path(os.environ['XDG_RUNTIME_DIR']).resolve() != Path(os.environ['NK_WIDGETS_RUN']).resolve() / 'runtime':
    raise RuntimeError('use toolkit/widgets-demo/check-headless.sh')
if LOG == Path('/tmp') or Path('/tmp') in LOG.parents:
    raise RuntimeError('nk-widgets evidence must not use /tmp')
LOG.mkdir(parents=True, exist_ok=True)
if any(p.name not in {'cage.log', 'hyalo.log', 'check.log'} for p in LOG.iterdir()):
    raise RuntimeError('use a new empty capture directory; stale results are not evidence')
(LOG / 'environment.json').write_text(json.dumps({'revision': subprocess.check_output(['git', '-c', 'safe.directory=*', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(), 'demo_sha256': hashlib.sha256(Path(BIN).read_bytes()).hexdigest(), 'compositor_sha256': hashlib.sha256(Path(MSG[0] if '/' in MSG[0] else shutil.which(MSG[0])).read_bytes()).hexdigest(), 'runtime': os.environ['XDG_RUNTIME_DIR'], 'fault': os.environ.get('CAPSULE_LAB_FAULT'), 'scale': os.environ.get('CAPSULE_EXTERNAL_SCALE', '1')}, indent=2))

class InfrastructureError(RuntimeError):
    pass

def pump(seconds=0.05):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(0.005)

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
                if node and node.get_name() == 'Nidara control capsule lab':
                    return node
        except GLib.Error:
            continue
    return None

def find(root, name, role=None):
    return next((n for n in walk(root) if n.get_name() == name and (role is None or n.get_role() == role)), None)

def ipc(*args):
    response = subprocess.run([*MSG, *map(str, args)], capture_output=True, text=True, check=True)
    return json.loads(response.stdout)['ok']
session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
os.environ['AT_SPI_BUS_ADDRESS'] = address
registry_path = next((p for p in [Path('/usr/lib/at-spi2-registryd'), Path('/usr/libexec/at-spi2-registryd')] if p.exists()))
registry_log = (LOG / 'registry.log').open('w')
registry = subprocess.Popen([str(registry_path)], stdout=registry_log, stderr=registry_log)
private_bus = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
barrier(lambda: private_bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', ('org.a11y.atspi.Registry',)), GLib.VariantType.new('(b)'), Gio.DBusCallFlags.NONE, 1000, None).unpack()[0], 'registry')
session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set', GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))), None, Gio.DBusCallFlags.NONE, 5000, None)
import re
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
command = LOG / 'backdrop.command'
publish_command(command, 'white\n')
backlog = LOG / 'backdrop.log'
frontlog = LOG / 'capsule.log'
back = front = None
try:
    ipc('do', 'workspace', 94)
    ipc('do', 'set-workspace-mode', 94, 'floating')
    scale = float(os.environ.get('CAPSULE_EXTERNAL_SCALE', '1'))
    if scale not in (1., 1.25):
        raise InfrastructureError('supported external diagnostic scales:1 and1.25')
    output = ipc('outputs')['outputs'][0]
    ipc('output', output['name'], f'scale={scale}')
    with backlog.open('w') as bs, frontlog.open('w') as fs:
        back = subprocess.Popen([BIN, f'--capsule-backdrop={command}'], stdout=bs, stderr=bs)
        barrier(lambda: 'CAPSULE_BACKDROP_COMMIT' in backlog.read_text(), 'external backdrop committed')
        front = subprocess.Popen([BIN, '--capsule-lab=overlay', f'--content-width={CONTENT_WIDTH}'] + ([f"--capsule-lab-fault={os.environ['CAPSULE_LAB_FAULT']}"] if os.environ.get('CAPSULE_LAB_FAULT') else []), env={**os.environ, 'WAYLAND_DEBUG': 'client'}, stdout=fs, stderr=fs)
        barrier(lambda: 'CAPSULE_LAB_COMMIT' in frontlog.read_text(), 'capsule client committed')
        root = barrier(app_tree, 'capsule tree')

        def current():
            return next((w for w in ipc('windows')['windows'] if w['app_id'] == 'nk-capsule-lab'))

        def capture(stage, expected, before=None):
            path = LOG / f'{stage}.png'

            def ready():
                if front.poll() is not None or back.poll() is not None:
                    raise InfrastructureError('fixture client exited')
                ipc('screenshot', path)
                w = current()
                meta = json.loads((LOG / f'{stage}.capture.json').read_text())
                if str(w['id']) in meta.get('opening', {}):
                    return None
                if not material_ready(w, expected, before):
                    return None
                return w
            w = barrier(ready, f'{stage} measured settled external answer', seconds=20)
            (LOG / f'{stage}.json').write_text(json.dumps(w, indent=2))
            (LOG / f'{stage}-before.json').write_text(json.dumps(before))
            layer = max(w['layers'], key=lambda l: l['width'])
            im = GdkPixbuf.Pixbuf.new_from_file(str(path))
            data = im.get_pixels()
            stride = im.get_rowstride()
            n = im.get_n_channels()
            x = int((w['x'] + layer['x'] + 8) * scale)
            y = int((w['y'] + layer['y'] + 8) * scale)
            values = sorted((sum(data[j * stride + i * n:j * stride + i * n + 3]) / 3 for i in range(x, x + int(16 * scale)) for j in range(y, y + int(16 * scale))))
            return {'answers': [l['answers'] for l in w['layers']], 'p10': values[len(values) // 10], 'p90': values[len(values) * 9 // 10], 'p50': values[len(values) // 2], 'root_commits': len(re.findall('CAPSULE_LAB_COMMIT', frontlog.read_text())), 'all_surface_commits': len(re.findall('wl_surface@\\d+\\.commit\\(', frontlog.read_text()))}
        samples = [capture('white', 1)]
        if not os.environ.get('CAPSULE_LAB_FAULT'):
            assert samples[0]['p10'] < 128 < samples[0]['p50'], 'white external backdrop did not produce dark glyphs'
        for scene, expected in [('dark', 0), ('white', 1)]:
            before = answer_revisions(current())
            commits = backlog.read_text().count(f'command={scene}')
            publish_command(command, scene + '\n')
            barrier(lambda: backlog.read_text().count(f'command={scene}') > commits,
                    'external client new command')
            sample = capture(scene + '-after-change', expected, before)
            samples.append(sample)
        if not os.environ.get('CAPSULE_LAB_FAULT'):
            assert samples[1]['p50'] < 128 < samples[1]['p90'], 'dark external backdrop did not produce light glyphs'
        assert len({s['root_commits'] for s in samples}) == 1, 'capsule root committed during external backdrop change'
        assert len({s['all_surface_commits'] for s in samples}) == 1, 'capsule surface committed during external backdrop change'
        assert samples[0]['all_surface_commits'] > 0, 'wire commit counter did not observe setup'
        result = {'samples': samples, 'separate_pids': [back.pid, front.pid], 'scale': scale, 'control_catches': False}
        (LOG / 'result.json').write_text(json.dumps(result, indent=2))
        print('CAPTURE external white/dark/white measured response; ink is evaluated separately', flush=True)
finally:
    for proc in [front, back, registry]:
        if proc is not None:
            proc.terminate()
            proc.wait(timeout=5)
