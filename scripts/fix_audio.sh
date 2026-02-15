#!/bin/bash
set -e

# Define paths
REPO_SCRIPT="$HOME/Dev/Distroia/config/wireplumber/scripts/node/state-stream.lua"
USER_CONFIG_DIR="$HOME/.config/wireplumber/scripts/node"
USER_SCRIPT="$USER_CONFIG_DIR/state-stream.lua"

echo "🔧 Applying Audio System Fix (User Space)..."

# Verify source exists
if [ ! -f "$REPO_SCRIPT" ]; then
    echo "❌ Error: Source script not found at $REPO_SCRIPT"
    exit 1
fi

# Create destination directory
mkdir -p "$USER_CONFIG_DIR"

# Symlink the patched script (structural fix)
ln -sf "$REPO_SCRIPT" "$USER_SCRIPT"
echo "✅ Linked patched script to $USER_SCRIPT"

# Restart WirePlumber to apply changes
echo "🔄 Restarting Audio Service..."
systemctl --user restart wireplumber

# Verify status
if systemctl --user is-active --quiet wireplumber; then
    echo "✨ Audio System successfully patched and restarted!"
else
    echo "⚠️ Warning: WirePlumber service is not active."
fi
