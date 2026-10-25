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
an instance already running is refused, not measured); PSS 5 s after; then only that window is
closed and only the launched process is waited for. The median is of runs 2…N (run 1 warms
the caches).
"""
import argparse, hashlib, json, pathlib, queue, re, shutil, statistics, subprocess, sys, threading, time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--ready', help='stderr regex for the authoritative content milestone')
parser.add_argument('--json', type=pathlib.Path, help='write samples and environment to this report')
parser.add_argument('app_id')
parser.add_argument('runs', type=int)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
if args.runs < 2:
    parser.error('at least two runs are needed to exclude the warm-up')
cmd = args.command[1:] if args.command[:1] == ['--'] else args.command
if not cmd:
    parser.error('provide a command after --')
ready = re.compile(args.ready) if args.ready else None
app_id, runs = args.app_id, args.runs


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
                return int(line.split()[1]) / 1024
    except OSError:
        return None


def pump(stream, q):
    threading.Thread(target=lambda: [q.put((time.monotonic(), l)) for l in stream], daemon=True).start()


def stop_child(proc):
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def one():
    if any(w['app_id'] == app_id for w in msg('windows')['ok']['windows']):
        sys.exit(f'{app_id}: a window is already open — close it first, it would be counted')
    ev = subprocess.Popen(['nidara-hyalo', 'msg', 'events'], stdout=subprocess.PIPE, text=True)
    events = queue.Queue()
    pump(ev.stdout, events)
    try:
        _, first = events.get(timeout=5)       # the stream answers once it is subscribed
    except queue.Empty:
        stop_child(ev)
        sys.exit('Hyalo\'s event stream did not answer')
    if 'ok' not in json.loads(first):
        stop_child(ev)
        sys.exit(f'Hyalo\'s event stream refused: {first}')
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE if ready else subprocess.DEVNULL, text=True)
    lines = queue.Queue()
    if ready:
        pump(proc.stderr, lines)
    errors = []
    mapped = ready_at = wid = wpid = None
    deadline = t0 + 30
    while time.monotonic() < deadline and not (mapped and (not ready or ready_at)):
        try:
            t, line = events.get(timeout=0.02)
            e = json.loads(line)
            for w in e.get('windows', []) if e.get('event') == 'windows_changed' and not mapped else []:
                if w['app_id'] == app_id and w['width'] > 0 and w['height'] > 0:
                    if not descends(w['pid'], proc.pid):
                        stop_child(ev)
                        stop_child(proc)
                        sys.exit(f'{app_id}: window {w["id"]} belongs to pid {w["pid"]}, not to the '
                                 f'launched {proc.pid} — an instance already running?')
                    mapped, wid, wpid = t, w['id'], w['pid']
        except queue.Empty:
            pass
        while ready and not ready_at and not lines.empty():
            t, line = lines.get()
            errors.append(line.rstrip())
            if ready.search(line):
                ready_at = t
    stop_child(ev)
    if not mapped or (ready and not ready_at):
        if wid is not None:
            msg('do', 'close-window', str(wid))
        stop_child(proc)
        error = f'{app_id}: no {"ready line and " if ready else ""}mapped window in 30 s; stderr: {errors[-20:]}'
        if args.json:
            args.json.parent.mkdir(parents=True, exist_ok=True)
            args.json.write_text(json.dumps({'error': error, 'samples': rows,
                'gate4_complete': False}, indent=2) + '\n')
        sys.exit(error)
    end = max(mapped, ready_at or mapped)
    time.sleep(5)
    mem = pss(wpid)
    msg('do', 'close-window', str(wid))
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        stop_child(proc)       # ours: the process this run launched, nothing else
    return (mapped - t0) * 1000, (end - t0) * 1000, mem


rows = []
for i in range(runs):
    m, e, mem = one()
    rows.append((m, e, mem))
    extra = f'  ready {e:7.0f} ms' if ready else ''
    print(f'run {i+1}: first buffer {m:7.0f} ms{extra}  PSS {mem if mem is None else round(mem, 2)} MiB', flush=True)
    time.sleep(1.5)
warm = rows[1:] or rows
what = 'ready' if ready else 'first buffer'
mems = [r[2] for r in warm if r[2]]
print(f'{app_id}: median {what} {statistics.median(r[1] for r in warm):.0f} ms '
      f'(min {min(r[1] for r in warm):.0f}, max {max(r[1] for r in warm):.0f}), '
      f'median PSS {round(statistics.median(mems), 2) if mems else "?"} MiB, {len(warm)} warm runs')

if args.json:
    executable = shutil.which(cmd[0])
    report = {
        'app_id': app_id, 'command': cmd, 'ready_regex': args.ready,
        'settle_seconds': 5, 'excluded_warmup_runs': 1,
        'executable': executable,
        'sha256': hashlib.sha256(pathlib.Path(executable).read_bytes()).hexdigest() if executable else None,
        'samples': [{'first_buffer_ms': m, 'ready_ms': e, 'pss_mib': mem} for m, e, mem in rows],
        'median_ready_ms': statistics.median(r[1] for r in warm),
        'median_pss_mib': statistics.median(mems) if mems else None,
        'installed_build_verified': False,
        'thresholds': {'ready_ms_lt': 473, 'pss_mib_lt': 157},
        'startup_below_threshold': statistics.median(r[1] for r in warm) < 473,
        'pss_below_threshold': statistics.median(mems) < 157 if len(mems) == len(warm) else None,
        'gate4_complete': False,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + '\n')
