#!/usr/bin/env bash
# The REAL shell — its bar, its dock, its Control Center — over the reference probe's calibration
# wallpapers, on a nested Hyalo in a headless cage. Nothing reaches your session: its own HOME,
# runtime dir, session bus and dconf; no config of yours.
#
#   scripts/dev/glass-lab/shell-calib.sh OUTDIR [--size WxH] [--bin HYALO] [--tuning FILE] [--lib DIR]
#
# OUTDIR/<mode>-desktop-<wall>.png  the desktop (bar, dock) over each wallpaper
# OUTDIR/<mode>-cc-<wall>.png       the same with the Control Center open (opened once, the
#                                   wallpaper changed under it — as the probe does on the reference)
# OUTDIR/<mode>-layers.json         Hyalo's `msg layers`
# OUTDIR/shell.log, hyalo.log
# --tuning   a glass-tuning.conf for the shell (dev mode reads it): the glass under test; without
#            it, the shell's factory glass.
# --lib      a libnidara-wl build (lib/nidara-wl/build.sh DIR) for the shell instead of the
#            installed one — with a Hyalo of the same protocol (--bin), as they ship together.
set -euo pipefail
here=$(dirname "$(realpath "$0")"); repo=$(realpath "$here/../../..")
out="" size=1280x800 bin="" tuning="" lib=""
while [ $# -gt 0 ]; do
    case "$1" in
        --size) size=$2; shift ;;
        --bin) bin=$(realpath "$2"); shift ;;
        --tuning) tuning=$(realpath "$2"); shift ;;
        --lib) lib=$(realpath "$2"); shift ;;
        -*) echo "shell-calib: unknown option $1" >&2; exit 2 ;;
        *) out=$(realpath -m "$1") ;;
    esac
    shift
done
[ -n "$out" ] || { echo "usage: shell-calib.sh OUTDIR [--size WxH] [--bin HYALO] [--tuning FILE]" >&2; exit 2; }
[ -n "$bin" ] || bin="$repo/hyalo/target/release/nidara-hyalo"
[ -x "$bin" ] || bin=/usr/bin/nidara-hyalo
mkdir -p "$out"
sb=$(mktemp -d "${TMPDIR:-/tmp}/shell-calib.XXXXXX")
[ -n "${SHELL_CALIB_KEEP:-}" ] && echo "shell-calib: sandbox kept at $sb" >&2 || trap 'rm -rf "$sb"' EXIT
mkdir -p "$sb/home/.config/nidara" "$sb/run" "$sb/walls" && chmod 700 "$sb/run"
touch "$sb/home/.config/nidara/.dev"
[ -n "$tuning" ] && cp "$tuning" "$sb/home/.config/nidara/glass-tuning.conf"

# The wallpapers, at the output's size: the probe's levels and colours (sRGB as given).
w=${size%x*} h=${size#*x}
python3 - "$sb/walls" "$w" "$h" <<'PY'
import sys, zlib, struct
d, W, H = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
def png(path, rgb):
    row = b"\x00" + bytes(rgb) * W
    def chunk(t, x): return struct.pack(">I", len(x)) + t + x + struct.pack(">I", zlib.crc32(t + x) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(row * H)) + chunk(b"IEND", b""))
for v in ("0", "0.1", "0.2", "0.35", "0.5", "0.65", "0.8", "0.9", "1"):
    b = round(float(v) * 255); png(f"{d}/level-{v}.png", (b, b, b))
for hx in ("E53935", "43A047", "1E88E5", "FDD835", "8E24AA", "00ACC1"):
    png(f"{d}/rgb-{hx}.png", (int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)))
PY
walls=$(cd "$sb/walls" && ls level-*.png rgb-*.png | sed 's/\.png$//' | sort -V | tr '\n' ' ')

printf '[idle]\nscreen_off = 0\nlock = 0\nsuspend = 0\n' > "$sb/hyalo.toml"

