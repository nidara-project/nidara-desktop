import gi
import json
import os
import sys

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk, Gio

class SettingsWindow(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app)
        self.set_title("Configuración MiDistroIA")
        self.set_default_size(400, 300)
        
        # Estilo de la ventana
        self.add_css_class("settings-window")
        self.load_css()
        
        # Container principal
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20)
        main_box.set_margin_top(30)
        main_box.set_margin_bottom(30)
        main_box.set_margin_start(30)
        main_box.set_margin_end(30)
        self.set_child(main_box)
        
        # Título
        title = Gtk.Label(label="Apariencia y Temas")
        title.add_css_class("settings-title")
        main_box.append(title)
        
        # Selector de tema
        theme_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        theme_label = Gtk.Label(label="Tema:")
        theme_box.append(theme_label)
        
        self.theme_combo = Gtk.ComboBoxText()
        self.themes_data = self.load_themes()
        
        active_id = self.themes_data.get("active_theme", "cyberpunk")
        
        for theme_id in self.themes_data.get("themes", {}).keys():
            self.theme_combo.append(theme_id, theme_id.replace("_", " ").title())
            if theme_id == active_id:
                self.theme_combo.set_active_id(theme_id)
                
        self.theme_combo.connect("changed", self.on_theme_changed)
        theme_box.append(self.theme_combo)
        main_box.append(theme_box)
        
        # Botón cerrar
        close_btn = Gtk.Button(label="Cerrar")
        close_btn.add_css_class("suggested-action")
        close_btn.connect("clicked", lambda x: self.close())
        main_box.append(close_btn)
    
    def load_themes(self):
        path = os.path.expanduser("~/.config/midistroia/themes.json")
        if os.path.exists(path):
            with open(path, 'r') as f:
                return json.load(f)
        return {"active_theme": "cyberpunk", "themes": {}}

    def on_theme_changed(self, combo):
        theme_id = combo.get_active_id()
        if theme_id:
            # Guardar configuración
            self.themes_data["active_theme"] = theme_id
            path = os.path.expanduser("~/.config/midistroia/themes.json")
            with open(path, 'w') as f:
                json.dump(self.themes_data, f, indent=4)
            
            # Reiniciar dock y topbar usando los scripts de arranque robustos
            import subprocess
            dock_script = os.path.expanduser("~/Dev/MiDistroIA/scripts/start_dock.sh")
            topbar_script = os.path.expanduser("~/Dev/MiDistroIA/scripts/start_topbar.sh")
            
            # Usar setsid para que los procesos sobrevivan si cerramos settings
            subprocess.Popen(f"setsid {dock_script}", shell=True)
            subprocess.Popen(f"setsid {topbar_script}", shell=True)

    def load_css(self):
        css = """
        .settings-window {
            background-color: #1e1e2e;
            color: #cdd6f4;
        }
        .settings-title {
            font-size: 20px;
            font-weight: bold;
            color: #cba6f7;
            margin-bottom: 10px;
        }
        button {
            padding: 8px 16px;
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
