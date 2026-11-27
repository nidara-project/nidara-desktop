#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# headless-smoke.sh — CI boot smoke test for the Nidara UI.
#
# What this proves on every PR, with no GPU and no display:
#   1. The desktop's gsettings schemas compile, strictly.
#   2. The in-repo C libraries build from PLAIN ARCH PACKAGES: libnidara-wl,
#      libnidara-auth (and the eight signals the lock screen connects to are in
#      its GIR), and the native hosts.
#   3. scripts/bundle.sh still produces the shell and Settings bundles, and the
#      SCSS compiles (CI's other jobs don't bundle).
#
# ⚠️ WHAT IT NO LONGER PROVES (2026-11-16, owner's decision). It used to boot
# Hyprland on vkms with the shipped config/hypr/hyprland.lua, boot the TS shell
# on it, ask its IPC door, run the config store's assertions and fail on a GTK
# CRITICAL in the boot log. Nothing has to boot on Hyprland any more, and no
# session starts the TS shell: the boot that counts is hyalo-smoke.sh's. The
# job keeps its name ("Headless boot smoke") because it is a REQUIRED check:
# renaming it means changing the branch protection in the same move.
#
# Runs INSIDE an archlinux:latest container (docker run, see the `smoke` job in
# ci.yml), as root.
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { echo "[smoke] $*"; }

# ─────────────────────────────────────────────────────────────────────────────
# Phase: deps — pacman packages, all from official Arch repos (as root)
# ─────────────────────────────────────────────────────────────────────────────
phase_deps() {
    log "pacman deps…"
    # -Syu (never bare -Sy): same partial-upgrade rationale as install.sh.
    # wlr-protocols is for libnidara-wl, not for a wlr feature: see the PROTOCOLS
    # list in lib/nidara-wl/build.sh for why the wlr XML has to be scanned too.
    pacman -Syu --needed --noconfirm \
        base-devel git gobject-introspection glib2-devel esbuild \
        gtk3 gtk4 gtk4-layer-shell pam \
        libpulse networkmanager libnma-gtk4 bluez-libs upower libnotify \
        pipewire wireplumber libwireplumber \
        nodejs npm gjs python \
        mesa dbus systemd \
        wayland-protocols hyprland-protocols wlr-protocols \
        jq librsvg dconf \
        ttf-jetbrains-mono ttf-nerd-fonts-symbols-mono inter-font noto-fonts-emoji

    ldconfig
}

# ─────────────────────────────────────────────────────────────────────────────
# Phase: bundle — SCSS + scripts/bundle.sh of the COMMITTED tree (as root)
# ─────────────────────────────────────────────────────────────────────────────
phase_bundle() {
    # The desktop's settings schemas (#573), where the package puts them. Without
    # them every settings store falls back to memory.
    install -Dm644 -t /usr/share/glib-2.0/schemas "$REPO"/config/gsettings/*.gschema.xml
    glib-compile-schemas --strict /usr/share/glib-2.0/schemas
    log "gsettings schemas OK"

    # libnidara-wl first. The shell TOLERATES it missing (VisibleRegion.ts imports
    # it lazily and falls back to full surfaces), so this is not about booting —
    # it is so the smoke exercises the real path, and so a broken build.sh fails
    # CI here instead of silently degrading every user's session.
    log "libnidara-wl…"
    local wl_build="$REPO/build/nidara-wl"
    "$REPO/lib/nidara-wl/build.sh" "$wl_build" >/dev/null
    install -Dm755 "$wl_build/libnidara-wl.so.0.0.0" /usr/lib/libnidara-wl.so.0.0.0
    ln -sf libnidara-wl.so.0.0.0 /usr/lib/libnidara-wl.so.0
    ln -sf libnidara-wl.so.0     /usr/lib/libnidara-wl.so
    install -Dm644 "$wl_build/NidaraWl-1.0.typelib" \
        /usr/lib/girepository-1.0/NidaraWl-1.0.typelib
    ldconfig
    log "libnidara-wl OK"

    # libnidara-auth. The shell never loads it, the LOCKSCREEN does. It is here
    # because until 2026-08-23 it was the ONLY C library in the repo that no CI
    # job compiled, and it is the one that authenticates: a C error or a broken
    # build.sh reached people at `install.sh` time instead of failing here.
    #
    # The signal list is the second half of the gate. GJS resolves a signal name
    # at `connect()` time, so a renamed or dropped signal is not a compile error
    # anywhere — it is an exception thrown the first time someone locks their
    # screen, on a surface no automated boot visits. These eight are the ones
    # the lock screen connects to (toolkit/lockscreen/src/auth.rs).
    log "libnidara-auth…"
    local auth_build="$REPO/build/nidara-auth"
    "$REPO/lib/nidara-auth/build.sh" "$auth_build" >/dev/null
    local sig
    for sig in success fail auth-prompt-hidden auth-prompt-visible \
               auth-info auth-error password-expired account-denied; do
        if ! grep -q "glib:signal name=\"$sig\"" "$auth_build/NidaraAuth-1.0.gir"; then
            log "FATAL: libnidara-auth exposes no \"$sig\" signal — the lockscreen connects to it."
            return 1
        fi
    done
    log "libnidara-auth OK (8 signals)"

    "$REPO/lib/nidara-host/build.sh" "$REPO/build/nidara-host"
    python "$REPO/scripts/ci/native-host-check.py" "$REPO/build/nidara-host"
    for host in "$REPO"/build/nidara-host/nidara-*; do
        install -Dm755 "$host" "/usr/lib/nidara/${host##*/}"
    done
    cd "$REPO/ui/shell"
    log "npm install…"
    npm install
    log "sass…"
    # The kit's sheet first: the shell loads it at runtime from the source tree
    # (ui/lib/nidara-kit/kit.css, next to NIDARA_SHELL_ROOT) — tech-debt #108 phase 2.
    npx sass --no-charset ../lib/nidara-kit/styles/kit.scss ../lib/nidara-kit/kit.css && sed -i '/@charset/d' ../lib/nidara-kit/kit.css
    npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css
    log "bundle…"
    mkdir -p build
    # The kit is loaded at runtime (#108 phase 3), from the checkout here — the
    # same modules a release installs at /usr/share/nidara-kit/js.
    node "$REPO/scripts/bundle.mjs" kit "$REPO/ui/lib/nidara-kit/build/js"
    "$REPO/scripts/bundle.sh" app.ts build/nidara --native-host=nidara-shell --kit-external="$REPO/ui/lib/nidara-kit/build/js"
    npx sass --no-charset ../settings/style.scss ../settings/style.css
    ( cd ../settings; mkdir -p build; "$REPO/scripts/bundle.sh" app.ts build/nidara-settings --native-host=nidara-settings --kit-external="$REPO/ui/lib/nidara-kit/build/js" )
    log "bundle OK: $(du -h build/nidara | cut -f1)"
}

case "${1:-all}" in
    all) phase_deps; phase_bundle; log "SMOKE PASSED" ;;
    *)   echo "usage: $0 [all]" >&2; exit 2 ;;
esac
