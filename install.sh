#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Nidara — Installer
# Usage:
#   ./install.sh            # System install (recommended for end users)
#   ./install.sh --dev      # Developer install (run UI from source)
#   ./install.sh --update   # Update an existing install (or use nidara-update)
#
# Update model: STABLE updates are STATELESS — `nidara-update` (bin/) shallow-clones
# the newest release tag from the remote into a throwaway temp dir, builds/installs
# from there, and discards it. No per-user source copy: the source of truth is the
# git remote + what's installed in /usr/share. (The runtime is system-wide, so a
# per-user clone made no sense and diverged between users.) The pinned Astal/AGS/
# appmenu stack is still rebuilt ONLY when the pins changed (/usr/share/nidara/pins).
# A --dev install registers the developer's own clone (~/.config/nidara/.dev +
# .source) and updates from there, following its branch (same pin-skip). A plain
# `./install.sh` (system) always rebuilds the whole stack — the escape hatch — and
# migrates away any legacy ~/.local/share/nidara/src.
# Agent-carried local patches (clone path recorded in ~/.config/nidara/.patches —
# see the in-repo nidara skill, "Carrying a GLOBAL fix locally") make nidara-update
# refuse the blind stateless path: the agent rebases the patch branch onto the new
# release and re-runs --update-apply instead. --update likewise refuses to checkout
# a release over local-only commits rather than silently dropping them.
# ─────────────────────────────────────────────────────────────────────────────

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# When run via `sudo bash install.sh`, $HOME is /root. Use SUDO_USER's home instead.
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
CONFIG_DIR="${REAL_HOME}/.config/nidara"

# Update plumbing (see header). SOURCE_FILE records a DEV install's source clone.
# SRC_CANON is the LEGACY per-user source copy: no longer created (stable updates
# are stateless) — kept here only so a system install can migrate it away.
SRC_CANON="${REAL_HOME}/.local/share/nidara/src"
SOURCE_FILE="$CONFIG_DIR/.source"
PINS_FILE="/usr/share/nidara/pins"
REPO_URL="https://github.com/nidara-project/nidara-desktop.git"

# ── Mode selection ────────────────────────────────────────────────────────────
# update       = pull the registered source, then re-exec the NEW installer
# update-apply = internal: like system, but skips unchanged deps and never
#                touches the user's dev/source markers
MODE="system"
for arg in "$@"; do
    case "$arg" in
        --dev)          MODE="dev" ;;
        --update)       MODE="update" ;;
        --update-apply) MODE="update-apply" ;;
        --help) echo "Usage: $0 [--system|--dev|--update]"; exit 0 ;;
    esac
done

# ── Pinned upstream versions ──────────────────────────────────────────────────
# The Astal/AGS/appmenu libraries are built from source. Building against an
# upstream's moving HEAD has bitten us before (e.g. the GJS 1.88 break of
# `ags request`), so each source build is pinned to a known-good revision.
#
# MAINTAINERS: bump these and re-test a clean install before tagging a release.
# Astal has no git tags, so it is pinned by commit SHA.
ASTAL_REF="948805f6e8cf7f8c08eba06ab1db1eef0e75e3a0"   # github.com/aylur/astal @ main (includes tray unregister fix, PR #451)
AGS_REF="v3.1.2"                                        # github.com/aylur/ags release tag
APPMENU_REF="aea4ea398b7c75494f23f5e5bdb4f495d615059f"  # gitlab vala-panel-appmenu @ master

# Build dir for the source-built dependency packages (Astal libs, AGS, appmenu).
PKG_CACHE="${REAL_HOME}/.cache/nidara/pkgbuild"

# Run a command as the unprivileged user. makepkg refuses to run as root, so when
# the installer itself is invoked via `sudo` we drop back to $REAL_USER (with -H so
# npm/go caches land in the user's home, not /root).
run_user() {
    if [ "$(id -u)" -eq 0 ]; then sudo -u "$REAL_USER" -H "$@"; else "$@"; fi
}

# makepkg the PKGBUILD in dir $1, then hand the result to pacman. We --overwrite
# because earlier Nidara releases `meson install`-ed these libs straight into
# /usr as UNTRACKED files (invisible to `pacman -Qo`, unupgradable, unremovable —
# the exact blind spot that hid a stale, crashing appmenu-glib-translator). This
# transition gives those paths to pacman; from here they upgrade/remove cleanly.
build_install_pkg() {
    local dir="$1"
    mkdir -p "$PKG_CACHE/src"
    chown -R "$REAL_USER" "$dir" "$PKG_CACHE/src" 2>/dev/null || true
    # -f rebuild, --nodeps (install order is managed below), --skipinteg (git sources)
    run_user bash -c "cd '$dir' && SRCDEST='$PKG_CACHE/src' makepkg -f --noconfirm --nodeps --skipinteg --noprogressbar"
    local pkgfile
    pkgfile="$(ls -t "$dir"/*.pkg.tar.* 2>/dev/null | head -1)"
    [ -n "$pkgfile" ] || { echo "  [ERR] makepkg produced no package in $dir" >&2; exit 1; }
    sudo pacman -U --noconfirm --overwrite '*' "$pkgfile"
}

