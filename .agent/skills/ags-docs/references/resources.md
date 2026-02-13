# AGS & Astal Resources

## GJS References
- [gjs-docs.gnome.org](https://gjs-docs.gnome.org/): Official library references for GJS.
- [gjs.guide](https://gjs.guide/): Beginner-friendly guide to GJS and GObject.

## Astal Service Libraries
These are the foundation for system integration in AGS v3:
- **Hyprland**: IPC socket integration.
- **Network**: NetworkManager wrapper.
- **Mpris**: Media player control.
- **Microphone/WirePlumber**: Audio control.
- **Battery**: Upower proxy.
- **Bluetooth**: Bluez control.
- **Notifd**: Notification daemon.
- **Tray**: System tray support.
- **Apps**: Application querying.

**Rule of Thumb**: Always prefer an Astal library over a shell command (e.g., use `astal/mpris` instead of polling `playerctl`).
