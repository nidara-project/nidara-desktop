#!/usr/bin/env python3
"""The export the native Settings reads (scripts/export-settings-data.mjs) is complete and exact.

usage: settings-data-check.py OUT_DIR
Compared against an INDEPENDENT reading of the sources — taken from the .ts text by pattern,
not by importing it: the page ids in order; every key AND value of every locale (each value is
one double-quoted line, read as a JSON string); Appearance's items, keys and predicates. CI also
runs it on copies with a key removed, a value changed and a predicate dropped: each must fail.
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
else:
    # Appearance is the page the native Settings draws (PHASE1.md D2): every item, key and
    # predicate in the export, as the source spells them.
    start = src.index('id: "appearance"')
    nxt = re.search(r'^ {8}id: "', src[start + 1:], re.M)
    block = src[start:start + 1 + nxt.start()] if nxt else src[start:]
    want = sorted(re.findall(r'(?:custom|decoration|key): "([^"]+)"', block)
                  + re.findall(r'^\s*"([a-z]+\.[A-Za-z.]+)",\s*$', block, re.M))
    got = []
    def walk(items):
        for it in items:
            if isinstance(it, str):
                got.append(it)
                continue
            for field in ('custom', 'decoration', 'key'):
                if field in it:
                    got.append(it[field])
            for when in ('visibleWhen', 'sensitiveWhen'):
                if when in it:
                    got.append(it[when]['key'])
            walk(it.get('items', []))
    for g in appearance['groups']:
        walk(g.get('items', []))
        if 'footerWhen' in g:
            got.append(g['footerWhen']['key'])
    if sorted(got) != want:
        fail.append(f'manifest: Appearance items {sorted(got)} != source {want}')

locales = sorted((repo / 'ui/shell/core/i18n/locales').glob('*.ts'))
for ts in locales:
    pairs = re.findall(r'^\s*"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*(?://.*)?$', ts.read_text(), re.M)
    source = {k: json.loads(v) for k, v in pairs}
    keys = set(source)
    if len(re.findall(r'^\s*"[^"]+"\s*:', ts.read_text(), re.M)) != len(pairs):
        fail.append(f'i18n {ts.stem}: a value the pattern cannot read (not one double-quoted line)')
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
    wrong = [k for k in keys & set(got) if got[k] != source[k]][:5]
    if wrong:
        fail.append(f'i18n {ts.stem}: values differ from the source for {wrong}')

if fail:
    print('\n'.join(f'FAIL: {f}' for f in fail))
    sys.exit(1)
print(f'settings data OK: {len(ids)} pages, {len(locales)} locales')
