import gi
import os
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk

def check_icon():
    display = Gdk.Display.get_default()
    theme = Gtk.IconTheme.get_for_display(display)
    
    # Add path manually as we did in the dock
    local_icons = os.path.expanduser("~/.local/share/icons")
    theme.add_search_path(local_icons)
    theme.add_search_path(os.path.join(local_icons, "hicolor"))
    
    icon_name = "chrome-gjcmcplpgihbecacndmmbaenpfgimlec-Default"
    
    print(f"Buscando icono: {icon_name}")
    print(f"Rutas de busqueda: {theme.get_search_path()}")
    
    if theme.has_icon(icon_name):
        print("¡EXITO! GTK encuentra el icono.")
    else:
        print("FALLO. GTK no ve el icono.")

    # Check file manually
    path = os.path.expanduser("~/.local/share/icons/hicolor/128x128/apps/" + icon_name + ".png")
    if os.path.exists(path):
        print(f"El archivo fisico SI existe en: {path}")
    else:
        print(f"El archivo fisico NO existe en: {path}")

app = Gtk.Application()
app.connect('activate', lambda app: check_icon())
app.run(None)
