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
        
        # Periodic check for dock positioning (every 2 seconds)
        GLib.timeout_add(2000, self.check_dock_position)
        
        # Initial dump
        GLib.idle_add(self.dump_windows)

    def check_dock_position(self):
        # Usar wmctrl para posicionar el dock (funciona en GNOME)
        import subprocess
        
        # Obtener dimensiones de pantalla
        display_w = self.screen.get_width()
        display_h = self.screen.get_height()
        
        # Tamaño del dock
        dock_w = 700
        dock_h = 80  # Altura aumentada para indicadores
        margin = 40  # Separación del borde inferior
        
        # Calcular posición centrada abajo
        x_pos = (display_w - dock_w) // 2
        y_pos = display_h - dock_h - margin
        
        # Usar wmctrl para mover la ventana
        try:
            # Mover a posición correcta
            subprocess.run([
                'wmctrl', '-r', 'MiDistro Dock', '-e',
                f'0,{x_pos},{y_pos},{dock_w},{dock_h}'
            ], capture_output=True)
            
            # Mantener siempre encima
            subprocess.run([
                'wmctrl', '-r', 'MiDistro Dock', '-b', 'add,above'
            ], capture_output=True)
            
            # Ocultar de la barra de tareas y del dock de Ubuntu
            subprocess.run([
                'wmctrl', '-r', 'MiDistro Dock', '-b', 'add,skip_taskbar,skip_pager'
            ], capture_output=True)
        except Exception as e:
            pass  # Silenciar errores si wmctrl no está instalado
            
        # --- POSICIONAR MENÚ IA SI EXISTE ---
        # Si la ventana "Menu IA" está abierta, colocarla encima del dock
        # Asumimos que queremos centrarla horizontalmente con el dock
        try:
            # Ancho del menú IA (definido en ai_menu.py como 400)
            menu_w = 400
            menu_h = 500
            
            menu_x = (display_w - menu_w) // 2
            menu_y = y_pos - menu_h - 20 # 20px encima del dock
            
            subprocess.run([
                'wmctrl', '-r', 'Menu IA', '-e',
                f'0,{menu_x},{menu_y},{menu_w},{menu_h}'
            ], capture_output=True)
            
            subprocess.run([
                'wmctrl', '-r', 'Menu IA', '-b', 'add,above'
            ], capture_output=True)
            
        except:
            pass
        
        return True  # Seguir ejecutando


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
                    "class_name": res_class.lower() if res_class else res_name.lower(),
                    "icon_name": icon_name, 
                    "is_active": (window.get_xid() == active_xid)
                })

        # Output JSON to stdout
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
                if cmd.get("action") == "activate":
                    self.activate_window(cmd.get("xid"))
            except ValueError:
                continue
            except Exception as e:
                sys.stderr.write(f"Error reading command: {e}\n")

    def activate_window(self, xid):
        # Find window by xid
        for window in self.screen.get_windows():
            if window.get_xid() == xid:
                # Get current timestamp for activation
                now = Gdk.CURRENT_TIME # Gtk3 Gdk
                # Wnck activation needs timestamp
                window.activate(now)
                break

if __name__ == "__main__":
    monitor = WindowMonitor()
    
    # Start command listener thread
    import threading
    cmd_thread = threading.Thread(target=monitor.read_commands, daemon=True)
    cmd_thread.start()
    
    try:
        Gtk.main()
    except KeyboardInterrupt:
        pass
