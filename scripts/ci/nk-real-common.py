#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Shared private-compositor helpers for the #832/#835 prerequisite probes.

This is deliberately not the complete phase-0 matrix. A failed prerequisite is
reported as a failure; subsequent requirements remain explicitly NOT RUN.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
BIN = os.environ.get('NK_PHASE0_BIN', str(ROOT / 'toolkit/target/release/nk-phase0'))
MSG = [os.environ.get('HYALO_BIN', str(ROOT / 'hyalo/target/release/nidara-hyalo')), 'msg']


def wait(predicate, label, seconds=8):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = predicate()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError(label)


class Probe:
    def __init__(self, name):
        # Both the live desktop's bus and compositor must stay out of this test.
        if os.environ.get('NK_PHASE0_TEST') != 'vkms':
            run = Path(os.environ['NK_PHASE0_RUN']).resolve()
            runtime = Path(os.environ['XDG_RUNTIME_DIR']).resolve()
            assert runtime == run / 'runtime', 'use toolkit/phase0/check-headless.sh'
        else:
            assert os.environ['XDG_RUNTIME_DIR'] == '/run/hyalo-smoke', 'private CI runtime required'
        self.pipe = open(os.environ['HYALO_CONTROL'], 'w', buffering=1)
        self.log = Path(os.environ['NK_PHASE0_LOG']).resolve() / name
        self.log.mkdir(parents=True, exist_ok=True)
        self.procs = []
        self.streams = []
        self.rows = []
        self.original_workspace = next(w['id'] for w in self.msg('workspaces')['workspaces'] if w['focused'])
        self.msg('do', 'workspace', 96)
        self.msg('do', 'set-workspace-mode', 96, 'floating')
        for key, directory in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                               ('XDG_CACHE_HOME', 'cache'), ('XDG_STATE_HOME', 'state')]:
            path = self.log / directory
            path.mkdir(exist_ok=True)
            os.environ[key] = str(path)
        os.environ['LC_ALL'] = 'C.UTF-8'
        # Config stays private, and no activation delegates writes to live dconf.
        os.environ['GSETTINGS_BACKEND'] = 'keyfile'
        self.environment = {
            'client_sha256': hashlib.sha256(Path(BIN).read_bytes()).hexdigest(),
            'compositor_sha256': hashlib.sha256(Path(MSG[0]).read_bytes()).hexdigest(),
            'revision': subprocess.check_output(['git', '-c', 'safe.directory=*', '-C', str(ROOT),
                                                 'rev-parse', 'HEAD'], text=True).strip(),
            'package_overlay': Path(os.environ['NK_PREFLIGHT_PACKAGE_MANIFEST']).read_text() if os.environ.get('NK_PREFLIGHT_PACKAGE_MANIFEST') else None,
            'atspi': subprocess.check_output(['pkg-config', '--modversion', 'atspi-2'], text=True).strip(),
        }

    def msg(self, *args):
        return json.loads(subprocess.check_output([*MSG, *map(str, args)], timeout=10))['ok']

    def control(self, command, pause=.15):
        self.pipe.write(command + '\n')
        self.pipe.flush()
        time.sleep(pause)

    def key(self, code):
        self.control(f'key {code}')

    def chord(self, modifiers, code):
        for mod in modifiers:
            self.control(f'keydown {mod}', .03)
        self.key(code)
        for mod in reversed(modifiers):
            self.control(f'keyup {mod}', .03)

    def start(self, argv, path, env=None, **kwargs):
        stream = path.open('w')
        self.streams.append(stream)
        proc = subprocess.Popen(argv, stdout=stream, stderr=subprocess.STDOUT, env=env, **kwargs)
        self.procs.append(proc)
        return proc

    def stop(self, proc):
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    def row(self, step, passed, why='', **details):
        status = 'PASS' if passed else 'FAIL'
        self.rows.append(dict(step=step, status=status, why=why, **details))
        print(f'{status} {step}: {why}', flush=True)

    def save(self, pending):
        report = dict(environment=self.environment, rows=self.rows,
                      not_run=pending, complete_matrix=False)
        (self.log / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        lines = ['| Baseline assertion | Result | Reason |', '| --- | --- | --- |']
        for row in self.rows:
            reason = row['why'].replace('|', '\\|').replace('\n', ' ')
            lines.append(f"| {row['step']} | {row['status']} | {reason} |")
        lines += ['', 'Requirements still pending:', '']
        lines += ['- ' + step for step in pending]
        for step in pending:
            print('PENDING: ' + step, flush=True)
        summary = '\n'.join(lines) + '\n'
        (self.log / 'summary.md').write_text(summary)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
                stream.write(summary)

    def close(self):
        for proc in reversed(self.procs):
            self.stop(proc)
        for stream in self.streams:
            stream.close()
        self.msg('do', 'workspace', self.original_workspace)
        self.pipe.close()
