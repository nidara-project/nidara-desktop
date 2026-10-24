#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""#882: real Orca on Claude's controls — the segmented choice, the slider, the time fields — in
nk-widgets-demo --choices, on the same private compositor and speech server as nk-orca-check.py.

SPEECH OUTPUT is the oracle. Each step's position comes from AT-SPI focus (grab_focus, as a
reader's own navigation would), its key through the real seat; what Orca then says is what is
asserted. One Orca for the whole run; the demo restarts per case: the baseline, then one case per
step with its fault (the demo logs CONTROL_APPLIED), which must fail THAT step. A fault that
never applied is not a caught control.

CI: NK_PHASE0_TEST=vkms NK_PHASE0_LOG=<short path> (scripts/ci/hyalo-smoke.sh). NK_REAL_CONTROLS=0
runs the baseline alone, as the other real gates do (ci-scope `full`).
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import time

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('nk-real-common.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
from gi.repository import Atspi, GLib  # noqa: E402 (versions required by nk-real-common)

BIN = os.environ.get('NK_WIDGETS_BIN', str(native.ROOT / 'toolkit/target/release/nk-widgets-demo'))
KEY_RIGHT, KEY_UP = 106, 103
# Each step and the demo fault that must fail it (toolkit/widgets-demo/src/choices.rs, main.rs).
CONTROLS = {'Segmented focus': 'segment-role', 'Segmented arrow': 'arrows',
            'Slider focus': 'slider-value', 'Slider arrow': 'value-stale',
            'Hour focus': 'spin-name', 'Hour arrow': 'spin-stale'}


def children(node):
    node.clear_cache()
    return [c for c in (node.get_child_at_index(i) for i in range(node.get_child_count())) if c]


def walk(node):
    return [node, *(n for c in children(node) for n in walk(c))]


def frame():
    for app in children(Atspi.get_desktop(0)):
        try:
            app.set_cache_mask(Atspi.Cache.NONE)
            found = next((n for n in children(app) if n.get_name() == 'Nidara widgets demo'), None)
        except GLib.Error:
            continue
        if found:
            return found
    return None


def spoken_since(debug, before):
    with debug.open('rb') as stream:
        stream.seek(before)
        return re.findall(r"SPEECH OUTPUT: '(.*?)'(?=\{)", stream.read().decode(errors='replace'))


def run_case(p, reader, fault, target):
    """The walk on one demo process. True when the case did what it must: the baseline passed
    every step, a control failed its target after applying (and passed every step before it)."""
    name = fault or 'baseline'
    log = p.log / name
    log.mkdir(exist_ok=True)
    client = log / 'client.log'
    app = p.start([BIN, '--choices', *([f'--fault={fault}'] if fault else [])], client)
    text = lambda: client.read_text()
    try:
        native.wait(lambda: app.poll() is not None or ('CONTENT_READY' in text() and 'A11Y_READY' in text()),
                    'demo readiness', 15)
        assert app.poll() is None, f'demo exited {app.returncode}'
        native.wait(lambda: any(w['pid'] == app.pid for w in p.msg('windows')['windows']), 'mapped demo')
        root = native.wait(frame, 'AT-SPI frame')
        nodes = walk(root)
        segments = next(children(n) for n in nodes if n.get_name() == 'Window controls'
                        and n.get_role() == Atspi.Role.PANEL and len(children(n)) == 3)
        slider = next(n for n in nodes if n.get_name() == 'Temperature' and n.get_role() == Atspi.Role.SLIDER)
        hour = next(n for n in nodes if n.get_role() == Atspi.Role.SPIN_BUTTON)
        # Let Orca finish the window's own announcement before the first slice starts.
        time.sleep(2)

        def focus(node):
            return lambda: node.get_component_iface().grab_focus()

        steps = [
            ('Segmented focus', focus(segments[1]), [lambda t: 'right' in t, lambda t: 'radio' in t]),
            ('Segmented arrow', lambda: p.key(KEY_RIGHT), [lambda t: 'hidden' in t]),
            ('Slider focus', focus(slider), [lambda t: 'temperature' in t, lambda t: 'slider' in t,
                                             lambda t: '4500 k' in t]),
            ('Slider arrow', lambda: p.key(KEY_RIGHT), [lambda t: '4600 k' in t]),
            ('Hour focus', focus(hour), [lambda t: 'from hour' in t, lambda t: 'spin' in t,
                                         lambda t: '22' in t]),
            ('Hour arrow', lambda: p.key(KEY_UP), [lambda t: '23' in t]),
        ]
        for label, action, predicates in steps:
            before = reader.debug.stat().st_size
            action()
            # Await the speech rather than clip it on software GL; the action is sent once, and a
            # missing utterance fails the same predicates at the deadline.
            started = time.monotonic()
            while time.monotonic() < started + 8:
                while GLib.MainContext.default().pending():
                    GLib.MainContext.default().iteration(False)
                said = ' '.join(spoken_since(reader.debug, before)).lower()
                if time.monotonic() >= started + 1 and all(test(said) for test in predicates):
                    break
                time.sleep(.01)
            utterances = spoken_since(reader.debug, before)
            said = ' '.join(utterances).lower()
            assert app.poll() is None and reader.orca.poll() is None and reader.speechd.poll() is None, \
                'demo, reader or speech server died during ' + label
            passed = all(test(said) for test in predicates)
            if label == target:
                applied = f'CONTROL_APPLIED {fault}' in text()
                caught = not passed and applied
                p.row(f'{label} ({fault})', caught,
                      ('CAUGHT ' if caught else 'NOT CAUGHT ' if applied else 'UNAPPLIED ') + repr(utterances),
                      status='CAUGHT' if caught else None, speech=utterances, fault=fault, applied=applied)
                return caught
            if fault:
                if not passed:
                    p.row(f'{label} (before {fault})', False, repr(utterances), speech=utterances)
                    return False
                continue
            p.row(label, passed, repr(utterances), speech=utterances)
            p.msg('screenshot', log / (label.replace(' ', '-') + '.png'))
        return not fault and all(r['status'] == 'PASS' for r in p.rows)
    finally:
        p.stop(app)
        time.sleep(.5)


def main():
    p = native.Probe('choices-orca')
    p.environment['client_sha256'] = hashlib.sha256(Path(BIN).read_bytes()).hexdigest()
    ok = False
    try:
        reader = native.start_reader(p)
        ok = run_case(p, reader, None, None)
        if not ok:
            p.row('controls', False, 'BLOCKED: the baseline did not pass')
        elif os.environ.get('NK_REAL_CONTROLS', '1') != '0':
            for target, fault in CONTROLS.items():
                ok = run_case(p, reader, fault, target) and ok
    except Exception as error:
        p.row('infrastructure', False, repr(error))
        ok = False
    finally:
        p.save([], complete=ok)
        p.close()
    (p.log / 'controls.json').write_text(json.dumps(CONTROLS, indent=2) + '\n')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
