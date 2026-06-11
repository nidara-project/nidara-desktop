#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# headless-smoke.sh — CI boot smoke test for the Crystal Shell UI.
#
# What this proves on every PR, with no GPU and no display:
#   1. The pinned dependency stack (Astal libs + AGS + appmenu) still BUILDS
#      against current Arch (install.sh would succeed for a new user).
#   2. `ags bundle` still produces a shell bundle (CI's other jobs don't bundle).
#   3. The shipped config/hypr/hyprland.lua still parses and boots Hyprland.
#   4. The shell bundle BOOTS on that Hyprland and stays alive.
#   5. The IPC surface responds (`ags request listActions` / `dumpState`).
#   6. Screenshots (grim) are captured for HUMAN review — deliberately NOT a
#      pixel diff (fragile, rejected); a person glances at the artifact.
#
# How headless works: HYPRLAND_HEADLESS_ONLY=1 makes aquamarine skip DRM/libseat
# entirely (the same mechanism Hyprland's own hyprtester uses); rendering falls
# back to llvmpipe (mesa software GL). A virtual output is created with
# `hyprctl output create headless` if none exists.
#
# Runs INSIDE an archlinux:latest container as root (see the `smoke` job in
# .github/workflows/ci.yml). Hyprland refuses to run as root, so the boot phase
# runs as an unprivileged `ci` user (`run` subcommand, re-invoked via runuser).
#
# Dependency cache: if /opt/crystal-deps.tar.zst exists (restored by
# actions/cache), the built dependency stack is unpacked instead of rebuilt;
# otherwise it is built from source and the tarball is created for the cache.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-${GITHUB_WORKSPACE:-$REPO}/smoke-out}"   # uploaded as artifact (always())
DEPS_TARBALL="/opt/crystal-deps.tar.zst"
STAGE="/opt/crystal-deps-stage"              # DESTDIR staging → tarball content

# Single source of truth for the pinned revisions: install.sh.
ASTAL_REF="$(grep -m1 '^ASTAL_REF='   "$REPO/install.sh" | cut -d'"' -f2)"
AGS_REF="$(grep -m1 '^AGS_REF='       "$REPO/install.sh" | cut -d'"' -f2)"
APPMENU_REF="$(grep -m1 '^APPMENU_REF=' "$REPO/install.sh" | cut -d'"' -f2)"

log() { echo "[smoke] $*"; }

# ─────────────────────────────────────────────────────────────────────────────
# Phase: deps — pacman packages + source-built Astal/AGS stack (as root)
# ─────────────────────────────────────────────────────────────────────────────
phase_deps() {
    log "pacman deps…"
    # -Syu (never bare -Sy): same partial-upgrade rationale as install.sh.
    pacman -Syu --needed --noconfirm \
        base-devel git cmake meson ninja vala gobject-introspection glib2-devel \
        gtk3 gtk4 gtk4-layer-shell libpeas-2 \
        libpulse networkmanager bluez-libs upower libnotify \
        pipewire wireplumber \
        nodejs npm gjs go \
        hyprland mesa dbus zstd \
        grim jq \
        ttf-jetbrains-mono-nerd inter-font noto-fonts-emoji

    if [ -f "$DEPS_TARBALL" ]; then
        log "dependency cache HIT — unpacking prebuilt Astal/AGS stack"
        tar --zstd -xf "$DEPS_TARBALL" -C /
        ldconfig
        return
    fi

    log "dependency cache MISS — building Astal/AGS stack from source"
    mkdir -p "$STAGE" /opt/src

    # meson-build $srcdir: install into / AND into $STAGE (for the cache tarball).
    build() {
        local src="$1"
        ( cd "$src" \
          && meson setup build --prefix=/usr --buildtype=release \
          && meson compile -C build \
          && meson install -C build --destdir "$STAGE" )
        cp -a "$STAGE"/usr/. /usr/
        ldconfig
    }

    # appmenu-glib-translator FIRST (libastal-tray links it) — same as install.sh.
    git clone https://gitlab.com/vala-panel-project/vala-panel-appmenu.git /opt/src/appmenu
    git -C /opt/src/appmenu checkout --quiet "$APPMENU_REF"
    build /opt/src/appmenu/subprojects/appmenu-glib-translator

    # Astal libs, dependency order (io first) — mirrors install.sh's astal_pkgs.
    git clone https://github.com/Aylur/astal.git /opt/src/astal
    git -C /opt/src/astal checkout --quiet "$ASTAL_REF"
    local astal_subdirs=(
        lib/astal/io lib/quarrel lib/astal/gtk3 lib/astal/gtk4
        lib/apps lib/hyprland lib/mpris lib/network lib/battery
        lib/notifd lib/bluetooth lib/tray lib/wireplumber lang/gjs
    )
    local sub
    for sub in "${astal_subdirs[@]}"; do
        log "astal: $sub"
        build "/opt/src/astal/$sub"
    done

    # AGS CLI (needs npm install before meson).
    git clone --branch "$AGS_REF" --depth 1 https://github.com/Aylur/ags.git /opt/src/ags
    ( cd /opt/src/ags && npm install )
    build /opt/src/ags

    log "creating dependency cache tarball"
    tar --zstd -cf "$DEPS_TARBALL" -C "$STAGE" usr
}

