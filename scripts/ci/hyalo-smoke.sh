#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# hyalo-smoke.sh — CI for Hyalo, the compositor of our own (hyalo/, #681).
#
# What it proves on every PR, in an Arch container on the runner's vkms:
#   1. hyalo/ passes `clippy -D warnings` and its unit tests, against the committed lock file.
#   2. The PACKAGE builds from this tree (packaging/nidara/PKGBUILD, makepkg) and installs with
#      pacman: desktop, kit and Hyalo, dependencies from the repositories. Everything below
#      runs the INSTALLED system — what a user gets — not the checkout.
#   3. Hyalo BOOTS on real DRM/KMS — the tty backend, the one a session uses — through
#      libseat (seatd) and udev, rendering in software (llvmpipe) on vkms.
#   4. The shell, started as the session does (nidara-ui), boots on it, stays alive and
#      answers its IPC; Hyalo's own IPC lists the output.
#   5. A screenshot of the desktop is uploaded for a HUMAN to look at — through Hyalo's IPC
#      (grim works too since 2026-10-02: scripts/ci/hyalo-screen-capture-check.sh tests it).
#   6. The shell log is held to the same bar as the Hyprland smoke: no JS errors and no
#      toolkit CRITICAL (an absent accessibility bus excepted, that is the container).
#
# The Hyprland smoke (headless-smoke.sh) stays the gate for the shell itself; this one is
# Hyalo's. Same container, same vkms, same unprivileged-user split.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-${GITHUB_WORKSPACE:-$REPO}/hyalo-out}"

log() { echo "[hyalo] $*"; }
# The checks that watch an ANIMATION on screen (minimize, motion, layer motion) race CI's
# software GL — a frame there can take 2-4 s — and failed correct PRs again and again
# (owner, 2026-10-19: "I want to work on the project, not on the CI"). They run in the nightly
# run on main (HYALO_ANIMATION_CHECKS=true from ci.yml on schedule), which opens an issue when
# one fails, and in any local run (unset: true); on a PR, not.
animations() { [ "${HYALO_ANIMATION_CHECKS:-true}" = true ]; }

phase_deps() {
    log "pacman deps…"
    # The shell's runtime (as in headless-smoke.sh) plus Hyalo's build: rust, the libraries
    # Smithay links against, and Pango/Cairo for the title bar's text (here with gtk4).
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
        nodejs npm gjs python python-gobject at-spi2-core \
        fcitx5 fcitx5-mozc fcitx5-chinese-addons fcitx5-hangul \
        orca speech-dispatcher libao \
        wayland-protocols hyprland-protocols wlr-protocols \
        jq librsvg dconf file procps-ng \
        grim slurp wl-clipboard wf-recorder ffmpeg xorg-xwayland \
        ttf-jetbrains-mono ttf-nerd-fonts-symbols-mono inter-font noto-fonts noto-fonts-cjk noto-fonts-emoji
    ldconfig
    # Disposable CI container only: sd_dummy still initializes an audio driver.
    # libao's null driver exercises the real speech server without an audio device.
    echo 'default_driver=null' > /etc/libao.conf
}

