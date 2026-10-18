#!/usr/bin/env python3
"""Launch → first buffer of a toplevel, from Hyalo's own event stream.

usage: scripts/dev/startup-probe.py APP_ID RUNS -- CMD...
For each run: start `msg events`, spawn CMD, wait for the window with APP_ID to be
created and then to carry its first buffer (width > 0 in WindowInfo), record both
times; measure PSS of the window's process 2 s later; close it; wait for the
process to exit.
"""
import json, os, subprocess, sys, time, statistics, threading, queue

app_id, runs = sys.argv[1], int(sys.argv[2])
cmd = sys.argv[sys.argv.index('--') + 1:]

def msg(*a):
    return json.loads(subprocess.run(['nidara-hyalo', 'msg', *a], capture_output=True, text=True).stdout)

def pss(pid):
    try:
        for line in open(f'/proc/{pid}/smaps_rollup'):
            if line.startswith('Pss:'):
                return int(line.split()[1]) // 1024
    except OSError:
        return None

def one():
    ev = subprocess.Popen(['nidara-hyalo', 'msg', 'events'], stdout=subprocess.PIPE, text=True)
    q = queue.Queue()
    threading.Thread(target=lambda: [q.put((time.monotonic(), l)) for l in ev.stdout], daemon=True).start()
    time.sleep(0.3)
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    created = mapped = wid = wpid = None
    deadline = t0 + 30
    while mapped is None and time.monotonic() < deadline:
        try:
            t, line = q.get(timeout=0.5)
        except queue.Empty:
            continue
        e = json.loads(line)
        if e.get('event') != 'windows_changed':
            continue
        for w in e['windows']:
            if w['app_id'] == app_id:
                if created is None:
                    created, wid, wpid = t, w['id'], w['pid']
                if w['width'] > 0 and w['height'] > 0:
                    mapped = t
    ev.kill()
    if mapped is None:
        raise SystemExit(f'{app_id}: no mapped window in 30 s')
    time.sleep(2)
    mem = pss(wpid)
    msg('do', 'close-window', str(wid))
    for _ in range(100):
        if proc.poll() is not None and not os.path.exists(f'/proc/{wpid}'):
            break
        time.sleep(0.1)
    else:
        os.kill(wpid, 15)  # our own child's process only
        time.sleep(0.5)
    return (created - t0) * 1000, (mapped - t0) * 1000, mem

rows = []
for i in range(runs):
    c, m, mem = one()
    rows.append((c, m, mem))
    print(f'run {i+1}: created {c:7.0f} ms  first buffer {m:7.0f} ms  PSS {mem} MiB', flush=True)
    time.sleep(1.5)
warm = rows[1:] or rows   # the first run warms the caches
print(f'{app_id}: median first buffer {statistics.median(r[1] for r in warm):.0f} ms '
      f'(min {min(r[1] for r in warm):.0f}, max {max(r[1] for r in warm):.0f}), '
      f'median PSS {statistics.median(r[2] for r in warm if r[2]) if any(r[2] for r in warm) else "?"} MiB, '
      f'{len(warm)} warm runs')
