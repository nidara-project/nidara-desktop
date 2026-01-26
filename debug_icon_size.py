import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk, GLib
import os
import sys

class DebugApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='com.debug.icons')

    def do_activate(self):
        win = Gtk.ApplicationWindow(application=self)
        win.set_title("Debug Icons")
        
        box = Gtk.Box(spacing=10)
        win.set_child(box)
        
        # 1. System Icon
        icon_sys = Gtk.Image.new_from_icon_name("org.gnome.nautilus")
        icon_sys.set_pixel_size(28)
        box.append(icon_sys)
        
        # 2. WebApp Icon (Search for one)
        icon_path = None
        base = os.path.expanduser("~/.local/share/icons/hicolor/128x128/apps/")
        if os.path.exists(base):
            for f in os.listdir(base):
                if f.startswith("chrome-") and f.endswith(".png"):
                    icon_path = os.path.join(base, f)
                    break
        
        if icon_path:
            icon_web = Gtk.Image.new_from_file(icon_path)
            icon_web.set_pixel_size(28)
            box.append(icon_web)
        else:
            print("No WebApp icon found for debug")
            icon_web = None

        win.present()
        
        def check_size():
            w1 = icon_sys.get_allocated_width()
            h1 = icon_sys.get_allocated_height()
            
            w2 = icon_web.get_allocated_width() if icon_web else 0
            h2 = icon_web.get_allocated_height() if icon_web else 0
            
            print(f"VVVV_METRICS_START_VVVV")
            print(f"SYSTEM_ICON: {w1}x{h1}")
            print(f"WEBAPP_ICON: {w2}x{h2}")
            print(f"AAAA_METRICS_END_AAAA")
            
            self.quit()

        GLib.timeout_add(1000, check_size)

app = DebugApp()
app.run(None)
