#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Offline regressions for the private classicui screenshot oracle (no compositor)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ime', Path(__file__).with_name('nk-fcitx5-check.py'))
ime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ime)

BG = (209, 255, 217)
BLUE = (0, 128, 255)


class CandidatePixels(unittest.TestCase):
    def image(self, scale=1, moved=0, selection=True, background=True, second=False):
        width, height = round(400*scale), round(240*scale)
        pixels = bytearray(bytes((250, 250, 250))*width*height)
        def rect(box, color):
            x,y,w,h = [round(n*scale) for n in box]
            for row in range(y,y+h):
                start=(row*width+x)*3
                pixels[start:start+w*3] = bytes(color)*w
        # An earlier client accent must not become the candidate pane.
        rect((8,8,40,12), BLUE)
        x,y,w,h = (80+moved,60,100,100)
        if background:
            rect((x,y,w,h), BG)
        if selection:
            rect((x+5,y+25,w-10,18), BLUE)
            # Highlight glyphs are white; ordinary glyphs are black holes.
            rect((x+10,y+28,8,10), (255,255,255))
        rect((x+10,y+65,30,10), (0,0,0))
        if second:
            rect((240,60,100,100), BG)
            rect((245,85,90,18), BLUE)
        root=Path(__file__).resolve().parents[2]/'toolkit/target'
        root.mkdir(parents=True,exist_ok=True)
        folder=tempfile.TemporaryDirectory(prefix='ime-pixels-',dir=root)
        self.addCleanup(folder.cleanup)
        path=Path(folder.name)/'screen.ppm'
        path.write_bytes(f'P6\n{width} {height}\n255\n'.encode()+pixels)
        expected=[round(x*scale),round(y*scale),round((x+w)*scale),round((y+h)*scale)]
        return path, dict(x=0,y=0,width=400,height=240), expected

    def test_whole_pane_isolated_from_the_light_client_and_an_earlier_accent(self):
        for scale in (1,1.25,2):
            path,win,expected=self.image(scale)
            self.assertEqual(ime.candidate_box(path,win,scale,[80*scale,40*scale,81*scale,60*scale]),expected)

    def test_displaced_panel_is_measured_where_it_is_not_clamped_to_the_caret(self):
        path,win,expected=self.image(moved=80)
        box=ime.candidate_box(path,win,1,[80,40,81,60])
        self.assertEqual(box,expected)
        self.assertGreater(abs(box[0]-80),6)

    def test_background_or_client_accent_alone_is_not_a_candidate_pane(self):
        for options in (dict(selection=False),dict(background=False)):
            path,win,_=self.image(**options)
            with self.assertRaises(AssertionError):
                ime.candidate_box(path,win,1,[80,40,81,60])

    def test_two_panes_are_ambiguous_instead_of_choosing_the_one_nearest_the_caret(self):
        path,win,_=self.image(second=True)
        with self.assertRaises(AssertionError):
            ime.candidate_box(path,win,1,[80,40,81,60])


if __name__=='__main__':
    unittest.main()
