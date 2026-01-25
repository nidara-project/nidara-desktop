
import os
import sys
import gi

print(f"Python Version: {sys.version}")
print(f"XDG_SESSION_TYPE: {os.environ.get('XDG_SESSION_TYPE', 'Unset')}")
print(f"WAYLAND_DISPLAY: {os.environ.get('WAYLAND_DISPLAY', 'Unset')}")

try:
    gi.require_version('Gtk', '4.0')
    from gi.repository import Gtk
    print("GTK 4.0: OK")
except Exception as e:
    print(f"GTK 4.0: FAIL - {e}")

try:
    gi.require_version('Gtk4LayerShell', '1.0')
    from gi.repository import Gtk4LayerShell
    print("Gtk4LayerShell 1.0: OK")
except Exception as e:
    print(f"Gtk4LayerShell 1.0: FAIL - {e}")
    # Check library paths manually
    print(f"LD_LIBRARY_PATH: {os.environ.get('LD_LIBRARY_PATH', 'Unset')}")
    print(f"GI_TYPELIB_PATH: {os.environ.get('GI_TYPELIB_PATH', 'Unset')}")
