#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Real engines on production Settings SearchInput/FontChooser View; nightly/manual only.

Uses the phase-0 profile, wire barriers and classicui pixel oracle. Every assertion
has its own applied fault; an infrastructure exception is never a caught control.
"""
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
os.environ['NK_PHASE0_BIN'] = os.environ.get('NK_SETTINGS_IME_BIN', str(ROOT / 'toolkit/target/release/nk-settings-ime'))
spec = importlib.util.spec_from_file_location('ime', Path(__file__).with_name('nk-fcitx5-check.py'))
ime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ime)
native = ime.native
STEPS = ('preedit', 'candidates', 'commit', 'cancel')


class Caught(Exception):
    pass


def run(p, field, engine, scale, target=None):
    label = f'{field}-{engine}-{scale:g}' + (f'-control-{target}' if target else '')
    directory = p.log / label
    directory.mkdir(exist_ok=True)
    fault = directory / 'fault'
    barrier = directory / 'barrier'
    fault.write_text('')
    barrier.write_text('0')
    (directory / 'state.jsonl').write_text('')
    env = os.environ | {'WAYLAND_DEBUG': '1', 'NK_IME_STATE_LOG': str(directory / 'state.jsonl'),
                        'NK_IME_FAULT_FILE': str(fault), 'NK_IME_BARRIER_FILE': str(barrier)}
    engine_log = directory / 'fcitx.log'
    client_log = directory / 'client.log'
    app = fcitx = None
    nonce = 0
    try:
        fcitx = native.start_ime(p, engine, label, engine_log, env)
        app = p.start([native.BIN, field], client_log, env)
        win = native.wait(lambda: next((w for w in p.msg('windows')['windows'] if w['pid'] == app.pid), None), 'mapped Settings field')
        native.wait(lambda: (directory / 'state.jsonl').stat().st_size and ime.state(directory)['catalogue_ready'], 'real field/catalogue ready')
        native.wait(lambda: 'Loaded addon ' + engine in engine_log.read_text(), 'engine loaded', 20)

        def drain():
            nonlocal nonce
            def processed():
                assert app.poll() is None and fcitx.poll() is None, 'client or engine exited'
                received = len(re.findall(r'<- zwp_text_input_v3@\d+\.(?:done|leave),', client_log.read_text()))
                return ime.state(directory)['ime_count'] >= received
            native.wait(processed, 'real IME batches dispatched')
            nonce += 1
            barrier.write_text(str(nonce))
            native.wait(lambda: ime.state(directory)['barrier'] == str(nonce), 'fresh post-dispatch snapshot')

        def key(code):
            start = len(client_log.read_text())
            p.key(code)
            native.wait(lambda: re.search(rf'<- wl_keyboard@\d+\.key, \(\d+, \d+, {code}, 0\)',
                                         client_log.read_text()[start:]), 'key release delivered')
            drain()

        def chord(modifiers, code):
            start = len(client_log.read_text())
            p.chord(modifiers, code)
            native.wait(lambda: all(re.search(
                rf'<- wl_keyboard@\d+\.key, \(\d+, \d+, {released}, 0\)', client_log.read_text()[start:])
                for released in [code, *modifiers]), 'chord and modifier releases delivered')
            drain()

        def active(on=True):
            subprocess.run(['fcitx5-remote', '-s', engine], check=True, timeout=5)
            subprocess.run(['fcitx5-remote', '-o' if on else '-c'], check=True, timeout=5)
            time.sleep(.2)
            drain()

        def arm(step):
            fault.write_text(('cursor' if step == 'candidates' else step) if target == step else '')

        def check(step, predicate, details):
            assert app.poll() is None and fcitx.poll() is None, 'process exited before assertion'
            if step == target:
                applied = ('cursor' if step == 'candidates' else step) in ime.state(directory)['faults']
                p.row(label + '/' + step, not predicate and applied, details, observed=bool(predicate), applied=applied)
                assert not predicate and applied, 'own fault did not fail target assertion'
                raise Caught()
            p.row(label + '/' + step, bool(predicate), details)
            assert predicate, 'baseline assertion failed: ' + step

        active()
        sequence, expected, finish = ime.ENGINES[engine]
        arm('preedit')
        key(ime.CODES[sequence[0]])
        first = ime.state(directory)
        for letter in sequence[1:]:
            key(ime.CODES[letter])
        composing = ime.state(directory)
        wire = client_log.read_text()
        check('preedit', first['preedit'] and composing['preedit'] and
              first['preedit'] != composing['preedit'] and composing['display'] != composing['text'] and
              bool(re.search(r'<- zwp_text_input_v3@\d+\.preedit_string, \(Some\("[^"\n]+"', wire)),
              json.dumps(composing, ensure_ascii=False))
        arm('candidates')
        if engine == 'mozc':
            key(57)
            key(57)
            finish = [103, 28]
        elif engine == 'hangul':
            key(67)  # fcitx5-hangul's real F9 Hanja candidate list
        drain()
        time.sleep(.3)
        win = next(w for w in p.msg('windows')['windows'] if w['pid'] == app.pid)
        p.msg('screenshot', directory / 'candidates.ppm')
        composing = ime.state(directory)
        rect = list(map(int, re.findall(r'set_cursor_rectangle\((-?\d+), (-?\d+), (\d+), (\d+)\)', client_log.read_text())[-1]))
        x, y, w, h = composing['rect']
        caret = [(win['x'] + x)*scale, (win['y'] + y)*scale,
                 (win['x'] + x+w)*scale, (win['y'] + y+h)*scale]
        # A missing candidate pane is infrastructure/setup failure even in a control.
        box = ime.candidate_box(directory / 'candidates.ppm', win, scale, caret)
        placed = rect == composing['rect'] and abs(box[0]-caret[0]) <= 6*scale and (
            abs(box[1]-caret[3]) <= 2*scale or abs(box[3]-caret[1]) <= 2*scale)
        check('candidates', placed, f'wire={rect}; model={composing["rect"]}; pixels={box}; caret={caret}')
        arm('commit')
        if engine == 'hangul':
            key(1)  # dismiss Hanja; Hangul confirms its preedit before forwarding Escape
        for code in finish:
            if code == -1:
                active(False)
            else:
                key(code)
        committed = ime.state(directory)
        check('commit', committed['text'] == expected and not committed['preedit'], json.dumps(committed, ensure_ascii=False))
        # Seed through the real clipboard, waiting for its fresh offer before Ctrl+V.
        active(False)
        chord([29], 30)
        start = len(client_log.read_text())
        clip = p.start(['wl-copy', '--foreground', '--type', 'text/plain;charset=utf-8'],
                       directory / 'clipboard.log', stdin=subprocess.PIPE)
        clip.stdin.write(b'base')
        clip.stdin.close()
        def ready():
            assert clip.poll() is None, 'seed clipboard exited'
            if not re.search(r'<- wl_data_device@\d+\.selection, \(wl_data_offer@', client_log.read_text()[start:]):
                return False
            value = subprocess.run(['wl-paste', '-n'], capture_output=True, timeout=3)
            return value.returncode == 0 and value.stdout == b'base'
        native.wait(ready, 'new exact clipboard seed')
        chord([29], 47)
        native.wait(lambda: ime.state(directory)['text'] == 'base', 'seed paste dispatched')
        active()
        for letter in sequence[:2]:
            key(ime.CODES[letter])
        before = ime.state(directory)
        assert before['preedit'], 'cancel setup did not compose'
        arm('cancel')
        key(1)
        cancelled = ime.state(directory)
        check('cancel', not cancelled['preedit'] and cancelled['text'] == ('base하' if engine == 'hangul' else 'base'),
              json.dumps(cancelled, ensure_ascii=False))
    except Caught:
        pass
    finally:
        p.stop(app)
        p.stop(fcitx)
        # Wait for this engine's bus name to disappear before starting the next profile.
        native.wait(lambda: b'false' in subprocess.check_output(
            ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
             '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5'], timeout=2), 'engine stopped')


def main():
    p = native.Probe('settings-ime')
    output = p.msg('outputs')['outputs'][0]
    original = output['scale']
    fields = os.environ.get('NK_SETTINGS_IME_FIELDS', 'search fonts').split()
    engines = os.environ.get('NK_FCITX5_ENGINES', 'mozc pinyin hangul').split()
    scales = [float(s) for s in os.environ.get('NK_FCITX5_SCALES', '1 1.25').split()]
    controls = os.environ.get('NK_REAL_CONTROLS', '1') != '0'
    p.environment.update(fields=fields, engines=engines, scales=scales, controls=controls)
    try:
        for scale in scales:
            p.msg('settings', json.dumps({'outputs': {output['name']: {'scale': scale}}}))
            for field in fields:
                for engine in engines:
                    for target in [None, *(STEPS if controls else ())]:
                        try:
                            run(p, field, engine, scale, target)
                        except Exception as error:
                            p.row(f'{field}-{engine}-{scale:g}-{target}/infrastructure-or-setup', False, repr(error))
    finally:
        p.msg('settings', json.dumps({'outputs': {output['name']: {'scale': original}}}))
        expected = {f'{field}-{engine}-{scale:g}/{step}'
                    for field in fields for engine in engines for scale in scales for step in STEPS}
        if controls:
            expected |= {f'{field}-{engine}-{scale:g}-control-{step}/{step}'
                         for field in fields for engine in engines for scale in scales for step in STEPS}
        passed = {r['step'] for r in p.rows if r['status'] == 'PASS'}
        pending = sorted(expected - passed)
        p.save(pending, complete=not pending and not any(r['status'] == 'FAIL' for r in p.rows) and
               set(fields) == {'search', 'fonts'} and set(engines) == set(ime.ENGINES) and
               set(scales) == {1., 1.25} and controls)
        p.close()
    return int(any(r['status'] == 'FAIL' for r in p.rows))


if __name__ == '__main__':
    raise SystemExit(main())
