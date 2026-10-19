#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""#832: real fcitx5 matrix baseline. Gate incomplete until its controls pass.

Run through toolkit/phase0/check-prerequisites.sh ime, or the vkms smoke.
Requires fcitx5, mozc, chinese-addons, hangul and wl-clipboard. Every run uses a
fresh profile and the real input-method-v2 client. The placement oracle measures
a diagnostic classicui candidate pane in screenshot pixels against the client's
actual text-input-v3 rectangle. No compositor/client fixes belong in this probe.
"""
from collections import deque
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import statistics
import time

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('nk-real-common.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

ENGINES = {'mozc': ('nihongo', '日本語', [57, 28]),
           'pinyin': ('zhongwen', '中文', [57]),
           'hangul': ('gksrmf', '한글', [-1])}
CODES = dict(zip('qwertyuiopasdfghjklzxcvbnm',
                 [16,17,18,19,20,21,22,23,24,25,30,31,32,33,34,35,36,37,38,44,45,46,47,48,49,50]))
CONTROLS = {
    'commit': ('initial','drop-commit'),
    'composition-backspace': ('edit','preedit-update'),
    'preedit-replacement': ('edit','preedit-update'),
    'escape': ('edit','cancel'), 'cancelled-undo': ('edit','undo'),
    'surrounding-utf8': ('context','surrounding'),
    'interior-insertion': ('context','append-commit'),
    'selection-replacement': ('selection','keep-selection'),
    'focus-loss': ('focus','focus-loss'), 'focus-return': ('focus','focus-return'),
    'restart': ('restart','drop-commit'),
    'compose': ('native_keys','compose'), 'dead-acute': ('native_keys','compose'),
    'repeat-delay': ('native_keys','repeat-delay'), 'repeat-rate': ('native_keys','repeat-rate'),
    'repeat-release': ('native_keys','repeat-release'),
    'repeat-backspace': ('native_keys','backspace-repeat'),
    'repeat-focus-loss': ('native_keys','repeat-focus-loss'),
    'scrolled-candidates': ('scroll','field-cursor'),
    'document-scrolled-candidates': ('scroll','document-cursor'),
}
GROUP = {step: group for step,(group,_) in CONTROLS.items()}



def candidate_box(path, win, scale, caret):
    data = path.read_bytes()
    magic, dims, depth, pixels = data.split(b'\n', 3)
    assert magic == b'P6' and depth == b'255', 'expected Hyalo PPM'
    width, height = map(int, dims.split())
    points = []
    # Deterministic private classicui theme; this private compositor has no shell.
    # The upper form area excludes the corpus's coloured emoji further below.
    for y in range(max(0, int(win['y'] * scale)), min(height, int((win['y'] + win['height']) * scale))):
        for x in range(max(0, int(win['x'] * scale)), min(width, int((win['x'] + win['width']) * scale))):
            r, g, b = pixels[(y * width + x) * 3: (y * width + x) * 3 + 3]
            if r < 70 and 70 < g < 210 and b > 220:
                points.append((x, y))
    assert len(points) > 100 * scale, 'no classicui candidate selection found'
    # Flood the diagnostic selection AND its contiguous white background. The
    # selected row alone is insufficient: a later Mozc candidate can be below
    # the caret even when the top of its popup still covers the preedit.
    todo = deque([points[0]])
    visited = set()
    while todo:
        x, y = todo.popleft()
        if (x, y) in visited or not (0 <= x < width and 0 <= y < height):
            continue
        if caret[0] - 1 <= x < caret[2] + 1 and caret[1] - 1 <= y < caret[3]:
            continue
        r, g, b = pixels[(y * width + x) * 3: (y * width + x) * 3 + 3]
        if not (min(r, g, b) > 235 or (r < 70 and 70 < g < 210 and b > 220)):
            continue
        visited.add((x, y))
        todo.extend([(x-1,y), (x+1,y), (x,y-1), (x,y+1)])
    return [min(x for x,y in visited), min(y for x,y in visited),
            max(x for x,y in visited) + 1, max(y for x,y in visited) + 1]


def state(directory):
    rows = re.findall(r'^IME_STATE (.*)\n', (directory / 'state.jsonl').read_text() if (directory / 'state.jsonl').exists() else '', re.M)
    assert rows, 'no Editor evidence; rebuild nk-phase0'
    return json.loads(rows[-1])


class TargetReached(Exception):
    pass


def run(p, engine, scale, fault=None, target=None, mutation=None):
    label = f'{engine}-{scale:g}' + ('-' + (target or fault) if target or fault else '')
    directory = p.log / label
    directory.mkdir(exist_ok=True)
    config = p.log / 'config' / label / 'fcitx5'
    config.mkdir(parents=True, exist_ok=True)
    (config / 'profile').write_text(
        '[Groups/0]\nName=Default\nDefault Layout=us\nDefaultIM=' + engine +
        '\n\n[Groups/0/Items/0]\nName=keyboard-us\nLayout=\n\n[Groups/0/Items/1]\nName=' + engine +
        '\nLayout=\n\n[GroupOrder]\n0=Default\n')
    (config / 'config').write_text('[Behavior]\nActiveByDefault=True\n')
    conf = config / 'conf'
    conf.mkdir(exist_ok=True)
    (conf / 'classicui.conf').write_text('Theme=preflight\nUseDarkTheme=False\nUseAccentColor=False\n')
    theme = p.log / 'data/fcitx5/themes/preflight'
    theme.mkdir(parents=True, exist_ok=True)
    (theme / 'theme.conf').write_text(
        '[Metadata]\nName=Preflight diagnostic\nVersion=1\n'
        '[InputPanel]\nNormalColor=#000000\nHighlightColor=#ffffff\n'
        '[InputPanel/TextMargin]\nLeft=5\nRight=5\nTop=5\nBottom=5\n'
        '[InputPanel/Background]\nColor=#ffffff\n'
        '[InputPanel/Highlight]\nColor=#0080ff\n')
    fault_file = directory / 'fault'
    fault_file.write_text('')
    barrier_file = directory / 'barrier'
    barrier_file.write_text('0')
    (directory / 'state.jsonl').write_text('')
    barrier_nonce = 0
    env = os.environ | {'XDG_CONFIG_HOME': str(config.parent), 'WAYLAND_DEBUG': '1',
                        'NK_IME_STATE_LOG': str(directory / 'state.jsonl'), 'NK_IME_FAULT_FILE': str(fault_file),
                        'NK_IME_BARRIER_FILE': str(barrier_file)}
    app = ime = None
    ime_log = directory / 'fcitx.log'
    try:
        ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin',
                       '--verbose=key_trace=5'], ime_log, env)
        native.wait(lambda: b'true' in subprocess.check_output(
            ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus',
             '--object-path', '/org/freedesktop/DBus', '--method',
             'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5'], timeout=2), 'fcitx5 controller')
        app = p.start([native.BIN, '--ime-evidence', *([fault] if fault else [])], directory / 'client.log', env)
        win = native.wait(lambda: next((w for w in p.msg('windows')['windows'] if w['pid'] == app.pid), None), 'mapped native client')
        time.sleep(.8)
        win = next(w for w in p.msg('windows')['windows'] if w['pid'] == app.pid)
        native.wait(lambda: 'zwp_input_method_keyboard_grab_v2' in (directory / 'fcitx.log').read_text()
                    and 'Loaded addon ' + engine in (directory / 'fcitx.log').read_text(), 'engine activation', 20)
        subprocess.run(['fcitx5-remote', '-s', engine], check=True, timeout=5)
        subprocess.run(['fcitx5-remote', '-o'], check=True, timeout=5)
        time.sleep(.2)
        sequence, expected, finish = ENGINES[engine]
        def arm(step):
            fault_file.write_text(mutation if target == step else '')

        def check(step, predicate, why):
            assert app.poll() is None, 'client died during ' + step
            if GROUP.get(step) != 'native_keys':
                assert ime.poll() is None, 'fcitx5 died during ' + step
            if step == target:
                fired = mutation in state(directory)['faults']
                p.row(label + '/control-' + step, not predicate and fired, f'applied={fired}; {why}', observed=bool(predicate), applied=fired)
                if predicate or not fired:
                    raise AssertionError('fault did not fail its target: ' + step)
                raise TargetReached()
            p.row(label + '/' + step, predicate, why)
            p.msg('screenshot', directory / (step + '.png'))
            assert predicate, 'baseline/setup assertion failed: ' + step

        def activate():
            subprocess.run(['fcitx5-remote', '-s', engine], check=True, timeout=5)
            subprocess.run(['fcitx5-remote', '-o'], check=True, timeout=5)
            current = state(directory)
            context = (current['text'], current['cursor'], current['anchor'])
            native.wait(lambda: engine_ready(context=context), 'active context, current surrounding text and keyboard grab')

        def engine_ready(start=0, context=None):
            wire = ime_log.read_text()[start:]
            activations = list(re.finditer(r'zwp_input_method_v2#\d+\.activate\(\)', wire))
            deactivations = list(re.finditer(r'zwp_input_method_v2#\d+\.deactivate\(\)', wire))
            if not activations or (deactivations and deactivations[-1].start() > activations[-1].start()):
                return False
            active = wire[activations[-1].end():]
            # libwayland prints literal newlines inside C string arguments.
            surrounding = re.findall(r'zwp_input_method_v2#\d+\.surrounding_text\(("(?:[^"\\]|\\.)*"), (\d+), (\d+)\)', active)
            current = ((json.loads(surrounding[-1][0], strict=False), int(surrounding[-1][1]), int(surrounding[-1][2]))
                       if surrounding else None)
            matches_context = (context is None or (current is not None
                               and (current[0] == context if isinstance(context, str) else current == context)))
            return ('.grab_keyboard(' in active
                    and re.search(r'zwp_input_method_v2#\d+\.done\(\)', active)
                    and re.search(r'zwp_input_method_keyboard_grab_v2#\d+\.keymap\(', active)
                    and matches_context)

        def drain_ime():
            nonlocal barrier_nonce
            # Each done and leave queues exactly one Event::Ime in nk-wayland.
            # Wait for those events to reach Editor, regardless of their text or
            # whether a fault deliberately discards them. Never wait for the
            # desired predicate to become true before checking a control.
            def drained():
                wire = (directory / 'client.log').read_text()
                received = len(re.findall(r'<- zwp_text_input_v3@\d+\.(?:done|leave),', wire))
                return state(directory)['ime_count'] >= received
            native.wait(drained, 'received IME batches processed by Editor')
            # A raw key release is logged before Application receives its
            # queued native Key callback. Request a fresh evidence snapshot at
            # idle after dispatch too, without inserting any synthetic input.
            barrier_nonce += 1
            barrier_file.write_text(str(barrier_nonce))
            native.wait(lambda: state(directory)['barrier'] == str(barrier_nonce),
                        'post-dispatch evidence snapshot')

        def key(code):
            start = len((directory / 'client.log').read_text())
            p.key(code)
            native.wait(lambda: re.search(
                rf'<- wl_keyboard@\d+\.key, \(\d+, \d+, {code}, 0\)',
                (directory / 'client.log').read_text()[start:]), 'key release delivered')
            drain_ime()

        def chord(modifiers, code):
            start = len((directory / 'client.log').read_text())
            p.chord(modifiers, code)
            def released():
                wire = (directory / 'client.log').read_text()[start:]
                return all(re.search(
                    rf'<- wl_keyboard@\d+\.key, \(\d+, \d+, {released_code}, 0\)', wire)
                    for released_code in [code, *modifiers])
            # The IME forwards releases asynchronously. Killing it after only
            # V-up can discard the pending Ctrl-up, leaving native Compose
            # under Ctrl even though the harness already wrote both releases.
            native.wait(released, 'chord key and modifier releases delivered')
            drain_ime()

        def flush_hangul():
            start = len((directory / 'client.log').read_text())
            subprocess.run(['fcitx5-remote', '-c'], check=True, timeout=5)
            native.wait(lambda: re.search(r'commit_string,.*\n.*zwp_text_input_v3@\d+\.done,',
                (directory / 'client.log').read_text()[start:]), 'Hangul flush received')
            drain_ime()

        def seed(text):
            if ime.poll() is None:
                subprocess.run(['fcitx5-remote', '-c'], check=True, timeout=5)
                time.sleep(.2)
            chord([29], 30)
            wire_start = len((directory / 'client.log').read_text())
            clip = p.start(['wl-copy', '--foreground', '--type', 'text/plain;charset=utf-8'],
                           directory / 'clipboard.log', stdin=subprocess.PIPE)
            clip.stdin.write(text.encode())
            clip.stdin.close()
            # A fixed sleep can send Ctrl+V against the previous offer while
            # wl-copy is still replacing it. Require the client's new offer,
            # then independently read its bytes before the single real paste.
            def clipboard_ready():
                assert clip.poll() is None, 'clipboard source exited before seed'
                wire = (directory / 'client.log').read_text()[wire_start:]
                if not re.search(r'<- wl_data_device@\d+\.selection, \(wl_data_offer@', wire):
                    return False
                value = subprocess.run(['wl-paste', '--no-newline', '--type',
                                        'text/plain;charset=utf-8'],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                return value.returncode == 0 and value.stdout == text.encode()
            native.wait(clipboard_ready, 'new clipboard offer with exact seed bytes')
            pasted = state(directory)['paste_count']
            chord([29], 47)
            native.wait(lambda: state(directory)['paste_count'] > pasted and state(directory)['text'] == text,
                        'seed paste processed with exact text')

        def release(code):
            wire_start = len((directory / 'client.log').read_text())
            p.control(f'keyup {code}', 0)
            native.wait(lambda: re.search(
                rf'<- wl_keyboard@\d+\.key, \(\d+, \d+, {code}, 0\)',
                (directory / 'client.log').read_text()[wire_start:]), 'held key release delivered')
            drain_ime()
            return state(directory)

        def compose(text=sequence):
            activate()
            for char in text:
                key(CODES[char])

        def commit():
            if engine == 'mozc':
                key(57)
                key(28)
            elif engine == 'pinyin':
                key(57)
            else:
                flush_hangul()

        def initial():
            nonlocal ime, finish
            activate()
            key(CODES[sequence[0]])
            def first_preedit():
                value = state(directory)
                return value if value['preedit'] else None
            first_state = state(directory) if fault == '--control-no-preedit' else native.wait(first_preedit, 'first real preedit')
            for letter in sequence[1:]:
                key(CODES[letter])
            if engine == 'mozc':
                key(57)  # first Space converts; the second opens the candidate list
                key(57)
                finish = [103, 28]  # select the first candidate (日本語) before confirming
            time.sleep(.3)
            p.msg('screenshot', directory / 'candidates.ppm')
            p.msg('screenshot', directory / 'candidates.png')
            composing = state(directory)
            image = (directory / 'candidates.ppm').read_bytes().split(b'\n', 3)
            image_width, image_height = map(int, image[1].split())
            ink = 0
            for x,y,w,h in composing['underlines']:
                for py in range(round((win['y']+y)*scale), round((win['y']+y+h)*scale)):
                    for px in range(round((win['x']+x)*scale), round((win['x']+x+w)*scale)):
                        if 0 <= px < image_width and 0 <= py < image_height:
                            pixel = image[3][(py*image_width+px)*3:(py*image_width+px)*3+3]
                            ink += min(pixel) > 175
            underlined = bool(first_state['preedit']) and bool(composing['preedit']) and first_state['preedit'] != composing['preedit'] and ink > 10*scale
            assert app.poll() is None, 'client died before preedit assertion'
            if fault == '--control-no-preedit':
                p.row(label + '/control-underlined-preedit', not underlined and 'no-preedit' in composing['faults'], 'ignored preedit must fail the underline assertion')
                return
            if fault and not underlined:
                raise AssertionError('cursor-control setup: underline baseline failed')
            p.row(label + '/underlined-preedit', underlined,
                  f'first={first_state}; composing={composing}; underline ink={ink}')
            wire = (directory / 'client.log').read_text()
            preedits = re.findall(r'<- zwp_text_input_v3@\d+\.preedit_string, \((.*)\)', wire)
            assert any('Some("' in item and 'Some("")' not in item for item in preedits), 'missing real preedit wire evidence'
            if engine != 'hangul':
                rect = list(map(int, re.findall(r'set_cursor_rectangle\((-?\d+), (-?\d+), (\d+), (\d+)\)', wire)[-1]))
                model = composing['rect']
                expected_rect = [math.floor(model[0]), math.floor(model[1]), max(1, math.ceil(model[2])), math.ceil(model[3])]
                x, y, width, height = expected_rect
                caret = [(win['x'] + x) * scale, (win['y'] + y) * scale,
                         (win['x'] + x + width) * scale, (win['y'] + y + height) * scale]
                try:
                    box = candidate_box(directory / 'candidates.ppm', win, scale, caret)
                except AssertionError:
                    box = None
                # Candidates may sit above or below, but cannot cover the cursor's protected area.
                adjacent = box is not None and abs(box[0] - caret[0]) <= 6 * scale
                clear = box is not None and (abs(box[1] - caret[3]) <= 2*scale or abs(box[3] - caret[1]) <= 2*scale)
                placed = adjacent and clear and rect == expected_rect
                if fault == '--control-ime-cursor':
                    p.row(label + '/control-candidate-placement', box is not None and not placed and rect[0] == expected_rect[0] + 80, f'wire cursor={rect}; model={expected_rect}; panel={box}')
                    return
                p.row(label + '/candidate-placement', placed,
                      f'candidate pane={box}; protected caret={caret}; candidates must leave the caret visible',
                      candidate_pixels=box, caret_pixels=caret, cursor_rectangle=rect, window=win)
            arm('commit')
            for code in finish:
                if code == -1:
                    flush_hangul()
                else:
                    key(code)
            chord([29], 30)
            copy_start = len((directory / 'client.log').read_text())
            chord([29], 46)
            native.wait(lambda: re.search(r'<- wl_data_device@\d+\.selection, \(wl_data_offer@',
                (directory / 'client.log').read_text()[copy_start:]), 'new copied selection offered')
            actual = subprocess.check_output(['wl-paste', '-n'], text=True, timeout=5)
            (directory / 'committed.txt').write_text(actual)
            committed = state(directory)
            check('commit', actual == expected and committed['text'] == expected and committed['preedit'] is None,
                  f'expected {expected!r}; clipboard reads {actual!r}; Editor={committed}')
            p.msg('screenshot', directory / 'committed.png')
        def edit():
            seed('sentinel')
            undo_target = 'sentinel'
            seed('base')
            compose(sequence[:2])
            before = state(directory)
            arm('composition-backspace')
            key(14)
            after = state(directory)
            check('composition-backspace', bool(before['preedit']) and before['preedit'] != after['preedit']
                  and after['text'] == before['text'], f'before={before}; after={after}')
            arm('preedit-replacement')
            key(CODES[sequence[1]])
            replaced = state(directory)
            check('preedit-replacement', bool(replaced['preedit']) and replaced['preedit'] != after['preedit']
                  and replaced['text'] == 'base', str(replaced))
            arm('escape')
            key(1)
            cancelled = state(directory)
            check('escape', not cancelled['preedit'] and cancelled['text'] == ('base하' if engine == 'hangul' else 'base'), str(cancelled))
            arm('cancelled-undo')
            chord([29], 44)
            undone = state(directory)
            check('cancelled-undo', not undone['preedit'] and undone['text'] == ('base' if engine == 'hangul' else undo_target), str(undone))
        def context():
            seed('日🙂尾')
            arm('surrounding-utf8')
            key(105)
            middle = state(directory)
            wire = (directory / 'client.log').read_text()
            surrounding = re.findall(r'set_surrounding_text\((.*)\)', wire)[-1]
            check('surrounding-utf8', middle['cursor'] == 7 and middle['anchor'] == 7
                  and '日🙂尾' in surrounding and ', 7, 7' in surrounding, surrounding)
            compose()
            arm('interior-insertion')
            commit()
            check('interior-insertion', state(directory)['text'] == '日🙂' + expected + '尾', str(state(directory)))
        def selection():
            seed('日🙂尾')
            key(105)
            chord([42], 105)
            arm('selection-replacement')
            compose()
            commit()
            check('selection-replacement', state(directory)['text'] == '日' + expected + '尾', str(state(directory)))
        def focus():
            seed('base')
            compose(sequence[:2])
            arm('focus-loss')
            before_focus = state(directory)['focus_count']
            other = p.start([native.BIN], directory / 'second.log', env | {'NK_IME_STATE_LOG': str(directory / 'second-state.jsonl')})
            other_win = native.wait(lambda: next((w for w in p.msg('windows')['windows'] if w['pid'] == other.pid), None), 'second window')
            p.msg('do', 'focus-window ' + str(other_win['id']))
            native.wait(lambda: state(directory)['focus_count'] > before_focus, 'focus loss processed by client')
            drain_ime()
            lost = state(directory)
            check('focus-loss', not lost['active'] and not lost['preedit'] and lost['text'] == 'base', str(lost))
            arm('focus-return')
            before_focus = state(directory)['focus_count']
            context_start = len(ime_log.read_text())
            p.msg('do', 'focus-window ' + str(win['id']))
            native.wait(lambda: state(directory)['focus_count'] > before_focus, 'focus return processed by client')
            try:
                native.wait(lambda: engine_ready(context_start, 'base'), 'fresh field context and keyboard grab')
            except AssertionError:
                check('focus-return', False, 'fresh field context and keyboard grab never arrived')
            compose()
            commit()
            check('focus-return', state(directory)['text'] == 'base' + expected,
                  f'fresh field context and grab confirmed; {state(directory)}')
            p.stop(other)
        def restart():
            nonlocal ime, finish, ime_log
            seed('')
            p.stop(ime)
            time.sleep(.5)
            ime_log = directory / 'fcitx-restart.log'
            ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin'], ime_log, env)
            native.wait(lambda: b'true' in subprocess.check_output(
                ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
                 '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5']), 'restart controller')
            time.sleep(1)
            compose()
            arm('restart')
            commit()
            check('restart', state(directory)['text'] == expected, str(state(directory)))
        def native_keys():
            nonlocal ime, finish
            seed('')
            p.stop(ime)  # Exercise nk-wayland's XKB/Compose, not fcitx5's keyboard grab.
            time.sleep(.2)
            p.msg('settings', json.dumps({'input': {'keyboard': {
                'layout': 'us', 'variant': '', 'options': 'compose:ralt',
                'repeat_delay': 600, 'repeat_rate': 25}}}))
            time.sleep(.3)
            arm('compose')
            key(100)  # Right Alt is Multi_key, configured on the actual seat.
            prefix = state(directory)
            key(40)
            accent_prefix = state(directory)
            key(18)
            composed = state(directory)
            check('compose', prefix['text'] == '' and accent_prefix['text'] == '' and composed['text'] == 'é', str(composed))
            seed('')
            p.msg('settings', json.dumps({'input': {'keyboard': {
                'layout': 'us', 'variant': 'intl', 'options': ''}}}))
            time.sleep(.3)
            arm('dead-acute')
            key(40)
            dead_prefix = state(directory)
            key(18)
            dead = state(directory)
            check('dead-acute', dead_prefix['text'] == '' and dead['text'] == 'é', str(dead))
            p.msg('settings', json.dumps({'input': {'keyboard': {
                'layout': 'us', 'variant': '', 'options': ''}}}))
            time.sleep(.3)
            seed('')
            arm(target if target in ('repeat-delay', 'repeat-rate') else 'repeat-delay')
            count = state(directory)['key_count']
            p.control('keydown 30', 0)
            native.wait(lambda: state(directory)['key_count'] > count, 'first held key delivered')
            time.sleep(.25)
            early = state(directory)
            time.sleep(.7)
            released = release(30)
            hold_end = released['ms']
            arm('repeat-release')
            time.sleep(.3)
            settled = state(directory)
            samples = [json.loads(row) for row in re.findall(r'^IME_STATE (.*)\n',
                       (directory / 'state.jsonl').read_text(), re.M)]
            repeats = [row for row in samples if row['key_count'] > count and row['ms'] <= hold_end
                       and re.fullmatch('a+', row['text'])]
            repeated = []
            for sample in repeats:
                if not repeated or sample['text'] != repeated[-1]['text']:
                    repeated.append(sample)
            intervals = [b['ms']-a['ms'] for a,b in zip(repeated, repeated[1:])]
            check('repeat-delay', early['text'] == 'a' and len(repeated) > 1
                  and 500 <= repeated[1]['ms'] - repeated[0]['ms'] <= 780,
                  f'early={early}; intervals_ms={intervals}')
            check('repeat-rate', len(intervals) > 3 and all(25 <= dt <= 90 for dt in intervals[1:]) and 25 <= statistics.median(intervals[1:]) <= 55, str(intervals))
            check('repeat-release', len(released['text']) > 2 and settled['text'] == released['text'],
                  f'released={released}; settled={settled}')
            arm('repeat-backspace')
            count = state(directory)['key_count']
            p.control('keydown 14', 0)
            native.wait(lambda: state(directory)['key_count'] > count, 'held Backspace delivered')
            time.sleep(.8)
            deleted = release(14)
            time.sleep(.2)
            check('repeat-backspace', len(deleted['text']) < len(released['text']) - 1
                  and state(directory)['text'] == deleted['text'], str(deleted))
            p.control('keydown 30', .75)
            arm('repeat-focus-loss')
            other = p.start([native.BIN], directory / 'repeat-second.log', env | {'NK_IME_STATE_LOG': str(directory / 'repeat-second-state.jsonl')})
            native.wait(lambda: any(w['pid'] == other.pid for w in p.msg('windows')['windows']), 'repeat second window')
            time.sleep(.25)
            lost_repeat = state(directory)
            time.sleep(.5)
            after_loss = state(directory)
            p.control('keyup 30', .05)
            check('repeat-focus-loss', not after_loss['active'] and after_loss['text'] == lost_repeat['text'], str(after_loss))
            p.stop(other)
            p.msg('do', 'focus-window ' + str(win['id']))
            time.sleep(.3)
        def scroll():
            nonlocal ime, finish, ime_log
            p.stop(ime)
            ime_log = directory / 'fcitx-scroll.log'
            ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin'],
                          ime_log, env)
            native.wait(lambda: b'true' in subprocess.check_output(
                ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
                 '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5']), 'scroll controller')
            time.sleep(1)
            seed('line\n' * 8)
            arm('scrolled-candidates')
            compose()
            if engine == 'mozc':
                key(57)
                key(57)
            scrolled = state(directory)
            assert scrolled['field_scroll'] > 0, 'field did not scroll'
            p.msg('screenshot', directory / 'scrolled.ppm')
            if engine != 'hangul':
                win = next(w for w in p.msg('windows')['windows'] if w['pid'] == app.pid)
                wire = (directory / 'client.log').read_text()
                x,y,w,h = scrolled['rect']
                caret = [(win['x']+x)*scale, (win['y']+y)*scale,
                         (win['x']+x+w)*scale, (win['y']+y+h)*scale]
                try:
                    box = candidate_box(directory / 'scrolled.ppm', win, scale, caret)
                except AssertionError:
                    if target == 'scrolled-candidates':
                        check('scrolled-candidates', False, 'fault displaced the panel outside its expected area')
                    raise
                check('scrolled-candidates', abs(box[0] - caret[0]) < 6*scale and abs(box[1] - caret[3]) <= 2*scale,
                      f'candidate={box}; caret={caret}')


                output = p.msg('outputs')['outputs'][0]
                ow,oh = output['logical_size']
                arm('document-scrolled-candidates')
                subprocess.run(['nidara-input', 'scroll', str(win['x'] + win['width']//2),
                                str(win['y'] + 150), str(ow), str(oh), '0', '1'],
                               check=True, timeout=5)
                time.sleep(.3)
                document = state(directory)
                p.msg('screenshot', directory / 'document-scrolled.ppm')
                model = document['rect']
                caret = [(win['x']+model[0])*scale, (win['y']+model[1])*scale,
                         (win['x']+model[0]+model[2])*scale, (win['y']+model[1]+model[3])*scale]
                try:
                    box = candidate_box(directory / 'document-scrolled.ppm', win, scale, caret)
                except AssertionError:
                    if target == 'document-scrolled-candidates':
                        check('document-scrolled-candidates', False, 'fault displaced the panel outside its expected area')
                    raise
                check('document-scrolled-candidates', document['document_scroll'] > 0
                      and document['rect'][1] < scrolled['rect'][1]
                      and abs(box[0] - caret[0]) < 6*scale and abs(box[1] - caret[3]) <= 2*scale,
                      f'candidate={box}; caret={caret}; state={document}')
        group = GROUP.get(target) if target else None
        for name in ([group] if group else ['initial'] if fault else ['initial','edit','context','selection','focus','restart','native_keys','scroll']):
            locals()[name]()
    except TargetReached:
        return
    finally:
        p.stop(app)
        p.stop(ime)
        for proc in p.procs:
            p.stop(proc)
        time.sleep(.2)


def main():
    p = native.Probe('fcitx5-preflight')
    output = p.msg('outputs')['outputs'][0]
    original = output['scale']
    keyboard = p.msg('config')['config']['input']['keyboard']
    try:
        p.environment['engines'] = os.environ.get('NK_FCITX5_ENGINES', 'mozc pinyin hangul').split()
        p.environment['scales'] = [float(s) for s in os.environ.get('NK_FCITX5_SCALES', '1 1.25').split()]
        p.environment['packages'] = subprocess.run(
            ['pacman', '-Q', 'fcitx5', 'fcitx5-mozc', 'fcitx5-chinese-addons', 'fcitx5-hangul'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.strip()
        for scale in [float(s) for s in os.environ.get('NK_FCITX5_SCALES', '1 1.25').split()]:
            p.msg('settings', json.dumps({'outputs': {output['name']: {'scale': scale}}}))
            for engine in os.environ.get('NK_FCITX5_ENGINES', 'mozc pinyin hangul').split():
                try:
                    run(p, engine, scale)
                    baseline = {r['step'].split('/')[-1]: r['status'] for r in p.rows
                                if r['step'].startswith(f'{engine}-{scale:g}/')}
                    # NK_REAL_CONTROLS=0: the baseline alone (nk-orca-check.py says why).
                    if os.environ.get('NK_REAL_CONTROLS', '1') == '0':
                        continue
                    if baseline.get('underlined-preedit') == 'PASS':
                        run(p, engine, scale, '--control-no-preedit')
                    if engine != 'hangul' and baseline.get('candidate-placement') == 'PASS':
                        run(p, engine, scale, '--control-ime-cursor')
                    for step, (_, mutation) in CONTROLS.items():
                        if os.environ.get('NK_IME_CONTROL') and step not in os.environ['NK_IME_CONTROL'].split():
                            continue
                        if engine == 'hangul' and step in ('scrolled-candidates','document-scrolled-candidates'):
                            continue  # Normal Hangul composition has no candidate list.
                        if baseline.get(step) != 'PASS':
                            p.row(f'{engine}-{scale:g}/blocked-control-{step}', False, 'baseline did not pass')
                            continue
                        try:
                            run(p, engine, scale, target=step,
                                mutation='drop-commit' if engine == 'hangul' and step == 'escape' else mutation)
                            assert any(r['step'] == f'{engine}-{scale:g}-{step}/control-{step}' and r['status'] == 'PASS' for r in p.rows), 'target assertion was not reached'
                        except Exception as error:
                            p.row(f'{engine}-{scale:g}/control-{step}', False, repr(error))

                except Exception as e:
                    p.row(f'{engine}-{scale:g}/prerequisite', False, repr(e))
    finally:
        try:
            p.msg('settings', json.dumps({'outputs': {output['name']: {'scale': original}}, 'input': {'keyboard': keyboard}}))
        finally:
            p.save([], complete=not any(r['status'] == 'FAIL' for r in p.rows) and set(p.environment['engines']) == set(ENGINES) and set(p.environment['scales']) == {1., 1.25} and not os.environ.get('NK_IME_CONTROL'))
            p.close()
    return 1 if any(r['status'] == 'FAIL' for r in p.rows) else 0


if __name__ == '__main__':
    raise SystemExit(main())
