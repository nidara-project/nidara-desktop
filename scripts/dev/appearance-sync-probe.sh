#!/usr/bin/env bash
# appearance-sync-probe.sh — an appearance change from a second process: are the desktop's
# side effects done once, and only by the shell? (#571)
#
#   scripts/dev/appearance-sync-probe.sh            the real split: expect every effect ×1, all from the shell
#   CONTROL=1 scripts/dev/appearance-sync-probe.sh  the "Settings" process ALSO starts the sync:
#                                                   the probe must report duplicates
#   SOLO=1 scripts/dev/appearance-sync-probe.sh     today's shape: ONE process with the sync drives
#                                                   the setters itself — expect every effect ×1
#
# Two gjs processes under a headless `cage` (a real Wayland display, nothing on screen):
#   shell     — ThemeManager + AppearanceSync
#   settings  — ThemeManager only, flips mode, accent, cursor and glass opacity
# Attribution: fake `hyprctl` and `systemctl` on PATH log their parent PID; "settings" gets
# its own HOME, XDG_CONFIG_HOME and greeter-mirror dir (its dconf dir is a SYMLINK to the
# shell's, so both read one database), so any file it wrote lands where the probe can see.
# Private bus with env on the daemon's command line + dconf canary; schema from this checkout.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d -t nidara-appearance-sync-XXXXXX)"
cleanup() { rm -rf "$work" 2>/dev/null || { sleep 0.5; rm -rf "$work"; }; }
trap cleanup EXIT
mkdir -p "$work"/{bin,runtime,schemas,shell/home,shell/config,shell/mirror,settings/home,settings/config,settings/mirror}
chmod 700 "$work/runtime"
ln -s "$work/shell/config/dconf" "$work/settings/config/dconf"
cp "$repo"/config/gsettings/*.gschema.xml "$work/schemas/" && glib-compile-schemas "$work/schemas"
"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/appearance-sync-probe.ts" "$work/probe.js" >/dev/null 2>&1

for tool in hyprctl systemctl; do
cat > "$work/bin/$tool" <<FAKE
#!/usr/bin/env bash
echo "\$PPID $tool \$*" >> "$work/calls.log"
case "\$*" in *getoption*) echo '{"int": 0, "set": false}' ;; *) echo ok ;; esac
FAKE
chmod +x "$work/bin/$tool"
done

role_env() {  # $1 = shell|settings
  echo HOME="$work/$1/home" XDG_CONFIG_HOME="$work/$1/config" NIDARA_GREETER_MIRROR_DIR="$work/$1/mirror"
}
settings_role=settings; [ -n "${CONTROL:-}${SOLO:-}" ] && settings_role=settings-with-sync

env -u DBUS_SESSION_BUS_ADDRESS -u HYPRLAND_INSTANCE_SIGNATURE -u WAYLAND_DISPLAY -u DISPLAY \
  PATH="$work/bin:$PATH" XDG_RUNTIME_DIR="$work/runtime" XDG_CONFIG_HOME="$work/shell/config" HOME="$work/shell/home" \
  GSETTINGS_SCHEMA_DIR="$work/schemas" GIO_USE_VFS=local NIDARA_SHELL_ROOT="$repo/ui/shell" \
  work="$work" settings_role="$settings_role" SOLO="${SOLO:-}" \
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
  dbus-run-session -- cage -- bash -c '
set -uo pipefail
dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/shell/config/dconf/user" ] || { echo "ABORT dconf canary"; exit 1; }
gsettings set org.gnome.desktop.interface cursor-theme Adwaita
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gsettings set org.gnome.desktop.interface accent-color blue
if [ -z "$SOLO" ]; then
  env HOME="$work/shell/home" XDG_CONFIG_HOME="$work/shell/config" NIDARA_GREETER_MIRROR_DIR="$work/shell/mirror" \
    gjs -m "$work/probe.js" shell > "$work/shell.log" 2>&1 & shell=$!
  sleep 2.5
else
  shell=none; : > "$work/shell.log"
fi
: > "$work/calls.log"                                  # count only what the CHANGES cause
for f in "$work"/shell/config/gtk-3.0/settings.ini "$work"/shell/home/.local/share/icons/default/index.theme "$work"/shell/mirror/appearance.json; do
  [ -f "$f" ] && echo "start  $(basename "$f") present" || echo "start  $(basename "$f") MISSING"
done
env HOME="$work/settings/home" XDG_CONFIG_HOME="$work/settings/config" NIDARA_GREETER_MIRROR_DIR="$work/settings/mirror" \
  gjs -m "$work/probe.js" "$settings_role" > "$work/settings.log" 2>&1 & settings=$!
wait $settings
sleep 1
echo "shell=$shell settings=$settings"
grep -hE "^(READY|BEFORE|DONE|CURSOR-APPLIED)" "$work/shell.log" "$work/settings.log"
echo "--- external calls, by process"
[ -n "$SOLO" ] && echo "(SOLO: the one process also did the START effects — groupbar blue, setcursor Adwaita — not counted apart; each CHANGE must still appear once)"
while read -r pid rest; do
  who=other; [ "$pid" = "$shell" ] && who=shell; [ "$pid" = "$settings" ] && who=settings
  echo "$who: $rest"
done < "$work/calls.log" | sed -E "s/(rgba\([0-9A-Fa-f]+\))/\1/" | sort | uniq -c
[ -n "$SOLO" ] && echo "--- files written by the one process (SOLO: expected, it is the shell here)" || echo "--- files written by the settings process (must be none)"
find "$work/settings/home" "$work/settings/config" "$work/settings/mirror" -type f ! -path "*/dconf/*" | sed "s|$work/||"
[ -n "$SOLO" ] || echo "--- shell results"
out=shell; [ -n "$SOLO" ] && out=settings
grep -h "prefer-dark" "$work/$out/config/gtk-3.0/settings.ini"
grep -h "Inherits" "$work/$out/home/.local/share/icons/default/index.theme"
grep -hE "\"(isDark|accent|cursorTheme|barOpacity)\"" "$work/$out/mirror/appearance.json" | tr -d " \n"; echo
grep -iE "error|critical" "$work/shell.log" "$work/settings.log" | grep -v "HyprIPC\|atspi" | head -5
[ "$shell" != none ] && { kill $shell 2>/dev/null; wait $shell 2>/dev/null; }
'
