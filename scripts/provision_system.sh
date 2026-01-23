#!/bin/bash
# MiDistroIA - Provisioning Script (ISO Edition)
# Automates the setup of the environment for the ISO custom build.

set -e

# Support for Chroot (ignore sudo if not present)
SUDO=""
if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi

# 1. System Dependencies
echo "📦 Installing system dependencies..."
$SUDO apt update
$SUDO apt install -y software-properties-common
$SUDO add-apt-repository -y universe
$SUDO apt update

$SUDO apt install -y \
    python3-gi \
    python3-gi-cairo \
    gir1.2-gtk-4.0 \
    wmctrl \
    x11-utils \
    network-manager \
    upower \
    pulseaudio-utils \
    flameshot \
    nautilus \
    git \
    ripgrep \
    fd-find \
    wget \
    gpg

# 1.0.1 Locales (Fix for Spanish support)
echo "🌐 Generating locales..."
$SUDO apt install -y locales
$SUDO locale-gen es_ES.UTF-8
$SUDO update-locale LANG=es_ES.UTF-8 LC_ALL=es_ES.UTF-8

# 1.0.2 UI Dependencies (Fix for missing menus/icons)
echo "🎨 Installing UI themes and dependencies..."
$SUDO apt install -y \
    adwaita-icon-theme-full \
    yaru-theme-icon \
    libgtk-3-dev \
    libgtk-4-dev \
    libgirepository1.0-dev

# 1.1 Install Google Chrome
if ! command -v google-chrome-stable >/dev/null 2>&1; then
    echo "🌐 Installing Google Chrome..."
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | $SUDO gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | $SUDO tee /etc/apt/sources.list.d/google-chrome.list
    $SUDO apt update
    $SUDO apt install -y google-chrome-stable
fi

# 2. Setup Skeleton (for any new user in the future)
echo "📁 Setting up system skeleton (/etc/skel)..."
SKEL="/etc/skel"
mkdir -p "$SKEL/Dev/MiDistroIA"
mkdir -p "$SKEL/.config/autostart"
mkdir -p "$SKEL/.config/gtk-4.0"

# Copy project to /opt for persistence and easy reference
echo "🚚 Copying project to /opt/midistroia..."
PROJECT_ROOT=$(realpath "$(dirname "$0")/..")
rm -rf /opt/midistroia
cp -r "$PROJECT_ROOT" /opt/midistroia

# Link from skel/Dev to /opt (or copy if preferred, here we copy to allow independent changes)
cp -r /opt/midistroia/* "$SKEL/Dev/MiDistroIA/"

# 3. Autostart Configuration in Skel
echo "🚀 Configuring autostart in /etc/skel..."
cat <<EOF > "$SKEL/.config/autostart/midistroia-shell.desktop"
[Desktop Entry]
Type=Application
Name=MiDistroIA Shell
Exec=bash -c "sleep 2; \$HOME/Dev/MiDistroIA/scripts/start_all.sh"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF

# 4. Global CSS Stylization in Skel
echo "🎨 Applying global stylization to /etc/skel..."
cp /opt/midistroia/ui/global.css "$SKEL/.config/gtk-4.0/gtk.css"

# 5. Create start_all utility in the project folder
echo "🛠️ Ensuring start_all utility is ready..."
cat <<EOF > /opt/midistroia/scripts/start_all.sh
#!/bin/bash
# Master launcher for MiDistroIA
/opt/midistroia/scripts/start_dock.sh &
/opt/midistroia/scripts/start_topbar.sh &
EOF
chmod +x /opt/midistroia/scripts/start_all.sh

# Ensure the skel version also has it
cp /opt/midistroia/scripts/start_all.sh "$SKEL/Dev/MiDistroIA/scripts/start_all.sh"

echo "✅ ISO Provisioning complete. You can now finalize the build in Cubic."
