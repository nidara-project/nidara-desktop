import gi
import time
gi.require_version('Gtk', '3.0')
gi.require_version('Wnck', '3.0')
from gi.repository import Gtk, Wnck, GLib

def dump_info():
    screen = Wnck.Screen.get_default()
    screen.force_update()
    
    # We need to wait a bit for events to populate? 
    # Wnck sometimes needs the main loop to run a bit.
    
    for window in screen.get_windows():
        if window.get_window_type() != Wnck.WindowType.NORMAL:
            continue
            
        print("-" * 40)
        print(f"Title: {window.get_name()}")
        print(f"Class Group Name (res_class): {window.get_class_group_name()}")
        print(f"Class Instance Name (res_name): {window.get_class_instance_name()}")
        
        app = window.get_application()
        if app:
             print(f"App Name: {app.get_name()}")
             print(f"App Icon Name: {app.get_icon_name()}")
        else:
             print("No Wnck Application found")
             
    Gtk.main_quit()

if __name__ == "__main__":
    GLib.timeout_add(1000, dump_info)
    Gtk.main()
