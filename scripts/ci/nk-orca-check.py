#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""#835: real Orca speech baseline and discriminating provider fault controls.

Run only on a private test compositor/bus. SPEECH OUTPUT is the oracle; AT-SPI
queries and application logs do not stand in for the reader. Known baseline
failures stay failures, and a failed baseline blocks its corresponding control.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
from gi.repository import GLib

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('nk-real-common.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class TargetReached(Exception):
    pass


def main():
    broken = os.environ.get('NK_ORCA_FAULT')
    target = os.environ.get('NK_ORCA_TARGET')
    dynamic = os.environ.get('NK_ORCA_DYNAMIC') == '1'
    caught = False
    key_late = False
    p = native.Probe('orca-' + os.environ.get('NK_ORCA_CASE', broken or 'baseline'))
    app = None
    try:
        reader = native.start_reader(p)
        debug, orca, speechd = reader.debug, reader.orca, reader.speechd
        refused, key_events, caps = reader.refused, reader.key_events, reader.caps
        fault_file = p.log / 'fault'
        fault_file.write_text('')
        env = os.environ | ({'NK_ORCA_FAULT_FILE': str(fault_file)} if dynamic else {})
        app = p.start([native.BIN, '--a11y', 'atspi', *([f'--control-a11y={broken}'] if broken and not dynamic else [])], p.log / 'client.log', env)
        native.wait(lambda: any(w['pid'] == app.pid for w in p.msg('windows')['windows']), 'mapped form')
        time.sleep(2)

        def speech_step(label, action, predicates):
            before = debug.stat().st_size
            if dynamic and label == target:
                fault_file.write_text(broken)
                native.wait(lambda: 'A11Y_FAULT ' + broken in (p.log / 'client.log').read_text(), 'fault applied')
                if broken == 'text-extents':
                    native.wait(lambda: 'A11Y_FAULT_APPLIED text-extents' in (p.log / 'client.log').read_text(),
                                'wrong extents published to provider')
            action()
            # Await the actual speech, rather than clipping a correct utterance
            # while software-GL CI is still generating it. Send the action once:
            # a missing utterance still fails the identical predicate at the deadline.
            # Keep the full settling interval for absence (password privacy).
            started = time.monotonic()
            end = started + 8
            while time.monotonic() < end:
                while GLib.MainContext.default().pending():
                    GLib.MainContext.default().iteration(False)
                with debug.open('rb') as stream:
                    stream.seek(before)
                    current = stream.read().decode(errors='replace')
                spoken = ' '.join(re.findall(r"SPEECH OUTPUT: '(.*?)'(?=\{)", current)).lower()
                if time.monotonic() >= started + 1 and all(test(spoken) for test in predicates):
                    break
                time.sleep(.01)
            with debug.open('rb') as stream:
                stream.seek(before)
                delta = stream.read().decode(errors='replace')
            utterances = re.findall(r"SPEECH OUTPUT: '(.*?)'(?=\{)", delta)
            text = ' '.join(utterances).lower()
            assert app.poll() is None and orca.poll() is None and speechd.poll() is None, \
                'client, reader or speech server died during ' + label
            passed = all(test(text) for test in predicates)
            # Keep Orca's attribution next to the speech result: a caret event
            # overtaking KeyboardMonitor's key can be mistaken for prior typing.
            # Diagnostics never replace the fresh SPEECH OUTPUT predicate.
            causes = [line for line in delta.splitlines()
                      if 'Reason for object:text-caret-moved' in line]
            # Orca names a caret move's cause after the last key IT has seen. The key reaches it
            # from Hyalo over the session bus, the move from the app over the accessibility bus,
            # and nothing orders the two: Hyalo writes the key first (a11y.rs), yet on the
            # nightly of 2026-10-24 Left reached Orca 24 ms after the move, which it took for the
            # 'd' typed before and kept silent. When Orca's own log shows a move it put down to
            # TYPING before this step's key reached it, the step proves nothing either way: KEY
            # LATE, neither a pass nor a failure, and never repeated. Only that cause: a move the
            # previous step left behind (the dialog reopened, its entry refilled) is UNKNOWN to
            # Orca and stays a failure. Only a step that failed: speech that came anyway passed.
            key = delta.find('KEYBOARD_EVENT:')
            typed = re.search(r'Reason for object:text-caret-moved .*: TextEventReason\.TYPING$', delta, re.M)
            late = not passed and key >= 0 and typed is not None and typed.start() < key
            p.row(label, passed, repr(utterances), status='KEY LATE' if late else None,
                  speech=utterances, caret_causes=causes)
            (p.log / (label.replace(' ', '-') + '.log')).write_text(delta)
            p.msg('screenshot', p.log / (label.replace(' ', '-') + '.png'))
            if label == target:
                nonlocal caught
                client_log = (p.log / 'client.log').read_text()
                applied = (not dynamic or 'A11Y_FAULT ' + broken in client_log)
                if broken in ('ignore-edit', 'ignore-paste', 'text-extents'):
                    applied = applied and 'A11Y_FAULT_APPLIED ' + broken in client_log
                if broken == 'text-extents':
                    # Orca's own diagnostic proves that its real query consumed
                    # the wrong response; the speech predicate above stays the oracle.
                    responses = [line for line in delta.splitlines() if re.search(
                        r"AXText: Range .*?Name.*?has rect \(x:-10000, y:-10000, width:0, height:0\)", line)]
                    applied = applied and bool(responses)
                    p.rows[-1].update(fault=broken, applied=applied, geometry_response=responses)
                caught = not passed and applied and not late
                if late:
                    nonlocal key_late
                    key_late = True
                raise TargetReached()
            if target and not passed and not late:
                raise AssertionError('control setup failed before ' + target + ': ' + label)

        # Include translated role synonyms, but require each distinct fact.
        for name, role, state in [
            ('Password', ('password text', 'protected entry') if broken != 'password' or dynamic else ('entry',), ()),
            ('Language', ('combo',), ('japanese',)),
            ('Remember me', ('check',), ('not checked',)),
            ('Review', ('button',), ()),
            ('Name', ('entry', 'text'), ())]:
            speech_step('Tab ' + name, lambda: p.key(15),
                        [lambda t, name=name: name.lower() in t,
                         lambda t, role=role: any(r in t for r in role),
                         *[lambda t, s=s: s in t for s in state]])
        clip = p.start(['wl-copy', '--foreground', '--type', 'text/plain;charset=utf-8'],
                       p.log / 'clipboard.log', stdin=subprocess.PIPE)
        clip.stdin.write('日本🙂 word'.encode())
        clip.stdin.close()
        time.sleep(.2)
        speech_step('Paste acknowledgement', lambda: p.chord([29], 47),
                    [lambda t: 'pasted contents from clipboard' in t])
        speech_step('Unicode line', lambda: (p.key(15), p.chord([42], 15)),
                    [lambda t: 'name entry 日本🙂 word' in t])
        # Real desktop-layout Orca command: KP_Up reads the current flat-review
        # line. The speech slice starts after the preceding focus announcement.
        speech_step('Flat review Unicode line', lambda: p.key(72),
                    [lambda t: '日本🙂 word' in t])
        p.key(74)  # KP_Subtract leaves flat review before the editing walk.
        speech_step('Delete d', lambda: p.key(14), [lambda t: bool(re.search(r'\bd\b', t))])
        speech_step('Insert d', lambda: p.key(32), [lambda t: bool(re.search(r'\bd\b', t))])
        speech_step('Caret left', lambda: p.key(105), [lambda t: bool(re.search(r'\bd\b', t))])
        speech_step('Caret right', lambda: p.key(106), [lambda t: 'blank' in t])
        speech_step('Select word', lambda: p.chord([29, 42], 105),
                    [lambda t: 'word' in t, lambda t: 'selected' in t])
        speech_step('Password focus', lambda: p.key(15), [lambda t: 'password entry' in t if broken == 'password' and not dynamic else ('password password text' in t or 'password protected entry' in t)])
        def type_text(text):
            codes = dict(zip('qwertyuiopasdfghjklzxcvbnm',
                             [16,17,18,19,20,21,22,23,24,25,30,31,32,33,34,35,36,37,38,44,45,46,47,48,49,50]))
            for letter in text:
                p.key(codes[letter])
        speech_step('Password silence', lambda: type_text('secret'), [lambda t: not t])
        speech_step('Dropdown focus', lambda: p.key(15), [lambda t: 'language' in t, lambda t: 'combo' in t, lambda t: 'japanese' in t])
        if not target or dynamic or broken in ('expanded', 'dropdown', 'collapse'):
            speech_step('Dropdown expanded', lambda: p.key(57), [lambda t: 'japanese' in t])
            speech_step('Dropdown chosen', lambda: p.key(108), [lambda t: 'chinese' in t])
            speech_step('Dropdown closed', lambda: p.key(28), [lambda t: 'chinese' in t])
        p.key(15)
        speech_step('Checkbox checked', lambda: p.key(57), [lambda t: 'checked' in t and 'not checked' not in t])
        p.key(15)
        speech_step('Dialog opened', lambda: p.key(28),
                    [lambda t: 'correct error' in t, lambda t: 'dialog' in t,
                     lambda t: 'confirmation' in t, lambda t: 'invalid' in t,
                     lambda t: 'enter correct' in t])
        p.key(15)
        speech_step('Invalid save', lambda: (p.key(28), p.chord([42], 15)),
                    [lambda t: 'confirmation' in t, lambda t: 'wrong' in t, lambda t: 'invalid' in t])
        speech_step('Error corrected', lambda: (p.chord([29], 30), type_text('correct')),
                    [lambda t: re.findall(r'\b[a-z]\b', t) == list('correct') or 'correct' in t,
                     lambda t: 'entry valid' in t])
        p.key(15)
        speech_step('Dialog saved and restored', lambda: p.key(28),
                    [lambda t: 'review' in t, lambda t: 'button' in t])
        reopened = debug.stat().st_size
        p.key(28)
        native.wait(lambda: 'correct error dialog' in ' '.join(re.findall(
            r"SPEECH OUTPUT: '(.*?)'(?=\{)",
            debug.read_bytes()[reopened:].decode(errors='replace'))).lower(),
            'Orca announced reopened dialog before Escape')
        speech_step('Dialog escaped and restored', lambda: p.key(1),
                    [lambda t: 'review' in t, lambda t: 'button' in t])
        tab_echo = any('tab' in r.get('speech', []) for r in p.rows if r['step'].startswith('Tab '))
        delete_echo = any('backspace' in r.get('speech', []) for r in p.rows if r['step'] == 'Delete d')
        p.row('Wayland keyboard monitor refusal', refused and not key_events and tab_echo and delete_echo,
              f'libatspi capabilities={int(caps)}, but observed key events={len(key_events)}; capabilities alone may describe a legacy fallback',
              key_events=key_events)
        p.msg('screenshot', p.log / 'form.png')
        # These diagnostics explain failure; they are NOT the speech oracle.
        full = debug.read_text()
        p.environment['orca'] = next((line for line in full.splitlines() if 'Orca version ' in line), 'version not reported')
        diagnostics = [line for line in full.splitlines() if any(message in line for message in
            ('lacks active state', 'Not speaking inserted string due to lack of cause',
             'TextEventReason.UNKNOWN', 'Ignoring event because reason for change is unknown'))]
        (p.log / 'diagnostics.log').write_text('\n'.join(diagnostics) + '\n')
    except TargetReached:
        pass
    except Exception as e:
        p.row('infrastructure', False, repr(e))
    finally:
        p.save([])
        p.close()
    if target:
        # 2: the target's key reached Orca after its effect — this control is undecided tonight.
        if key_late:
            return 2
        return 0 if caught and all(r['status'] != 'FAIL' for r in p.rows[:-1]) else 1
    return 1 if any(row['status'] == 'FAIL' for row in p.rows) else 0


def matrix():
    status = subprocess.run(['python3', __file__], env=os.environ | {'NK_ORCA_CHILD': '1'}).returncode
    log = Path(os.environ['NK_PHASE0_LOG'])
    baseline = json.loads((log / 'orca-baseline/report.json').read_text())
    controls = []
    cases = [('name', 'Tab Name', False), ('role', 'Tab Remember me', False),
             ('password', 'Password silence', False), ('expanded', 'Dropdown expanded', False),
             ('dropdown', 'Dropdown chosen', False), ('collapse', 'Dropdown closed', False),
             ('state', 'Checkbox checked', False), ('dialog', 'Dialog opened', False),
             ('error', 'Dialog opened', False), ('restore', 'Dialog saved and restored', False)]
    cases += [('role-password','Tab Password',False), ('role-language','Tab Language',False), ('role-review','Tab Review',False)]
    cases += [('ignore-paste', 'Paste acknowledgement', True), ('text','Unicode line',True)]
    cases += [('ignore-edit', step, True) for step in ('Delete d','Insert d','Caret left','Caret right','Select word','Error corrected')]
    cases += [('accept-invalid', 'Invalid save',True), ('restore','Dialog escaped and restored',True)]
    cases += [('text-extents', 'Flat review Unicode line', True)]
    # NK_REAL_CONTROLS=0: the baseline alone. The controls prove the assertions can fail; they
    # change only with these checks (or the faults they inject), so a PR that touches neither
    # leaves them to the nightly run (scripts/ci/ci-scope.sh, `full`).
    run_controls = os.environ.get('NK_REAL_CONTROLS', '1') != '0'
    for index, (fault, target, dynamic) in enumerate(cases):
        if not run_controls:
            break
        if os.environ.get('NK_ORCA_CONTROLS') and str(index) not in os.environ['NK_ORCA_CONTROLS'].split():
            continue
        row = next((r for r in baseline['rows'] if r['step'] == target), None)
        if not row or row['status'] == 'FAIL':
            controls.append(dict(fault=fault, assertion=target, status='BLOCKED', reason='baseline did not pass'))
            status = 1
            continue
        result = subprocess.run(['python3', __file__], env=os.environ | {
            'NK_ORCA_CHILD': '1', 'NK_ORCA_FAULT': fault, 'NK_ORCA_TARGET': target,
            'NK_ORCA_DYNAMIC': '1' if dynamic else '0', 'NK_ORCA_CASE': str(index)})
        if result.returncode == 2:
            controls.append(dict(fault=fault, assertion=target, status='KEY LATE'))
            continue
        controls.append(dict(fault=fault, assertion=target, status='CAUGHT' if result.returncode == 0 else 'FAIL'))
        status = status or result.returncode
    pending = []
    # Repeated focus preconditions use the same role/name oracle as their Tab row.
    coverage = {row['step']: [c['fault'] for c in controls if c['assertion'] == row['step']] for row in baseline['rows']}
    coverage['Password focus'] = coverage['Tab Password']
    coverage['Dropdown focus'] = coverage['Tab Language']
    coverage['Wayland keyboard monitor refusal'] = ['ordinary Atspi.Device + explicit AccessDenied; positive Orca key echo']
    assert not run_controls or all(coverage.values()), 'a baseline assertion lacks its control'
    report = dict(baseline=baseline, controls=controls, coverage=coverage, pending=pending, complete_matrix=status == 0 and len(controls) == len(cases) and all(c['status'] == 'CAUGHT' for c in controls))
    (log / 'orca-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    lines = ['| Orca assertion | Baseline |', '| --- | --- |']
    lines += [f"| {r['step']} | {r['status']} |" for r in baseline['rows']]
    lines += ['', '| Fault | Assertion | Result |', '| --- | --- | --- |']
    lines += [f"| {r['fault']} | {r['assertion']} | {r['status']} |" for r in controls]
    lines += ['', 'Pending: ' + '; '.join(pending), '']
    (log / 'orca-summary.md').write_text('\n'.join(lines) + '\n')
    for step in pending:
        print('PENDING: ' + step, flush=True)
    return 1 if pending else status


if __name__ == '__main__':
    raise SystemExit(main() if os.environ.get('NK_ORCA_CHILD') else matrix())
