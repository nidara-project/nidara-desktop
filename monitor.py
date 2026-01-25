import sys
import os
import json
import threading
import gi

# Ensure we can import from core (if running from project root)
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

from datetime import datetime

# Detect session type
SESSION_TYPE = os.environ.get('XDG_SESSION_TYPE', 'x11').lower()

# GTK Loop only needed for X11 Wnck events
Gtk = None
GLib = None

if SESSION_TYPE == 'x11':
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, GLib

# Import wrapper factory
from core.wm.factory import get_window_manager

class MonitorService:
    def __init__(self):
        with open("/tmp/monitor_boot.log", "a") as f:
            f.write(f"MonitorService INIT at {datetime.now()}\n")
        try:
            self.wm = get_window_manager()
            self.wm.set_on_windows_changed(self.on_update)
            self.wm.start_monitoring()
            sys.stderr.write(f"MonitorService started with backend: {self.wm.__class__.__name__}\n")
        except Exception as e:
            sys.stderr.write(f"CRITICAL: Failed to initialize WindowManager backend: {e}\n")
            # Fallback a lista vacía para no matar el proceso padre
            self.wm = None

    def on_update(self, windows_list):
        # Dump to stdout for the Dock
        try:
            output = json.dumps(windows_list)
            print(output, flush=True)
            # Log adicional para auditoría
            with open("/tmp/monitor_standalone.log", "a") as f:
                f.write(f"UPDATE: {len(windows_list)} windows\n")
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
        
        # Start Main Loop
        if SESSION_TYPE == 'x11' and Gtk:
            Gtk.main()
        else:
            import time
            while True:
                time.sleep(10)
        
    except KeyboardInterrupt:
        pass
