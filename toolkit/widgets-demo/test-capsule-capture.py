#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Filesystem/metadata guard tests, not native capture acceptance."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from capsule_capture import publish_command, answer_revisions, material_ready, stable_capture


class CaptureGuards(unittest.TestCase):
    def test_command_publish_keeps_old_bytes_until_same_directory_rename(self):
        root = Path(os.environ['NK_CAPTURE_TEST_DIR'])
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            target = Path(directory) / 'backdrop.command'
            target.write_text('white\n')
            original_write, original_replace = Path.write_text, Path.replace
            observed, renames = [], []

            def write(path, value, *args, **kwargs):
                # Interpose a reader while a real file is only half written.
                original_write(path, value[:len(value)//2], *args, **kwargs)
                observed.append(target.read_text())
                return original_write(path, value, *args, **kwargs)

            def replace(path, destination):
                self.assertEqual(path.parent, destination.parent)
                self.assertNotEqual(path, destination)
                self.assertEqual(target.read_text(), 'white\n')
                self.assertEqual(path.read_text(), 'dark\n')
                renames.append((path, destination))
                return original_replace(path, destination)

            with patch.object(Path, 'write_text', write), patch.object(Path, 'replace', replace):
                publish_command(target, 'dark\n')
            self.assertEqual(observed, ['white\n'], 'reader saw a partial command before publication')
            self.assertEqual(len(renames), 1, 'command was not published by rename')
            self.assertEqual(target.read_text(), 'dark\n')

    def test_pending_write_error_preserves_visible_command(self):
        root = Path(os.environ['NK_CAPTURE_TEST_DIR'])
        with tempfile.TemporaryDirectory(dir=root) as directory:
            target = Path(directory) / 'backdrop.command'
            target.write_text('white\n')
            with patch.object(Path, 'write_text', side_effect=OSError('write failed')):
                with self.assertRaises(OSError):
                    publish_command(target, 'dark\n')
            self.assertEqual(target.read_text(), 'white\n')

    def test_capture_rejects_revision_change_during_screenshot(self):
        answer = {'revision': 7, 'shapes': [{'measured': True, 'settled': True, 'r': 1.}]}
        first = {'layers': [dict(x=x, y=4, width=40, height=24, answers=copy.deepcopy(answer))
                           for x in (4, 80)], 'controls_answers': copy.deepcopy(answer)}
        last = copy.deepcopy(first)
        last['layers'][0]['answers']['revision'] = 8
        order = []
        reads = iter([first, last])
        def read():
            order.append('read')
            return next(reads)
        def screenshot():
            order.append('screenshot')
        self.assertIsNone(stable_capture(read, screenshot, 1.),
                          'revision advanced while capturing but screenshot was accepted')
        self.assertEqual(order, ['read', 'screenshot', 'read'])
        reads = iter([first, copy.deepcopy(first)])
        self.assertIsNotNone(stable_capture(read, screenshot, 1.))
        last = copy.deepcopy(first)
        last['layers'][0]['answers']['shapes'][0]['settled'] = False
        reads = iter([first, last])
        self.assertIsNone(stable_capture(read, screenshot, 1.), 'capture became unsettled')
        order.clear()
        self.assertIsNone(stable_capture(lambda: last, screenshot, 1.))
        self.assertEqual(order, [], 'captured before the first ready answer')

    def test_revision_must_advance_on_every_panel_before_settled_is_accepted(self):
        # Explicit synthetic metadata exercises only the guard, not a compositor.
        answer = {'revision': 7, 'shapes': [{'measured': True, 'settled': True, 'r': 1.}]}
        window = {'layers': [dict(x=x, y=4, width=40, height=24, answers=copy.deepcopy(answer))
                             for x in (4, 80)], 'controls_answers': copy.deepcopy(answer)}
        before = answer_revisions(window)
        self.assertTrue(material_ready(window, 1.))
        self.assertFalse(material_ready(window, 1., before), 'stale settled answers accepted')
        for layer in window['layers']:
            layer['answers']['revision'] += 1
        self.assertFalse(material_ready(window, 1., before), 'stale server answer accepted')
        window['controls_answers']['revision'] += 1
        window['layers'][0]['answers']['shapes'][0]['settled'] = False
        self.assertFalse(material_ready(window, 1., before), 'unsettled fresh answer accepted')
        window['layers'][0]['answers']['shapes'][0]['settled'] = True
        self.assertTrue(material_ready(window, 1., before))
        self.assertFalse(material_ready(window, 0., before), 'wrong external stimulus accepted')
        del window['layers'][0]['answers']['revision']
        self.assertFalse(material_ready(window, 1., before), 'missing revision accepted')


if __name__ == '__main__':
    unittest.main()
