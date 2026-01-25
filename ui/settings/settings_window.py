import gi
import json
import os
import sys
import subprocess

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk, Gio

class SettingsWindow(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app)
        self.set_title("Centro de Control DistroIA")
        self.set_default_size(600, 450)
        
        # Estilo de la ventana
        self.add_css_class("settings-window")
        self.load_css()
        
        # Container principal (Scrollable por si acaso)
        scrolled = Gtk.ScrolledWindow()
        self.set_child(scrolled)
        
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        main_box.set_margin_top(40)
        main_box.set_margin_bottom(40)
        main_box.set_margin_start(40)
        main_box.set_margin_end(40)
        scrolled.set_child(main_box)
        
        # Header
        header_label = Gtk.Label(label="DistroIA Settings")
        header_label.add_css_class("main-title")
        header_label.set_halign(Gtk.Align.START)
        main_box.append(header_label)
        
        # --- SECCIÓN 1: HARDWARE (Ubuntu) ---
        self.add_section_title(main_box, "Hardware y Sistema", "icon-system")
        
        sys_grid = Gtk.Grid()
        sys_grid.set_column_spacing(20)
        sys_grid.set_row_spacing(20)
        
        # Botón grande para abrir GNOME Control Center
        btn_ubuntu = Gtk.Button()
        btn_ubuntu.set_size_request(-1, 80)
        btn_ubuntu.add_css_class("card-button")
        
        btn_content = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=15)
        btn_content.set_halign(Gtk.Align.CENTER)
        
        icon = Gtk.Image.new_from_icon_name("preferences-system")
        icon.set_pixel_size(48)
        
        lbl_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        lbl_box.set_valign(Gtk.Align.CENTER)
        lbl_title = Gtk.Label(label="Ajustes del Sistema")
        lbl_title.add_css_class("card-title")
        lbl_title.set_halign(Gtk.Align.START)
        lbl_desc = Gtk.Label(label="Wi-Fi, Bluetooth, Usuarios, Sonido")
        lbl_desc.add_css_class("card-desc")
        lbl_desc.set_halign(Gtk.Align.START)
        
        lbl_box.append(lbl_title)
        lbl_box.append(lbl_desc)
        
        btn_content.append(icon)
        btn_content.append(lbl_box)
        btn_ubuntu.set_child(btn_content)
        btn_ubuntu.connect("clicked", self.launch_gnome_settings)
        
        main_box.append(btn_ubuntu)
        
        # --- SECCIÓN 2: PERSONALIZACIÓN VISUAL (DistroIA) ---
        self.add_section_title(main_box, "DistroIA Visuals", "icon-brush")
        
        vis_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=15)
        
        # --- Selector de Tema ---
        theme_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=20)
        theme_label = Gtk.Label(label="Tema de Color")
        theme_label.set_hexpand(True)
        theme_label.set_halign(Gtk.Align.START)
        
        self.theme_combo = Gtk.ComboBoxText()
        self.theme_combo.set_valign(Gtk.Align.CENTER)
        self.themes_data = self.load_themes()
        active_id = self.themes_data.get("active_theme", "cyberpunk")
        
        for theme_id in self.themes_data.get("themes", {}).keys():
            self.theme_combo.append(theme_id, theme_id.replace("_", " ").title())
            if theme_id == active_id:
                self.theme_combo.set_active_id(theme_id)
        
        self.theme_combo.connect("changed", self.on_theme_changed)
        theme_row.append(theme_label)
        theme_row.append(self.theme_combo)
        vis_box.append(theme_row)
        
        # Separator
        vis_box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        
        # --- Botones de Acción ---
        actions_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=15)
        
        btn_wall = Gtk.Button(label="Cambiar Fondo")
        btn_wall.connect("clicked", self.open_wallpaper_config)
        actions_row.append(btn_wall)
        
        btn_reload = Gtk.Button(label="Recargar UI")
        btn_reload.add_css_class("destructive-action")
        btn_reload.connect("clicked", self.reload_ui)
        actions_row.append(btn_reload)
        
        vis_box.append(actions_row)
        
        # Envolver en un frame estilizado
        frame = Gtk.Frame()
        frame.set_child(vis_box)
        frame.add_css_class("settings-frame")
        main_box.append(frame)

    def add_section_title(self, box, text, icon_name):
        lbl = Gtk.Label(label=text)
        lbl.add_css_class("section-title")
        lbl.set_halign(Gtk.Align.START)
        box.append(lbl)

    def launch_gnome_settings(self, btn):
        try:
            print("Lanzando GNOME Control Center...")
            env = os.environ.copy()
            env["XDG_CURRENT_DESKTOP"] = "GNOME"
            subprocess.Popen(["gnome-control-center"], env=env)
        except Exception as e:
            print(f"Error: {e}")

    def open_wallpaper_config(self, btn):
        # Por ahora abrimos el editor de texto
        subprocess.Popen(["xdg-open", os.path.expanduser("~/.config/hypr/hyprpaper.conf")])

    def reload_ui(self, btn):
        # Reiniciar de forma limpia y desvinculada (pkill -9 para asegurar muerte)
        cmd = "pkill -9 -f main_dock.py; pkill -9 waybar; sleep 0.8; setsid bash /home/angel/Dev/MiDistroIA/scripts/start_wayland_stack.sh &"
        subprocess.Popen(cmd, shell=True, start_new_session=True)

    def load_themes(self):
        path = os.path.expanduser("~/.config/midistroia/themes.json")
        if os.path.exists(path):
            with open(path, 'r') as f:
                return json.load(f)
        return {"active_theme": "cyberpunk", "themes": {"cyberpunk": {}, "nord": {}, "dracula": {}}}

    def on_theme_changed(self, combo):
        theme_id = combo.get_active_id()
        if theme_id:
            self.themes_data["active_theme"] = theme_id
            path = os.path.expanduser("~/.config/midistroia/themes.json")
            with open(path, 'w') as f:
                json.dump(self.themes_data, f, indent=4)
            # Todo: Aplicar tema real (Postpuesto por ahora)
            

    def load_css(self):
        css = """
        .settings-window {
            background-color: #1e1e2e;
            color: #cdd6f4;
            font-family: 'Segoe UI', sans-serif;
        }
        .main-title {
            font-size: 28px;
            font-weight: 800;
            color: #cba6f7;
            margin-bottom: 10px;
        }
        .section-title {
            font-size: 16px;
            font-weight: bold;
            color: #89b4fa;
            margin-top: 10px;
            margin-bottom: 5px;
            opacity: 0.8;
            text-transform: uppercase;
        }
        .card-button {
            background-color: #313244;
            border-radius: 12px;
            border: 1px solid #45475a;
            transition: all 0.2s;
            padding: 10px;
        }
        .card-button:hover {
            background-color: #45475a;
        }
        .card-title {
            font-weight: bold;
            font-size: 16px;
            color: #ffffff;
        }
        .card-desc {
            font-size: 12px;
            color: #a6adc8;
        }
        .settings-frame {
            background-color: #313244;
            border-radius: 12px;
            padding: 20px;
        }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css.encode('utf-8'))
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

class SettingsApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='com.angel.midistroia.settings')
    
    def do_activate(self):
        win = SettingsWindow(self)
        win.present()

if __name__ == '__main__':
    app = SettingsApp()
    app.run(sys.argv)
