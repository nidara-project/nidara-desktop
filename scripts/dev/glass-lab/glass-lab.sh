#!/usr/bin/env bash
# The glass lab (lab.ts): the shell's glass pieces on a Hyalo of their own.
#
#   scripts/dev/glass-lab/glass-lab.sh                       a window on your desktop
#   scripts/dev/glass-lab/glass-lab.sh --headless OUT.png    nothing on screen: one capture,
#                                                            OUT.txt with the readings
#   options:  --preset FILE   start from a preset (what the window's «Guardar» writes)
#             --bg NAME       the backdrop (blanco, negro, gris, "mitad blanco/negro", …)
#             --show NAME     which pieces (todas, barra, "centro de control", avisos, …)
#             --video         with --headless: a video instead of one capture (the drift, frame by
#                             frame, «Duración del vídeo» from the preset) into the presets dir
#             --bin PATH      the Hyalo to draw on (default: the lab build, else the installed one)
#             --no-dev-shader the shader compiled into Hyalo, no LAB hooks (the parity check: at
#                             the lab's neutral values both must draw the same pixels)
#
# Nothing it does reaches your session: Hyalo runs nested (a window, or inside a headless
# cage) with HYALO_CONFIG=/dev/null and a settings file of its own, so no binding or setting of
# yours applies and none is written; the lab gets its own glass-tuning.conf, its own
# lab_params.conf, GSettings in memory (the shell's ThemeManager writes some keys) and its own
# greeter-mirror dir. Presets and captures go to ~/.local/share/nidara/glass-lab.
set -euo pipefail
here=$(dirname "$(realpath "$0")")
repo=$(realpath "$here/../../..")

headless="" out="" preset="" bg="" show="" bin="" devshader=1 video=""
while [ $# -gt 0 ]; do
    case "$1" in
        --headless) headless=1; out=$(realpath -m "$2"); shift ;;
        --preset) preset=$(realpath "$2"); shift ;;
        --bg) bg="$2"; shift ;;
        --show) show="$2"; shift ;;
        --bin) bin=$(realpath "$2"); shift ;;
        --no-dev-shader) devshader="" ;;
        --video) video=1 ;;
        *) echo "glass-lab: unknown option $1" >&2; exit 2 ;;
    esac
    shift
done
if [ -z "$bin" ]; then
    bin="${CARGO_TARGET_DIR:-$repo/hyalo/target}/release/nidara-hyalo"
    [ -x "$bin" ] || bin=/usr/bin/nidara-hyalo
fi
[ -f "$repo/ui/shell/style.css" ] || { echo "glass-lab: compile ui/shell/style.css first (see the skill's dev loop)" >&2; exit 2; }

sb=$(mktemp -d "${TMPDIR:-/tmp}/glass-lab.XXXXXX")
[ -n "${GLASS_LAB_KEEP:-}" ] && echo "glass-lab: sandbox kept at $sb" >&2 || trap 'rm -rf "$sb"' EXIT
# A home of its own: the material reads ~/.config/nidara/glass-tuning.conf (in a dev install),
# and yours must neither leak in nor be written.
mkdir -p "$sb/home/.config/nidara" "$sb/shaders" "$sb/mirror"
touch "$sb/home/.config/nidara/.dev" "$sb/home/.config/nidara/glass-tuning.conf"
# The glass shader itself, LINKED: an edit to it shows in the lab as it is saved (Hyalo recompiles
# it, keeping the last one that compiled), with its LAB hooks live (glass_gl.rs's LAB_ON).
ln -s "$repo/hyalo/compositor/src/render/glass_final.glsl" "$sb/shaders/glass_final.glsl"
"$repo/scripts/bundle.sh" --js "$here/lab.ts" "$sb/lab.js" >/dev/null

export HYALO_CONFIG=/dev/null HYALO_SETTINGS="$sb/hyalo-settings.toml"
if [ -n "$devshader" ]; then export HYALO_SHADER_DIR="$sb/shaders"; else unset HYALO_SHADER_DIR; fi
lab_env=(
    HOME="$sb/home" XDG_CONFIG_HOME="$sb/home/.config" GSETTINGS_BACKEND=memory NIDARA_GREETER_MIRROR_DIR="$sb/mirror"
    NIDARA_SHELL_ROOT="$repo/ui/shell" LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so
    GLASS_LAB_REPO="$repo" GLASS_LAB_TUNING="$sb/home/.config/nidara/glass-tuning.conf"
    HYALO_SHADER_DIR="$sb/shaders" GLASS_LAB_HYALO="$bin"
    GLASS_LAB_PRESETS="${XDG_DATA_HOME:-$HOME/.local/share}/nidara/glass-lab"
    GLASS_LAB_WALLPAPERS="$repo/defaults/wallpaper" GLASS_LAB_PRESET="$preset" GLASS_LAB_BG="$bg" GLASS_LAB_SHOW="$show"
    GLASS_LAB_SHOT="$out" GLASS_LAB_VIDEO="$video" GLASS_LAB_SHOT_DELAY="${GLASS_LAB_SHOT_DELAY:-}" GLASS_LAB_DEBUG="${GLASS_LAB_DEBUG:-}" NIDARA_MATERIAL_DEBUG="${GLASS_LAB_DEBUG:-}"
)
lab="env $(printf '%q ' "${lab_env[@]}") gjs -m $sb/lab.js"

if [ -z "$headless" ]; then
    echo "glass-lab: $bin $( [ -n "$devshader" ] && echo "(shader with LAB hooks: $sb/shaders)" )"
    "$bin" --winit -c "$lab; kill \$PPID" 2>"$sb/hyalo.log" || true
    exit 0
fi

# Headless: a cage with no output of its own, Hyalo in a window inside it, the lab inside that.
rm -f "${out%.png}.txt"
inner="$sb/inner.sh"
cat > "$inner" <<INNER
#!/bin/sh
"$bin" --winit -c "$lab" >"$sb/hyalo.log" 2>&1 &
pid=\$!
for _ in \$(seq 1 $([ -n "$video" ] && echo 4800 || echo 120)); do [ -f "${out%.png}.txt" ] && break; sleep 0.25; done
kill \$pid
INNER
chmod +x "$inner"
env -u DISPLAY WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- "$inner" 2>&1 | grep -v -E 'EGL|GLES|extensions' || true
if [ -f "${out%.png}.txt" ]; then tail -n +2 "${out%.png}.txt"; else echo "glass-lab: no capture (Hyalo log: $sb/hyalo.log)" >&2; cat "$sb/hyalo.log" >&2; exit 1; fi
