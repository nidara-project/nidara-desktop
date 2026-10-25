# SPDX-License-Identifier: LGPL-3.0-or-later
"""The operation table of PHASE1 D1, expanded by actual UI control, not just key."""
from dataclasses import dataclass

@dataclass(frozen=True)
class Operation:
    id: str
    key: str
    kind: str
    label: str = ''
    part: str = ''

OPERATIONS = (
    Operation('dark-mode', 'appearance.darkMode', 'toggle'),
    Operation('accent', 'appearance.accent', 'radio', 'settings.appearance.accent'),
    Operation('wallpaper-preview', 'wallpaper.current', 'image'),
    Operation('wallpaper-gallery', 'wallpaper.current', 'gallery'),
    Operation('wallpaper-picker', 'wallpaper.current', 'file', 'settings.appearance.image'),
    Operation('transition', 'wallpaper.transition', 'combo'),
    Operation('window-background', 'appearance.windowBackground', 'radio'),
    Operation('window-controls', 'appearance.windowControls', 'radio'),
    Operation('night-enabled', 'nightlight.enabled', 'toggle'),
    Operation('night-temperature', 'nightlight.temperature', 'slider'),
    Operation('night-schedule', 'nightlight.scheduleEnabled', 'toggle'),
    Operation('from-hour', 'nightlight.scheduleFrom', 'time', part='hour'),
    Operation('from-minute', 'nightlight.scheduleFrom', 'time', part='minute'),
    Operation('to-hour', 'nightlight.scheduleTo', 'time', part='hour'),
    Operation('to-minute', 'nightlight.scheduleTo', 'time', part='minute'),
    Operation('gtk-theme', 'appearance.gtkTheme', 'combo'),
    Operation('icon-theme', 'appearance.iconTheme', 'combo'),
    Operation('interface-icons', 'appearance.interfaceIconTheme', 'combo'),
    Operation('cursor-theme', 'appearance.cursorTheme', 'combo'),
    Operation('interface-font', 'appearance.interfaceFont', 'font', 'settings.appearance.interface-font'),
    Operation('mono-font', 'appearance.monoFont', 'font', 'settings.appearance.mono-font'),
)
# Faults stop at this exact assertion; an earlier failure cannot count as caught.
CONTROLS = {
    'updated': 'external:night-enabled',
    'apply': 'apply:night-enabled',
    'builder': 'structure:wallpaper-preview',
    'keyboard': 'apply:night-enabled',
    'value-event': 'speech:night-temperature',
    'focus-return': 'focus:interface-font',
}
KEYS = frozenset(op.key for op in OPERATIONS)

# Physical evdev codes, through Hyalo's existing seat FIFO; no AT-SPI mutation here.
KEY = {'escape': 1, 'tab': 15, 'enter': 28, 'space': 57, 'home': 102,
       'up': 103, 'left': 105, 'right': 106, 'end': 107, 'down': 108}
