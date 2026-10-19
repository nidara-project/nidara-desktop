#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Test 5 with nk-phase0. Uses the server probe's screenshot/input oracle.
Requires a TEST Hyalo with HYALO_CONTROL. Never drives the live desktop.
"""
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('motion', Path(__file__).with_name('hyalo-layer-motion-check.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BASE = Path(os.environ.get('NK_PHASE0_LOG', '/tmp/hyalo/nk-layer-motion'))
BIN = os.environ.get('NK_PHASE0_BIN', str(ROOT / 'toolkit/target/release/nk-phase0'))
REPORT = []
CONTROL_SERIAL = 0
send_control = m.control

PREVIEWS = []
raw_shot = m.shot


def shot(name):
    # PNG encoding is evidence preparation, not part of capture -> input.
    image = raw_shot(name, preview=False)
    PREVIEWS.append((m.LOG / f'{name}.ppm', image))
    return image


def save_previews():
    for path, image in PREVIEWS:
        m.save_preview(path, image)
    PREVIEWS.clear()


m.shot = shot


def delivered_control(line):
    # The FIFO reader forwards lines to calloop on another thread. Returning
    # from write() says nothing about seat delivery, and screenshot IPC can
    # overtake it. Acknowledge that channel, never a hit-test outcome.
    global CONTROL_SERIAL
    CONTROL_SERIAL += 1
    ack = m.LOG / f'control-{CONTROL_SERIAL}.ack'
    ack.unlink(missing_ok=True)
    sent = time.monotonic()
    send_control(f'{line}\nbarrier {ack}')
    wait(lambda: ack.exists(), f'control not delivered: {line}')
    with (m.LOG / 'delivery.jsonl').open('a') as stream:
        stream.write(json.dumps({'command': line, 'sent': sent,
                                 'acknowledged': time.monotonic(),
                                 'server_clock': ack.read_text().strip()}) + '\n')


m.control = delivered_control


def record(row):
    REPORT.append(row)
    (BASE / 'report.json').write_text(json.dumps(REPORT, indent=2))
    table = ['| Scenario | Result | Fault applied |', '| --- | --- | --- |']
    table += [f"| {r['test']} | {r.get('status', 'PASS')} | {r.get('applied', '—')} |" for r in REPORT]
    (BASE / 'report.md').write_text('\n'.join(table) + '\n')


def cursor_vertical_bounds(solid_width, output_scale):
    # A scanline counts pixel centres with almost the exact fill colour. Its
    # integer span is not the geometric width: sampling/linear filtering can
    # lose a boundary pixel on either side. Carry that physical-pixel
    # uncertainty through the OUTWARD logical rounding used for cursor rects.
    # Comparing height with 12*s directly counts both rounded edges as error
    # and spuriously rejects the 14 -> 16 transition near s = 7/6.
    low = (solid_width - 1) / (80 * output_scale)
    high = (solid_width + 2) / (80 * output_scale)
    return {'scale': [low, high],
            'top': [math.floor(70 - 6 * high), math.floor(70 - 6 * low)],
            'bottom': [math.ceil(70 + 6 * low), math.ceil(70 + 6 * high)]}


def cursor_vertical_matches(rect, bounds):
    return (bounds['top'][0] <= rect[1] <= bounds['top'][1]
            and bounds['bottom'][0] <= rect[1] + rect[3] <= bounds['bottom'][1])


def wait(test, label, seconds=7):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        time.sleep(.01)
    raise AssertionError(f'{label}; client: {m.lines()}')


def ticks(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')


def native(label, flag=None, retarget=False):
    m.LOG = BASE / label
    m.LOG.mkdir(parents=True, exist_ok=True)
    m.OUT = m.LOG / 'client.log'
    with m.OUT.open('w') as stream:
        client = subprocess.Popen([BIN, '--test5', *([flag] if flag else [])], stdout=stream, stderr=stream)
    try:
        def ready():
            assert client.poll() is None, f'client exited: {m.lines()}'
            return 'READY' in m.lines()
        wait(ready, 'client never became ready')
        time.sleep(1.1)  # Past the window opening transition.
        # Settled before the click: no paint pending. A configure that came with the click left
        # the parent dirty when the press committed the layers (2026-10-18) — the preferred
        # scale, told once the opening ended. It is told before the first frame now (#868), so
        # the window paints nothing more once open.
        def settled():
            before = sum(l.startswith('PAINT ') for l in m.lines())
            time.sleep(.3)
            return before == sum(l.startswith('PAINT ') for l in m.lines())
        wait(settled, 'opened, but still repainting', seconds=2)
        win = next(w for w in m.msg('windows')['windows'] if w['app_id'] == 'nk-phase0')
        scale = m.msg('outputs')['outputs'][0]['scale']
        # Screenshots are physical pixels; HYALO_CONTROL takes logical coordinates.
        phys = lambda x: int((win['x'] + x) * scale)
        ya, yb = (int((win['y'] + y)*scale) for y in (70,210))
        before = m.shot('before')
        a0, b0 = m.span(before, ya, m.RED), m.span(before, yb, m.BLUE)
        assert a0 and b0 and abs(a0[0]-phys(20)) <= 2 and abs(b0[0]-phys(20)) <= 2, 'placed: layers missing or misplaced'
        # Hyalo lists the window's layers (msg windows → layers; PHASE1.md D7's acceptance reads
        # it): A and B where the client put them; with client-side motion there are none.
        listed = sorted((round(l['x']), round(l['y']), round(l['width']), round(l['height'])) for l in win.get('layers', []))
        if flag == '--control-client-motion':
            assert listed == [], f'listed: a window without layers lists {listed}'
        elif not flag:
            assert listed == [(20, 40, 80, 60), (20, 180, 80, 60)], f'listed: layers {listed}, not A and B'
        if not flag:
            assert 'LIMIT_OK' in m.lines(), 'app-side 64-layer limit/lifetime path not exercised'
        if retarget:
            m.control('key 19')  # r: responsive spring, t retargets it.
        else:
            m.control(f"click {win['x']+90} {win['y']+322}")
        wait(lambda: 'MOVED' in m.lines(), 'no transition committed')
        t0 = time.monotonic()
        if retarget:
            retarget_check(phys, ya, yb, scale)
            record({'test': label, 'status': 'PASS'})
            return
        cpu0 = ticks(client.pid)
        # Stats distinguish the session's build/render CPU from this harness's captures.
        stats0 = m.msg('stats')
        time.sleep(max(0., .25-(time.monotonic()-t0)))
        s1 = m.shot('during-1')
        time.sleep(max(0., .55-(time.monotonic()-t0)))
        s2 = m.shot('during-2')
        stats_during = m.msg('stats')
        cpu1 = ticks(client.pid)
        elapsed = time.monotonic()-t0
        a1, a2 = m.span(s1, ya, m.RED), m.span(s2, ya, m.RED)
        b1, b2 = m.span(s1, yb, m.BLUE), m.span(s2, yb, m.BLUE)
        assert not any(l.startswith('AWAKE') for l in m.lines()), 'client woke before captures'
        assert a1 and a2 and b1 and b2, 'moving: a layer disappeared'
        assert a0[0] < a1[0] < a2[0] and b0[0] < b1[0] < b2[0], 'moving: layers did not move while client blocked'
        assert a2[0] < phys(300)-20, 'moving: no transition (jumped to end)'
        assert cpu1-cpu0 <= max(.02, elapsed*.03), f'client consumed {cpu1-cpu0}s while blocked'
        m.control(f"click {win['x']+340} {win['y']+70}")
        now = m.span(m.shot('during-3'), ya, m.RED)
        assert now, 'A missing before click'
        m.control(f'click {(now[0]+now[1])/2/scale} {ya/scale}')
        assert time.monotonic()-t0 < 1.4 and not any(l.startswith('AWAKE') for l in m.lines()), 'clicks after wake'
        wait(lambda: any(l.startswith('AWAKE') for l in m.lines()), 'client did not wake')
        def presses():
            return [l.split() for l in m.lines()[m.lines().index('MOVED')+1:] if l.startswith('PRESS')]
        wait(lambda: len(presses()) >= 2, 'client did not read both clicks')
        p = presses()
        assert p[0][1] != 'A', f'model hit-test: end-position click reached A: {p[0]}'
        assert p[1][1] == 'A', f'presented hit-test: visible-position click missed A: {p[1]}'
        x, y = map(float, p[1][2:4])
        assert 0 <= x < 80 and 0 <= y < 60, f'layer-local coordinates outside A: {x} {y}'
        wait(lambda: all(any(l.startswith(f'DONE {i} ') for l in m.lines()) for i in (1,2)), 'missing done events')
        done = [l.split() for l in m.lines() if l.startswith('DONE')]
        assert all(int(l[2]) > 0 and 0 <= int(l[3]) < 1_000_000_000 for l in done), 'invalid presentation timestamps'
        end = m.shot('after')
        for row, colour in [(ya,m.RED),(yb,m.BLUE)]:
            span = m.span(end,row,colour)
            assert span and abs(span[0]-phys(300)) <= 2, f'wrong end position: {span}'
        awake = next(l.split() for l in m.lines() if l.startswith('AWAKE'))
        assert awake[2] == awake[3], 'parent repainted during block'
        # Include the raw stats; not a hardware benchmark or client CPU estimate.
        (m.LOG/'cost.json').write_text(json.dumps({'client_cpu_s':cpu1-cpu0,'blocked_sample_s':elapsed,
            'hyalo_stats_start':stats0,'hyalo_stats_during':stats_during,'hyalo_stats_end':m.msg('stats')},indent=2))
        record({'test':label,'client_cpu_s':cpu1-cpu0,'blocked_sample_s':elapsed,
                       'A':[a0[0],a1[0],a2[0]],'B':[b0[0],b1[0],b2[0]]})
        print(f'PASS {label}: independent movement while blocked, local clicks, both done; client CPU {cpu1-cpu0:.3f}s',flush=True)
    finally:
        if client.poll() is None:
            client.terminate()
            client.wait(timeout=5)
        save_previews()
        wait(lambda: not any(w['app_id']=='nk-phase0' for w in m.msg('windows')['windows']), 'window did not close')


def retarget_check(phys, ya, yb, scale):
    time.sleep(.12)
    first = m.shot('spring-1')
    t1 = time.monotonic()
    time.sleep(.08)
    second = m.shot('spring-2')
    t2 = time.monotonic()
    p1 = [m.span(first,y,c) for y,c in [(ya,m.RED),(yb,m.BLUE)]]
    p2 = [m.span(second,y,c) for y,c in [(ya,m.RED),(yb,m.BLUE)]]
    assert all(p1+p2), 'spring layers missing'
    assert all(b[0]>a[0] for a,b in zip(p1,p2)), 'spring was not moving right'
    m.control('key 20')  # t: replace target while moving right.
    wait(lambda: 'RETARGETED' in m.lines(), 'no retarget')
    immediate = m.shot('retarget-immediate')
    t3 = time.monotonic()
    # The kept VELOCITY is not asserted here: screenshots cannot date the moment Hyalo applied the
    # retarget. On CI (2026-10-15) the key, the client and the capture took long enough for this
    # spring to pass its peak and turn back before the first capture, so "still moving right"
    # failed with Hyalo right. Hyalo's unit test a_retargeted_spring_keeps_where_it_is_and_its_velocity
    # (protocols/layers.rs) proves it with no clock; this asserts the end-to-end path around it.
    for i,(y,c) in enumerate([(ya,m.RED),(yb,m.BLUE)]):
        at = m.span(immediate,y,c)
        assert at, 'retarget layer disappeared'
        speed=(p2[i][0]-p1[i][0])/(t2-t1)
        assert abs(at[0]-p2[i][0]) <= max(12*scale, speed*(t3-t2)*1.8+4*scale), 'retarget jumped instead of starting at presentation'
    wait(lambda: 'CANCELLED 1' in m.lines() and 'CANCELLED 2' in m.lines(), 'missing cancellations')
    wait(lambda: all(any(l.startswith(f'DONE {i} ') for l in m.lines()) for i in (3,4)), 'retarget never settled',seconds=10)
    assert not any(l.startswith('DONE 1 ') or l.startswith('DONE 2 ') for l in m.lines()), 'replaced transition completed'
    end=m.shot('retarget-end')
    for y,c in [(ya,m.RED),(yb,m.BLUE)]:
        pos=m.span(end,y,c)
        assert pos and abs(pos[0]-phys(20))<=2, 'retarget missed final position'
    print('PASS spring retarget: continuous position, cancelled old serials, done new serials',flush=True)
    m.control('key 22')  # u: scale A about its centre; fade B out.
    wait(lambda: all(any(l.startswith(f'DONE {i} ') for l in m.lines()) for i in (5,6)), 'scale/opacity did not finish')
    transformed=m.shot('scale-opacity')
    a=m.span(transformed,ya,m.RED)
    assert a and abs(a[0]-phys(0))<=2 and abs((a[1]-a[0]+1)-120*scale)<=3, 'scale/anchor was not applied'
    assert m.span(transformed,yb,m.BLUE) is None, 'opacity=0 layer remains visible'
    press_count=sum(l.startswith('PRESS') for l in m.lines())
    m.control(f'click {(a[0]+a[1])/2/scale} {ya/scale}')
    m.control(f'click {phys(60)/scale} {yb/scale}')
    wait(lambda: sum(l.startswith('PRESS') for l in m.lines())>=press_count+2, 'transformed clicks missing')
    presses=[l.split() for l in m.lines() if l.startswith('PRESS')][-2:]
    assert presses[0][1]=='A' and abs(float(presses[0][2])-40)<2 and abs(float(presses[0][3])-30)<2, 'scaled pointer was not inverse-transformed'
    assert presses[1][1]=='WINDOW', 'invisible B still receives input'
    m.control('key 48')  # b: replace A's content/size via a released buffer.
    wait(lambda: 'BUFFER_REPLACED' in m.lines(), 'no resized buffer')
    def resized():
        image=m.shot('resized')
        a=m.span(image,ya,m.RED)
        b=m.span(image,yb,m.BLUE)
        return a and b and abs(a[0]-phys(20))<=2 and abs(a[1]-a[0]+1-100*scale)<=3
    wait(resized,'layer resize/repaint did not replace content')
    print('PASS anchored scale, transparent input, inverse pointer coordinates, released-buffer resize',flush=True)



def cursor_check(label, flag=None):
    m.LOG=BASE/label
    m.LOG.mkdir(parents=True,exist_ok=True)
    m.OUT=m.LOG/'client.log'
    ime_log=m.LOG/'ime.log'
    with m.OUT.open('w') as stream:
        client=subprocess.Popen([BIN,'--test5',*([flag] if flag else [])],stdout=stream,stderr=stream)
    ime=None
    try:
        def alive():
            assert client.poll() is None, f'cursor client exited: {m.lines()}'
            return 'READY' in m.lines()
        wait(alive,'cursor client never ready')
        time.sleep(1.1)
        win=next(w for w in m.msg('windows')['windows'] if w['app_id']=='nk-phase0')
        scale=m.msg('outputs')['outputs'][0]['scale']
        phys=lambda x:int((win['x']+x)*scale)
        with ime_log.open('w') as stream:
            ime=subprocess.Popen([os.environ.get('IME_PROBE_BIN','hyalo-ime-probe'),'--cursor'],stdout=stream,stderr=stream)
        def ime_lines():
            assert ime.poll() is None, f'IME exited: {ime_log.read_text()}'
            return ime_log.read_text().splitlines()
        wait(lambda:'READY' in ime_lines(),'IME never ready')
        m.control('key 24')  # o: establish standard root-local fallback.
        wait(lambda:'RECT 220 120 2 12' in ime_lines(),'root cursor missing')
        m.control('key 23')  # i: same text-input focus; cursor now belongs to A.
        wait(lambda:'RECT 52 64 2 12' in ime_lines(),'initial layer cursor missing')
        marker=(32,224,96)
        m.control(f"click {win['x']+90} {win['y']+322}")
        wait(lambda:'MOVED' in m.lines(),'cursor transition not committed')
        t0=time.monotonic()
        positions=[]
        for index,delay in enumerate((.25,.55)):
            time.sleep(max(0.,delay-(time.monotonic()-t0)))
            image=m.shot(f'cursor-during-{index}')
            red=m.span(image,int((win['y']+45)*scale),m.RED)
            # The probe's popup is 24 px tall and sits BELOW the cursor rectangle (y 70-6s,
            # height 12s, so its bottom is at most 80): this row is inside it, under the caret.
            green=m.span(image,int((win['y']+90)*scale),marker)
            assert red and green,'cursor marker or layer missing'
            layer_scale=(red[1]-red[0]+1)/(80*scale)
            expected=red[0]+32*scale*layer_scale
            assert abs(green[0]-expected)<5*scale,'cursor follows: IME popup did not follow presented layer'
            sent = json.loads((m.LOG/f'cursor-during-{index}.capture.json').read_text())['input_method_rectangles']
            assert len(sent) == 1, f'capture has no unique IME event source: {sent}'
            last = sent[0]
            event = 'RECT ' + ' '.join(map(str, last))
            wait(lambda: event in ime_lines(), 'capture cursor event not delivered')
            bounds=cursor_vertical_bounds(red[1]-red[0]+1,scale)
            (m.LOG/f'cursor-during-{index}.json').write_text(json.dumps({
                'output_scale':scale,'red_span':red,'popup_span':green,
                'cursor_rect':last,'vertical_bounds':bounds},indent=2))
            assert abs(phys(last[0])-green[0])<8*scale,'cursor follows: IME event disagrees with rendered popup'
            assert cursor_vertical_matches(last,bounds),f'cursor follows: anchor/scale not applied to rectangle: {last}, {bounds}'
            assert not any(l.startswith('AWAKE') for l in m.lines()),'cursor sampled after client woke'
            positions.append(green[0])
        assert positions[1]>positions[0],'cursor follows: candidate did not move while client blocked'
        wait(lambda:all(any(l.startswith(f'DONE {i} ') for l in m.lines()) for i in (1,2,7)),'cursor transitions never ended')
        # Clear the layer association and observe the standard rectangle again.
        before=len(ime_lines())
        m.control('key 24')
        wait(lambda:'RECT 220 120 2 12' in ime_lines()[before:],'root cursor was not restored after clearing layer')
        def root_popup():
            image=m.shot('cursor-cleared')
            green=m.span(image,int((win['y']+145)*scale),marker)  # below RECT 220 120 2 12
            return green and abs(green[0]-phys(220))<=2
        wait(root_popup,'cleared cursor popup still follows the layer')
        record({'test': label, 'status': 'PASS'})
        print(f'PASS {label}: real IME popup/event follow position and anchored scale while client blocked; root fallback restored',flush=True)
    finally:
        for process in (ime,client):
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        save_previews()
        wait(lambda:not any(w['app_id']=='nk-phase0' for w in m.msg('windows')['windows']),'cursor window did not close')


if __name__ == '__main__':
    BASE.mkdir(parents=True,exist_ok=True)
    original = next(w['id'] for w in m.msg('workspaces')['workspaces'] if w['focused'])
    output = m.msg('outputs')['outputs'][0]
    try:
        m.msg('do','workspace',95)
        m.msg('do','set-workspace-mode',95,'floating')
        for scale in (1,1.25):
            m.msg('output',output['name'],f'scale={scale}')
            if os.environ.get('NK_LAYER_CURSOR_ONLY') == '1':
                cursor_check(f'scale{scale}-cursor')
                continue
            native(f'scale{scale}')
            # First pass proves both oracles reachable; then break each path.
            for name,flag in [('no-parent','--control-no-parent-commit'),('client-motion','--control-client-motion')]:
                try:
                    native(f'scale{scale}-{name}',flag)
                except AssertionError as e:
                    assert str(e).startswith('moving: layers did not move'), f'wrong failure for {name}: {e}'
                    assert any(l.startswith(f'LAYER_FAULT {name} applied:') for l in m.lines()), f'{name} never applied'
                    record({'test': f'scale{scale}-{name}', 'status': 'CAUGHT', 'assertion': str(e), 'applied': True})
                    print(f'CONTROL PASS {name}: {e}',flush=True)
                else:
                    raise AssertionError(f'control {name} unexpectedly passed')
            native(f'scale{scale}-retarget',retarget=True)
            cursor_check(f'scale{scale}-cursor')
            try:
                cursor_check(f'scale{scale}-cursor-control','--control-no-cursor-association')
            except AssertionError as e:
                assert str(e).startswith('cursor follows:'), f'wrong cursor control failure: {e}'
                assert any(l.startswith('LAYER_FAULT cursor-association applied:') for l in m.lines()), 'cursor association fault never applied'
                record({'test': f'scale{scale}-cursor-control', 'status': 'CAUGHT', 'assertion': str(e), 'applied': True})
                print(f'CONTROL PASS cursor association: {e}',flush=True)
            else:
                raise AssertionError('cursor association control unexpectedly passed')
        (BASE/'report.json').write_text(json.dumps(REPORT,indent=2))
        print('NATIVE LAYER MOTION CHECK PASSED',flush=True)
    finally:
        m.msg('output',output['name'],f"scale={output['scale']}")
        m.msg('do','workspace',original)
