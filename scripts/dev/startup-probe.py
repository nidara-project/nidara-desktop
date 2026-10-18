#!/usr/bin/env python3
"""Launch → a window's milestone, from Hyalo's own event stream (toolkit/PHASE1.md, gate 4).

usage: scripts/dev/startup-probe.py [--ready REGEX] APP_ID RUNS -- CMD...

Milestones:
- default — the window's FIRST BUFFER: Hyalo lists a window only once it is mapped
  (ipc/server.rs `window_infos`). Right for a GTK app, whose first buffer is its first full
  frame — the references (the legacy Settings, Nautilus) are measured this way.
- `--ready REGEX` — the later of the first buffer and the first line of the app's stderr
  matching REGEX (the native Settings' `CONTENT_READY`, logged with the commit of the first
  frame holding Appearance with authoritative values).

Each run, in order: the event stream has answered (it is subscribed) BEFORE the launch; a
window of APP_ID already open refuses the run (it would be counted as this launch); the window
counted must belong to the launched process or a descendant (an app that hands the request to
an instance already running is refused, not measured); PSS 2 s after; then only that window is
closed and only the launched process is waited for. The median is of runs 2…N (run 1 warms
the caches).
"""
import json, queue, re, statistics, subprocess, sys, threading, time

args = sys.argv[1:]
ready = None
if args[:1] == ['--ready']:
    ready, args = re.compile(args[1]), args[2:]
app_id, runs = args[0], int(args[1])
cmd = args[args.index('--') + 1:]


def msg(*a):
    return json.loads(subprocess.run(['nidara-hyalo', 'msg', *a], capture_output=True, text=True).stdout)


def descends(pid, root):
    """Whether `pid` is `root` or one of its descendants."""
    while pid and pid > 1:
        if pid == root:
            return True
        try:
            with open(f'/proc/{pid}/stat') as f:
                pid = int(f.read().rsplit(')', 1)[1].split()[1])
        except OSError:
            return False
    return False


def pss(pid):
    try:
        for line in open(f'/proc/{pid}/smaps_rollup'):
            if line.startswith('Pss:'):
                return int(line.split()[1]) // 1024
    except OSError:
        return None


def pump(stream, q):
    threading.Thread(target=lambda: [q.put((time.monotonic(), l)) for l in stream], daemon=True).start()


def one():
    if any(w['app_id'] == app_id for w in msg('windows')['ok']['windows']):
        sys.exit(f'{app_id}: a window is already open — close it first, it would be counted')
    ev = subprocess.Popen(['nidara-hyalo', 'msg', 'events'], stdout=subprocess.PIPE, text=True)
    events = queue.Queue()
    pump(ev.stdout, events)
    try:
        _, first = events.get(timeout=5)       # the stream answers once it is subscribed
    except queue.Empty:
        sys.exit('Hyalo\'s event stream did not answer')
    if 'ok' not in json.loads(first):
        sys.exit(f'Hyalo\'s event stream refused: {first}')
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE if ready else subprocess.DEVNULL, text=True)
    lines = queue.Queue()
    if ready:
        pump(proc.stderr, lines)
    mapped = ready_at = wid = wpid = None
    deadline = t0 + 30
    while time.monotonic() < deadline and not (mapped and (not ready or ready_at)):
        try:
            t, line = events.get(timeout=0.02)
            e = json.loads(line)
            for w in e.get('windows', []) if e.get('event') == 'windows_changed' and not mapped else []:
                if w['app_id'] == app_id and w['width'] > 0 and w['height'] > 0:
                    if not descends(w['pid'], proc.pid):
                        ev.kill()
                        sys.exit(f'{app_id}: window {w["id"]} belongs to pid {w["pid"]}, not to the '
                                 f'launched {proc.pid} — an instance already running?')
                    mapped, wid, wpid = t, w['id'], w['pid']
        except queue.Empty:
            pass
        while ready and not ready_at and not lines.empty():
            t, line = lines.get()
            if ready.search(line):
                ready_at = t
    ev.kill()
    if not mapped or (ready and not ready_at):
        proc.terminate()
        sys.exit(f'{app_id}: no {"ready line and " if ready else ""}mapped window in 30 s')
    end = max(mapped, ready_at or mapped)
    time.sleep(2)
    mem = pss(wpid)
    msg('do', 'close-window', str(wid))
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.terminate()       # ours: the process this run launched, nothing else
        proc.wait(timeout=5)
    return (mapped - t0) * 1000, (end - t0) * 1000, mem


rows = []
for i in range(runs):
    m, e, mem = one()
    rows.append((m, e, mem))
    extra = f'  ready {e:7.0f} ms' if ready else ''
    print(f'run {i+1}: first buffer {m:7.0f} ms{extra}  PSS {mem} MiB', flush=True)
    time.sleep(1.5)
warm = rows[1:] or rows
what = 'ready' if ready else 'first buffer'
mems = [r[2] for r in warm if r[2]]
print(f'{app_id}: median {what} {statistics.median(r[1] for r in warm):.0f} ms '
      f'(min {min(r[1] for r in warm):.0f}, max {max(r[1] for r in warm):.0f}), '
      f'median PSS {statistics.median(mems) if mems else "?"} MiB, {len(warm)} warm runs')
