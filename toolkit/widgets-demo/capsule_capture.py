# SPDX-License-Identifier: LGPL-3.0-or-later
"""Filesystem publication and metadata barriers; no display/bus imports."""
import json
from pathlib import Path


def publish_command(path, value):
    """One writer publishes complete command bytes by same-directory rename."""
    path = Path(path)
    pending = path.with_suffix('.pending')
    pending.write_text(value)
    pending.replace(path)


def answer_revisions(window):
    layers = window['layers']
    if len(layers) != 2:
        raise ValueError('expected two capsule layers')
    result = {}
    for layer in layers:
        key = json.dumps([layer[k] for k in ('x', 'y', 'width', 'height')])
        if key in result:
            raise ValueError('ambiguous capsule geometry')
        result[key] = layer['answers']['revision']
    result['server'] = window['controls_answers']['revision']
    if not all(type(v) is int and v >= 0 for v in result.values()):
        raise ValueError('invalid answer revision')
    return result


def material_ready(window, expected, before=None):
    try:
        revisions = answer_revisions(window)
        shapes = [s for layer in window['layers'] for s in layer['answers']['shapes']]
        shapes += window['controls_answers']['shapes']
        if before is not None and (revisions.keys() != before.keys()
                or not all(revisions[k] > before[k] for k in revisions)):
            return False
        return len(shapes) == 3 and all(s['measured'] and s['settled']
            and abs(s['r'] - expected) < .01 for s in shapes)
    except (KeyError, TypeError, ValueError):
        return False