# ─────────────────────────────────────────────────────────────────────────────
# Phase: bundle — SCSS + ags bundle of the COMMITTED tree (as root)
# ─────────────────────────────────────────────────────────────────────────────
phase_bundle() {
    cd "$REPO/ui/shell"
    log "npm install…"
    npm install
    log "sass…"
    npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css
    log "ags bundle…"
    mkdir -p build
    ags bundle app.ts build/crystal-shell
    log "bundle OK: $(du -h build/crystal-shell | cut -f1)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Phase: boot — run Hyprland + shell as the unprivileged `ci` user
# ─────────────────────────────────────────────────────────────────────────────
phase_boot() {
    id ci &>/dev/null || useradd -m -s /bin/bash ci
    # The boot phase only WRITES to /tmp — but it must read the whole repo,
    # and `actions/checkout` leaves it owned by root.
    chmod -R a+rX "$REPO"

    export XDG_RUNTIME_DIR=/run/smoke
    mkdir -p "$XDG_RUNTIME_DIR" && chown ci "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

    # A system bus keeps libnm/bluez/upower clients from erroring at connect
    # (the services themselves are absent; the shell must tolerate that — a
    # desktop without BT/battery is a supported install).
    dbus-uuidgen --ensure
    mkdir -p /run/dbus && dbus-daemon --system --fork

    mkdir -p "$OUT" /tmp/smoke && chown ci /tmp/smoke "$OUT"

    # Everything below runs unprivileged, with a private session bus.
    runuser -u ci -- env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" REPO="$REPO" OUT="$OUT" \
        dbus-run-session -- bash "$REPO/scripts/ci/headless-smoke.sh" run
}

# ─────────────────────────────────────────────────────────────────────────────
# Subcommand: run — the actual boot + checks (executed as `ci`)
# ─────────────────────────────────────────────────────────────────────────────
phase_run() {
    export HYPRLAND_HEADLESS_ONLY=1      # aquamarine: no DRM, no libseat (hyprtester's mode)
    export LIBGL_ALWAYS_SOFTWARE=1       # mesa llvmpipe for both Hyprland and GTK
    export LANG=C.UTF-8

    local hypr_log=/tmp/smoke/hyprland.log shell_log=/tmp/smoke/shell.log
    local hypr_pid= shell_pid=

    # Always ship the logs + screenshots as artifacts, pass or fail.
    finish() {
        local rc=$?
        [ -n "$shell_pid" ] && kill "$shell_pid" 2>/dev/null || true
        [ -n "$hypr_pid" ]  && kill "$hypr_pid"  2>/dev/null || true
        cp -f /tmp/smoke/*.png /tmp/smoke/*.log /tmp/smoke/*.json "$OUT"/ 2>/dev/null || true
        if [ $rc -ne 0 ]; then
            echo "─── shell.log (tail) ───────────────────────────────"; tail -n 80 "$shell_log" 2>/dev/null || true
            echo "─── hyprland.log (tail) ────────────────────────────"; tail -n 40 "$hypr_log" 2>/dev/null || true
        fi
        return $rc
    }
    trap finish EXIT

    # ── 1. Hyprland, with the SHIPPED config (that's part of the test) ────────
    log "booting Hyprland (headless)…"
    Hyprland -c "$REPO/config/hypr/hyprland.lua" >"$hypr_log" 2>&1 &
    hypr_pid=$!

    local sig="" i
    for i in $(seq 1 30); do
        sig="$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | head -1 || true)"
        [ -n "$sig" ] && [ -S "$XDG_RUNTIME_DIR/hypr/$sig/.socket.sock" ] && break
        kill -0 "$hypr_pid" 2>/dev/null || { log "FAIL: Hyprland died during boot"; exit 1; }
        sleep 1
    done
    [ -n "$sig" ] || { log "FAIL: Hyprland socket never appeared"; exit 1; }
    export HYPRLAND_INSTANCE_SIGNATURE="$sig"
    log "Hyprland up (instance $sig)"

    # ── 2. Ensure a virtual output exists ─────────────────────────────────────
    if [ "$(hyprctl monitors -j | jq 'length')" = "0" ]; then
        hyprctl output create headless SMOKE-1
        sleep 1
    fi
    hyprctl monitors -j > /tmp/smoke/monitors.json
    [ "$(jq 'length' /tmp/smoke/monitors.json)" != "0" ] || { log "FAIL: no output after 'output create headless'"; exit 1; }
    log "monitors: $(jq -r '.[].name' /tmp/smoke/monitors.json | tr '\n' ' ')"

    # Hyprland names its Wayland socket itself; discover it instead of guessing.
    local wl
    wl="$(basename "$(ls "$XDG_RUNTIME_DIR"/wayland-* 2>/dev/null | grep -v '\.lock$' | head -1)")"
    [ -n "$wl" ] || { log "FAIL: no Wayland socket in XDG_RUNTIME_DIR"; exit 1; }
    export WAYLAND_DISPLAY="$wl"

    # ── 3. The shell bundle, exactly as production runs it ────────────────────
    log "booting crystal-shell bundle…"
    export GDK_BACKEND=wayland
    export CRYSTAL_SHELL_ROOT="$REPO/ui/shell"
    cd "$REPO/ui/shell"
    ./build/crystal-shell >"$shell_log" 2>&1 &
    shell_pid=$!

    # ── 4. Gate: stays alive + IPC answers ────────────────────────────────────
    local ok=""
    for i in $(seq 1 40); do
        kill -0 "$shell_pid" 2>/dev/null || { log "FAIL: shell process died"; exit 1; }
        if ags request listActions >/tmp/smoke/listActions.json 2>/dev/null; then ok=1; break; fi
        sleep 1
    done
    [ -n "$ok" ] || { log "FAIL: shell never answered 'ags request listActions'"; exit 1; }
    jq -e . /tmp/smoke/listActions.json >/dev/null || { log "FAIL: listActions is not valid JSON"; exit 1; }

    ags request dumpState >/tmp/smoke/dumpState.json
    jq -e '.version' /tmp/smoke/dumpState.json >/dev/null || { log "FAIL: dumpState has no .version"; exit 1; }
    log "IPC OK — shell version $(jq -r '.version' /tmp/smoke/dumpState.json)"

    # ── 5. Screenshots for human review (NOT a gate beyond grim succeeding) ───
    sleep 4                                   # let the first frames render
    grim /tmp/smoke/desktop.png
    log "captured desktop.png"
    # Control Center open — best-effort: a CC regression shouldn't mask the
    # boot gate, but the picture is valuable to reviewers.
    if ags request toggleControlCenter >/dev/null 2>&1; then
        sleep 2
        grim /tmp/smoke/control-center.png || true
        log "captured control-center.png"
    fi

    # ── 6. JS errors are a hard failure (boot must be clean) ──────────────────
    if grep -nE "JS ERROR|Unhandled promise rejection" "$shell_log" > /tmp/smoke/js-errors.txt; then
        log "FAIL: JS errors during boot:"
        cat /tmp/smoke/js-errors.txt
        exit 1
    fi

    log "SMOKE PASSED"
}

case "${1:-all}" in
    run) phase_run ;;
    all) phase_deps; phase_bundle; phase_boot ;;
    *)   echo "usage: $0 [all|run]" >&2; exit 2 ;;
esac
