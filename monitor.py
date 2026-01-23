import gi
import json
import sys

# Require GTK 3.0 and Wnck 3.0
gi.require_version('Gtk', '3.0')
gi.require_version('Wnck', '3.0')

from gi.repository import Gtk, Wnck, GLib

class WindowMonitor:
    def __init__(self):
        self.screen = Wnck.Screen.get_default()
        
        # We need to force an update to populate the initial list
        self.screen.force_update()

        # Connect signals
        self.screen.connect("window-opened", self.on_window_changed)
        self.screen.connect("window-closed", self.on_window_changed)
        self.screen.connect("active-window-changed", self.on_window_changed)
        
        # Initial dump
        GLib.idle_add(self.dump_windows)

    def on_window_changed(self, screen, window=None):
        self.dump_windows()

    def dump_windows(self):
        # Determine active window XID
        active_window = self.screen.get_active_window()
        active_xid = active_window.get_xid() if active_window else None

        windows_list = []
        for window in self.screen.get_windows():
            window_type = window.get_window_type()
            
            # Filter for normal windows (skip docks, desktops, etc.)
            if window_type == Wnck.WindowType.NORMAL:
                # Wnck might list windows that are "skip_tasklist"
                if window.is_skip_tasklist():
                    continue
                
                app = window.get_class_group_name()
                
                # Priority for icon:
                # 1. Class instance name (res_name) - e.g. "google-chrome", "gnome-terminal-server"
                # 2. Class group name (res_class) - e.g. "Google-chrome", "Gnome-terminal"
                # 3. Wnck App icon name (fallback)
                
                res_name = window.get_class_instance_name()
                res_class = window.get_class_group_name()
                
                # Default
                icon_name = res_name.lower()
                
                # Try to get a better app name if possible
                wnck_app = window.get_application()
                if wnck_app:
                    app_name = wnck_app.get_name()
                else:
                    app_name = res_class or window.get_name()

                windows_list.append({
                    "xid": window.get_xid(),
                    "title": window.get_name(),
                    "app_name": app_name,
                    "icon_name": icon_name, 
                    "is_active": (window.get_xid() == active_xid)
                })

        # Output JSON to stdout
        try:
            print(json.dumps(windows_list), flush=True)
        except Exception as e:
            sys.stderr.write(f"Error dumping windows: {e}\n")

if __name__ == "__main__":
    monitor = WindowMonitor()
    try:
        Gtk.main()
    except KeyboardInterrupt:
        pass
