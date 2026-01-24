#!/bin/bash
# Script para reemplazar componentes por defecto de Ubuntu con MiDistro

echo "🔄 Reconfigurando componentes del escritorio..."

# 1. Deshabilitar Ubuntu Dock
# El dock de Ubuntu es una extensión de GNOME Shell.
# Para deshabilitarlo, necesitamos usar gsettings o gnome-extensions tool.

# Método A: GSettings (Usuario actual)
echo "🚫 Deshabilitando Ubuntu Dock (Dash to Dock)..."
gnome-extensions disable ubuntu-dock@ubuntu.com
gnome-extensions disable ding@rastersoft.com # Desktop Icons NG (para gestionar escritorio nosotros si quisiéramos)

# Método B: System-Wide (para la ISO)
# Esto requiere crear un override en /usr/share/glib-2.0/schemas/
# Lo simulamos aquí creando el archivo en system_root

mkdir -p $HOME/Dev/MiDistroIA/system_root/usr/share/glib-2.0/schemas/

cat <<EOF > $HOME/Dev/MiDistroIA/system_root/usr/share/glib-2.0/schemas/99_midistro_dock_override.gschema.override
[org.gnome.shell]
enabled-extensions=['user-theme@gnome-shell-extensions.gcampax.github.com']
disabled-extensions=['ubuntu-dock@ubuntu.com', 'ding@rastersoft.com']

[org.gnome.shell.extensions.dash-to-dock]
dock-fixed=false
autohide=true
EOF

echo "✅ Configuración guardada en system_root."
echo "⚠️ Nota: Para aplicar los cambios en la sesión actual, reinicia GNOME (Alt+F2 -> r) o cierra sesión."