# Inside the nested Hyalo, on a bus of its own.
cat > "$sb/client.sh" <<CLIENT
#!/bin/bash
set -u
msg() { "$bin" msg "\$@"; }
shot() { msg screenshot "\$1" >/dev/null || echo "shell-calib: screenshot \$1 failed" >&2; }
awww-daemon >"$out/awww.log" 2>&1 &
for _ in \$(seq 1 50); do awww query >/dev/null 2>&1 && break; sleep 0.1; done
wall() { awww img "$sb/walls/\$1.png" --transition-type none >/dev/null 2>&1; sleep 1.3; }
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
wall level-0.5
( cd "$repo/ui/shell" && ${lib:+GI_TYPELIB_PATH="$lib" LD_LIBRARY_PATH="$lib"} NIDARA_SHELL_ROOT="$repo/ui/shell" "$repo/scripts/run.sh" app.ts >"$out/shell.log" 2>&1 ) &
for _ in \$(seq 1 120); do nidara-ipc listActions >/dev/null 2>&1 && break; sleep 0.5; done
sleep 4
for mode in dark light; do
    gsettings set org.gnome.desktop.interface color-scheme \$([ \$mode = dark ] && echo prefer-dark || echo prefer-light)
    sleep 2
    for w in $walls; do wall \$w; shot "$out/\$mode-desktop-\$w.png"; done
    nidara-ipc toggleControlCenter >/dev/null; sleep 2
    for w in $walls; do wall \$w; shot "$out/\$mode-cc-\$w.png"; done
    msg layers >"$out/\$mode-layers.json"
    nidara-ipc toggleControlCenter >/dev/null; sleep 1.5
done
touch "$sb/done"
CLIENT
chmod +x "$sb/client.sh"

# The cage's output at the asked size (output-mode.c, as glass-lab.sh builds it).
xml=/usr/share/wlr-protocols/unstable/wlr-output-management-unstable-v1.xml
wayland-scanner client-header "$xml" "$sb/wlr-output-management-unstable-v1-client-protocol.h"
wayland-scanner private-code "$xml" "$sb/wlr-output-management-unstable-v1-protocol.c"
cc -O2 -I"$sb" -o "$sb/output-mode" "$here/output-mode.c" "$sb/wlr-output-management-unstable-v1-protocol.c" \
    $(pkg-config --cflags --libs wayland-client)

cat > "$sb/inner.sh" <<INNER
#!/bin/bash
"$sb/output-mode" $size || exit 1
# Hyalo talks to the cage by the cage's socket path, then lives in the sandbox's runtime dir.
export WAYLAND_DISPLAY="\$XDG_RUNTIME_DIR/\$WAYLAND_DISPLAY" XDG_RUNTIME_DIR="$sb/run"
export HOME="$sb/home" XDG_CONFIG_HOME="$sb/home/.config" XDG_CACHE_HOME="$sb/home/.cache" XDG_DATA_HOME="$sb/home/.local/share"
export HYALO_CONFIG="$sb/hyalo.toml" HYALO_SETTINGS="$sb/hyalo-settings.toml"
unset HYALO_SOCKET DISPLAY HYPRLAND_INSTANCE_SIGNATURE NIDARA_SESSION DBUS_SESSION_BUS_ADDRESS
# Its own process group: the shell, awww and the bus outlive Hyalo otherwise, and keep the cage up.
setsid dbus-run-session -- "$bin" --winit -c "$sb/client.sh" >"$out/hyalo.log" 2>&1 &
pid=\$!
for _ in \$(seq 1 1200); do [ -f "$sb/done" ] && break; sleep 0.25; done
kill -- -\$pid 2>/dev/null
INNER
chmod +x "$sb/inner.sh"
env -u DISPLAY WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -d -- "$sb/inner.sh" 2>&1 | grep -v -E 'EGL|GLES|extensions|INFO' || true
[ -f "$sb/done" ] && echo "shell-calib: $(ls "$out"/*.png | wc -l) captures in $out" || { echo "shell-calib: did not finish (see $out/hyalo.log, $out/shell.log)" >&2; exit 1; }
