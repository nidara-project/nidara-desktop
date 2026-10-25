# SPDX-License-Identifier: LGPL-3.0-or-later
"""Read-only legacy queryUI observations, scoped to the rendered row, never registry state."""
import re

def row(nodes, label):
    shown = [n for n in nodes if n.get('visible') and n.get('mapped')]
    title = next((n for n in shown if n.get('text') == label and all(k in n.get('bounds', {}) for k in ('x', 'y', 'w', 'h'))), None)
    if title is None:
        return []
    b = title['bounds']
    cy = b['y'] + b['h']/2
    return [n for n in shown if all(k in n.get('bounds', {}) for k in ('x','y','w','h'))
            and n['bounds']['x'] >= b['x'] and n['bounds']['y'] <= cy+12
            and n['bounds']['y'] + n['bounds']['h'] >= cy-12
            and n['bounds']['w'] > 0 and n['bounds']['h'] > 0]

def contains(nodes, kind, expected):
    if kind == 'toggle':
        return any(n.get('active') is expected for n in nodes)
    text = ' '.join(n.get('text') or '' for n in nodes).lower()
    if kind in ('radio', 'gallery'):
        # The selected widget must geometrically contain the actual option label.
        selected = [n for n in nodes if n.get('active') is True or
                    {'selected', 'active', 'checked'} & set(n.get('cssClasses', []))]
        return any(t.get('text', '').lower() == str(expected).lower() and
                   b['x'] <= t['bounds']['x'] and b['y'] <= t['bounds']['y'] and
                   t['bounds']['x'] + t['bounds']['w'] <= b['x'] + b['w'] and
                   t['bounds']['y'] + t['bounds']['h'] <= b['y'] + b['h']
                   for n in selected for b in [n['bounds']] for t in nodes if t.get('text'))
    if kind == 'time':
        digits = str(expected).replace(':', '')
        return digits in re.sub(r'\D', '', text)
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return re.search(r'(?<![\d.])' + re.escape(format(expected, 'g')) + r'(?![\d.])', text) is not None
    return str(expected).lower() in text
