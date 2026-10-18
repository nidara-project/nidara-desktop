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
CI also runs it on a copy with one used token dropped from one set, which must fail.
"""
import json, re, sys
from itertools import product
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]) / 'tokens'
colors = json.loads((out / 'colors.json').read_text())
static = json.loads((out / 'static.json').read_text())
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

if fail:
    print('\n'.join(f'FAIL: {f}' for f in fail))
    sys.exit(1)
print(f'settings tokens OK: {len(sets)} colour sets, {len(used)} used tokens in each, '
      f'{len(static["scss"])} scss + {len(static["ts"])} ts static')
