import gi
import os
import sys

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk

def check_icons():
    app = Gtk.Application(application_id='com.angel.debug.icons')
    
    def on_activate(app):
        print("--- GTK Icon Diagnosis ---")
        display = Gdk.Display.get_default()
        theme = Gtk.IconTheme.get_for_display(display)
        
        # 1. Check current search paths
        print("\n[Search Paths]")
        paths = theme.get_search_path()
        for p in paths:
            print(f"  - {p}")
            
        # 2. Add our custom paths (simulate main_dock logic)
        extra_paths = [
            "/var/lib/snapd/desktop/icons",
            "/var/lib/flatpak/exports/share/icons",
            os.path.expanduser("~/.local/share/flatpak/exports/share/icons"),
            "/usr/share/icons",
            "/usr/local/share/icons"
        ]
        print("\n[Adding Extra Paths]")
        for path in extra_paths:
            if os.path.exists(path):
                print(f"  + Adding: {path}")
                theme.add_search_path(path)
            else:
                print(f"  x Missing: {path}")
                
        # 3. Check specific icons
        icons_to_check = [
            "firefox", 
            "org.gnome.Nautilus", 
            "org.gnome.Terminal", 
            "code", 
            "org.telegram.desktop",
            "telegram-desktop", # Fallback check
            "folder" # Control
        ]
        
        print("\n[Icon Lookup]")
        for icon_name in icons_to_check:
            if theme.has_icon(icon_name):
                print(f"  ✅ FOUND: {icon_name}")
            else:
                print(f"  ❌ FAILED: {icon_name}")
                
        app.quit()

    app.connect('activate', on_activate)
    app.run(None)

if __name__ == "__main__":
    check_icons()
