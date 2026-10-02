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
#   4. A screenshot of the desktop is uploaded for a HUMAN to look at — through Hyalo's IPC
#      (grim works too since 2026-10-02: scripts/ci/hyalo-screen-capture-check.sh tests it).
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
        jq librsvg dconf file procps-ng \
        grim slurp wl-clipboard wf-recorder ffmpeg \
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
    # nidara-input (the Assistant's virtual pointer), exactly as install.sh builds it.
    local vp_xml=/usr/share/wlr-protocols/unstable/wlr-virtual-pointer-unstable-v1.xml vp="$REPO/build/vp"
    mkdir -p "$vp"
    wayland-scanner client-header "$vp_xml" "$vp/wlr-virtual-pointer-unstable-v1-client-protocol.h"
    wayland-scanner private-code  "$vp_xml" "$vp/wlr-virtual-pointer-unstable-v1-protocol.c"
    cc -O2 "$REPO/bin/nidara-input.c" "$vp/wlr-virtual-pointer-unstable-v1-protocol.c" \
        -I"$vp" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/nidara-input
    # The sandbox probe (what a Flatpak app sees, hyalo/compositor/src/sandbox.rs).
    local sc_xml=/usr/share/wayland-protocols/staging/security-context/security-context-v1.xml sc="$REPO/build/sc"
    mkdir -p "$sc"
    wayland-scanner client-header "$sc_xml" "$sc/security-context-v1-client-protocol.h"
    wayland-scanner private-code  "$sc_xml" "$sc/security-context-v1-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-sandbox-probe.c" "$sc/security-context-v1-protocol.c" \
        -I"$sc" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-sandbox-probe
    # The idle-inhibit probe (a shown window holding idle off, hyalo/compositor/src/idle.rs).
    local ii="$REPO/build/ii" xs_xml=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml \
          ii_xml=/usr/share/wayland-protocols/unstable/idle-inhibit/idle-inhibit-unstable-v1.xml
    mkdir -p "$ii"
    wayland-scanner client-header "$xs_xml" "$ii/xdg-shell-client-protocol.h"
    wayland-scanner private-code  "$xs_xml" "$ii/xdg-shell-protocol.c"
    wayland-scanner client-header "$ii_xml" "$ii/idle-inhibit-unstable-v1-client-protocol.h"
    wayland-scanner private-code  "$ii_xml" "$ii/idle-inhibit-unstable-v1-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-idle-inhibit-probe.c" "$ii/xdg-shell-protocol.c" "$ii/idle-inhibit-unstable-v1-protocol.c" \
        -I"$ii" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-idle-inhibit-probe
    # The stand-in input method (hyalo-ime-check.sh). input-method-v2 is not in wayland-protocols:
    # its XML comes with the wayland-protocols-misc crate Hyalo was just built with.
    local im="$REPO/build/im" im_xml
    im_xml=$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -name input-method-unstable-v2.xml | head -1)
    mkdir -p "$im"
    wayland-scanner client-header "$im_xml" "$im/input-method-unstable-v2-client-protocol.h"
    wayland-scanner private-code  "$im_xml" "$im/input-method-unstable-v2-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-ime-probe.c" "$im/input-method-unstable-v2-protocol.c" \
        -I"$im" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-ime-probe
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
    # HYALO_CONFIG replaces the layers; HYALO_SETTINGS gives it a settings layer of its own,
    # so the `settings` request has somewhere to write that is not a real ~/.config.
    export HYALO_SETTINGS=/tmp/hyalo/hyalo-settings.toml
    rm -f "$HYALO_SETTINGS"
    # Input for the checks below (keys, a pinch), through the same path as a device (control.rs).
    export HYALO_CONTROL=/tmp/hyalo/control
    rm -f "$HYALO_CONTROL"; mkfifo "$HYALO_CONTROL"
    # The lock check (below) kills its lock client: Hyalo must start ITS probe again, not
    # nidara-lock (lock.rs, HYALO_LOCK_RELAUNCH).
    export HYALO_LOCK_RELAUNCH="LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so gjs -m $REPO/scripts/ci/hyalo-lock-probe.js lock >/tmp/hyalo/lock/relaunched.log 2>&1"
    mkdir -p /tmp/hyalo/lock
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

    # The glass (#684): every shell surface tells Hyalo where its glass is (nidara-material-v1)
    # and Hyalo paints it. The bar, the dock and the island each declare theirs; opening the
    # Control Center adds its panes to the bar's, so the shapes follow what is on screen.
    glass_shapes() {
        nidara-hyalo msg layers | jq -r --arg ns "$1" \
            '[.ok.layers[] | select(.namespace == $ns) | .glass | select(. != null and .compositor_paints) | .shapes] | max // 0'
    }
    for i in $(seq 1 20); do
        [ "$(glass_shapes nidara-bar)" -gt 0 ] && [ "$(glass_shapes nidara-dock)" -gt 0 ] \
            && [ "$(glass_shapes nidara-island)" -gt 0 ] && break
        sleep 0.5
    done
    for ns in nidara-bar nidara-dock nidara-island; do
        [ "$(glass_shapes "$ns")" -gt 0 ] \
            || { log "FAIL: $ns declared no glass for Hyalo to paint"; nidara-hyalo msg layers; exit 1; }
    done
    local bar_rest bar_cc
    bar_rest="$(glass_shapes nidara-bar)"
    # The bar's and the dock's glass cast no shadow (`trackNoScrim`): not a halo per capsule.
    local ns lone
    for ns in nidara-bar nidara-dock; do
        lone="$(nidara-hyalo msg layers | jq -r --arg ns "$ns" \
            '[.ok.layers[] | select(.namespace == $ns) | .glass.scrims[]? | select(.kind == "shape")] | length')"
        [ "$lone" -eq 0 ] \
            || { log "FAIL: $lone of $ns's panes cast a shadow of their own"; nidara-hyalo msg layers; exit 1; }
    done
    /tmp/hyalo/nidara-ipc toggleCC >/dev/null
    sleep 2
    bar_cc="$(glass_shapes nidara-bar)"
    # The shadow under the glass: the Control Center's panes share ONE, centred on the
    # panel (trackScrimRegion), rather than one each. Its strength depends on the
    # wallpaper; what is checked is that the region reached Hyalo and holds the panes (the
    # bar's own region casts nothing, so Hyalo lists none for it).
    local cc_scrim
    cc_scrim="$(nidara-hyalo msg layers | jq -r \
        '[.ok.layers[] | select(.namespace == "nidara-bar") | .glass.scrims[]? | select(.kind == "region") | .shapes] | max // 0')"
    /tmp/hyalo/nidara-ipc toggleCC >/dev/null
    sleep 1
    [ "$bar_cc" -gt "$bar_rest" ] \
        || { log "FAIL: the Control Center's panes never reached Hyalo ($bar_rest shapes closed, $bar_cc open)"; exit 1; }
    [ "$cc_scrim" -gt 1 ] \
        || { log "FAIL: the Control Center's panes do not share one shadow under their glass ($cc_scrim in its region)"; nidara-hyalo msg layers; exit 1; }
    log "glass OK (the bar's $bar_rest shapes, $bar_cc with the Control Center open, $cc_scrim of them on one shadow; the dock's, the island's)"

    # Settings reach Hyalo through the compositor interface (#682): the shell states its
    # workspace modes at boot, which lands in the settings layer Hyalo writes; a patch is
    # applied, and re-stating it changes nothing (or the shell's reload handlers would loop).
    for i in $(seq 1 10); do grep -q '^\[workspaces\]' "$HYALO_SETTINGS" 2>/dev/null && break; sleep 1; done
    grep -q '^\[workspaces\]' "$HYALO_SETTINGS" \
        || { log "FAIL: the shell's workspace modes never reached the settings layer"; cat "$HYALO_SETTINGS" 2>/dev/null; exit 1; }
    local patch='{"input":{"keyboard":{"numlock":true},"pointer":{"accel_profile":"flat"}}}'
    nidara-hyalo msg settings "$patch" | jq -e '.ok.changed == true' >/dev/null \
        || { log "FAIL: a settings patch was not applied"; exit 1; }
    nidara-hyalo msg config | jq -e '.ok.config.input.keyboard.numlock and .ok.config.input.pointer.accel_profile == "flat"' >/dev/null \
        || { log "FAIL: the config in force does not show the patch"; exit 1; }
    nidara-hyalo msg settings "$patch" | jq -e '.ok.changed == false' >/dev/null \
        || { log "FAIL: re-stating a setting changed something"; exit 1; }
    if nidara-hyalo msg settings '{"input":{"pointer":{"accel_profile":"bouncy"}}}' >/dev/null; then
        log "FAIL: an invalid setting was accepted"; exit 1
    fi
    log "settings OK"

    # Window capture (#682): the overview's thumbnails, through the standard protocols
    # (ext-foreign-toplevel-list + ext-image-copy-capture, hyalo/compositor/src/capture.rs),
    # of a window parked on a HIDDEN workspace — the case a capture that read the screen
    # would get wrong. Its centre must come back as the colour it was painted.
    gjs -m "$REPO/scripts/ci/hyalo-capture-probe.js" window '#2471a3' >/tmp/hyalo/capture-window.log 2>&1 &
    local probe_pid=$! cid=""
    for i in $(seq 1 20); do
        cid="$(nidara-hyalo msg windows | jq -r '.ok.windows[] | select(.app_id == "org.nidara.captureprobe" and .width > 0) | .id' | head -1)"
        [ -n "$cid" ] && break
        sleep 0.5
    done
    [ -n "$cid" ] || { log "FAIL: the capture probe's window never appeared"; cat /tmp/hyalo/capture-window.log; exit 1; }
    nidara-hyalo msg do move-to-workspace-silent 3 "$cid" >/dev/null
    local got
    gjs -m "$REPO/scripts/ci/hyalo-capture-probe.js" capture "$(printf '%x' "$cid")" >/tmp/hyalo/capture-probe.log 2>&1 || true
    got="$(sed -n 's/^RESULT //p' /tmp/hyalo/capture-probe.log | tail -1)"
    [ -n "$got" ] || { log "FAIL: the capture probe said nothing"; cat /tmp/hyalo/capture-probe.log; exit 1; }
    log "capture of a window on a hidden workspace: $got"
    kill "$probe_pid" 2>/dev/null || true
    echo "$got" | awk '{ split($2, c, ","); ok = ($1 ~ /^[0-9]+x[0-9]+$/) && c[1] >= 26 && c[1] <= 46 && c[2] >= 103 && c[2] <= 123 && c[3] >= 153 && c[3] <= 173; exit !ok }' \
        || { log "FAIL: the window capture did not come back as #2471a3 (36,113,163)"; cat /tmp/hyalo/capture-probe.log; exit 1; }
    log "window capture OK"

    # Game mode (#682): Hyalo recognises a game (wm/games.rs) — here by the Steam app id in its
    # process's environment — and its shipped [rules.games] puts it on the named workspace
    # `gamespace` and takes the user there. The control is the same window WITHOUT the id: it
    # must stay where it opened, or the check is not telling games apart. When the game closes,
    # the SHELL (core/GameSession.ts) takes the user back to where they were, after its grace.
    nidara-hyalo msg do workspace 1 >/dev/null
    window_id() {
        local id=""
        for i in $(seq 1 20); do
            id="$(nidara-hyalo msg windows | jq -r --arg c "$1" '.ok.windows[] | select(.app_id == "org.nidara.captureprobe" and .width > 0 and (.id | tostring) != $c) | .id' | head -1)"
            [ -n "$id" ] && break
            sleep 0.5
        done
        echo "$id"
    }
    gjs -m "$REPO/scripts/ci/hyalo-capture-probe.js" window '#555555' >/tmp/hyalo/not-a-game.log 2>&1 &
    local plain_pid=$! plain
    plain="$(window_id "$cid")"
    [ -n "$plain" ] || { log "FAIL: the plain window never appeared"; exit 1; }
    nidara-hyalo msg windows | jq -e --argjson id "$plain" '.ok.windows[] | select(.id == $id) | .workspace == 1' >/dev/null \
        || { log "FAIL (control): a window that is not a game left workspace 1"; nidara-hyalo msg windows; exit 1; }
    kill "$plain_pid" 2>/dev/null || true
    sleep 0.5
    SteamAppId=440 gjs -m "$REPO/scripts/ci/hyalo-capture-probe.js" window '#555555' >/tmp/hyalo/game.log 2>&1 &
    local game_pid=$! game
    game="$(window_id "$cid")"
    [ -n "$game" ] || { log "FAIL: the game's window never appeared"; exit 1; }
    nidara-hyalo msg workspaces | jq -e '
        .ok.workspaces | map(select(.name == "gamespace" and .id < 0 and (.special | not) and .active and .focused)) | length == 1' >/dev/null \
        || { log "FAIL: no active, focused, named gamespace after a game opened"; nidara-hyalo msg workspaces; exit 1; }
    nidara-hyalo msg windows | jq -e --argjson id "$game" '.ok.windows[] | select(.id == $id) | .workspace < 0' >/dev/null \
        || { log "FAIL: the game is not on gamespace"; nidara-hyalo msg windows; exit 1; }
    kill "$game_pid" 2>/dev/null || true
    local back=""
    for i in $(seq 1 20); do
        back="$(nidara-hyalo msg workspaces | jq -r '.ok.workspaces[] | select(.focused) | .name')"
        [ "$back" = "1" ] && break
        sleep 0.5
    done
    [ "$back" = "1" ] || { log "FAIL: the shell did not take the user back to workspace 1 after the game (on '$back')"; exit 1; }
    log "game mode OK (a game to gamespace, a plain window left alone, back to workspace 1)"

    # Sandboxed clients (wp-security-context-v1, #682): a client that connects through a
    # sandbox's socket, as a Flatpak app does, must not be offered synthetic input, window
    # capture, the window list or the shell's own globals — and must still get what an
    # application needs. The probe's control is built in: every hidden global must be offered
    # OUTSIDE the sandbox, or it fails (a probe that saw nothing anywhere would pass).
    hyalo-sandbox-probe >/tmp/hyalo/sandbox-probe.log 2>&1 \
        || { log "FAIL: the sandbox probe"; cat /tmp/hyalo/sandbox-probe.log; exit 1; }
    log "sandboxed clients OK ($(sed -n 's/^RESULT //p' /tmp/hyalo/sandbox-probe.log))"
    # xdg-dialog (#682): focusing a window that has a MODAL dialog open focuses the dialog; with
    # a dialog that is not modal the parent takes the focus (the control).
    DIALOG_LOG=/tmp/hyalo/dialog-clients.log "$REPO/scripts/ci/hyalo-dialog-check.sh" >/tmp/hyalo/dialog.log 2>&1 \
        || { log "FAIL: modal dialogs"; cat /tmp/hyalo/dialog.log; exit 1; }
    log "modal dialogs OK (the parent gives way to its modal dialog, not to a plain one)"

    # Computer use (#682): the compositor's state through bin/nidara-wm (Hyprland's shapes,
    # built from Hyalo's IPC) and the virtual pointer nidara-input speaks: a move to a point
    # must leave the cursor exactly there.
    local mons w h
    mons="$("$REPO/bin/nidara-wm" monitors)"
    echo "$mons" | jq -e 'length > 0 and (.[0] | has("x") and has("y") and has("width") and has("scale") and has("focused"))' >/dev/null \
        || { log "FAIL: nidara-wm monitors is not in the shape the helpers read"; echo "$mons"; exit 1; }
    "$REPO/bin/nidara-wm" clients | jq -e 'type == "array"' >/dev/null \
        || { log "FAIL: nidara-wm clients is not a list"; exit 1; }
    w="$(echo "$mons" | jq '.[0].width / .[0].scale | floor')"; h="$(echo "$mons" | jq '.[0].height / .[0].scale | floor')"
    nidara-input move 123 77 "$w" "$h"
    sleep 0.3
    "$REPO/bin/nidara-wm" cursorpos | jq -e '.x == 123 and .y == 77' >/dev/null \
        || { log "FAIL: the virtual pointer did not land at 123,77 ($("$REPO/bin/nidara-wm" cursorpos | jq -c .))"; exit 1; }
    log "computer use OK (nidara-wm, virtual pointer)"

    # pointer-gestures (#682): a touchpad pinch over a GTK window drives its zoom gesture. Without
    # the global the seat still sees the pinch and the app hears nothing. Through HYALO_CONTROL.
    GESTURE_LOG=/tmp/hyalo/gesture-client.log "$REPO/scripts/ci/hyalo-gesture-check.sh" >/tmp/hyalo/gesture.log 2>&1 \
        || { log "FAIL: pointer gestures"; cat /tmp/hyalo/gesture.log; exit 1; }
    log "pointer gestures OK ($(sed -n 's/^ok *//p' /tmp/hyalo/gesture.log))"
    # xdg-activation (#682): an app the user just clicked may raise its other window; an app the
    # user is not in may not take the front (the control — a compositor that honoured every
    # request would pass the first half only). Real clicks, through the virtual pointer.
    nidara-hyalo msg do workspace 1 >/dev/null
    ACTIVATION_LOG=/tmp/hyalo/activation-clients.log "$REPO/scripts/ci/hyalo-activation-check.sh" \
        >/tmp/hyalo/activation.log 2>&1 \
        || { log "FAIL: xdg-activation"; cat /tmp/hyalo/activation.log /tmp/hyalo/activation-clients.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "xdg-activation OK (honoured from the user's app, refused from another)"
    # keyboard-shortcuts-inhibit (#682): a focused window that holds the shortcuts (a VM, a
    # remote desktop) gets Super+2 instead of the desktop; Super+Escape (`dont_inhibit`) gives
    # them back anyway; then Super+2 switches — the control, so the first step proved the hold
    # and not a dead key. Keys through HYALO_CONTROL.
    INHIBIT_LOG=/tmp/hyalo/inhibit-client.log "$REPO/scripts/ci/hyalo-inhibit-check.sh" >/tmp/hyalo/inhibit.log 2>&1 \
        || { log "FAIL: keyboard-shortcuts-inhibit"; cat /tmp/hyalo/inhibit.log; exit 1; }
    log "keyboard-shortcuts-inhibit OK (held, given back with Super+Escape, then the desktop's again)"
    # ext-session-lock (#683): locked only once said so, keys to the lock screen and not to the
    # window behind it, no desktop bindings, a second locker refused, a dead lock client
    # started again while the session stays locked — and after the unlock the window gets the
    # keys (the control). Keys through HYALO_CONTROL.
    LOCK_LOG=/tmp/hyalo/lock "$REPO/scripts/ci/hyalo-lock-check.sh" >/tmp/hyalo/lock.log 2>&1 \
        || { log "FAIL: the session lock"; cat /tmp/hyalo/lock.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "session lock OK ($(grep -c '^ok' /tmp/hyalo/lock.log) steps: locked, input held, relaunched, unlocked)"
    # Idle (#683): with nobody at the keys the session locks and the screens go dark; the first
    # key brings them back; a shown window holding idle off keeps it all away, and once it lets
    # go the lock comes (the control). The idle lock starts the lock check's probe.
    IDLE_LOG=/tmp/hyalo/idle "$REPO/scripts/ci/hyalo-idle-check.sh" >/tmp/hyalo/idle.log 2>&1 \
        || { log "FAIL: idle"; cat /tmp/hyalo/idle.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "idle OK ($(grep -c '^ok' /tmp/hyalo/idle.log) steps: locked and dark, woken, held off, then locked)"
    # Capture and the clipboard (#683): grim (whole output, a region, UPRIGHT), grim | wl-copy
    # and back through wl-paste, wl-paste --watch (data-control, the clipboard history), and
    # wf-recorder (wlr-screencopy) with frames, upright too.
    CAPTURE_LOG=/tmp/hyalo/screen-capture "$REPO/scripts/ci/hyalo-screen-capture-check.sh" >/tmp/hyalo/screen-capture.log 2>&1 \
        || { log "FAIL: screen capture"; cat /tmp/hyalo/screen-capture.log; exit 1; }
    log "screen capture OK ($(grep -c '^ok' /tmp/hyalo/screen-capture.log) steps: output, region, clipboard, watch, recording)"
    # Input methods (#683, #503): a stand-in input method's text reaches a focused window's
    # field (empty before it ran: the control) and the shell's search under its focus grab.
    PATH="/tmp/hyalo:$PATH" IME_LOG=/tmp/hyalo/ime "$REPO/scripts/ci/hyalo-ime-check.sh" >/tmp/hyalo/ime.log 2>&1 \
        || { log "FAIL: input methods"; cat /tmp/hyalo/ime.log; exit 1; }
    log "input methods OK ($(grep -c '^ok' /tmp/hyalo/ime.log) of 2: a window, the shell's search)"
    # Menus of the dock (#683): closed, they give the keyboard back to the window, and with an
    # input method holding the keyboard a click in another app still closes them. Real clicks.
    nidara-hyalo msg do workspace 1 >/dev/null
    POPUP_LOG=/tmp/hyalo/popup "$REPO/scripts/ci/hyalo-popup-check.sh" >/tmp/hyalo/popup.log 2>&1 \
        || { log "FAIL: menus"; cat /tmp/hyalo/popup.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "menus OK ($(grep -c '^ok' /tmp/hyalo/popup.log) of 2: the keyboard back, closed under an input method)"
    # The cursor (#682): the shell's theme survives a reload. Set only in memory, the next
    # Settings change (a keyboard layout) put the file's cursor back (found 2026-10-02).
    nidara-hyalo msg do "set-cursor Adwaita 32" >/dev/null
    nidara-hyalo msg settings '{"input":{"keyboard":{"repeat_rate":26}}}' >/dev/null
    sleep 0.5
    cur="$(nidara-hyalo msg config | jq -c '.ok.config.cursor')"
    [ "$cur" = '{"theme":"Adwaita","size":32}' ] || { log "FAIL: a reload put the cursor back ($cur)"; exit 1; }
    nidara-hyalo msg settings '{"cursor":null,"input":{"keyboard":{"repeat_rate":null}}}' >/dev/null
    log "cursor OK (the shell's theme survives a reload)"
    # Layer placement (#683): the bar and the dock both cover the monitor and each reserves its
    # strip; Hyalo places each against the whole output, whatever order they were mapped in.
    # The lock screen hides them and shows them again bar-first, and Smithay's own rule then put
    # the dock under the bar's strip, hanging off the screen (owner-caught 2026-10-02).
    /tmp/hyalo/nidara-ipc hideForLock >/dev/null
    sleep 1
    /tmp/hyalo/nidara-ipc showAfterLock >/dev/null
    sleep 2
    local placed
    placed="$(nidara-hyalo msg layers | jq -c '[.ok.layers[] | select(.namespace == "nidara-bar" or .namespace == "nidara-dock") | {namespace, y}]')"
    echo "$placed" | jq -e 'length == 2 and all(.y == 0)' >/dev/null \
        || { log "FAIL: after hiding and showing them again, the bar or the dock is out of place ($placed)"; exit 1; }
    log "layer placement OK (bar and dock back at the top of the output after a lock's hide and show)"
    # The same rule for every dock position and mapping order: a side dock must not push the
    # bar in or cut it short (it did, by its 80 px, under Smithay's rule).
    LAYERS_LOG=/tmp/hyalo/layers-probe.log "$REPO/scripts/ci/hyalo-layers-check.sh" >/tmp/hyalo/layers.log 2>&1 \
        || { log "FAIL: layer placement by dock position"; cat /tmp/hyalo/layers.log; exit 1; }
    log "layer placement OK ($(grep -c '^ok' /tmp/hyalo/layers.log) of 6: dock at the bottom, left and right, mapped before and after the bar)"
    # Every process Hyalo starts is waited for (#683). Unwaited they stayed zombies, and
    # nidara-lock, which will not start while a process of its name exists, refused every lock
    # after the first (owner-caught 2026-10-02; 5 spawns left 5 zombies before the fix).
    for _ in 1 2 3 4 5; do nidara-hyalo msg do spawn true >/dev/null; done
    sleep 1
    local zombies
    zombies="$(ps -eo ppid=,stat= | awk -v p="$(pgrep -x nidara-hyalo | head -1)" '$1 == p && $2 ~ /^Z/' | wc -l)"
    [ "$zombies" -eq 0 ] || { log "FAIL: $zombies of Hyalo's children are left as zombies"; exit 1; }
    log "spawned processes OK (none left as a zombie)"
    # Night light (#683): Hyalo sets every CRTC's gamma ramps and READS THEM BACK, answering an
    # error unless the hardware holds them. Informational here: whether vkms has a gamma LUT
    # depends on the runner's kernel; the screens that matter are real ones.
    if reply=$(nidara-hyalo msg night-light 3000 2>&1) && echo "$reply" | jq -e '.ok' >/dev/null 2>&1; then
        nidara-hyalo msg night-light off >/dev/null
        log "night light OK (3000 K set and read back on every output, then neutral)"
    else
        log "night light: not verifiable on this display ($(echo "$reply" | jq -r '.error // .' 2>/dev/null))"
    fi

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
    # A setting the shell asked for and Hyalo refused is said with this tag
    # (core/HyaloState.ts), in a console.error the toolkit grep above does not see.
    if grep -n "Hyalo refused" "$shell_log"; then
        log "FAIL: Hyalo refused a setting the shell sent"; exit 1
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
