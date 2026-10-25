#!/usr/bin/env python3
"""Prepare an inspectable preview overlay under this checkout's build/ or target/.

This does not install files or replace the public nidara-settings launcher. The
result overlays an existing Nidara package; shared assets and the GJS host remain
provided by that package. Build nk-settings, the GJS bundle and exports first.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

repo = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
destination = args.destination.resolve()
if not any(destination.is_relative_to(repo / name) and destination != repo / name
           for name in ('build', 'target')):
    parser.error('destination must be a new subdirectory of this checkout build/ or target/')
files = {
    'toolkit/target/release/nk-settings': 'usr/lib/nidara/nidara-settings-native',
    'bin/nidara-settings-native': 'usr/bin/nidara-settings-native',
    'bin/nidara-settings-legacy': 'usr/bin/nidara-settings-legacy',
    'ui/settings/build/nidara-settings': 'usr/share/nidara/ui/settings/build/nidara-settings',
    'packaging/nidara/settings-entrypoint': 'usr/share/nidara/settings-native/nidara-settings',
}
for source in files:
    if not (repo / source).is_file():
        parser.error(f'missing build artifact: {source}')
data = repo / 'build/settings-data'
if not (data / 'tokens/components.json').is_file():
    parser.error('export settings-data and tokens first')
if destination.exists():
    parser.error('destination already exists; choose a new staging directory')
destination.mkdir(parents=True)
manifest = {}
for source, target in files.items():
    output = destination / target
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(repo / source, output)
    manifest[target] = hashlib.sha256(output.read_bytes()).hexdigest()
shutil.copytree(data, destination / 'usr/share/nidara/settings-data')
report = {
    'source_revision': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
    'source_dirty': bool(subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'])),
    'files_sha256': manifest, 'public_launcher_replaced': False,
    'installed': False, 'gate4_complete': False,
}
(destination / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
print(destination)