phase_build() {
    cd "$REPO/hyalo"
    # The release build is the package's (phase_package); here what a package does not run.
    log "cargo clippy -D warnings…"
    cargo clippy --locked --all-targets -- -D warnings
    log "cargo test…"
    cargo test --locked

    # The native toolkit client: its build/lint/tests are the toolkit job;
    # its real input/material/IME pixel checks run below on this vkms Hyalo.
    cargo build --manifest-path "$REPO/toolkit/Cargo.toml" --release --locked -p nk-phase0 -p nk-settings-slice

    # The checks' own clients below; everything of the product comes from the package.
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
    # The decoration probe (who draws a title bar, hyalo/compositor/src/shell/decoration.rs).
    # KDE's server-decoration is not in wayland-protocols: its XML, like input-method-v2's
    # below, comes with the wayland-protocols-misc crate.
    local dc="$REPO/build/dc" dc_xml=/usr/share/wayland-protocols/unstable/xdg-decoration/xdg-decoration-unstable-v1.xml kd_xml
    kd_xml=$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -path '*wayland-protocols-misc*' -name server-decoration.xml | head -1)
    mkdir -p "$dc"
    wayland-scanner client-header "$xs_xml" "$dc/xdg-shell-client-protocol.h"
    wayland-scanner private-code  "$xs_xml" "$dc/xdg-shell-protocol.c"
    wayland-scanner client-header "$dc_xml" "$dc/xdg-decoration-unstable-v1-client-protocol.h"
    wayland-scanner private-code  "$dc_xml" "$dc/xdg-decoration-unstable-v1-protocol.c"
    wayland-scanner client-header "$kd_xml" "$dc/server-decoration-client-protocol.h"
    wayland-scanner private-code  "$kd_xml" "$dc/server-decoration-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-decoration-probe.c" "$dc/xdg-shell-protocol.c" \
        "$dc/xdg-decoration-unstable-v1-protocol.c" "$dc/server-decoration-protocol.c" \
        -I"$dc" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-decoration-probe
    # The window-controls probe (an app leaving room for Hyalo's controls, protocols/window_controls.rs).
    local wc="$REPO/build/wc" wc_xml="$REPO/protocols/nidara-window-controls-v1.xml"
    mkdir -p "$wc"
    wayland-scanner client-header "$xs_xml" "$wc/xdg-shell-client-protocol.h"
    wayland-scanner private-code  "$xs_xml" "$wc/xdg-shell-protocol.c"
    wayland-scanner client-header "$wc_xml" "$wc/nidara-window-controls-v1-client-protocol.h"
    wayland-scanner private-code  "$wc_xml" "$wc/nidara-window-controls-v1-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-window-controls-probe.c" "$wc/xdg-shell-protocol.c" \
        "$wc/nidara-window-controls-v1-protocol.c" \
        -I"$wc" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-window-controls-probe
    # The layer-motion probe (layers Hyalo animates for their app, protocols/layers.rs: test 5
    # of the toolkit's phase 0, #818).
    local lm="$REPO/build/lm" lm_xml="$REPO/protocols/nidara-layers-v1.xml"
    mkdir -p "$lm"
    wayland-scanner client-header "$xs_xml" "$lm/xdg-shell-client-protocol.h"
    wayland-scanner private-code  "$xs_xml" "$lm/xdg-shell-protocol.c"
    wayland-scanner client-header "$lm_xml" "$lm/nidara-layers-v1-client-protocol.h"
    wayland-scanner private-code  "$lm_xml" "$lm/nidara-layers-v1-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-layer-motion-probe.c" "$lm/xdg-shell-protocol.c" \
        "$lm/nidara-layers-v1-protocol.c" \
        -I"$lm" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-layer-motion-probe
    # The layer-glass probe (a layer's own material over its window's content, and a graded
    # blur: toolkit/PHASE1.md D7).
    local lg="$REPO/build/lg" mt_xml="$REPO/protocols/nidara-material-v1.xml"
    mkdir -p "$lg"
    wayland-scanner client-header "$xs_xml" "$lg/xdg-shell-client-protocol.h"
    wayland-scanner private-code  "$xs_xml" "$lg/xdg-shell-protocol.c"
    wayland-scanner client-header "$lm_xml" "$lg/nidara-layers-v1-client-protocol.h"
    wayland-scanner private-code  "$lm_xml" "$lg/nidara-layers-v1-protocol.c"
    wayland-scanner client-header "$mt_xml" "$lg/nidara-material-v1-client-protocol.h"
    wayland-scanner private-code  "$mt_xml" "$lg/nidara-material-v1-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-layer-glass-probe.c" "$lg/xdg-shell-protocol.c" \
        "$lg/nidara-layers-v1-protocol.c" "$lg/nidara-material-v1-protocol.c" \
        -I"$lg" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-layer-glass-probe
    # The title-bar probe (an app that leaves its decorations to Hyalo, render/title_bar.rs).
    local tb="$REPO/build/tb"
    mkdir -p "$tb"
    wayland-scanner client-header "$xs_xml" "$tb/xdg-shell-client-protocol.h"
    wayland-scanner private-code  "$xs_xml" "$tb/xdg-shell-protocol.c"
    wayland-scanner client-header "$dc_xml" "$tb/xdg-decoration-unstable-v1-client-protocol.h"
    wayland-scanner private-code  "$dc_xml" "$tb/xdg-decoration-unstable-v1-protocol.c"
    local vp_xml=/usr/share/wayland-protocols/stable/viewporter/viewporter.xml
    wayland-scanner client-header "$vp_xml" "$tb/viewporter-client-protocol.h"
    wayland-scanner private-code  "$vp_xml" "$tb/viewporter-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-title-bar-probe.c" "$tb/xdg-shell-protocol.c" \
        "$tb/xdg-decoration-unstable-v1-protocol.c" "$tb/viewporter-protocol.c" \
        -I"$tb" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-title-bar-probe
    # The stand-in input method (hyalo-ime-check.sh). input-method-v2 is not in wayland-protocols:
    # its XML comes with the wayland-protocols-misc crate Hyalo was just built with.
    local im="$REPO/build/im" im_xml
    im_xml=$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -name input-method-unstable-v2.xml | head -1)
    mkdir -p "$im"
    wayland-scanner client-header "$im_xml" "$im/input-method-unstable-v2-client-protocol.h"
    wayland-scanner private-code  "$im_xml" "$im/input-method-unstable-v2-protocol.c"
    cc -O2 "$REPO/scripts/ci/hyalo-ime-probe.c" "$im/input-method-unstable-v2-protocol.c" \
        -I"$im" $(pkg-config --cflags --libs wayland-client) -o /usr/local/bin/hyalo-ime-probe
    phase_package
}

# The product as a user gets it: packaging/nidara/PKGBUILD built by makepkg from THIS tree and
# installed with pacman — every file where the package puts it, its dependencies from the
# repositories, nothing copied by hand (a hand list here once lacked the wallpapers, then the
# Settings portal: 2026-10-18). install.sh's local build takes the same recipe.
#
# Fast because nothing is unpacked or fetched twice: makepkg -e builds IN this checkout
# (src/ is a link to it), so Hyalo's and the session daemon's release builds land in the
# target dirs CI caches, and npm's tree is reused. The package is not compressed: it is
# installed here and thrown away.
phase_package() {
    log "the package: makepkg, then pacman -U…"
    id ci &>/dev/null || useradd -m -s /bin/bash ci
    local pkgver b=/tmp/nidara-pkg
    pkgver="$(sed -n 's/^pkgver=//p' "$REPO/packaging/nidara/PKGBUILD")"
    rm -rf "$b" && mkdir -p "$b/src"
    cp "$REPO/packaging/nidara/PKGBUILD" "$REPO/packaging/nidara/nidara.install" "$b/"
    ln -s "$REPO" "$b/src/nidara-desktop-$pkgver"
    # prepare() — the crates fetch — is what -e skips: done here, where the network is.
    (cd "$REPO/hyalo" && cargo fetch --locked)
    (cd "$REPO/session" && cargo fetch --locked)
    # makepkg refuses root; it builds as the user the session runs as, and writes all over the
    # tree it builds in. Not .git: the runner's own cleanup writes there after this job.
    chown ci "$REPO" && chown -R ci "$b"
    find "$REPO" -mindepth 1 -maxdepth 1 ! -name .git -exec chown -R ci {} +
    runuser -u ci -- env CARGO_HOME="$CARGO_HOME" CARGO_INCREMENTAL=0 PKGEXT=.pkg.tar \
        bash -c "cd '$b' && makepkg -e -f --nodeps --noconfirm --noprogressbar"
    # The desktop, its kit and Hyalo; not the installer, which only a live medium carries.
    pacman -U --noconfirm "$b"/nidara-{desktop,kit,hyalo}-"$pkgver"-*.pkg.tar
    python "$REPO/scripts/ci/native-host-check.py" "$REPO/build/nidara-host"
    log "package OK ($(pacman -Q nidara-desktop nidara-kit nidara-hyalo | tr '\n' ' '))"
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
    # XDG_CURRENT_DESKTOP as a real session has it (bin/nidara-hyalo-session: uwsm -D Nidara),
    # before the bus starts: xdg-desktop-portal, started by it, picks nidara-portals.conf by it.
    runuser -u ci -- env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" REPO="$REPO" OUT="$OUT" \
        XDG_CURRENT_DESKTOP=Nidara \
        NK_REAL_GATES="${NK_REAL_GATES:-true}" NK_REAL_FULL="${NK_REAL_FULL:-true}" \
        HYALO_ANIMATION_CHECKS="${HYALO_ANIMATION_CHECKS:-true}" \
        dbus-run-session -- bash "$REPO/scripts/ci/hyalo-smoke.sh" run
}

