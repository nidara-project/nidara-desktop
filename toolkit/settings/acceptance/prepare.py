#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Install small real choices BEFORE registry enumeration, in the disposable CI home only."""
import os
from pathlib import Path
import shutil

if os.environ.get('NK_SETTINGS_TEST') != 'vkms' or os.environ.get('XDG_RUNTIME_DIR') != '/run/hyalo-smoke':
    raise RuntimeError('only the disposable smoke home may receive acceptance fixtures')
repo = Path(__file__).resolve().parents[3]
home = Path.home()
# ThemeManager uses these standard per-user search paths, not a synthetic enum.
gtk = home / '.local/share/themes/NidaraGate/gtk-4.0'
gtk.mkdir(parents=True, exist_ok=True)
(gtk/'gtk.css').write_text('/* acceptance fixture, foreign GTK theme */\n')
icons = home / '.local/share/icons/NidaraGate'
(icons/'scalable/actions').mkdir(parents=True, exist_ok=True)
(icons/'cursors').mkdir(exist_ok=True)
reference = repo/'ui/shell/assets/icons/nidara/index.theme'
spec = next(line for line in reference.read_text().splitlines() if line.startswith('X-Nidara-Icon-Spec='))
(icons/'index.theme').write_text('[Icon Theme]\nName=NidaraGate\nInherits=nidara,Adwaita,hicolor\n'
                                +spec+'\nDirectories=scalable/actions\n\n[scalable/actions]\nSize=16\nType=Scalable\nContext=Actions\n')
for p in Path('/usr/share/icons').glob('*/cursors/left_ptr'):
    shutil.copyfile(p, icons/'cursors/left_ptr')
    break
else:
    raise RuntimeError('no installed real cursor for alternative cursor theme')
# The registry's gallery must have >=2 actual bundled images. Do not invent a fake catalogue.
print('Prepared real GTK/icon/interface-icon/cursor alternatives before shell registration')
