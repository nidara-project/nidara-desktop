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
import time

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('nk-real-common.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

ENGINES = {'mozc': ('nihongo', '日本語', [57, 28]),
           'pinyin': ('zhongwen', '中文', [57]),
           'hangul': ('gksrmf', '한글', [-1])}
CODES = dict(zip('qwertyuiopasdfghjklzxcvbnm',
                 [16,17,18,19,20,21,22,23,24,25,30,31,32,33,34,35,36,37,38,44,45,46,47,48,49,50]))
PENDING = ['Discriminating IME fault controls for every matrix row (blocked gate: Hangul Escape commits)',
           'Fault controls for candidate placement under field/document scrolling',
           'Complete vkms/tty CI run; baseline observations alone do not pass test 2']


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
    rows = re.findall(r'^IME_STATE (.*)$', (directory / 'client.log').read_text(), re.M)
    assert rows, 'no Editor evidence; rebuild nk-phase0'
    return json.loads(rows[-1])


def run(p, engine, scale, fault=None):
    label = f'{engine}-{scale:g}' + ('-' + fault if fault else '')
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
    env = os.environ | {'XDG_CONFIG_HOME': str(config.parent), 'WAYLAND_DEBUG': '1'}
    app = ime = None
    try:
        ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin',
                       '--verbose=key_trace=5'], directory / 'fcitx.log', env)
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
        p.key(CODES[sequence[0]])
        def first_preedit():
            value = state(directory)
            return value if value['preedit'] else None
        first_state = state(directory) if fault == '--control-no-preedit' else native.wait(first_preedit, 'first real preedit')
        for letter in sequence[1:]:
            p.key(CODES[letter])
        if engine == 'mozc':
            p.key(57)  # first Space converts; the second opens the candidate list
            p.key(57)
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
        if fault == '--control-no-preedit':
            p.row(label + '/control-underlined-preedit', not underlined and 'preedit_string, (Some("' in (directory / 'client.log').read_text(), 'ignored preedit must fail the underline assertion')
            return
        if fault and not underlined:
            raise AssertionError('cursor-control setup: underline baseline failed')
        p.row(label + '/underlined-preedit', underlined,
              f'first={first_state}; composing={composing}; underline ink={ink}')
        wire = (directory / 'client.log').read_text()
        preedits = re.findall(r'<- zwp_text_input_v3@\d+\.preedit_string, \((.*)\)', wire)
        p.row(label + '/preedit-received', any('Some("' in s and 'Some("")' not in s for s in preedits),
              'Received on the real text-input-v3 bridge; underline is not proved', wire_preedits=preedits)
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
            clear = box is not None and (box[1] >= caret[3] - 2 or box[3] <= caret[1] + 2)
            placed = adjacent and clear and rect == expected_rect
            if fault == '--control-ime-cursor':
                p.row(label + '/control-candidate-placement', box is not None and not placed and rect[0] == expected_rect[0] + 80, f'wire cursor={rect}; model={expected_rect}; panel={box}')
                return
            p.row(label + '/candidate-placement', placed,
                  f'candidate pane={box}; protected caret={caret}; candidates must leave the caret visible',
                  candidate_pixels=box, caret_pixels=caret, cursor_rectangle=rect, window=win)
        for code in finish:
            if code == -1:
                subprocess.run(['fcitx5-remote', '-c'], check=True, timeout=5)
                time.sleep(.3)
            else:
                p.key(code)
        p.chord([29], 30)
        p.chord([29], 46)
        actual = subprocess.check_output(['wl-paste', '-n'], text=True, timeout=5)
        (directory / 'committed.txt').write_text(actual)
        p.row(label + '/commit', actual == expected, f'expected {expected!r}; clipboard reads {actual!r}')
        p.msg('screenshot', directory / 'committed.png')
        def check(step, predicate, why):
            p.row(label + '/' + step, predicate, why)
            p.msg('screenshot', directory / (step + '.png'))

        def activate():
            subprocess.run(['fcitx5-remote', '-s', engine], check=True, timeout=5)
            subprocess.run(['fcitx5-remote', '-o'], check=True, timeout=5)
            time.sleep(.2)

        def seed(text):
            if ime.poll() is None:
                subprocess.run(['fcitx5-remote', '-c'], check=True, timeout=5)
                time.sleep(.2)
            p.chord([29], 30)
            clip = p.start(['wl-copy', '--foreground', '--type', 'text/plain;charset=utf-8'],
                           directory / 'clipboard.log', stdin=subprocess.PIPE)
            clip.stdin.write(text.encode())
            clip.stdin.close()
            time.sleep(.1)
            p.chord([29], 47)
            native.wait(lambda: state(directory)['text'] == text, 'seed text')

        def compose(text=sequence):
            activate()
            for char in text:
                p.key(CODES[char])

        def commit():
            if engine == 'mozc':
                p.key(57)
                p.key(28)
            elif engine == 'pinyin':
                p.key(57)
            else:
                subprocess.run(['fcitx5-remote', '-c'], check=True, timeout=5)
                time.sleep(.2)

        undo_target = state(directory)['text']
        seed('base')
        compose(sequence[:2])
        before = state(directory)
        p.key(14)
        after = state(directory)
        check('composition-backspace', bool(before['preedit']) and before['preedit'] != after['preedit']
              and after['text'] == before['text'], f'before={before}; after={after}')
        p.key(CODES[sequence[1]])
        replaced = state(directory)
        check('preedit-replacement', bool(replaced['preedit']) and replaced['preedit'] != after['preedit']
              and replaced['text'] == 'base', str(replaced))
        p.key(1)
        cancelled = state(directory)
        check('escape', not cancelled['preedit'] and cancelled['text'] == 'base', str(cancelled))
        p.chord([29], 44)
        undone = state(directory)
        check('cancelled-undo', not undone['preedit'] and undone['text'] == undo_target, str(undone))

        seed('日🙂尾')
        p.key(105)
        middle = state(directory)
        wire = (directory / 'client.log').read_text()
        surrounding = re.findall(r'set_surrounding_text\((.*)\)', wire)[-1]
        check('surrounding-utf8', middle['cursor'] == 7 and middle['anchor'] == 7
              and '日🙂尾' in surrounding and ', 7, 7' in surrounding, surrounding)
        compose()
        commit()
        check('interior-insertion', state(directory)['text'] == '日🙂' + expected + '尾', str(state(directory)))

        seed('日🙂尾')
        p.key(105)
        p.chord([42], 105)
        compose()
        commit()
        check('selection-replacement', state(directory)['text'] == '日' + expected + '尾', str(state(directory)))

        seed('base')
        compose(sequence[:2])
        other = p.start([native.BIN], directory / 'second.log', env)
        other_win = native.wait(lambda: next((w for w in p.msg('windows')['windows'] if w['pid'] == other.pid), None), 'second window')
        p.msg('do', 'focus-window ' + str(other_win['id']))
        time.sleep(.4)
        lost = state(directory)
        check('focus-loss', not lost['active'] and not lost['preedit'] and lost['text'] == 'base', str(lost))
        p.msg('do', 'focus-window ' + str(win['id']))
        time.sleep(.4)
        p.stop(other)
        compose()
        commit()
        check('focus-return', state(directory)['text'] == 'base' + expected, str(state(directory)))

        seed('')
        p.stop(ime)
        time.sleep(.5)
        ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin'],
                      directory / 'fcitx-restart.log', env)
        native.wait(lambda: b'true' in subprocess.check_output(
            ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
             '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5']), 'restart controller')
        time.sleep(1)
        compose()
        commit()
        check('restart', state(directory)['text'] == expected, str(state(directory)))


        seed('')
        p.stop(ime)  # Exercise nk-wayland's XKB/Compose, not fcitx5's keyboard grab.
        time.sleep(.2)
        p.msg('settings', json.dumps({'input': {'keyboard': {
            'layout': 'us', 'variant': '', 'options': 'compose:ralt',
            'repeat_delay': 600, 'repeat_rate': 25}}}))
        time.sleep(.3)
        p.key(100)  # Right Alt is Multi_key, configured on the actual seat.
        prefix = state(directory)
        p.key(40)
        accent_prefix = state(directory)
        p.key(18)
        composed = state(directory)
        check('compose', prefix['text'] == '' and accent_prefix['text'] == '' and composed['text'] == 'é', str(composed))
        seed('')
        p.msg('settings', json.dumps({'input': {'keyboard': {
            'layout': 'us', 'variant': 'intl', 'options': ''}}}))
        time.sleep(.3)
        p.key(40)
        dead_prefix = state(directory)
        p.key(18)
        dead = state(directory)
        check('dead-acute', dead_prefix['text'] == '' and dead['text'] == 'é', str(dead))
        p.msg('settings', json.dumps({'input': {'keyboard': {
            'layout': 'us', 'variant': '', 'options': ''}}}))
        time.sleep(.3)
        seed('')
        p.control('keydown 30', .25)
        early = state(directory)
        time.sleep(.7)
        p.control('keyup 30', .05)
        released = state(directory)
        time.sleep(.3)
        settled = state(directory)
        samples = [json.loads(row) for row in re.findall(r'^IME_STATE (.*)$',
                   (directory / 'client.log').read_text(), re.M)]
        repeats = [row for row in samples if row['ms'] >= early['ms'] and re.fullmatch('a+', row['text'])]
        repeated = []
        for sample in repeats:
            if not repeated or sample['text'] != repeated[-1]['text']:
                repeated.append(sample)
        intervals = [b['ms']-a['ms'] for a,b in zip(repeated, repeated[1:])]
        check('repeat-delay', early['text'] == 'a' and len(repeated) > 3
              and 500 <= repeated[1]['ms'] - repeated[0]['ms'] <= 780,
              f'early={early}; intervals_ms={intervals}')
        check('repeat-rate', len(intervals) > 3 and all(25 <= dt <= 90 for dt in intervals[1:]), str(intervals))
        check('repeat-release', len(released['text']) > 2 and settled['text'] == released['text'], str(settled))
        p.control('keydown 14', .8)
        p.control('keyup 14', .05)
        deleted = state(directory)
        time.sleep(.2)
        check('repeat-backspace', len(deleted['text']) < len(released['text']) - 1
              and state(directory)['text'] == deleted['text'], str(deleted))
        p.control('keydown 30', .75)
        other = p.start([native.BIN], directory / 'repeat-second.log', env)
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
        ime = p.start(['fcitx5', '-D', '--disable=ibusfrontend,xim,notifications,cloudpinyin'],
                      directory / 'fcitx-scroll.log', env)
        native.wait(lambda: b'true' in subprocess.check_output(
            ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
             '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5']), 'scroll controller')
        time.sleep(1)
        seed('line\n' * 8)
        compose()
        if engine == 'mozc':
            p.key(57)
            p.key(57)
        scrolled = state(directory)
        check('field-scrolled', scrolled['field_scroll'] > 0, str(scrolled))
        p.msg('screenshot', directory / 'scrolled.ppm')
        if engine != 'hangul':
            win = next(w for w in p.msg('windows')['windows'] if w['pid'] == app.pid)
            wire = (directory / 'client.log').read_text()
            x,y,w,h = map(int, re.findall(r'set_cursor_rectangle\((-?\d+), (-?\d+), (\d+), (\d+)\)', wire)[-1])
            caret = [(win['x']+x)*scale, (win['y']+y)*scale,
                     (win['x']+x+w)*scale, (win['y']+y+h)*scale]
            box = candidate_box(directory / 'scrolled.ppm', win, scale, caret)
            check('scrolled-candidates', abs(box[0] - caret[0]) < 6*scale and box[1] >= caret[3] - 1,
                  f'candidate={box}; caret={caret}')


            output = p.msg('outputs')['outputs'][0]
            ow,oh = output['logical_size']
            subprocess.run(['nidara-input', 'scroll', str(win['x'] + win['width']//2),
                            str(win['y'] + 150), str(ow), str(oh), '0', '1'],
                           check=True, timeout=5)
            time.sleep(.3)
            document = state(directory)
            p.msg('screenshot', directory / 'document-scrolled.ppm')
            model = document['rect']
            caret = [(win['x']+model[0])*scale, (win['y']+model[1])*scale,
                     (win['x']+model[0]+model[2])*scale, (win['y']+model[1]+model[3])*scale]
            box = candidate_box(directory / 'document-scrolled.ppm', win, scale, caret)
            check('document-scrolled-candidates', document['document_scroll'] > 0
                  and document['rect'][1] < scrolled['rect'][1]
                  and abs(box[0] - caret[0]) < 6*scale and box[1] >= caret[3]-1,
                  f'candidate={box}; caret={caret}; state={document}')
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
                    if baseline.get('underlined-preedit') == 'PASS':
                        run(p, engine, scale, '--control-no-preedit')
                    if engine != 'hangul' and baseline.get('candidate-placement') == 'PASS':
                        run(p, engine, scale, '--control-ime-cursor')
                except Exception as e:
                    p.row(f'{engine}-{scale:g}/prerequisite', False, repr(e))
    finally:
        try:
            p.msg('settings', json.dumps({'outputs': {output['name']: {'scale': original}}, 'input': {'keyboard': keyboard}}))
        finally:
            p.save(PENDING)
            p.close()
    return 1 if PENDING or any(r['status'] == 'FAIL' for r in p.rows) else 0


if __name__ == '__main__':
    raise SystemExit(main())
