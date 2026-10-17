#!/usr/bin/env python3
"""The export the native Settings reads (scripts/export-settings-data.mjs) is complete.

usage: settings-data-check.py OUT_DIR
Compared against an INDEPENDENT reading of the sources — page ids and every locale's keys
taken from the .ts text by pattern, not by importing it — so a key or page the export drops
fails here. CI also runs it on a copy with one key removed, which must fail.
"""
import json, re, sys
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1])
fail = []

manifest = json.loads((out / 'manifest.json').read_text())
src = (repo / 'ui/shell/surfaces/settings/manifest.ts').read_text()
src_ids = re.findall(r'^ {8}id: "([^"]+)"', src, re.M)
ids = [p['id'] for p in manifest]
if ids != src_ids:
    fail.append(f'manifest: pages {ids} != source {src_ids}')

appearance = next((p for p in manifest if p['id'] == 'appearance'), None)
if not appearance or len(appearance.get('groups', [])) < 1:
    fail.append('manifest: no Appearance page with groups')

locales = sorted((repo / 'ui/shell/core/i18n/locales').glob('*.ts'))
for ts in locales:
    keys = set(re.findall(r'^\s*"([^"]+)"\s*:', ts.read_text(), re.M))
    path = out / 'i18n' / (ts.stem + '.json')
    if not path.exists():
        fail.append(f'i18n: {path.name} missing')
        continue
    got = json.loads(path.read_text())
    if set(got) != keys:
        missing, extra = sorted(keys - set(got))[:5], sorted(set(got) - keys)[:5]
        fail.append(f'i18n {ts.stem}: {len(got)} keys vs {len(keys)} in source (missing {missing}, extra {extra})')
    if any(not isinstance(v, str) or not v for v in got.values()):
        fail.append(f'i18n {ts.stem}: a value is empty or not a string')

if fail:
    print('\n'.join(f'FAIL: {f}' for f in fail))
    sys.exit(1)
print(f'settings data OK: {len(ids)} pages, {len(locales)} locales')