echo ""
echo "  Nidara Installer"
echo "  Mode: $MODE"
echo "  Repo: $REPO_DIR"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Update mode: refresh the registered source, then hand over to the NEW installer
# (--update-apply) so the update always runs with the just-pulled logic.
# ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "update" ]; then
    SRC=""
    [ -f "$SOURCE_FILE" ] && SRC="$(cat "$SOURCE_FILE")"
    if [ -z "$SRC" ] || [ ! -d "$SRC/.git" ]; then
        # Pre-registration installs: fall back to the checkout we're running from.
        if [ -d "$REPO_DIR/.git" ]; then
            SRC="$REPO_DIR"
        else
            echo "  [ERR] No registered source and this directory is not a git checkout." >&2
            echo "        Re-clone the repo and run ./install.sh once to (re)register it:" >&2
            echo "          git clone $REPO_URL && cd nidara-desktop && ./install.sh" >&2
            exit 1
        fi
    fi

    echo "  Updating source: $SRC"
    if [ -n "$(run_user git -C "$SRC" status --porcelain)" ]; then
        echo "  [ERR] $SRC has local changes — refusing to update over them." >&2
        echo "        Commit/stash them (or update manually with git), then retry. Local" >&2
        echo "        fixes meant to survive updates belong committed on a local/patches" >&2
        echo "        branch — see the nidara skill, 'Carrying a GLOBAL fix locally'." >&2
        exit 1
    fi
    # Fetch ONLY release tags (v*), never --tags: the repo also carries MOVING
    # utility tags (ci-assets, re-pointed on every typings republish) and git
    # refuses to clobber a changed local tag, aborting the whole update. Release
    # tags are immutable so the plain (non-forced) refspec is safe; the branch
    # itself is fetched by the pull below.
    run_user git -C "$SRC" fetch origin 'refs/tags/v*:refs/tags/v*'

    # Dev clones follow their branch; everyone else jumps to the newest release
    # tag when releases exist (the stable channel), or fast-forwards main before
    # the first release.
    latest_tag="$(run_user git -C "$SRC" tag -l 'v*' --sort=-v:refname | head -1)"
    if [ -f "$CONFIG_DIR/.dev" ] || [ -z "$latest_tag" ]; then
        run_user git -C "$SRC" pull --ff-only origin "$(run_user git -C "$SRC" rev-parse --abbrev-ref HEAD)" \
            || { echo "  [ERR] fast-forward pull failed (diverged history?) — update manually with git." >&2; exit 1; }
    else
        # Local commits the release doesn't include (agent-carried patches — see the
        # nidara skill, "Carrying a GLOBAL fix locally") would be silently dropped by
        # the checkout below. Refuse loudly; the carry flow rebases + --update-apply.
        local_commits="$(run_user git -C "$SRC" rev-list --count "$latest_tag..HEAD" --not --remotes=origin 2>/dev/null || echo 0)"
        if [ "${local_commits:-0}" -gt 0 ]; then
            echo "  [ERR] $SRC carries $local_commits local commit(s) that $latest_tag doesn't include —" >&2
            echo "        updating would silently stop applying them. Ask your agent to update:" >&2
            echo "        it rebases the patches onto $latest_tag and re-runs the apply pass" >&2
            echo "        (git rebase $latest_tag && ./install.sh --update-apply)." >&2
            exit 1
        fi
        run_user git -C "$SRC" checkout -q "$latest_tag"
        echo "  Source at release $latest_tag"
    fi

    exec bash "$SRC/install.sh" --update-apply
fi

