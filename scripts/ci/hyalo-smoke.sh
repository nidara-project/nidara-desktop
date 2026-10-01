#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# hyalo-smoke.sh — CI for Hyalo, the compositor of our own (hyalo/, #681).
#
# What it proves on every PR, in an Arch container on the runner's vkms:
#   1. hyalo/ builds against the committed lock file (`cargo build --locked`), passes
#      `clippy -D warnings`, and its unit tests pass.
#   2. Hyalo BOOTS on real DRM/KMS — the tty backend, the one a session uses — through
#      libseat (seatd) and udev, rendering in software (llvmpipe) on vkms.
#   3. The REAL shell bundle boots on it, stays alive and answers its IPC; Hyalo's own IPC
#      lists the output.
#   4. A screenshot of the desktop is uploaded for a HUMAN to look at — through Hyalo's IPC,
#      since Hyalo does not speak a capture protocol grim could use yet (#683).
#   5. The shell log is held to the same bar as the Hyprland smoke: no JS errors and no
#      toolkit CRITICAL (an absent accessibility bus excepted, that is the container).
#
# The Hyprland smoke (headless-smoke.sh) stays the gate for the shell itself; this one is
# Hyalo's. Same container, same vkms, same unprivileged-user split.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-${GITHUB_WORKSPACE:-$REPO}/hyalo-out}"

log() { echo "[hyalo] $*"; }

phase_deps() {
    log "pacman deps…"
    # The shell's runtime (as in headless-smoke.sh) plus Hyalo's build: rust and the
    # libraries Smithay links against.
    #
    # `hyprland` although Hyprland never runs here: the shell still calls `hyprctl` at start,
    # some of it synchronously (its Hyprland dependency is #682's to remove). On every real
    # install the binary exists — nidara-desktop depends on hyprland — and answers "no
    # instance", which the shell survives; with no binary at all the spawn throws at module
    # top level and the shell never starts (the first run of this job, 2026-10-01).
    pacman -Syu --needed --noconfirm \
        base-devel git rust clang hyprland \
        libinput seatd libdisplay-info libxkbcommon mesa systemd dbus \
        gobject-introspection glib2-devel esbuild \
        gtk3 gtk4 gtk-layer-shell gtk4-layer-shell libpeas-2 pam \
        libpulse networkmanager libnma-gtk4 bluez-libs upower libnotify \
        pipewire wireplumber libwireplumber \
        nodejs npm gjs \
        wayland-protocols hyprland-protocols wlr-protocols \
        jq librsvg dconf file \
        ttf-jetbrains-mono ttf-nerd-fonts-symbols-mono inter-font noto-fonts-emoji
    ldconfig
}

