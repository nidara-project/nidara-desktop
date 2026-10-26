#!/usr/bin/env python3
"""Launcher contracts on fake siblings/dev hosts; never starts the desktop."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class Launchers(unittest.TestCase):
    def setUp(self):
        parent = ROOT / 'toolkit/target'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='launchers-', dir=parent)
        self.root = Path(self.temp.name)
        self.env = os.environ | {'XDG_CONFIG_HOME': str(self.root/'config'),
                                 'XDG_CACHE_HOME': str(self.root/'cache')}
        self.env.pop('NIDARA_SETTINGS_REPO', None)
        self.env.pop('NIDARA_SETTINGS_EXECUTABLE', None)
        self.env.pop('NIDARA_SETTINGS_LEGACY', None)

    def tearDown(self):
        self.temp.cleanup()

    def script(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/bash\nset -eu\n' + body)
        path.chmod(0o755)
        return path

    def run_script(self, path, env):
        process = subprocess.Popen([str(path), 'page', 'a b 日本'], env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, err)
        return out.splitlines()

    def test_public_runs_the_dev_native_entry_point_and_preserves_arguments(self):
        repo = self.root/'repo'
        self.script(repo/'toolkit/target/release/nk-settings',
                    'printf "%s\\n" "$NK_SETTINGS_LEGACY" "$GDK_BACKEND" "$@"\n')
        self.assertEqual(self.run_script(ROOT/'bin/nidara-settings', self.env | {'NIDARA_SETTINGS_REPO':str(repo)}),
                         [str(repo/'bin/nidara-settings-legacy'), 'wayland', '--entry-point', 'page', 'a b 日本'])

    def test_public_executable_override_runs_directly(self):
        public = self.root/'nidara-settings'
        shutil.copy2(ROOT/'bin/nidara-settings', public)
        override = self.script(self.root/'override', 'printf "%s\\n" "$NIDARA_SETTINGS_PROCESS" "$@"\n')
        self.assertEqual(self.run_script(public, self.env | {'NIDARA_SETTINGS_EXECUTABLE':str(override)}),
                         ['1', 'page', 'a b 日本'])

    def test_direct_gjs_defaults_legacy_but_accepts_public_identity(self):
        repo = self.root/'repo'
        for file in ['ui/settings/app.ts', 'scripts/bundle.mjs', 'scripts/bundle.sh']:
            path = repo/file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        self.script(repo/'lib/nidara-host/build/nidara-settings', 'printf "%s\\n" "$NIDARA_SETTINGS_LEGACY" "$@"\n')
        cache = self.root/'cache/nidara/dev-settings'
        cache.mkdir(parents=True)
        (cache/'nidara-settings.js').touch()
        revision = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'],
                                  capture_output=True, text=True).stdout.strip() or 'none'
        (cache/'stamp').write_text(revision)
        env = self.env | {'NIDARA_SETTINGS_REPO':str(repo),
                          'NIDARA_SETTINGS_EXECUTABLE':'/must-not-run',
                          'NIDARA_GTK4_LAYER_SHELL':'/dev/null'}
        for identity in ['1', '0']:
            output = self.run_script(ROOT/'bin/nidara-settings-legacy', env if identity == '1' else env | {'NIDARA_SETTINGS_LEGACY':'0'})
            self.assertEqual(output, [identity, str(cache/'nidara-settings.js'), 'page', 'a b 日本'])

if __name__ == '__main__':
    unittest.main()
