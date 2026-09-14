# 2026-09-14 — six settings files → GSettings `org.nidara.*` (#573)
#
# The stores behind these files live in GSettings now (`defineSettings`,
# ui/shell/core/configFile.ts), so the values a user chose are carried over once,
# before the shell reads them. `settings_import` (bin/nidara-migrate) holds the
# rules — what is dropped, what is not imported, and why `gsettings set` is not
# trusted on its own word — and renames each file to `<name>.migrated`, which is
# what makes a second run a no-op and leaves the user's data on disk.

# The dock kept its file in the bare ~/.config/ before it moved under nidara/.
# The shell's own one-time move for it went with this migration, so take the
# legacy file from here when the current one does not exist.
legacy_dock="${XDG_CONFIG_HOME:-$HOME/.config}/dock_settings.json"
if [ ! -f "$CONFIG_DIR/dock_settings.json" ] && [ -f "$legacy_dock" ]; then
    mv -f "$legacy_dock" "$CONFIG_DIR/dock_settings.json" || { warn "could not move $legacy_dock"; return 1; }
fi

settings_import notif-config.json  notifications || return 1
settings_import night-light.json   night-light   || return 1
settings_import bar-settings.json  bar           || return 1
settings_import dock_settings.json dock          || return 1
settings_import workspaces.json    workspaces    || return 1
settings_import recording.json     recording     || return 1