# ─────────────────────────────────────────────────────────────────────────────
# Release channel for fresh system installs: a normal `git clone` lands on main's
# tip, which may be ahead of the latest release — installing it would hand the
# user an unlabelled dev snapshot AND make their first nidara-update a
# silent downgrade to the newest tag. So: on a CLEAN main checkout with release
# tags available, jump to the newest tag and re-exec the installer from there
# (its pins may differ). Loop-safe: after checkout HEAD is detached, so this
# block no-ops on the second pass. Deliberate opt-outs keep working: --dev
# installs, dirty trees, and checkouts on any other branch/commit are untouched.
# ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "system" ] && [ -d "$REPO_DIR/.git" ] \
   && [ "$(run_user git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] \
   && [ -z "$(run_user git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
    release_tag="$(run_user git -C "$REPO_DIR" tag -l 'v*' --sort=-v:refname | head -1)"
    if [ -n "$release_tag" ] \
       && [ "$(run_user git -C "$REPO_DIR" rev-parse "$release_tag^{commit}")" != "$(run_user git -C "$REPO_DIR" rev-parse HEAD)" ]; then
        echo "  Installing release $release_tag (main may be ahead of the release channel)"
        run_user git -C "$REPO_DIR" checkout -q "$release_tag"
        exec bash "$REPO_DIR/install.sh"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Decide whether the pinned dependency stack (Astal libs + AGS + appmenu) must be
# rebuilt. It's expensive to build from source, so it's skipped when the pins
# recorded at the last install ($PINS_FILE) already match this script's pins —
# then phases 1, 2 and 4 are skipped and only Nidara's own artifacts are rebuilt.
#
# Which modes consult the pins:
#   update-apply : skip on a pin match; ALSO skip when no pins are recorded yet
#                  (pre-pin-era install whose stack is assumed current).
#   dev          : skip ONLY on a positive pin match. A missing pins file means
#                  the stack was never built on this machine, so it must build —
#                  this is what makes re-running `./install.sh --dev` while
#                  iterating on the shell cheap (no Astal recompile).
#   system       : never skipped. Plain `./install.sh` is the documented
#                  "rebuild everything from scratch" escape hatch.
# ─────────────────────────────────────────────────────────────────────────────
REBUILD_DEPS="yes"
# Phase 1 (pacman) has its own fingerprint, separate from the source-build pins:
# a pin match skips the expensive Astal/AGS rebuild, but a CHANGED package list
# (e.g. a new runtime tool like playerctl) must still sync packages — otherwise
# updated installs silently miss dependencies that fresh installs get.
PACMAN_SHA_FILE="/usr/share/nidara/pins-pacman"
SYNC_PACMAN="yes"
PACMAN_DEPS="base-devel glib2-devel cmake meson ninja gobject-introspection vala
    gtk3 gtk4 gtk-layer-shell gtk4-layer-shell libpeas-2
    libpulse networkmanager bluez bluez-libs bluez-utils upower libnotify
    intltool scdoc brightnessctl pamixer playerctl
    jq curl slurp grim wf-recorder wl-clipboard cliphist mesa pam
    pipewire pipewire-audio pipewire-alsa pipewire-pulse wireplumber
    git nodejs npm gjs go
    at-spi2-core wtype wlr-protocols wayland
    accountsservice greetd pavucontrol rust cargo
    hyprland hypridle hyprsunset uwsm power-profiles-daemon python-gobject
    kitty nautilus gnome-calculator
    polkit-gnome
    xdg-desktop-portal-gtk xdg-desktop-portal-hyprland
    ttf-jetbrains-mono-nerd inter-font noto-fonts-emoji
    papirus-icon-theme adwaita-icon-theme xdg-utils gsettings-desktop-schemas
    awww lz4"
DEPS_LIST_SHA="$(printf '%s' "$PACMAN_DEPS" | sha256sum | awk '{print $1}')"
# Set to "yes" once the Astal/AGS/appmenu stack is installed as prebuilt packages
# from nidara-repo (the binary pacman repo). When yes, the from-source build steps
# (§2, §4) are skipped — they remain only as the fallback when the repo is
# unreachable or incomplete.
DEPS_FROM_REPO="no"
OLD_VERSION="$(cat /usr/share/nidara/VERSION 2>/dev/null || echo "?")"
# An update of a dev-mode install must keep dev semantics (config symlinks into
# the source tree) — otherwise the update would silently downgrade them to copies.
DEV_LIKE="no"
[ "$MODE" = "dev" ] && DEV_LIKE="yes"
[ "$MODE" = "update-apply" ] && [ -f "$CONFIG_DIR/.dev" ] && DEV_LIKE="yes"
if [ "$MODE" = "update-apply" ] || [ "$MODE" = "dev" ]; then
    new_pins="$(printf 'ASTAL_REF=%s\nAGS_REF=%s\nAPPMENU_REF=%s\n' "$ASTAL_REF" "$AGS_REF" "$APPMENU_REF")"
    if [ -f "$PINS_FILE" ] && [ "$new_pins" = "$(cat "$PINS_FILE")" ]; then
        REBUILD_DEPS="no"
        echo "  Dependency pins unchanged — skipping the Astal/AGS rebuild."
    elif [ ! -f "$PINS_FILE" ] && [ "$MODE" = "update-apply" ]; then
        # Installs that predate pin recording: assume the stack matches current
        # pins (it was built from this same repo recently). Recorded from now on;
        # if anything misbehaves, a plain ./install.sh rebuilds everything.
        REBUILD_DEPS="no"
        echo "  [WARN] No pin record found (pre-update-era install). Assuming the"
        echo "         dependency stack is current; it will be recorded this time."
    elif [ ! -f "$PINS_FILE" ]; then
        # Fresh dev install: the stack was never built here, so build it.
        echo "  No pin record found — building the Astal/AGS stack."
    else
        echo "  Dependency pins changed — full stack rebuild required."
    fi
    # Even on a pin match, run phase 1 if the pacman list changed since the
    # last install. A missing record = pre-fingerprint install → sync once
    # (converges any dep added while this record didn't exist) and record.
    if [ "$REBUILD_DEPS" = "no" ]; then
        if [ -f "$PACMAN_SHA_FILE" ] && [ "$DEPS_LIST_SHA" = "$(cat "$PACMAN_SHA_FILE")" ]; then
            SYNC_PACMAN="no"
        else
            echo "  Package list changed (or not yet recorded) — phase 1 will run."
        fi
    fi
fi

# (System environment detection — keyboard layout / timezone / locale — lives
# in bin/nidara-setup now, next to its only consumers: the per-user config
# seeds and the greetd template.)

# ─────────────────────────────────────────────────────────────────────────────
# nidara-repo trust & registration
# The binary pacman repo (GitHub Pages) ships the Astal/AGS/appmenu stack
# prebuilt. Its CI GPG-signs every package and the repo db (since 2026-07-05);
# the public key travels with this repo (packaging/nidara-repo.gpg) so a fresh
# install needs no extra network fetch to establish trust.
#
# This block runs UNCONDITIONALLY (deliberately outside §1's pin-skip):
# installs registered in the unsigned era carry `SigLevel = Optional TrustAll`
# in pacman.conf and must be tightened even when phase 1 is skipped. Every step
# is an idempotent no-op after the first run.
# ─────────────────────────────────────────────────────────────────────────────
NIDARA_REPO_KEY="80B0AC8C36A43611A8619959B06B716279F755A9"
if ! pacman-key --list-keys "$NIDARA_REPO_KEY" &>/dev/null; then
    echo "  Importing the nidara-repo signing key into pacman's keyring..."
    sudo pacman-key --add "$REPO_DIR/packaging/nidara-repo.gpg"
    # lsign = local trust; without it pacman ignores signatures from this key.
    sudo pacman-key --lsign-key "$NIDARA_REPO_KEY"
fi
if ! grep -q '^\[nidara\]' /etc/pacman.conf 2>/dev/null; then
    echo "  Registering nidara-repo in /etc/pacman.conf..."
    # `$arch` stays literal — pacman expands it (single-quoted printf format
    # keeps the shell from touching it).
    printf '\n[nidara]\nSigLevel = Required DatabaseOptional\nServer = https://nidara-project.github.io/nidara-repo/$arch\n' \
        | sudo tee -a /etc/pacman.conf > /dev/null
elif grep -A2 '^\[nidara\]' /etc/pacman.conf | grep -q '^SigLevel = Optional TrustAll$'; then
    # Unsigned-era registration: flip it to signature verification. The sed
    # range keeps the substitution inside the [nidara] section only.
    echo "  Migrating nidara-repo to GPG signature verification..."
    sudo sed -i '/^\[nidara\]/,/^\[/ s/^SigLevel = Optional TrustAll$/SigLevel = Required DatabaseOptional/' /etc/pacman.conf
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. System dependencies
# ─────────────────────────────────────────────────────────────────────────────
if [ "$REBUILD_DEPS" = "no" ] && [ "$SYNC_PACMAN" = "no" ]; then
echo "[1/7] System dependencies — skipped (pins and package list unchanged)."
else
echo "[1/7] Installing system dependencies..."
# nidara-repo registration + signing key live in the unconditional block above
# (they must also run when this phase is pin-skipped, to migrate old installs).
# -Syu, never bare -Sy: syncing the DBs without a full upgrade leaves a partial-upgrade
# state, and the next --needed install pulls a new lib (e.g. aquamarine) whose soname no
# longer matches already-installed packages (e.g. hyprtoolkit) → transaction fails.
# The list itself lives in PACMAN_DEPS (top of the script) so its fingerprint
# can be compared on updates. Unquoted on purpose: word-splitting wanted.
sudo pacman -Syu --needed --noconfirm $PACMAN_DEPS

# Install the Astal/AGS/appmenu stack from nidara-repo (prebuilt binaries) instead
# of compiling it. aylurs-gtk-shell only depends on astal-gjs + gjs, and every
# libastal-* package declares depends=() (its real runtime deps came from the
# pacman -S above), so the whole stack must be listed explicitly — dep resolution
# alone would not pull the libastal-* libs. On ANY failure (repo down, package
# missing, version skew) we leave DEPS_FROM_REPO=no and fall through to the
# from-source build in §2/§4 — the installer still succeeds, just slower.
# NOTE (lockstep): this package list mirrors nidara-repo (built from its pins.env);
# keep it in sync with §2's astal_pkgs + §4's ags + the appmenu package name.
echo "  Installing the Astal/AGS stack from nidara-repo (prebuilt)..."
if sudo pacman -S --needed --noconfirm \
    aylurs-gtk-shell appmenu-glib-translator \
    libastal-io astal-quarrel libastal-gtk3 libastal-gtk4 libastal-apps \
    libastal-hyprland libastal-mpris libastal-network libastal-battery \
    libastal-notifd libastal-bluetooth libastal-tray libastal-wireplumber \
    libastal-greet libastal-auth; then
    # Lockstep guard: `pacman -S` can "succeed" with STALE versions when nidara-repo
    # hasn't been rebuilt for a pin bump yet (its packages still predate the new
    # *_REF). That would silently install outdated deps AND let §6 record the new
    # pins as if they matched — a mismatch the source fallback would never catch on
    # its own. The package versions encode the pins (Astal/appmenu = r<sha7>, ags =
    # the tag), so verify the installed versions match THIS script's pins; if any
    # don't, treat it as a repo miss and fall through to the from-source build below
    # (which always builds the exact pinned revision).
    _astal_v="$(pacman -Q libastal-io 2>/dev/null | awk '{print $2}')"
    _ags_v="$(pacman -Q aylurs-gtk-shell 2>/dev/null | awk '{print $2}')"
    _appmenu_v="$(pacman -Q appmenu-glib-translator 2>/dev/null | awk '{print $2}')"
    if [[ "$_astal_v" == *"r${ASTAL_REF:0:7}"* ]] \
    && [[ "$_ags_v" == "${AGS_REF#v}-"* ]] \
    && [[ "$_appmenu_v" == *"r${APPMENU_REF:0:7}"* ]]; then
        DEPS_FROM_REPO="yes"
        echo "  [OK] Astal/AGS stack installed from nidara-repo (pins verified) — skipping source builds."
    else
        echo "  [WARN] nidara-repo versions don't match the current pins — the repo was"
        echo "         likely not rebuilt for this bump yet (astal=$_astal_v ags=$_ags_v appmenu=$_appmenu_v)."
        echo "         Falling back to building the Astal/AGS stack from source."
    fi
else
    echo "  [WARN] nidara-repo unavailable or incomplete — falling back to building"
    echo "         the Astal/AGS stack from source (this is slower)."
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Build & install Astal dependencies
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/7] Building & packaging Astal service libraries..."
if [ "$REBUILD_DEPS" = "no" ]; then
echo "  Skipped (pins unchanged)."
elif [ "$DEPS_FROM_REPO" = "yes" ]; then
echo "  Skipped (installed from nidara-repo)."
else
mkdir -p "$PKG_CACHE/src"
chown -R "$REAL_USER" "$PKG_CACHE" 2>/dev/null || true

# ── appmenu-glib-translator (build/runtime dep of libastal-tray) ──────────────
# Build this FIRST: libastal-tray links it. Pinned by $APPMENU_REF.
echo "  Packaging appmenu-glib-translator..."
appmenu_dir="$PKG_CACHE/appmenu-glib-translator"
mkdir -p "$appmenu_dir"
cat > "$appmenu_dir/PKGBUILD" <<PKGB
pkgname=appmenu-glib-translator
pkgver=25.04.r${APPMENU_REF:0:7}
_commit=$APPMENU_REF
PKGB
cat >> "$appmenu_dir/PKGBUILD" <<'PKGB'
pkgrel=1
pkgdesc="DBusMenu→GMenuModel translator (pinned for Nidara)"
arch=(x86_64)
url="https://gitlab.com/vala-panel-project/vala-panel-appmenu"
license=(LGPL3)
depends=()
makedepends=(meson ninja vala gobject-introspection git glib2-devel)
options=(!debug)
source=("vala-panel-appmenu::git+https://gitlab.com/vala-panel-project/vala-panel-appmenu.git#commit=$_commit")
sha256sums=('SKIP')
build() {
  cd "$srcdir/vala-panel-appmenu/subprojects/appmenu-glib-translator"
  meson setup build --prefix=/usr --buildtype=release
  meson compile -C build
}
package() {
  cd "$srcdir/vala-panel-appmenu/subprojects/appmenu-glib-translator"
  DESTDIR="$pkgdir" meson install -C build
}
PKGB
build_install_pkg "$appmenu_dir"

# ── Astal libraries ───────────────────────────────────────────────────────────
# Astal has no root meson.build: each lib is built standalone and finds the others
# via pkg-config, so they MUST be built+installed in dependency order (io first).
# One package per lib (mirrors the AUR libastal-* layout) keeps each individually
# trackable. The astal source is cloned once into the shared SRCDEST and reused.
# depends=() is intentional: every runtime dep is already pulled in by step 1's
# `pacman -S`, and empty deps keep this first packaging pass from failing on
# transient resolution. (nidara-repo can tighten these later — see packaging/README.)
echo "  Packaging Astal components (in dependency order)..."
astal_pkgs=(
    "lib/astal/io|libastal-io"
    "lib/quarrel|astal-quarrel"
    "lib/astal/gtk3|libastal-gtk3"
    "lib/astal/gtk4|libastal-gtk4"
    "lib/apps|libastal-apps"
    "lib/hyprland|libastal-hyprland"
    "lib/mpris|libastal-mpris"
    "lib/network|libastal-network"
    "lib/battery|libastal-battery"
    "lib/notifd|libastal-notifd"
    "lib/bluetooth|libastal-bluetooth"
    "lib/tray|libastal-tray"
    "lib/wireplumber|libastal-wireplumber"
    "lib/greet|libastal-greet"
    "lib/auth|libastal-auth"
    "lang/gjs|astal-gjs"
)
for entry in "${astal_pkgs[@]}"; do
    subdir="${entry%%|*}"
    name="${entry##*|}"
    pdir="$PKG_CACHE/$name"
    mkdir -p "$pdir"
    cat > "$pdir/PKGBUILD" <<PKGB
pkgname=$name
pkgver=0.1.0.r${ASTAL_REF:0:7}
_subdir=$subdir
_commit=$ASTAL_REF
PKGB
    cat >> "$pdir/PKGBUILD" <<'PKGB'
pkgrel=1
pkgdesc="Astal library ($_subdir), pinned for Nidara"
arch=(x86_64)
url="https://github.com/Aylur/astal"
license=(LGPL3)
depends=()
makedepends=(meson ninja vala gobject-introspection git glib2-devel)
options=(!debug)
source=("astal::git+https://github.com/Aylur/astal.git#commit=$_commit")
sha256sums=('SKIP')
build() {
  cd "$srcdir/astal/$_subdir"
  meson setup build --prefix=/usr --buildtype=release
  meson compile -C build
}
package() {
  cd "$srcdir/astal/$_subdir"
  DESTDIR="$pkgdir" meson install -C build
}
PKGB
    echo "  → $name ($subdir)"
    build_install_pkg "$pdir"
done
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Configure GObject Introspection
# ─────────────────────────────────────────────────────────────────────────────
echo "[3/7] Configuring GObject Introspection..."
sudo ldconfig
# (GI_TYPELIB_PATH in /etc/environment is applied by nidara-setup, called in §7.)

# ─────────────────────────────────────────────────────────────────────────────
# 4. Build & install AGS CLI
# ─────────────────────────────────────────────────────────────────────────────
echo "[4/7] Building & packaging AGS CLI..."
if [ "$REBUILD_DEPS" = "no" ]; then
echo "  Skipped (pins unchanged)."
elif [ "$DEPS_FROM_REPO" = "yes" ]; then
echo "  Skipped (installed from nidara-repo)."
else
ags_dir="$PKG_CACHE/aylurs-gtk-shell"
mkdir -p "$ags_dir"
cat > "$ags_dir/PKGBUILD" <<PKGB
pkgname=aylurs-gtk-shell
pkgver=${AGS_REF#v}
_ref=$AGS_REF
PKGB
cat >> "$ags_dir/PKGBUILD" <<'PKGB'
pkgrel=1
pkgdesc="Aylur's GTK Shell (ags) CLI, pinned for Nidara"
arch=(x86_64)
url="https://github.com/Aylur/ags"
license=(GPL3)
depends=(astal-gjs gjs)
makedepends=(meson ninja vala gobject-introspection git nodejs npm go glib2-devel)
options=(!debug)
source=("ags::git+https://github.com/Aylur/ags.git#tag=$_ref")
sha256sums=('SKIP')
build() {
  cd "$srcdir/ags"
  npm install
  meson setup build --prefix=/usr --buildtype=release
  meson compile -C build
}
package() {
  cd "$srcdir/ags"
  DESTDIR="$pkgdir" meson install -C build
}
PKGB
build_install_pkg "$ags_dir"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Build the Nidara UI bundle
# ─────────────────────────────────────────────────────────────────────────────
echo "[5/7] Building Nidara UI..."
cd "$REPO_DIR/ui/shell"
npm install
npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css

# Dev mode: generate the git-ignored @girs/ GI typings so typecheck + editor
# IntelliSense work straight after a clone — no manual `ags types` step. Only if
# missing (regenerable, ~58MB); system mode doesn't typecheck so it's skipped.
if [ "$MODE" = "dev" ]; then
    echo "  Generating @girs/ TypeScript typings..."
    [ -d @girs ] || ags types -d .
fi

if [ "$MODE" != "dev" ]; then
    echo "  Bundling shell UI..."
    mkdir -p build
    ags bundle app.ts build/nidara
    echo "  [OK] Bundle: $REPO_DIR/ui/shell/build/nidara"
fi

echo "  Building greeter..."
# Use the shell bundle's sass installation for SCSS compilation
cd "$REPO_DIR/ui/shell"
npx sass --no-charset ../greeter/style.scss ../greeter/style.css && sed -i '/@charset/d' ../greeter/style.css
cd "$REPO_DIR/ui/greeter"
if [ "$MODE" != "dev" ]; then
    mkdir -p build
    ags bundle app.ts build/nidara-greeter
    echo "  [OK] Greeter bundle: $REPO_DIR/ui/greeter/build/nidara-greeter"
fi

echo "  Building lockscreen..."
cd "$REPO_DIR/ui/lockscreen"
if [ "$MODE" != "dev" ]; then
    mkdir -p build
    ags bundle app.ts build/nidara-lock
    echo "  [OK] Lockscreen bundle: $REPO_DIR/ui/lockscreen/build/nidara-lock"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Install system files
# ─────────────────────────────────────────────────────────────────────────────
echo "[6/7] Installing system files..."

# Version file
sudo mkdir -p /usr/share/nidara
sudo cp "$REPO_DIR/VERSION" /usr/share/nidara/VERSION

# Record the dependency pins this install was built against — --update compares
# them to decide whether the Astal/AGS stack needs rebuilding.
printf 'ASTAL_REF=%s\nAGS_REF=%s\nAPPMENU_REF=%s\n' "$ASTAL_REF" "$AGS_REF" "$APPMENU_REF" \
    | sudo tee "$PINS_FILE" > /dev/null
# And the pacman list fingerprint — --update compares it to decide whether
# phase 1 (package sync) can be skipped.
printf '%s\n' "$DEPS_LIST_SHA" | sudo tee "$PACMAN_SHA_FILE" > /dev/null

# Hyprland config
sudo mkdir -p /usr/share/nidara/config/hypr
if [ "$DEV_LIKE" = "yes" ]; then
    sudo ln -sf "$REPO_DIR/config/hypr/hyprland.lua" /usr/share/nidara/config/hypr/hyprland.lua
    sudo cp "$REPO_DIR/config/hypr/hypridle.conf" /usr/share/nidara/config/hypr/hypridle.conf
else
    sudo cp -r "$REPO_DIR/config/hypr/." /usr/share/nidara/config/hypr/
fi

# Setup payloads consumed by nidara-setup (greetd templates, per-user seeds) —
# the same layout the nidara pacman package ships, so nidara-setup reads ONE
# place regardless of how Nidara was installed. defaults/wallpaper is excluded:
# the wallpaper already ships at its canonical /usr/share/nidara/wallpaper.jpg.
sudo rm -rf /usr/share/nidara/defaults /usr/share/nidara/config/greetd
sudo cp -r "$REPO_DIR/defaults" /usr/share/nidara/defaults
sudo rm -rf /usr/share/nidara/defaults/wallpaper
sudo cp -r "$REPO_DIR/config/greetd" /usr/share/nidara/config/greetd

# Default wallpaper (jpg since 2026-07). The stale wallpaper.png can go now:
# the DM block re-syncs a Nidara-owned /etc/greetd in this same run (tech-debt
# #16 fix), so the greeter .lua points at wallpaper.jpg again; a foreign
# DM/greeter never referenced our wallpaper in the first place.
if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper.jpg" ]; then
    sudo cp "$REPO_DIR/defaults/wallpaper/wallpaper.jpg" /usr/share/nidara/wallpaper.jpg
    sudo rm -f /usr/share/nidara/wallpaper.png
fi

# Shell UI bundle + style
# Migration: drop the pre-rename system tree (ui/ags-v3 → ui/shell, 2026-06)
sudo rm -rf /usr/share/nidara/ui/ags-v3
sudo mkdir -p /usr/share/nidara/ui/shell/build
if [ "$MODE" != "dev" ]; then
    sudo cp "$REPO_DIR/ui/shell/build/nidara" /usr/share/nidara/ui/shell/build/
fi
sudo cp "$REPO_DIR/ui/shell/style.css" /usr/share/nidara/ui/shell/
# Static assets (icons, svgs) — resolved via SHELL_ROOT in prod (core/Paths.ts).
sudo rm -rf /usr/share/nidara/ui/shell/assets
sudo cp -r "$REPO_DIR/ui/shell/assets" /usr/share/nidara/ui/shell/

# Greeter bundle + style
sudo mkdir -p /usr/share/nidara/ui/greeter/build
if [ "$MODE" != "dev" ]; then
    sudo cp "$REPO_DIR/ui/greeter/build/nidara-greeter" /usr/share/nidara/ui/greeter/build/
fi
sudo cp "$REPO_DIR/ui/greeter/style.css" /usr/share/nidara/ui/greeter/

# Greeter's blank GTK4 theme. The greeter starts with GTK_THEME=nidara so GTK4
# loads ZERO theme rules (no Adwaita) and only the greeter's own CSS applies —
# that only works if this empty theme exists at the matching name. (app.ts).
sudo mkdir -p /usr/share/themes/nidara/gtk-4.0
sudo cp "$REPO_DIR/ui/greeter/theme/gtk.css" /usr/share/themes/nidara/gtk-4.0/gtk.css
# Remove the pre-rename orphan (was crystal-shell) so it doesn't linger.
sudo rm -rf /usr/share/themes/crystal-shell

# Lockscreen bundle (shares greeter's style.css)
sudo mkdir -p /usr/share/nidara/ui/lockscreen/build
if [ "$MODE" != "dev" ]; then
    sudo cp "$REPO_DIR/ui/lockscreen/build/nidara-lock" /usr/share/nidara/ui/lockscreen/build/
fi

# Session wrapper scripts
sudo cp "$REPO_DIR/bin/nidara"     /usr/bin/nidara
sudo cp "$REPO_DIR/bin/nidara-ui"  /usr/bin/nidara-ui
sudo cp "$REPO_DIR/bin/nidara-greeter"   /usr/bin/nidara-greeter
sudo cp "$REPO_DIR/bin/nidara-lock"      /usr/bin/nidara-lock
sudo cp "$REPO_DIR/bin/nidara-before-sleep" /usr/bin/nidara-before-sleep
sudo cp "$REPO_DIR/bin/nidara-after-sleep"  /usr/bin/nidara-after-sleep
sudo cp "$REPO_DIR/bin/nidara-game-mode" /usr/bin/nidara-game-mode
sudo cp "$REPO_DIR/bin/nidara-doctor" /usr/bin/nidara-doctor
sudo cp "$REPO_DIR/bin/nidara-portal"    /usr/bin/nidara-portal
sudo cp "$REPO_DIR/bin/nidara-mcp" /usr/bin/nidara-mcp
sudo cp "$REPO_DIR/bin/nidara-a11y"      /usr/bin/nidara-a11y
sudo cp "$REPO_DIR/bin/nidara-act"       /usr/bin/nidara-act
sudo cp "$REPO_DIR/bin/nidara-type"      /usr/bin/nidara-type
sudo cp "$REPO_DIR/bin/nidara-click"     /usr/bin/nidara-click
sudo cp "$REPO_DIR/bin/nidara-update" /usr/bin/nidara-update
sudo cp "$REPO_DIR/bin/nidara-setup" /usr/bin/nidara-setup
sudo chmod +x /usr/bin/nidara /usr/bin/nidara-ui /usr/bin/nidara-greeter /usr/bin/nidara-lock /usr/bin/nidara-before-sleep /usr/bin/nidara-after-sleep /usr/bin/nidara-game-mode /usr/bin/nidara-doctor /usr/bin/nidara-portal /usr/bin/nidara-mcp /usr/bin/nidara-a11y /usr/bin/nidara-act /usr/bin/nidara-type /usr/bin/nidara-click /usr/bin/nidara-update /usr/bin/nidara-setup

# Compile the synthetic-pointer backend (nidara-input): a tiny zwlr_virtual_pointer_v1
# Wayland client. wayland-scanner generates the protocol glue from wlr-protocols, then cc
# links it against libwayland-client. No new build system — the toolchain is already a dep.
VP_XML=/usr/share/wlr-protocols/unstable/wlr-virtual-pointer-unstable-v1.xml
VP_BUILD="$(mktemp -d)"
wayland-scanner client-header "$VP_XML" "$VP_BUILD/wlr-virtual-pointer-unstable-v1-client-protocol.h"
wayland-scanner private-code  "$VP_XML" "$VP_BUILD/wlr-virtual-pointer-unstable-v1-protocol.c"
cc -O2 "$REPO_DIR/bin/nidara-input.c" "$VP_BUILD/wlr-virtual-pointer-unstable-v1-protocol.c" \
    -I"$VP_BUILD" $(pkg-config --cflags --libs wayland-client) -o "$VP_BUILD/nidara-input"
sudo install -m755 "$VP_BUILD/nidara-input" /usr/bin/nidara-input
rm -rf "$VP_BUILD"

# systemd user unit — the shell respawns on crash instead of leaving a bare
# compositor (see bin/nidara.service). NOT enabled by target: it's
# started explicitly from the Nidara Hyprland config so it can't leak into other
# Hyprland sessions (see the unit's NOTE and the migration disable in step 7).
sudo mkdir -p /usr/lib/systemd/user
sudo cp "$REPO_DIR/bin/nidara.service" /usr/lib/systemd/user/nidara.service

# Wayland session entry (shared file: config/wayland-sessions/, also shipped by
# the nidara pacman package — keep ONE source, don't reintroduce a heredoc here)
sudo mkdir -p /usr/share/wayland-sessions
sudo cp "$REPO_DIR/config/wayland-sessions/nidara.desktop" /usr/share/wayland-sessions/nidara.desktop

# Application entries
sudo mkdir -p /usr/share/applications
sudo cp "$REPO_DIR/config/applications/"*.desktop /usr/share/applications/
sudo update-desktop-database /usr/share/applications/ 2>/dev/null || true

# XDG portals
# - nidara.portal declares Nidara's own Settings backend (nidara-portal
#   daemon, D-Bus-activated): serves org.freedesktop.appearance accent-color so
#   libadwaita/GNOME apps follow the Nidara accent under Hyprland. The Settings
#   portal AGGREGATES backends (verified in x-d-p 1.20 src/settings.c): nidara
#   serves only accent-color; gtk keeps serving color-scheme/contrast.
# - Config goes in /etc/xdg-desktop-portal/hyprland-portals.conf (matched via
#   XDG_CURRENT_DESKTOP=Hyprland; /etc outranks /usr/share, and the /usr/share
#   one is OWNED BY THE HYPRLAND PACKAGE — never overwrite it). NOTE: the
#   portals/ subdir is for .portal files ONLY — a .conf there is dead (we
#   shipped one there by mistake once; remove it on upgrade).
# (Shared files: config/portal/, also shipped by the nidara pacman package —
# keep ONE source, don't reintroduce heredocs here.)
sudo mkdir -p /usr/share/xdg-desktop-portal/portals /usr/share/dbus-1/services /etc/xdg-desktop-portal
sudo rm -f /usr/share/xdg-desktop-portal/portals/nidara.conf  # misplaced legacy
sudo cp "$REPO_DIR/config/portal/nidara.portal" /usr/share/xdg-desktop-portal/portals/nidara.portal
sudo cp "$REPO_DIR/config/portal/org.freedesktop.impl.portal.desktop.nidara.service" /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.nidara.service
sudo cp "$REPO_DIR/config/portal/hyprland-portals.conf" /etc/xdg-desktop-portal/hyprland-portals.conf

# ─────────────────────────────────────────────────────────────────────────────
# 7. First-time setup — install-mode markers here; everything else is delegated
#    to nidara-setup (ONE implementation, shared with the pacman-package path).
# ─────────────────────────────────────────────────────────────────────────────
echo "[7/7] Initializing user configuration..."
mkdir -p "$CONFIG_DIR"
# Own the parent too: under sudo, `mkdir -p` can create ~/.config itself as
# root, which silently breaks the whole session (rationale in bin/nidara-setup).
chown "$REAL_USER" "${REAL_HOME}/.config" "$CONFIG_DIR"

# Dev mode marker. An update never changes the install's mode: --update-apply
# leaves the marker exactly as it found it.
if [ "$MODE" = "dev" ]; then
    echo "$REPO_DIR" > "$CONFIG_DIR/.dev"
    chown "$REAL_USER" "$CONFIG_DIR/.dev"
    echo "  [Dev] nidara-ui will run from: $REPO_DIR"
elif [ "$MODE" = "system" ]; then
    rm -f "$CONFIG_DIR/.dev"
fi

# ── Source registration / migration ──────────────────────────────────
# Stable updates are STATELESS (nidara-update re-clones the remote to a temp dir),
# so a system install keeps NO persistent source copy and writes no .source — it
# just migrates away the legacy per-user canonical clone. Dev installs DO register
# their own clone (that's what `nidara-update`'s dev path follows). update-apply
# never registers or migrates (the stable wrapper already migrated).
if [ "$MODE" = "dev" ]; then
    echo "$REPO_DIR" > "$SOURCE_FILE"
    chown "$REAL_USER" "$SOURCE_FILE"
elif [ "$MODE" = "system" ]; then
    if [ -e "$SRC_CANON" ]; then
        rm -rf "$SRC_CANON"
        echo "  [Source] Removed legacy per-user source copy: $SRC_CANON"
    fi
    rm -f "$SOURCE_FILE"
    echo "  [Source] Stateless updates — nidara-update re-clones the remote each time."
fi

# Everything else a first login needs — per-user config seeding, uwsm env +
# NVIDIA autodetect, greetd/DM setup, service enablement — lives in
# bin/nidara-setup: ONE idempotent implementation, shared with the package
# path (`pacman -S nidara && nidara-setup`) and with nidara-update. §6 just
# refreshed /usr/bin/nidara-setup and its /usr/share/nidara payloads, so run
# the installed copy. Dev installs point live-editable configs at the repo.
if [ "$DEV_LIKE" = "yes" ]; then
    bash /usr/bin/nidara-setup --dev-repo "$REPO_DIR"
else
    bash /usr/bin/nidara-setup
fi

echo ""
if [ "$MODE" = "update-apply" ]; then
    NEW_VERSION="$(cat "$REPO_DIR/VERSION" 2>/dev/null || echo "?")"
    if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
        echo "  ✓ Update complete (version $NEW_VERSION)"
    else
        echo "  ✓ Update complete: $OLD_VERSION → $NEW_VERSION"
    fi
    # Reload the running shell so the new bundle takes effect now; greeter and
    # lockscreen pick theirs up on next use. Harmless if the session isn't ours.
    if run_user systemctl --user is-active --quiet nidara.service 2>/dev/null; then
        run_user systemctl --user restart nidara.service || true
        echo "  Shell reloaded."
    fi
else
    echo "  ✓ Installation complete ($MODE mode)"
    if [ "$MODE" = "dev" ]; then
        echo "  Dev: nidara-ui will run from source at $REPO_DIR"
        echo "  To exit dev mode: rm $CONFIG_DIR/.dev && install.sh"
    fi
    echo "  Select 'Nidara' at the login screen."
    echo "  Update later with: nidara-update"
fi
echo ""
