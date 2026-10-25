#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Bounded specification checks; these are not native acceptance evidence."""
import unittest
from matrix import OPERATIONS, CONTROLS
from visible import row, contains

class Matrix(unittest.TestCase):
    def test_every_d1_operation_and_time_field_is_present(self):
        kinds = {op.kind for op in OPERATIONS}
        self.assertEqual(kinds, {'toggle', 'radio', 'image', 'gallery', 'file', 'combo', 'slider', 'time', 'font'})
        times = {(op.key, op.part) for op in OPERATIONS if op.kind == 'time'}
        self.assertEqual(times, {(key, part) for key in ['nightlight.scheduleFrom', 'nightlight.scheduleTo'] for part in ['hour', 'minute']})
        self.assertEqual({op.key for op in OPERATIONS if op.kind == 'font'}, {'appearance.interfaceFont', 'appearance.monoFont'})
        self.assertEqual(len({op.id for op in OPERATIONS}), len(OPERATIONS))

    def test_controls_target_baseline_assertions(self):
        assertions = {kind + ':' + op.id for op in OPERATIONS for kind in ['structure', 'apply', 'external', 'speech', 'focus']}
        self.assertTrue(set(CONTROLS.values()) <= assertions)
        self.assertEqual(set(CONTROLS), {'updated', 'apply', 'builder', 'keyboard', 'value-event', 'focus-return'})

class LegacyObservation(unittest.TestCase):
    def test_value_from_another_row_or_hidden_widget_is_not_evidence(self):
        def node(text, x, y, mapped=True, **extra):
            return {'text':text, 'visible':True, 'mapped':mapped,
                    'bounds':{'x':x,'y':y,'w':50,'h':20}, **extra}
        nodes = [node('Temperature',100,100), node('4000 K',300,100),
                 node('4500 K',300,180), node('4500 K',300,100,False)]
        observed = row(nodes, 'Temperature')
        self.assertTrue(contains(observed, 'slider', 4000))
        self.assertFalse(contains(observed, 'slider', 4500))

    def test_boolean_false_is_an_observed_switch_state(self):
        self.assertTrue(contains([{'active':False}], 'toggle', False))
        self.assertFalse(contains([{}], 'toggle', False))

if __name__ == '__main__':
    unittest.main()
