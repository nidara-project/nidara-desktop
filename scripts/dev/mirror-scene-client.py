#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Isolated probe client, not a desktop implementation or theme.
import os
from pathlib import Path
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk
app = Gtk.Application(application_id='org.nidara.MirrorProbe')
def activate(app):
    window = Gtk.ApplicationWindow(application=app)
    window.set_decorated(False)
    area = Gtk.DrawingArea()
    def draw(_, cr, width, height):
        for x, y, color in [(0, 0, (1, 0, 0)), (1, 0, (0, 1, 0)), (0, 1, (0, 0, 1)), (1, 1, (1, 1, 0))]:
            cr.set_source_rgb(*color)
            cr.rectangle(x * width / 2, y * height / 2, width / 2, height / 2)
            cr.fill()
    area.set_draw_func(draw)
    overlay = Gtk.Overlay(child=area)
    button = Gtk.Button(label='Probe')
    button.set_halign(Gtk.Align.CENTER)
    button.set_valign(Gtk.Align.CENTER)
    button.set_size_request(100, 60)
    def clicked(_):
        with (Path(os.environ['MIRROR_EVIDENCE']) / 'clicks').open('a') as log:
            log.write('clicked\n')
    button.connect('clicked', clicked)
    overlay.add_overlay(button)
    window.set_child(overlay)
    window.fullscreen()
    window.present()
app.connect('activate', activate)
app.run([])
