#!/bin/bash
# Activa Just Perfection y oculta el panel superior de GNOME

EXTENSION_ID="just-perfection-desktop@just-perfection"
EXTENSION_PATH="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_ID"
SCHEMAS_PATH="$EXTENSION_PATH/schemas"

echo "🔧 Compilando esquemas..."
glib-compile-schemas "$SCHEMAS_PATH"

echo "🔌 Habilitando extensión..."
# Habilitar extensión en el sistema
gnome-extensions enable "$EXTENSION_ID"

echo "🙈 Ocultando TopBar nativa..."
# Usar gsettings apuntando al esquema local si no está instalado globalmente
gsettings --schemadir "$SCHEMAS_PATH" set org.gnome.shell.extensions.just-perfection panel false

echo "✨ Configuración aplicada. Si no ves cambios, reinicia GNOME (Alt+F2 -> r) o cierra sesión."