phase_build() {
    cd "$REPO/hyalo"
    log "cargo build --locked --release…"
    cargo build --locked --release
    log "cargo clippy -D warnings…"
    cargo clippy --locked --all-targets -- -D warnings
    log "cargo test…"
    cargo test --locked
    install -Dm755 target/release/nidara-hyalo /usr/local/bin/nidara-hyalo

    # The shell, as the Hyprland smoke builds it (schemas, libnidara-wl, sheets, bundle).
    install -Dm644 -t /usr/share/glib-2.0/schemas "$REPO"/config/gsettings/*.gschema.xml
    glib-compile-schemas --strict /usr/share/glib-2.0/schemas
    local wl_build="$REPO/build/nidara-wl"
    "$REPO/lib/nidara-wl/build.sh" "$wl_build" >/dev/null
    install -Dm755 "$wl_build/libnidara-wl.so.0.0.0" /usr/lib/libnidara-wl.so.0.0.0
    ln -sf libnidara-wl.so.0.0.0 /usr/lib/libnidara-wl.so.0
    install -Dm644 "$wl_build/NidaraWl-1.0.typelib" /usr/lib/girepository-1.0/NidaraWl-1.0.typelib
    ldconfig
    cd "$REPO/ui/shell"
    npm install
    npx sass --no-charset ../lib/nidara-kit/styles/kit.scss ../lib/nidara-kit/kit.css && sed -i '/@charset/d' ../lib/nidara-kit/kit.css
    npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css
    mkdir -p build
    node "$REPO/scripts/bundle.mjs" kit "$REPO/ui/lib/nidara-kit/build/js"
    "$REPO/scripts/bundle.sh" app.ts build/nidara --kit-external="$REPO/ui/lib/nidara-kit/build/js"
    log "shell bundle OK"
}

phase_boot() {
    id ci &>/dev/null || useradd -m -s /bin/bash ci
    chmod -R a+rX "$REPO"
    export XDG_RUNTIME_DIR=/run/hyalo-smoke
    mkdir -p "$XDG_RUNTIME_DIR" && chown ci "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
    dbus-uuidgen --ensure
    mkdir -p /run/dbus && dbus-daemon --system --fork
    # udev: Smithay finds GPUs and input devices through libudev.
    /usr/lib/systemd/systemd-udevd --daemon
    udevadm trigger --action=add || true
    udevadm settle || true
    seatd -g seat >/tmp/seatd.log 2>&1 &
    usermod -aG seat,video,input ci
    sleep 1
    mkdir -p "$OUT" /tmp/hyalo && chown ci /tmp/hyalo "$OUT"
    runuser -u ci -- env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" REPO="$REPO" OUT="$OUT" \
        dbus-run-session -- bash "$REPO/scripts/ci/hyalo-smoke.sh" run
}

phase_run() {
    export LIBGL_ALWAYS_SOFTWARE=1 LANG=C.UTF-8 LIBSEAT_BACKEND=seatd
    hyalo_log=/tmp/hyalo/hyalo.log
    shell_log=/tmp/hyalo/shell.log
    hyalo_pid=""
    shell_pid=""
    finish() {
        local rc=$?
        [ -n "$shell_pid" ] && kill "$shell_pid" 2>/dev/null || true
        [ -n "$hyalo_pid" ] && kill "$hyalo_pid" 2>/dev/null || true
        cp -f /tmp/hyalo/*.png /tmp/hyalo/*.log /tmp/hyalo/*.json "$OUT"/ 2>/dev/null || true
        cp -f "$HOME"/.local/state/nidara/hyalo/crash-*.txt "$OUT"/ 2>/dev/null || true
        if [ $rc -ne 0 ]; then
            echo "─── hyalo.log (tail) ───"; tail -n 60 "$hyalo_log" 2>/dev/null || true
            echo "─── shell.log (tail) ───"; tail -n 60 "$shell_log" 2>/dev/null || true
        fi
        return $rc
    }
    trap finish EXIT

    # The vkms node, and only it: the runner also exposes a hyperv_drm card.
    local c dev=""
    for c in /sys/class/drm/card*; do
        [[ "$(readlink -f "$c")" == *vkms* ]] && dev="/dev/dri/$(basename "$c")" && break
    done
    [ -n "$dev" ] || { log "FAIL: no vkms device"; exit 1; }
    export HYALO_DRM_DEVICE="$dev"
    log "HYALO_DRM_DEVICE=$dev"

    # ── 1. Hyalo on the hardware path, with the SHIPPED config (no autostart: no --session).
    log "booting Hyalo (tty backend on vkms)…"
    HYALO_CONFIG="$REPO/config/hyalo/hyalo.toml" RUST_LOG=info nidara-hyalo --tty >"$hyalo_log" 2>&1 &
    hyalo_pid=$!
    local sock="" i
    for i in $(seq 1 30); do
        sock="$(ls "$XDG_RUNTIME_DIR"/nidara-hyalo.*.sock 2>/dev/null | head -1 || true)"
        [ -n "$sock" ] && break
        kill -0 "$hyalo_pid" 2>/dev/null || { log "FAIL: Hyalo died during boot"; exit 1; }
        sleep 1
    done
    [ -n "$sock" ] || { log "FAIL: Hyalo's IPC socket never appeared"; exit 1; }
    export HYALO_SOCKET="$sock"
    local wl="${sock##*/nidara-hyalo.}"; wl="${wl%.sock}"
    export WAYLAND_DISPLAY="$wl"
    log "Hyalo up ($WAYLAND_DISPLAY)"

    nidara-hyalo msg outputs > /tmp/hyalo/outputs.json
    jq -e '.ok.outputs | map(select(.enabled)) | length > 0' /tmp/hyalo/outputs.json >/dev/null \
        || { log "FAIL: Hyalo has no output on"; cat /tmp/hyalo/outputs.json; exit 1; }
    log "outputs: $(jq -r '.ok.outputs[] | "\(.name) \(.current_mode.width)x\(.current_mode.height)"' /tmp/hyalo/outputs.json | tr '\n' ' ')"

    # The window manager: every output shows a workspace, and a command switches it.
    nidara-hyalo msg workspaces > /tmp/hyalo/workspaces.json
    jq -e '.ok.workspaces | map(select(.active)) | length > 0' /tmp/hyalo/workspaces.json >/dev/null \
        || { log "FAIL: no output shows a workspace"; cat /tmp/hyalo/workspaces.json; exit 1; }
    nidara-hyalo msg do workspace 2 >/dev/null || { log "FAIL: 'do workspace 2' refused"; exit 1; }
    nidara-hyalo msg workspaces | jq -e '.ok.workspaces | map(select(.id == 2 and .active)) | length == 1' >/dev/null \
        || { log "FAIL: workspace 2 is not shown after 'do workspace 2'"; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "window manager OK"

    # ── 2. The shell, exactly as the Hyprland smoke runs it.
    log "booting the shell…"
    export GDK_BACKEND=wayland NIDARA_SHELL_ROOT="$REPO/ui/shell"
    cd "$REPO/ui/shell"
    ./build/nidara >"$shell_log" 2>&1 &
    shell_pid=$!
    cc -O2 "$REPO/bin/nidara-ipc.c" $(pkg-config --cflags --libs gio-2.0) -o /tmp/hyalo/nidara-ipc
    local ok=""
    for i in $(seq 1 40); do
        kill -0 "$shell_pid" 2>/dev/null || { log "FAIL: the shell died"; exit 1; }
        kill -0 "$hyalo_pid" 2>/dev/null || { log "FAIL: Hyalo died with the shell on it"; exit 1; }
        if /tmp/hyalo/nidara-ipc listActions >/tmp/hyalo/listActions.json 2>/dev/null; then ok=1; break; fi
        sleep 1
    done
    [ -n "$ok" ] || { log "FAIL: the shell never answered nidara-ipc"; exit 1; }
    log "shell IPC OK"

    # ── 3. Pictures for a person.
    sleep 4
    nidara-hyalo msg screenshot /tmp/hyalo/desktop.png >/dev/null \
        || { log "FAIL: Hyalo's screenshot request failed"; exit 1; }
    file /tmp/hyalo/desktop.png | grep -q "PNG image" || { log "FAIL: no PNG"; exit 1; }
    if /tmp/hyalo/nidara-ipc toggleControlCenter >/dev/null 2>&1; then
        sleep 2
        nidara-hyalo msg screenshot /tmp/hyalo/control-center.png >/dev/null || true
    fi
    log "screenshots taken"

    # ── 4. The same log bar as the Hyprland smoke.
    kill -0 "$hyalo_pid" 2>/dev/null || { log "FAIL: Hyalo died"; exit 1; }
    if grep -nE "JS ERROR|Unhandled promise rejection" "$shell_log" > /tmp/hyalo/js-errors.txt; then
        log "FAIL: JS errors:"; cat /tmp/hyalo/js-errors.txt; exit 1
    fi
    if grep -nE "(Gtk|Gdk|Gsk|GLib|GLib-GObject|GLib-GIO|Gjs|Pango)-CRITICAL" "$shell_log" \
        | grep -v "accessibility bus\|org.a11y.atspi" > /tmp/hyalo/toolkit-criticals.txt; then
        log "FAIL: toolkit CRITICALs:"; cat /tmp/hyalo/toolkit-criticals.txt; exit 1
    fi
    if grep -n "panicked" "$hyalo_log"; then
        log "FAIL: Hyalo panicked"; exit 1
    fi
    log "HYALO SMOKE PASSED"
}

case "${1:-all}" in
    run) phase_run ;;
    all) phase_deps; phase_build; phase_boot ;;
    *)   echo "usage: $0 [all|run]" >&2; exit 2 ;;
esac