phase_run() {
    export LIBGL_ALWAYS_SOFTWARE=1 LANG=C.UTF-8 LIBSEAT_BACKEND=seatd
    hyalo_log=/tmp/hyalo/hyalo.log
    # nidara-ui writes the shell's output there (bin/nidara-ui); the link puts it with the
    # other logs, in the artifacts.
    shell_log="$XDG_RUNTIME_DIR/nidara-ui.log"
    ln -sf "$shell_log" /tmp/hyalo/shell.log
    hyalo_pid=""
    shell_pid=""
    finish() {
        local rc=$?
        [ -n "$shell_pid" ] && kill "$shell_pid" 2>/dev/null || true
        [ -n "$hyalo_pid" ] && kill "$hyalo_pid" 2>/dev/null || true
        cp -f /tmp/hyalo/*.png /tmp/hyalo/*.log /tmp/hyalo/*.json "$OUT"/ 2>/dev/null || true
        # A check's own screenshots (its *_LOG directory), named after it: what a pixel check
        # saw is the first thing to look at when it fails.
        for f in /tmp/hyalo/*/*.png; do
            [ -e "$f" ] && cp -f "$f" "$OUT/$(basename "$(dirname "$f")")-$(basename "$f")"
        done
        if [ -d /tmp/hyalo/nk-layer-motion ]; then cp -a /tmp/hyalo/nk-layer-motion "$OUT/toolkit-layer-motion"; fi
        if [ -d /tmp/hyalo/nk-phase0 ]; then cp -a /tmp/hyalo/nk-phase0 "$OUT/toolkit-phase0"; fi
        if [ -d /tmp/ni ]; then cp -a /tmp/ni "$OUT/toolkit-fcitx5"; fi
        if [ -d /tmp/no ]; then cp -a /tmp/no "$OUT/toolkit-orca"; fi
        chmod -R a+rX "$OUT"
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
    # nidara-lock (lock.rs, HYALO_LOCK_RELAUNCH). Which probe is the wrapper's choice: the guard
    # check hands Hyalo one that never locks.
    export HYALO_LOCK_RELAUNCH="LOCK_LOG=/tmp/hyalo/lock sh $REPO/scripts/ci/hyalo-lock-client.sh"
    mkdir -p /tmp/hyalo/lock
    HYALO_A11Y_MANAGER=1 HYALO_CONFIG=/usr/share/nidara/hyalo/hyalo.toml RUST_LOG=info nidara-hyalo --tty >"$hyalo_log" 2>&1 &
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
    # As the session starts it: the installed nidara-ui, which runs the packaged bundle (no
    # .dev marker for this user) and finds Settings through /usr/bin/nidara-settings.
    log "booting the shell…"
    nidara-ui &
    shell_pid=$!
    local ok=""
    for i in $(seq 1 40); do
        kill -0 "$shell_pid" 2>/dev/null || { log "FAIL: the shell died"; exit 1; }
        kill -0 "$hyalo_pid" 2>/dev/null || { log "FAIL: Hyalo died with the shell on it"; exit 1; }
        if /usr/bin/nidara-ipc listActions >/tmp/hyalo/listActions.json 2>/dev/null; then ok=1; break; fi
        sleep 1
    done
    [ -n "$ok" ] || { log "FAIL: the shell never answered nidara-ipc"; exit 1; }
    log "shell IPC OK"

    # The glass (#684): every shell surface tells Hyalo where its glass is (nidara-material-v1)
    # and Hyalo paints it. The bar and the dock each declare theirs; opening the Control
    # Center adds its panes to the bar's, so the shapes follow what is on screen.
    #
    NIDARA_SETTINGS_CHECK_ISOLATED=1 "$REPO/scripts/ci/settings-process-check.sh" /usr/bin/nidara-ipc /tmp/hyalo

    # The bar is the ONE surface every panel hangs from (#708 point 3): the Activity Island
    # and the app grid are panels of it, not layers of their own. Its resting glass is
    # therefore three pieces — the left group, the island's capsule, the right group.
    glass_shapes() {
        nidara-hyalo msg layers | jq -r --arg ns "$1" \
            '[.ok.layers[] | select(.namespace == $ns) | .glass | select(. != null and .compositor_paints) | .shapes] | max // 0'
    }
    for i in $(seq 1 20); do
        [ "$(glass_shapes nidara-bar)" -ge 3 ] && [ "$(glass_shapes nidara-dock)" -gt 0 ] && break
        sleep 0.5
    done
    for ns in nidara-bar nidara-dock; do
        [ "$(glass_shapes "$ns")" -gt 0 ] \
            || { log "FAIL: $ns declared no glass for Hyalo to paint"; nidara-hyalo msg layers; exit 1; }
    done
    # The island is one fusion group (#705 step 2): its capsule, chips and modes are drawn as
    # one silhouette. Without the group Hyalo draws each piece on its own and nothing says so.
    local fusion
    fusion="$(nidara-hyalo msg layers | jq -r \
        '[.ok.layers[] | select(.namespace == "nidara-bar") | (.glass.fusion // []) | length] | max // 0')"
    [ "$fusion" -ge 1 ] \
        || { log "FAIL: the bar's glass declares no fusion group — the island's pieces are not one silhouette"; nidara-hyalo msg layers; exit 1; }
    local strays
    strays="$(nidara-hyalo msg layers | jq -r \
        '[.ok.layers[] | select(.namespace | test("^nidara-(island|app-grid)$")) | .namespace] | unique | join(" ")')"
    [ -z "$strays" ] \
        || { log "FAIL: a panel has a layer of its own again ($strays) — it belongs on the bar's surface"; nidara-hyalo msg layers; exit 1; }
    local bar_rest bar_cc bar_grid
    bar_rest="$(glass_shapes nidara-bar)"
    [ "$bar_rest" -ge 3 ] \
        || { log "FAIL: the bar declares $bar_rest glass shapes at rest — the island's capsule is not among them"; nidara-hyalo msg layers; exit 1; }
    # Every pane of the bar and the dock carries its tone (set_tone, the glass material's
    # `TONES`): a pane without one is the bare blurred backdrop.
    local ns toned shapes
    for ns in nidara-bar nidara-dock; do
        toned="$(nidara-hyalo msg layers | jq -r --arg ns "$ns" \
            '[.ok.layers[] | select(.namespace == $ns) | .glass.toned // 0] | max // 0')"
        shapes="$(glass_shapes "$ns")"
        [ "$toned" -gt 0 ] && [ "$toned" -eq "$shapes" ] \
            || { log "FAIL: $toned of $ns's $shapes panes carry a tone"; nidara-hyalo msg layers; exit 1; }
    done
    # Where the bar and the dock draw (set_drawn_region, #761): both declare it, a small part
    # of their monitor-sized surfaces at rest — or every damage under them is blended through
    # their empty pixels — and the bar's grows with a panel open, or the panel is not drawn.
    drawn_area() {
        nidara-hyalo msg layers | jq -r --arg ns "$1" \
            '[.ok.layers[] | select(.namespace == $ns) | .drawn // empty | .[] | .[2] * .[3]] | if length == 0 then -1 else add end'
    }
    surface_area() {
        nidara-hyalo msg layers | jq -r --arg ns "$1" '[.ok.layers[] | select(.namespace == $ns) | .width * .height] | max // 0'
    }
    local area whole bar_drawn bar_drawn_cc
    for ns in nidara-bar nidara-dock; do
        for i in $(seq 1 20); do [ "$(drawn_area "$ns")" -gt 0 ] && break; sleep 0.5; done
        area="$(drawn_area "$ns")"; whole="$(surface_area "$ns")"
        [ "$area" -gt 0 ] && [ "$area" -lt $((whole / 2)) ] \
            || { log "FAIL: $ns draws over $area of its $whole px (none declared: -1)"; nidara-hyalo msg layers; exit 1; }
    done
    bar_drawn="$(drawn_area nidara-bar)"
    /usr/bin/nidara-ipc toggleCC >/dev/null
    sleep 2
    bar_cc="$(glass_shapes nidara-bar)"
    bar_drawn_cc="$(drawn_area nidara-bar)"
    # The Control Center's panes lie on ONE fixed veil, the size of the panel
    # (trackVeilRegion), rather than one shadow each: what is checked is that the veil region
    # reached Hyalo and holds the panes (the bar's own region casts nothing, so Hyalo lists
    # none for it).
    local cc_scrim
    cc_scrim="$(nidara-hyalo msg layers | jq -r \
        '[.ok.layers[] | select(.namespace == "nidara-bar") | .glass.scrims[]? | select(.kind == "veil") | .shapes] | max // 0')"
    /usr/bin/nidara-ipc toggleCC >/dev/null
    sleep 1
    [ "$bar_cc" -gt "$bar_rest" ] \
        || { log "FAIL: the Control Center's panes never reached Hyalo ($bar_rest shapes closed, $bar_cc open)"; exit 1; }
    [ "$cc_scrim" -gt 1 ] \
        || { log "FAIL: the Control Center's panes do not lie on one veil ($cc_scrim in its veil region)"; nidara-hyalo msg layers; exit 1; }
    [ "$bar_drawn_cc" -gt "$bar_drawn" ] \
        || { log "FAIL: the bar's drawn region did not grow with the Control Center open ($bar_drawn px closed, $bar_drawn_cc open) — the panel is not drawn"; exit 1; }
    # The app grid's glass lands on the bar's surface too.
    /usr/bin/nidara-ipc toggleAppGrid >/dev/null
    sleep 2
    bar_grid="$(glass_shapes nidara-bar)"
    /usr/bin/nidara-ipc toggleAppGrid >/dev/null
    sleep 1
    [ "$bar_grid" -gt "$bar_rest" ] \
        || { log "FAIL: the app grid's glass never reached the bar's surface ($bar_rest shapes closed, $bar_grid open)"; nidara-hyalo msg layers; exit 1; }
    log "glass OK (the bar's $bar_rest shapes, $bar_cc with the Control Center open, $cc_scrim of them on one veil, $bar_grid with the app grid open; the dock's; the bar draws over $bar_drawn px, $bar_drawn_cc with the Control Center)"

    # The render's instruments (#766 A): the counters answer, and the debug overlay SETTLES — an
    # overlay that showed the damage it causes itself would redraw every frame for ever (it
    # leaves its own elements out of the damage it shows; render/stats.rs). Its picture goes up
    # with the screenshots.
    sleep 2
    local idle with_overlay
    idle="$(nidara-hyalo msg stats | jq -r '[.ok.stats.outputs[].frames_drawn] | max // -1')"
    [ "$idle" -ge 0 ] || { log "FAIL: msg stats reported no output"; nidara-hyalo msg stats; exit 1; }
    nidara-hyalo msg debug-overlay on >/dev/null || { log "FAIL: msg debug-overlay refused"; exit 1; }
    sleep 3
    with_overlay="$(nidara-hyalo msg stats | jq -r '[.ok.stats.outputs[].frames_drawn] | max // -1')"
    nidara-hyalo msg screenshot /tmp/hyalo/debug-overlay.png >/dev/null || true
    nidara-hyalo msg stats > /tmp/hyalo/stats.json || true
    nidara-hyalo msg debug-overlay off >/dev/null
    [ "$with_overlay" -le $((idle + 10)) ] \
        || { log "FAIL: with the debug overlay on, the desktop at rest draws $with_overlay frames a second ($idle without it)"; cat /tmp/hyalo/stats.json; exit 1; }
    log "render stats OK (at rest: $idle frames/s, $with_overlay with the debug overlay; Hyalo's GPU time: $(jq -c '.ok.stats.gpu_time' /tmp/hyalo/stats.json))"
    # Hyalo's own animations are drawn at the moment the frame shows (#766 B): each frame queued
    # carries the vblank it was predicted for, checked against the kernel's timestamp of its flip.
    # vkms times its vblanks, so frames drawn here must come back timed; how far off they land
    # depends on llvmpipe keeping up, so it is printed, not held to a number.
    /usr/bin/nidara-ipc toggleCC >/dev/null
    sleep 0.6
    nidara-hyalo msg stats > /tmp/hyalo/presentation.json || true
    /usr/bin/nidara-ipc toggleCC >/dev/null
    sleep 1
    local timed
    timed="$(jq -r '[.ok.stats.outputs[].presentation.frames // 0] | max // 0' /tmp/hyalo/presentation.json)"
    [ "$timed" -gt 0 ] \
        || { log "FAIL: frames were drawn opening the Control Center, but none came back timed — the predicted presentation is not checked against the flip"; cat /tmp/hyalo/presentation.json; exit 1; }
    log "presentation OK ($(jq -c '[.ok.stats.outputs[] | {output, frames_drawn, presentation}]' /tmp/hyalo/presentation.json))"

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
    # The same registry for other processes (org.nidara.Config1, toolkit/PHASE1.md D1): the
    # native Settings' only door to the settings. Describe/Get/Set/Changed, and the agent gate.
    python "$REPO/scripts/ci/config-service-check.py" /usr/bin/nidara-ipc >/tmp/hyalo/config-service.log 2>&1 \
        || { log "FAIL: org.nidara.Config1"; cat /tmp/hyalo/config-service.log; exit 1; }
    log "config service OK ($(grep -c '^ok' /tmp/hyalo/config-service.log) of 13: describe, get, set, agent door, transition, blur from another process, snapshot, apply, appearance keys, enum re-read, invalid, denied, native path)"

    # The native Settings' start-up slice (#862) against THIS shell's Config1 and portal: the
    # pixels it commits must be Config1.Get's values, and with --control-default-values they
    # must not. The check refuses an all-default session, so one value is set first by a
    # writer outside the shell — the GNOME key every titlebar reads — and awaited on Config1.
    gsettings set org.gnome.desktop.wm.preferences button-layout 'close,maximize:'
    python - <<'PY' || { log "FAIL: windowControls never became left on Config1"; exit 1; }
import time
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
for _ in range(50):
    v = bus.call_sync('org.nidara.Config', '/org/nidara/Config', 'org.nidara.Config1', 'Get',
                      GLib.Variant('(as)', (['appearance.windowControls'],)), None,
                      Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if v.get('appearance.windowControls') == 'left':
        raise SystemExit(0)
    time.sleep(.1)
raise SystemExit(1)
PY
    NK_SETTINGS_DATA=/usr/share/nidara/settings-data \
        python "$REPO/toolkit/settings-slice/check.py" "$REPO/toolkit/target/release/nk-settings-slice" \
        >/tmp/hyalo/settings-slice.log 2>&1 \
        || { log "FAIL: settings start-up slice"; cat /tmp/hyalo/settings-slice.log; exit 1; }
    cat /tmp/hyalo/settings-slice.log
    gsettings reset org.gnome.desktop.wm.preferences button-layout

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
    mons="$(nidara-wm monitors)"
    echo "$mons" | jq -e 'length > 0 and (.[0] | has("x") and has("y") and has("width") and has("scale") and has("focused"))' >/dev/null \
        || { log "FAIL: nidara-wm monitors is not in the shape the helpers read"; echo "$mons"; exit 1; }
    nidara-wm clients | jq -e 'type == "array"' >/dev/null \
        || { log "FAIL: nidara-wm clients is not a list"; exit 1; }
    w="$(echo "$mons" | jq '.[0].width / .[0].scale | floor')"; h="$(echo "$mons" | jq '.[0].height / .[0].scale | floor')"
    nidara-input move 123 77 "$w" "$h"
    sleep 0.3
    nidara-wm cursorpos | jq -e '.x == 123 and .y == 77' >/dev/null \
        || { log "FAIL: the virtual pointer did not land at 123,77 ($(nidara-wm cursorpos | jq -c .))"; exit 1; }
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
    # The guard (#683): a lock client that does not start, or hangs before asking, still gets
    # the session locked — by Hyalo itself — and a working one takes it over and unlocks.
    # Before sleep, that is the session coming back locked rather than open (logind.rs).
    LOCK_LOG=/tmp/hyalo/lock GUARD_LOG=/tmp/hyalo/guard "$REPO/scripts/ci/hyalo-lock-guard-check.sh" >/tmp/hyalo/guard.log 2>&1 \
        || { log "FAIL: the lock guard"; cat /tmp/hyalo/guard.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "lock guard OK ($(grep -c '^ok' /tmp/hyalo/guard.log) steps: not started, taken over, hung, control)"
    # Capture and the clipboard (#683): grim (whole output, a region, UPRIGHT), grim | wl-copy
    # and back through wl-paste, wl-paste --watch (data-control, the clipboard history), and
    # wf-recorder (wlr-screencopy) with frames, upright too.
    CAPTURE_LOG=/tmp/hyalo/screen-capture "$REPO/scripts/ci/hyalo-screen-capture-check.sh" >/tmp/hyalo/screen-capture.log 2>&1 \
        || { log "FAIL: screen capture"; cat /tmp/hyalo/screen-capture.log; exit 1; }
    log "screen capture OK ($(grep -c '^ok' /tmp/hyalo/screen-capture.log) steps: output, region, clipboard, watch, recording, pointer)"
    # How a window is drawn (#708 point 1): rounded corners, and the blur behind a translucent
    # one — the corner's pixel shows what is behind, the stripes under the glass are blurred,
    # and Settings' switch takes the blur away and gives it back.
    LOOK_LOG=/tmp/hyalo/window-look "$REPO/scripts/ci/hyalo-window-look-check.sh" >/tmp/hyalo/window-look.log 2>&1 \
        || { log "FAIL: window look"; cat /tmp/hyalo/window-look.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "window look OK ($(grep -c '^ok' /tmp/hyalo/window-look.log) steps: look, corners, backdrop, the switch, line and shadow)"
    # Who draws a title bar: Hyalo, as Hyprland did, by xdg-decoration and KDE's
    # server-decoration — whatever the client asked — so a window that asks draws no margin
    # of its own and is rounded.
    DECORATION_LOG=/tmp/hyalo/decoration "$REPO/scripts/ci/hyalo-decoration-check.sh" >/tmp/hyalo/decoration.log 2>&1 \
        || { log "FAIL: decorations"; cat /tmp/hyalo/decoration.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "decorations OK ($(grep -c '^ok' /tmp/hyalo/decoration.log) steps: xdg, KDE, rounded)"
    # A window's controls are Hyalo's (#708 point 5): told to the app, drawn where it placed
    # them, the pointer theirs and not the app's, maximize and close carried out, the side
    # switched live. Clicks through HYALO_CONTROL.
    CONTROLS_LOG=/tmp/hyalo/window-controls "$REPO/scripts/ci/hyalo-window-controls-check.sh" >/tmp/hyalo/window-controls.log 2>&1 \
        || { log "FAIL: window controls"; cat /tmp/hyalo/window-controls.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "window controls OK ($(grep -c '^ok' /tmp/hyalo/window-controls.log) steps: placed, pointer, maximize, side, buttons, rule, close)"
    # The controls on the shell's glass (toolkit/PHASE1.md D7), read from the installed token
    # export: the header blurred inside the capsule, the ink decided by what is under it; the
    # controls (glass = false) show the header sharp through it and keep white glyphs.
    CONTROLS_GLASS_LOG=/tmp/hyalo/controls-glass python "$REPO/scripts/ci/hyalo-controls-glass-check.py" >/tmp/hyalo/controls-glass.log 2>&1 \
        || { log "FAIL: controls glass"; cat /tmp/hyalo/controls-glass.log; exit 1; }
    log "controls glass OK ($(grep -c '^ok' /tmp/hyalo/controls-glass.log) of 2, $(grep -c '^CAUGHT' /tmp/hyalo/controls-glass.log) of 2 controls caught)"
    # Minimizing (#724): hidden with its dialog, its place given by the REAL dock, drawn
    # shrinking into it (pixels), back from a click on it, the app's own minimize, tiling,
    # reduce motion, the user's buttons. Clicks through HYALO_CONTROL.
    if animations; then
        MINIMIZE_LOG=/tmp/hyalo/minimize "$REPO/scripts/ci/hyalo-minimize-check.sh" >/tmp/hyalo/minimize.log 2>&1 \
            || { log "FAIL: minimize"; cat /tmp/hyalo/minimize.log; exit 1; }
        nidara-hyalo msg do workspace 1 >/dev/null
        log "minimize OK ($(grep -c '^ok' /tmp/hyalo/minimize.log) steps: button, dialog, hidden, place, drawn, back, own request, tiling, reduce motion, buttons)"
    else
        log "minimize SKIPPED on a PR: an animation check, nightly only (HYALO_ANIMATION_CHECKS)"
    fi
    # Opening and closing (#684): a window grows out of its middle and fades in; closing — its
    # window destroyed by its app, or the app killed — a picture of it shrinks and fades where
    # it was; reduce motion and a rule's animate = false take both away; another workspace
    # slides in sideways. Pixels.
    if animations; then
        MOTION_LOG=/tmp/hyalo/motion "$REPO/scripts/ci/hyalo-motion-check.sh" >/tmp/hyalo/motion.log 2>&1 \
            || { log "FAIL: motion"; cat /tmp/hyalo/motion.log; exit 1; }
        nidara-hyalo msg do workspace 1 >/dev/null
        log "motion OK ($(grep -c '^ok' /tmp/hyalo/motion.log) steps: opens, closes, killed + reduce motion, rule, workspace slide, back at once)"
    else
        log "motion SKIPPED on a PR: an animation check, nightly only (HYALO_ANIMATION_CHECKS)"
    fi
    # Hyalo's title bar (#708 point 5): an app that asks gets it, one piece with its top row
    # (the colour measured on screen, dark ink on light), the pointer Hyalo's, dragged to move,
    # a double click to maximize, gone and back as the app switches its frame, close in it.
    TITLE_BAR_LOG=/tmp/hyalo/title-bar "$REPO/scripts/ci/hyalo-title-bar-check.sh" >/tmp/hyalo/title-bar.log 2>&1 \
        || { log "FAIL: title bar"; cat /tmp/hyalo/title-bar.log; exit 1; }
    nidara-hyalo msg do workspace 1 >/dev/null
    log "title bar OK ($(grep -c '^ok' /tmp/hyalo/title-bar.log) steps: bar, one piece, pointer, drag/maximize, switch + cut + own maximize, close)"
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
    # X11 apps (#683): Hyalo's own Xwayland, Hyalo its window manager. A window with its own
    # pid, the keyboard, the clipboard both ways, and an X11 menu that keeps drawing.
    nidara-hyalo msg do workspace 1 >/dev/null
    X11_LOG=/tmp/hyalo/x11 "$REPO/scripts/ci/hyalo-x11-check.sh" >/tmp/hyalo/x11.log 2>&1 \
        || { log "FAIL: X11 apps"; cat /tmp/hyalo/x11.log; exit 1; }
    log "X11 apps OK ($(grep -c '^ok' /tmp/hyalo/x11.log) of 5: Xwayland, a window, keys, the clipboard, a menu)"
    # First float of a window born tiled (#809), and the saved floating box (#742).
    FLOAT_SIZE_LOG=/tmp/hyalo/float-size "$REPO/scripts/ci/hyalo-float-size-check.sh" >/tmp/hyalo/float-size.log 2>&1 \
        || { log "FAIL: floating size"; cat /tmp/hyalo/float-size.log; exit 1; }
    log "floating size OK (Wayland, X11, workspace moves, and saved boxes)"
    # Shared resize borders and tiles smaller than GTK's minimum: pixels and input
    # must both stay inside the layout's cells, even with ten windows.
    RESIZE_LOG=/tmp/hyalo/resize python "$REPO/scripts/ci/hyalo-resize-check.py" >/tmp/hyalo/resize.log 2>&1 \
        || { log "FAIL: resize and small tiles"; cat /tmp/hyalo/resize.log; exit 1; }
    log "resize and small tiles OK (borders, corners, shared split, pixels and input)"
    # Layers Hyalo animates for their app (#818, test 5 of the toolkit's phase 0): they move
    # while the app is blocked, a click reaches a layer where it is seen and not where it ends,
    # and the app is told when each transition is done.
    if animations; then
        LAYER_MOTION_LOG=/tmp/hyalo/layer-motion python "$REPO/scripts/ci/hyalo-layer-motion-check.py" >/tmp/hyalo/layer-motion.log 2>&1 \
            || { log "FAIL: layer motion"; cat /tmp/hyalo/layer-motion.log; exit 1; }
        log "layer motion OK ($(grep -c '^ok' /tmp/hyalo/layer-motion.log) of 4: placed, moved while blocked, clicks where seen, done)"
    else
        log "layer motion SKIPPED on a PR: an animation check, nightly only (HYALO_ANIMATION_CHECKS)"
    fi
    # A layer's own glass (toolkit/PHASE1.md D7): the window's content under it comes out
    # blurred, and a graded pane's blur falls from its top to its bottom; each with its control.
    LAYER_GLASS_LOG=/tmp/hyalo/layer-glass python "$REPO/scripts/ci/hyalo-layer-glass-check.py" >/tmp/hyalo/layer-glass.log 2>&1 \
        || { log "FAIL: layer glass"; cat /tmp/hyalo/layer-glass.log; exit 1; }
    log "layer glass OK ($(grep -c '^ok' /tmp/hyalo/layer-glass.log) of 2, $(grep -c '^CAUGHT' /tmp/hyalo/layer-glass.log) of 2 controls caught)"
    if animations; then
        NK_PHASE0_LOG=/tmp/hyalo/nk-layer-motion python "$REPO/scripts/ci/nk-layer-motion-check.py" >/tmp/hyalo/nk-layer-motion.log 2>&1 \
            || { log "FAIL: native toolkit layer motion"; cat /tmp/hyalo/nk-layer-motion.log; exit 1; }
        log "native layer motion OK (scales 1/1.25, blocked client, click coordinates, retarget, fault controls)"
    else
        log "native layer motion SKIPPED on a PR: an animation check, nightly only (HYALO_ANIMATION_CHECKS)"
    fi
    # The cursor (#682): the shell's theme survives a reload. Set only in memory, the next
    # Settings change (a keyboard layout) put the file's cursor back (found 2026-10-02).
    nidara-hyalo msg do "set-cursor Adwaita 32" >/dev/null
    nidara-hyalo msg settings '{"input":{"keyboard":{"repeat_rate":26}}}' >/dev/null
    sleep 0.5
    # Theme and size only: `[cursor]` holds more than the shell's theme (`recorded`, #733).
    cur="$(nidara-hyalo msg config | jq -c '.ok.config.cursor | {theme, size}')"
    [ "$cur" = '{"theme":"Adwaita","size":32}' ] || { log "FAIL: a reload put the cursor back ($cur)"; exit 1; }
    nidara-hyalo msg settings '{"cursor":null,"input":{"keyboard":{"repeat_rate":null}}}' >/dev/null
    log "cursor OK (the shell's theme survives a reload)"
    # Layer placement (#683): the bar and the dock both cover the monitor and each reserves its
    # strip; Hyalo places each against the whole output, whatever order they were mapped in.
    # The lock screen used to hide them and show them again bar-first, and Smithay's own rule then
    # put the dock under the bar's strip, hanging off the screen (owner-caught 2026-10-02); both
    # mapping orders are hyalo-layers-check.sh's, below. On Hyalo the lock no longer hides them
    # at all: Hyalo shows the session until the lock screen has drawn and then nothing of it
    # (lock.rs), so hiding them first only made the desktop change ~1 s before the lock screen.
    # Here: the lock's hide leaves both mapped, and they are where they were after its show.
    /usr/bin/nidara-ipc hideForLock >/dev/null
    sleep 1
    local placed
    placed="$(nidara-hyalo msg layers | jq -c '[.ok.layers[] | select(.namespace == "nidara-bar" or .namespace == "nidara-dock") | {namespace, y}]')"
    echo "$placed" | jq -e 'length == 2' >/dev/null \
        || { log "FAIL: on Hyalo the lock's hide unmapped the bar or the dock ($placed)"; exit 1; }
    /usr/bin/nidara-ipc showAfterLock >/dev/null
    sleep 1
    placed="$(nidara-hyalo msg layers | jq -c '[.ok.layers[] | select(.namespace == "nidara-bar" or .namespace == "nidara-dock") | {namespace, y}]')"
    echo "$placed" | jq -e 'length == 2 and all(.y == 0)' >/dev/null \
        || { log "FAIL: after a lock's hide and show, the bar or the dock is out of place ($placed)"; exit 1; }
    log "layer placement OK (a lock leaves the bar and the dock mapped, at the top of the output)"
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
    if /usr/bin/nidara-ipc toggleControlCenter >/dev/null 2>&1; then
        sleep 2
        nidara-hyalo msg screenshot /tmp/hyalo/control-center.png >/dev/null || true
        # Release its focus grab before the native toolkit's input checks.
        /usr/bin/nidara-ipc toggleControlCenter >/dev/null 2>&1 || true
    fi
    log "screenshots taken"

    # Toolkit phase 0 tests 1, 2 and 4: real window, committed material,
    # virtual keyboard, scripted input method, clipboard; each oracle is broken
    # independently and must fail for its own reason. Screenshots join artifacts.
    NK_PHASE0_LOG=/tmp/hyalo/nk-phase0 python "$REPO/scripts/ci/nk-phase0-check.py" \
        > /tmp/hyalo/nk-phase0.log 2>&1 \
        || { cat /tmp/hyalo/nk-phase0.log; exit 1; }
    cat /tmp/hyalo/nk-phase0.log

    # Test 3: the direct AT-SPI provider, consumed through libatspi like Orca.
    # Every oracle has a negative control.
    NK_PHASE0_LOG=/tmp/hyalo/nk-phase0 python "$REPO/scripts/ci/nk-a11y-check.py" \
        > /tmp/hyalo/nk-a11y.log 2>&1 \
        || { cat /tmp/hyalo/nk-a11y.log; exit 1; }
    cat /tmp/hyalo/nk-a11y.log

    # Tests 2/3: real engines and real Orca, on this same vkms/tty compositor.
    # Run both even when one fails, so the two issue reports remain independent.
    # Short paths are mandatory: speech-dispatcher uses Unix sockets (108 bytes).
    # Skipped ONLY when CI's scope says the change touches nothing they use
    # (scripts/ci/ci-scope.sh, `gates`); unset — a local run, any doubt — runs them.
    if [ "${NK_REAL_GATES:-true}" = false ]; then
        log "real IME/Orca gates SKIPPED: nothing they use changed (ci-scope gates=false)"
        echo "Real fcitx5 and Orca gates skipped: nothing they use changed (scripts/ci/ci-scope.sh)." > "$OUT/real-gates-skipped.md"
    else
        local real_status=0
        # The baseline alone (scale 1, no controls) unless the checks or their faults changed
        # (ci-scope `full`); the nightly run has everything.
        if [ "${NK_REAL_FULL:-true}" = false ]; then
            export NK_FCITX5_SCALES=1 NK_REAL_CONTROLS=0
            log "real IME/Orca: baseline at scale 1 only, controls and scale 1.25 left to the nightly run (ci-scope full=false)"
        fi
        NK_PHASE0_TEST=vkms NK_PHASE0_LOG=/tmp/ni python "$REPO/scripts/ci/nk-fcitx5-check.py" \
            > /tmp/hyalo/nk-fcitx5.log 2>&1 || real_status=1
        cat /tmp/hyalo/nk-fcitx5.log
        NK_PHASE0_TEST=vkms NK_PHASE0_LOG=/tmp/no HYALO_LOG="$hyalo_log" python "$REPO/scripts/ci/nk-orca-check.py" \
            > /tmp/hyalo/nk-orca.log 2>&1 || real_status=1
        cat /tmp/hyalo/nk-orca.log
        [ "$real_status" -eq 0 ] || { log "FAIL: real IME/Orca gates; inspect toolkit-fcitx5 and toolkit-orca artifacts"; exit 1; }
    fi

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
    # The build alone, exactly as `all` does it: what hyalo-cache.yml runs to warm main's cache.
    build) phase_deps; phase_build ;;
    *)   echo "usage: $0 [all|run|build]" >&2; exit 2 ;;
esac
