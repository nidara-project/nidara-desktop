import sys
import os
import json
import threading
import gi

# Ensure we can import from core (if running from project root)
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# GTK Loop needed for X11 Wnck events (even if logic is imported)
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib

# Import wrapper factory
from core.wm.factory import get_window_manager

class MonitorService:
    def __init__(self):
        self.wm = get_window_manager()
        self.wm.set_on_windows_changed(self.on_update)
        self.wm.start_monitoring()

    def on_update(self, windows_list):
        # Dump to stdout for the Dock
        try:
            print(json.dumps(windows_list), flush=True)
        except Exception as e:
            sys.stderr.write(f"Error dumping windows: {e}\n")

    def read_commands(self):
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                cmd = json.loads(line)
                action = cmd.get("action")
                
                if action == "activate":
                    self.wm.activate_window(cmd.get("xid"))
                elif action == "close":
                    self.wm.close_window(cmd.get("xid"))
                    
            except ValueError:
                continue
            except Exception as e:
                sys.stderr.write(f"Error reading command: {e}\n")

if __name__ == "__main__":
    try:
        service = MonitorService()
        
        # Start command listener
        cmd_thread = threading.Thread(target=service.read_commands, daemon=True)
        cmd_thread.start()
        
        # Start Main Loop (Required for Signal Handling in X11/Wnck)
        # In a pure Wayland/Hyprland Thread implementation this might differ,
        # but Gtk.main() is safe for now as `factory` imports Gtk only if needed.
        Gtk.main()
        
    except KeyboardInterrupt:
        pass
