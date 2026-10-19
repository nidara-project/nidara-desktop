#!/usr/bin/env python3
"""The token export the native Settings paints with (scripts/export-tokens.mjs) is complete.

usage: settings-tokens-check.py OUT_DIR
- Every `var(--nidara-*)` the current Settings and the kit's sheets paint with exists in EVERY
  colour set: a token used but defined nowhere is a declaration GTK silently drops (the
  installer shipped a hover that did nothing that way — token-contract-check.mjs).
- One set per input of the engine: accents × dark/light × reduce transparency × window
  transparency, each combination once.
- The mode really changes the ink, and the accent really reaches --nidara-accent.
- The static half carries the radius ladder and the type ramp.
- The glass (glass.json, D7): one variant per dark/light × reduce transparency, each with the
  same pieces, `panel` among them; each piece's steps start at side 0 and grow; the sized
  pieces really follow the size in the dark face, reduce transparency really makes them solid,
  and the light face is not the dark one.
CI also runs it on a copy with one used token dropped from one set, and on one with `panel`
dropped from one glass variant; both must fail.
"""
import json, re, sys
from itertools import product
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]) / 'tokens'
colors = json.loads((out / 'colors.json').read_text())
static = json.loads((out / 'static.json').read_text())
glass = json.loads((out / 'glass.json').read_text())
fail = []

sheets = ['ui/settings/style.scss', 'ui/shell/styles/_settings.scss', 'ui/shell/styles/_components.scss',
          'ui/shell/styles/_reset.scss', 'ui/lib/nidara-kit/styles/_components.scss',
          'ui/lib/nidara-kit/styles/_mixins.scss']
used = set()
for sheet in sheets:
    used |= set(re.findall(r'var\((--nidara-[\w-]+)', (repo / sheet).read_text()))
if len(used) < 10:
    fail.append(f'only {len(used)} tokens found in the sheets — the scan itself is broken')

sets = colors['sets']
accents = colors['accents']
want = set(product(accents, [True, False], [False, True], ['opaque', 'tinted', 'translucent']))
got = [(s['accent'], s['dark'], s['reduceTransparency'], s['windowBackground']) for s in sets]
if set(got) != want or len(got) != len(want):
    fail.append(f'{len(got)} sets for {len(want)} engine inputs')

for s in sets:
    missing = sorted(used - set(s['tokens']))
    if missing:
        fail.append(f"{s['accent']}/{'dark' if s['dark'] else 'light'}: used but missing {missing}")
        break
    if s['tokens'].get('--nidara-accent', '').lower() != accents[s['accent']].lower():
        fail.append(f"{s['accent']}: --nidara-accent is {s['tokens'].get('--nidara-accent')}")
        break

pick = lambda dark: next(s['tokens'] for s in sets if s['accent'] == 'blue' and s['dark'] == dark
                         and not s['reduceTransparency'] and s['windowBackground'] == 'translucent')
if pick(True).get('--nidara-text') == pick(False).get('--nidara-text'):
    fail.append('dark and light sets have the same --nidara-text')

if 'RADIUS' not in static.get('ts', {}) or 'fs-body' not in static.get('scss', {}):
    fail.append('static: no RADIUS (tokens.ts) or fs-body (_tokens.scss)')

variants = glass.get('variants', [])
keys = [(v['dark'], v['reduceTransparency']) for v in variants]
if sorted(keys) != sorted(product([True, False], [False, True])):
    fail.append(f'glass: variants {keys}, want dark/light × reduce transparency once each')
pieces = {frozenset(v['pieces']) for v in variants}
if len(pieces) != 1 or 'panel' not in next(iter(pieces), ()):
    fail.append(f'glass: the variants carry different pieces, or no panel: {[sorted(p) for p in pieces]}')
for v in variants:
    for name, steps in v['pieces'].items():
        sides = [st['fromSide'] for st in steps]
        if not sides or sides[0] != 0 or sides != sorted(set(sides)):
            fail.append(f"glass: {name} (dark={v['dark']}) steps from {sides[:3]}…, want 0 and growing")
for b in ('panel', 'popover'):
    if not isinstance(glass.get('blur', {}).get(b, {}).get('passes'), int):
        fail.append(f'glass: no {b} blur')
variant = lambda dark, reduce: next((v for v in variants if v['dark'] == dark and v['reduceTransparency'] == reduce), None)
if all(variant(d, r) for d, r in product([True, False], [False, True])) and not fail:
    panel = lambda d, r: variant(d, r)['pieces']['panel']
    if len(panel(True, False)) < 2:
        fail.append('glass: the dark panel does not follow its size (one step)')
    if any(st['tone']['wash']['a'] < 0.99 for st in panel(True, True) + panel(False, True)):
        fail.append('glass: reduce transparency leaves the panel see-through')
    if panel(True, False)[-1]['tone'] == panel(False, False)[-1]['tone']:
        fail.append('glass: the light panel is the dark one')
    ink = variant(True, False).get('ink') or {}
    if not (0 < ink.get('lightBelow', -1) < ink.get('darkAbove', -1) <= 1):
        fail.append(f"glass: no ink thresholds a reader can apply ({variant(True, False).get('ink')})")
    if variant(True, True).get('ink') is not None:
        fail.append('glass: reduce transparency still measures the ink')

if fail:
    print('\n'.join(f'FAIL: {f}' for f in fail))
    sys.exit(1)
print(f'settings tokens OK: {len(sets)} colour sets, {len(used)} used tokens in each, '
      f'{len(static["scss"])} scss + {len(static["ts"])} ts static, {len(variants)} glass variants')
