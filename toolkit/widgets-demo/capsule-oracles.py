#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Evaluate external white/dark/white captures; no intermediate RGB ink estimator."""
import argparse
import json
from pathlib import Path
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
from capsule_capture import answer_revisions, material_ready

def external(directory, scale):
    import re
    result = json.loads((directory / 'result.json').read_text())
    if len(set(result['separate_pids'])) != 2 or result['scale'] != scale:
        raise RuntimeError('external fixture identity/scale mismatch')
    samples = result['samples']
    wire = len(re.findall(r'wl_surface@\d+\.commit\(', (directory / 'capsule.log').read_text()))
    assert wire == samples[0]['all_surface_commits'] > 0, 'capsule wire commits continued after baseline'
    assert len({s['root_commits'] for s in samples}) == 1, 'capsule root committed during external changes'
    observed = []
    for stage, expected in [('white', 1.), ('dark-after-change', 0.), ('white-after-change', 1.)]:
        window = json.loads((directory / f'{stage}.json').read_text())
        metadata = json.loads((directory / f'{stage}.capture.json').read_text())
        before = json.loads((directory / f'{stage}-before.json').read_text())
        first = json.loads((directory / f'{stage}-capture-before.json').read_text())
        if (str(window['id']) in metadata.get('opening', {})
                or not material_ready(first, expected, before)
                or not material_ready(window, expected, before)
                or answer_revisions(first) != answer_revisions(window)):
            raise RuntimeError('external capture not stable across fresh, settled answer revisions')
        layer = max(window['layers'], key=lambda l: l['width'])
        image = GdkPixbuf.Pixbuf.new_from_file(str(directory / f'{stage}.png'))
        pixels, stride, channels = image.get_pixels(), image.get_rowstride(), image.get_n_channels()
        x = int((window['x'] + layer['x'] + 8) * scale)
        y = int((window['y'] + layer['y'] + 8) * scale)
        values = sorted(sum(pixels[j * stride + i * channels:j * stride + i * channels + 3]) / 3
                        for i in range(x, x + int(16 * scale)) for j in range(y, y + int(16 * scale)))
        low, middle, high = (values[len(values) * n // 10] for n in (1, 5, 9))
        if expected == 1.:
            assert low < 128 < middle, f'external white page has no dark glyph on light glass: {stage}'
        else:
            assert middle < 128 < high, 'external dark page has no light glyph on dark glass'
        observed.append({'stage': stage, 'p10': low, 'p50': middle, 'p90': high})
    return {'samples': observed, 'wire_commits': wire, 'root_commits': samples[0]['root_commits'],
            'zero_commits_during_changes': True, 'control_catches': False}



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--external', type=Path, required=True)
    parser.add_argument('--external-control', type=Path)
    parser.add_argument('--scale', type=float, choices=(1.,1.25), default=1.)
    args = parser.parse_args()
    result = external(args.external, args.scale)
    if args.external_control:
        marker = 'CAPSULE_LAB_FAULT_APPLIED fixed-light-ink'
        if marker not in (args.external_control / 'capsule.log').read_text():
            raise RuntimeError('external control was not applied')
        try:
            external(args.external_control, args.scale)
        except AssertionError as error:
            if 'external white page has no dark glyph on light glass' not in str(error):
                raise RuntimeError('external control failed outside its own ink assertion') from error
            result['control_catches'] = {'fixed-light-ink': str(error)}
        else:
            raise AssertionError('fixed-light-ink escaped external backdrop oracle')
    (args.external / 'external-oracles.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS external backdrop/glyph response with zero capsule wire commits')

if __name__ == '__main__':
    main()
