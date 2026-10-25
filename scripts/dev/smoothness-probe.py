#!/usr/bin/env python3
"""An open window's smoothness: the p95 gap between its frames while it scrolls, or follows a
slider drag, for 2 s (toolkit/PHASE1.md, gate 4: the native Settings ≤ the current one's p95).

usage: scripts/dev/smoothness-probe.py APP_ID RUNS scroll X Y [NOTCHES]
       scripts/dev/smoothness-probe.py APP_ID RUNS drag X1 Y1 X2 Y2

X, Y are logical px inside the window's box (`nidara-hyalo msg windows`): where to scroll, or
the slider's thumb and where to drag it. The window must be open, on the page, and the only one
of APP_ID: the probe moves nothing else and launches nothing.

The input is the same for every app, so the numbers compare, and it never pauses, so a window
is never idle for want of input: a scroll is a wheel notch every 16 ms for 2 s, NOTCHES down
then NOTCHES back up (default 8), over and over; a drag is a motion every 8 ms, there for 1 s,
back for 1 s (`nidara-input … [ms [legs]]`, one process for all of it). A frame is a buffer
anywhere in the window's tree (`msg frames ID`). The gaps measured run from the input's first
leg to its last, both ends counted as frames: an app slow to begin, or stuck at the end, is
seen.

Idle time is scored as a freeze, so the input must leave none. Two ways it did (legacy
Appearance, 2026-10-25): 62 notches straight down hit the bottom at 336 ms and left a 703 ms
"gap" in every run, the length of the page and not its smoothness; 16 notches a second left
~55 ms between notches with nothing to draw. Hence the continuous back and forth, and a guard:
when at least 3/4 of the legs going one way stop drawing before their last 40 ms, the input
ran out of page or track, and the probe stops. A freeze is not that: it silences a few legs in
a row, both ways (SIGSTOP 400 ms: 3 or 4 of 16), and it is scored. A drag has one leg each way,
so there a freeze right at the end of a leg reads as running out; the scroll tells them apart.

The number compared is `p95_time_ms`, the gap under which 95 % of the time passed; the plain
p95 of the gaps (`p95_ms`) and the longest (`max_ms`) are printed beside it. An app keeping
up shows ~one refresh; a freeze raises `p95_time_ms` where `p95_ms` does not move. Run 1 warms
the caches; the median is of runs 2…N.
"""
import json, math, os, statistics, subprocess, sys, time

MS = 2000
INPUT = os.environ.get('NIDARA_INPUT', 'nidara-input')


def msg(*a):
    reply = json.loads(subprocess.run(['nidara-hyalo', 'msg', *map(str, a)], capture_output=True, text=True).stdout)
    if 'ok' not in reply:
        sys.exit(f'nidara-hyalo msg {" ".join(map(str, a))}: {reply}')
    return reply['ok']


def p95(gaps):
    s = sorted(gaps)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]


def p95_time(gaps):
    """The gap under which 95 % of the TIME passed. A count p95 does not see one freeze: 400 ms
    among ~106 gaps is under 5 % of them (measured, the SIGSTOP control) — but it is 19 % of a
    2 s scroll, and the user watched all of it."""
    total, run = sum(gaps), 0.
    for g in sorted(gaps):
        run += g
        if run >= 0.95 * total:
            return g
    return max(gaps)


TAIL_MS = 40
NOTCH_MS = 16


def run_once(window, output, kind, coords, notches):
    # The window's box and its output's, logical px; nidara-input takes output-relative points.
    ox, oy = output['position']
    w, h = output['logical_size']
    to_out = lambda x, y: (round(window['x'] + x - ox), round(window['y'] + y - oy))
    if kind == 'scroll':
        x, y = to_out(*coords)
        legs = max(2, 2 * round(MS / (2 * notches * NOTCH_MS)))  # an even count: it ends where it began
        cmd = [INPUT, 'scroll', x, y, w, h, 0, notches, notches * NOTCH_MS, legs]
    else:
        a, b = to_out(*coords[:2]), to_out(*coords[2:])
        cmd = [INPUT, 'drag', *a, w, h, *b, MS // 2, 2]
    # One process for the whole input, so no seam between legs; its LEG lines say when each
    # leg ran, in the clock `msg frames` uses.
    out = subprocess.run(list(map(str, cmd)), check=True, capture_output=True, text=True).stdout
    legs = [tuple(map(float, l.split()[1:])) for l in out.splitlines() if l.startswith('LEG ')]
    start, end = legs[0][0], legs[-1][1]
    time.sleep(0.3)  # the last frames of the input reach Hyalo
    frames = [t for t in msg('frames', window['id'])['times_ms'] if start < t <= end]
    if not frames:
        return dict(frames=0, span_ms=round(end - start), p95_time_ms=None, p95_ms=None, max_ms=None)
    # Out of page or track, the legs going one way stop drawing before they end, nearly all of
    # them; a freeze silences a few legs in a row, both ways, and is scored, not refused.
    silent = [not any(edge - TAIL_MS < t <= edge for t in frames) for _, edge in legs]
    for way, name in ((0, 'there'), (1, 'back')):
        ways = silent[way::2]
        if ways and sum(ways) >= max(1, math.ceil(0.75 * len(ways))):
            sys.exit(f'{sum(ways)} of {len(ways)} legs going {name} stopped drawing before they ended: '
                     f'the input ran out of page or track; use fewer notches or a shorter drag')
    points = [start, *frames, end]
    gaps = [b - a for a, b in zip(points, points[1:])]
    return dict(frames=len(frames), span_ms=round(end - start), p95_time_ms=round(p95_time(gaps), 1),
                p95_ms=round(p95(gaps), 1), max_ms=round(max(gaps), 1))


def main():
    args = sys.argv[1:]
    if len(args) < 3 or args[2] not in ('scroll', 'drag'):
        sys.exit(__doc__)
    app_id, runs, kind = args[0], int(args[1]), args[2]
    coords = [float(v) for v in args[3:]]
    notches = 8
    if kind == 'scroll' and len(coords) == 3:
        notches = int(coords.pop())
    if len(coords) != (2 if kind == 'scroll' else 4) or notches < 1:
        sys.exit(__doc__)
    windows = [w for w in msg('windows')['windows'] if w['app_id'] == app_id]
    if len(windows) != 1:
        sys.exit(f'{len(windows)} windows of {app_id}: open exactly one, on the page to measure')
    window = windows[0]
    output = next(o for o in msg('outputs')['outputs'] if o['name'] == window['output'])
    results = []
    for i in range(runs):
        r = run_once(window, output, kind, coords, notches)
        print(f'run {i + 1}: {r}', flush=True)
        results.append(r)
        time.sleep(0.5)
    measured = [r['p95_time_ms'] for r in results[1:] if r['p95_time_ms'] is not None]
    if not measured:
        sys.exit('no frames during the input: wrong coordinates, or the window did not draw')
    print(json.dumps(dict(app_id=app_id, kind=kind, runs=runs, **({'notches': notches} if kind == 'scroll' else {}),
                          median_p95_time_ms=statistics.median(measured),
                          median_p95_ms=statistics.median(r['p95_ms'] for r in results[1:] if r['p95_ms']),
                          median_frames=statistics.median(r['frames'] for r in results[1:]))))


if __name__ == '__main__':
    main()
