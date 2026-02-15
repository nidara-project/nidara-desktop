
# 7. Enable Audio Services
echo "🔊 Enabling Audio Services..."
systemctl --user enable --now wireplumber pipewire pipewire-pulse

echo "✅ Provisioning Complete!"
echo "👉 To enable graphical login: sudo systemctl enable --now sddm"
echo "👉 To start manually: Hyprland"
