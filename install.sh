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
# per-user clone made no sense and diverged between users.) The one pinned
# dependency left (libastal-auth) is rebuilt ONLY when its pin changed
# (/usr/share/nidara/pins).
# A --dev install registers the developer's own clone (~/.config/nidara/.dev +
# .source) and updates from there, following its branch (same pin-skip). A plain
# `./install.sh` (system) always rebuilds the whole stack — the escape hatch — and
# migrates away any legacy ~/.local/share/nidara/src.
# Agent-carried local patches (clone path recorded in ~/.config/nidara/.patches —
# see the in-repo nidara skill, "Carrying a GLOBAL fix locally") make nidara-update
# refuse the blind stateless path: the agent rebases the patch branch onto the new
# release and re-runs --update-apply instead. --update likewise refuses to checkout
# a release over local-only commits rather than silently dropping them.
#
# Packaging model: system installs get Nidara itself as a pacman PACKAGE —
# prebuilt from the [nidara] repo when it serves this release, else built
# locally from packaging/nidara/PKGBUILD (§6) — so pacman owns every installed
# file. Dev installs keep copying source files into /usr directly (and remove
# the package first so pacman can't clobber the copies on -Syu).
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

# ── User execution helper ────────────────────────────────────────────────────
# Run a command as the unprivileged user. makepkg refuses to run as root, so when
# the installer itself is invoked via `sudo` we drop back to $REAL_USER (with -H so
# npm caches land in the user's home, not /root).
run_user() {
    if [ "$(id -u)" -eq 0 ]; then sudo -u "$REAL_USER" -H "$@"; else "$@"; fi
}

# Create the build cache with the USER owning it — ANCESTORS INCLUDED. Under sudo
# a bare `mkdir -p "$PKG_CACHE/…"` creates ~/.cache and ~/.cache/nidara as root
# whenever they don't exist yet, and from then on everything the user's own
# session writes there fails silently (Astal's frequents cache, the album-art
# cache, and `nidara-update`'s work dir — the list and the repair for installs
# already poisoned are in bin/nidara-setup, beside the same fix for ~/.config).
ensure_pkg_cache() {
    mkdir -p "$PKG_CACHE/src"
    chown "$REAL_USER" "${REAL_HOME}/.cache" "${REAL_HOME}/.cache/nidara" 2>/dev/null || true
    chown -R "$REAL_USER" "$PKG_CACHE" 2>/dev/null || true
}

# makepkg the PKGBUILD in dir $1, then hand the result to pacman. We --overwrite
# because earlier Nidara releases `meson install`-ed these libs straight into
# /usr as UNTRACKED files (invisible to `pacman -Qo`, unupgradable, unremovable —
# the exact blind spot that hid a stale, crashing appmenu-glib-translator, which
# is gone as of 2026-08-18). This
# transition gives those paths to pacman; from here they upgrade/remove cleanly.
build_install_pkg() {
    local dir="$1"
    ensure_pkg_cache
    chown -R "$REAL_USER" "$dir" 2>/dev/null || true
    # -f rebuild, --nodeps (install order is managed below), --skipinteg (git sources)
    run_user bash -c "cd '$dir' && SRCDEST='$PKG_CACHE/src' makepkg -f --noconfirm --nodeps --skipinteg --noprogressbar"
    local pkgfile
    pkgfile="$(ls -t "$dir"/*.pkg.tar.* 2>/dev/null | head -1)"
    [ -n "$pkgfile" ] || { echo "  [ERR] makepkg produced no package in $dir" >&2; exit 1; }
    sudo pacman -U --noconfirm --overwrite '*' "$pkgfile"
}

# Build the nidara package itself from THIS tree and install it (§6). Uses the
# same PKGBUILD releases ship (packaging/nidara/): makepkg finds a source file
# of the expected name in the build dir and skips the download, so we pack the
# working tree — as-is, uncommitted changes included: this is the escape-hatch/
# non-release path and must install what's here — under the tarball name and
# prefix the PKGBUILD expects. Build artifacts and node_modules are excluded
# because build() regenerates them. The SH transform flags keep symlink/hardlink
# TARGETS untouched (assets contain relative symlinks).
build_local_nidara_pkg() {
    local pdir="$PKG_CACHE/nidara" pkgver
    pkgver="$(grep '^pkgver=' "$REPO_DIR/packaging/nidara/PKGBUILD" | head -1 | cut -d= -f2)"
    if [ "$pkgver" != "$(cat "$REPO_DIR/VERSION")" ]; then
        echo "  [WARN] packaging/nidara/PKGBUILD pkgver=$pkgver ≠ VERSION=$(cat "$REPO_DIR/VERSION") —"
        echo "         these are bumped together in release commits; packaging this tree as $pkgver."
    fi
    ensure_pkg_cache
    rm -rf "$pdir"
    mkdir -p "$pdir"
    cp "$REPO_DIR/packaging/nidara/PKGBUILD" "$REPO_DIR/packaging/nidara/nidara.install" "$pdir/"
    tar -C "$REPO_DIR" -czf "$pdir/nidara-desktop-$pkgver.tar.gz" \
        --exclude='./.git' \
        --exclude='./ui/shell/node_modules' --exclude='./ui/shell/@girs' \
        --exclude='./ui/shell/build' --exclude='./ui/greeter/build' \
        --exclude='./ui/greeter/node_modules' --exclude='./ui/lockscreen/build' \
        --exclude='./ui/lockscreen/node_modules' \
        --exclude='./packaging/nidara/src' --exclude='./packaging/nidara/pkg' \
        --exclude='./packaging/nidara/*.tar.*' \
        --transform "s|^\.|nidara-desktop-$pkgver|SH" .
    build_install_pkg "$pdir"
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
# Decide whether the pinned dependency (libastal-auth) must be rebuilt. It's
# expensive to build from source, so it's skipped when the pin recorded at the
# last install ($PINS_FILE) already matches this script's — then phases 1 and 2
# are skipped and only Nidara's own artifacts are rebuilt.
#
# Which modes consult the pins:
#   update-apply : skip on a pin match; ALSO skip when no pins are recorded yet
#                  (pre-pin-era install whose stack is assumed current).
#   dev          : skip ONLY on a positive pin match. A missing pins file means
#                  it was never built on this machine, so it must build — this is
#                  what makes re-running `./install.sh --dev` while iterating on
#                  the shell cheap (no Astal recompile).
#   system       : never skipped. Plain `./install.sh` is the documented
#                  "rebuild everything from scratch" escape hatch.
# ─────────────────────────────────────────────────────────────────────────────
REBUILD_DEPS="yes"
# Phase 1 (pacman) has its own fingerprint, separate from the source-build pins:
# a pin match skips the expensive Astal rebuild, but a CHANGED package list
# (e.g. a new runtime tool like playerctl) must still sync packages — otherwise
# updated installs silently miss dependencies that fresh installs get.
PACMAN_SHA_FILE="/usr/share/nidara/pins-pacman"
SYNC_PACMAN="yes"
PACMAN_DEPS="base-devel glib2-devel cmake meson ninja gobject-introspection vala
    gtk3 gtk4 gtk-layer-shell gtk4-layer-shell libpeas-2
    libpulse networkmanager bluez bluez-libs bluez-utils upower libnotify
    intltool scdoc brightnessctl pamixer playerctl
    jq curl slurp grim wf-recorder wl-clipboard cliphist mesa pam
    pipewire pipewire-audio pipewire-alsa pipewire-pulse wireplumber libwireplumber
    git nodejs npm gjs esbuild
    at-spi2-core wtype wlr-protocols wayland wayland-protocols hyprland-protocols
    accountsservice greetd pavucontrol rust cargo
    hyprland hypridle hyprsunset uwsm power-profiles-daemon python-gobject
    kitty nautilus gnome-calculator
    polkit-gnome gnome-keyring libsecret
    xdg-desktop-portal-gtk xdg-desktop-portal-hyprland
    ttf-jetbrains-mono-nerd inter-font noto-fonts-emoji noto-fonts-cjk
    papirus-icon-theme adwaita-icon-theme adwaita-cursors xdg-utils gsettings-desktop-schemas
    awww lz4"
DEPS_LIST_SHA="$(printf '%s' "$PACMAN_DEPS" | sha256sum | awk '{print $1}')"
OLD_VERSION="$(cat /usr/share/nidara/VERSION 2>/dev/null || echo "?")"
# An update of a dev-mode install must keep dev semantics (config symlinks into
# the source tree) — otherwise the update would silently downgrade them to copies.
DEV_LIKE="no"
[ "$MODE" = "dev" ] && DEV_LIKE="yes"
[ "$MODE" = "update-apply" ] && [ -f "$CONFIG_DIR/.dev" ] && DEV_LIKE="yes"
if [ "$MODE" = "update-apply" ] || [ "$MODE" = "dev" ]; then
    if [ -f "$PACMAN_SHA_FILE" ] && [ "$DEPS_LIST_SHA" = "$(cat "$PACMAN_SHA_FILE")" ]; then
        SYNC_PACMAN="no"
    else
        echo "  Package list changed (or not yet recorded) — phase 1 will run."
    fi
fi

# (System environment detection — keyboard layout / timezone / locale — lives
# in bin/nidara-setup now, next to its only consumers: the per-user config
# seeds and the greetd template.)

# ─────────────────────────────────────────────────────────────────────────────
# nidara-repo trust & registration
# The binary pacman repo (GitHub Pages) ships libastal-auth (and the `nidara`
# package itself) prebuilt. Its CI GPG-signs every package and the repo db (since 2026-07-05);
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
if [ "$SYNC_PACMAN" = "no" ]; then
    echo "[1/5] System dependencies — skipped (package list unchanged)."
else
    echo "[1/5] Installing system dependencies..."
    # -Syu, never bare -Sy: syncing the DBs without a full upgrade leaves a partial-upgrade
    # state, and the next --needed install pulls a new lib (e.g. aquamarine) whose soname no
    # longer matches already-installed packages (e.g. hyprtoolkit) → transaction fails.
    # The list itself lives in PACMAN_DEPS (top of the script) so its fingerprint
    # can be compared on updates. Unquoted on purpose: word-splitting wanted.
    sudo pacman -Syu --needed --noconfirm $PACMAN_DEPS
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Configure GObject Introspection
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/5] Configuring GObject Introspection..."
sudo ldconfig
# (GI_TYPELIB_PATH in /etc/environment is applied by nidara-setup, called in §5.)

# ─────────────────────────────────────────────────────────────────────────────
# 3. Build the Nidara UI bundle
# ─────────────────────────────────────────────────────────────────────────────
echo "[3/5] Building Nidara UI..."
if [ "$DEV_LIKE" = "no" ]; then
echo "  Skipped — system installs get Nidara as a pacman package (prebuilt from"
echo "  nidara-repo, or built from this tree by makepkg in step 6)."
else
cd "$REPO_DIR/ui/shell"
npm install
npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css

# Dev mode: generate the git-ignored @girs/ GI typings so typecheck + editor
# IntelliSense work straight after a clone — no manual step. Only if missing
# (regenerable, ~58MB); system mode doesn't typecheck so it's skipped.
if [ "$MODE" = "dev" ]; then
    echo "  Generating @girs/ TypeScript typings..."
    [ -d @girs ] || "$REPO_DIR/scripts/gen-types.sh" .
fi

if [ "$MODE" != "dev" ]; then
    echo "  Bundling shell UI..."
    mkdir -p build
    "$REPO_DIR/scripts/bundle.sh" app.ts build/nidara
    echo "  [OK] Bundle: $REPO_DIR/ui/shell/build/nidara"
fi

echo "  Building greeter..."
# Use the shell bundle's sass installation for SCSS compilation
cd "$REPO_DIR/ui/shell"
npx sass --no-charset ../greeter/style.scss ../greeter/style.css && sed -i '/@charset/d' ../greeter/style.css
cd "$REPO_DIR/ui/greeter"
mkdir -p build
"$REPO_DIR/scripts/bundle.sh" app.ts build/nidara-greeter
echo "  [OK] Greeter bundle: $REPO_DIR/ui/greeter/build/nidara-greeter"

echo "  Building lockscreen..."
cd "$REPO_DIR/ui/lockscreen"
mkdir -p build
"$REPO_DIR/scripts/bundle.sh" app.ts build/nidara-lock
echo "  [OK] Lockscreen bundle: $REPO_DIR/ui/lockscreen/build/nidara-lock"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Install system files
# ─────────────────────────────────────────────────────────────────────────────
echo "[4/5] Installing system files..."

if [ "$DEV_LIKE" = "no" ]; then
# ── System installs consume the nidara PACKAGE ───────────────────────────────
# Prebuilt from nidara-repo when it serves this release, else built locally
# from packaging/nidara/PKGBUILD. Either way pacman owns every installed file:
# clean upgrades (pacman -Syu), clean removal, no untracked drift. --overwrite
# hands over files that script-era installs wrote untracked into /usr (same
# transition build_install_pkg documents for the Astal libs).
_ver="$(cat "$REPO_DIR/VERSION")"
NIDARA_FROM_REPO="no"

# The PREBUILT package is only a faithful install of this tree when the tree IS
# the release it was built from: a git-less release tarball, or a clean checkout
# of the v$_ver tag (nidara-update temp clones; release-channel installs). Any
# other tree (branches, local commits, dirty escape-hatch runs) builds locally —
# installing the repo's binaries would silently ignore the user's changes.
_tree_is_release="no"
if [ ! -d "$REPO_DIR/.git" ]; then
    _tree_is_release="yes"
elif [ -z "$(run_user git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ] \
  && [ "$(run_user git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" = "$(run_user git -C "$REPO_DIR" rev-parse "v$_ver^{commit}" 2>/dev/null)" ]; then
    _tree_is_release="yes"
fi

if [ "$_tree_is_release" = "yes" ]; then
    echo "  Installing nidara from nidara-repo (prebuilt)..."
    if sudo pacman -S --needed --noconfirm --overwrite '*' nidara; then
        # Lockstep guard, same rationale as the Astal stack in §1: a repo that
        # lags the release "succeeds" with the PREVIOUS version — build locally
        # instead of silently keeping stale binaries.
        _nidara_v="$(pacman -Q nidara 2>/dev/null | awk '{print $2}')"
        if [ "${_nidara_v%%-*}" = "$_ver" ]; then
            NIDARA_FROM_REPO="yes"
            echo "  [OK] nidara $_nidara_v installed from nidara-repo."
        else
            echo "  [WARN] nidara-repo serves $_nidara_v but this release is $_ver — the repo"
            echo "         likely wasn't rebuilt for this release yet. Building locally."
        fi
    else
        echo "  [WARN] nidara unavailable from nidara-repo — building the package locally."
    fi
else
    echo "  Tree is not exactly release v$_ver — building the nidara package from this tree."
fi

if [ "$NIDARA_FROM_REPO" = "no" ]; then
    build_local_nidara_pkg
fi

# Orphans that script-era installs left as untracked files (the package
# handover only covers paths the package OWNS; these old paths aren't in it):
sudo rm -rf /usr/share/nidara/ui/ags-v3 /usr/share/themes/crystal-shell
sudo rm -f /usr/share/nidara/wallpaper.png /usr/share/xdg-desktop-portal/portals/nidara.conf

# Installing the package replaced /usr/share/nidara/config/hypr/hyprland.lua.
# If a Nidara session is live right now (update-apply, script→package handoff,
# escape-hatch rerun from a terminal), Hyprland's config watch fired mid-extract,
# errored "cannot open … hyprland.lua", and the banner sticks — the watch died
# with the old inode. Reload now that the new file is in place; no-op outside a
# session (clean installs from TTY/SSH, or when sudo stripped the session env).
if [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ]; then
    run_user hyprctl reload >/dev/null 2>&1 || true
fi

else
# ── Dev installs copy source files straight into /usr ────────────────────────
# If the nidara PACKAGE is installed, pacman owns those paths and the next
# -Syu would clobber the dev copies — remove it first (files re-copied below).
if pacman -Qq nidara >/dev/null 2>&1; then
    echo "  Removing the nidara package (dev installs manage /usr files directly)..."
    sudo pacman -R --noconfirm nidara
fi

# Version file
sudo mkdir -p /usr/share/nidara
sudo cp "$REPO_DIR/VERSION" /usr/share/nidara/VERSION

# Hyprland config (dev: symlink hyprland.lua to the repo so edits apply live;
# system installs get a real copy from the package instead)
sudo mkdir -p /usr/share/nidara/config/hypr
sudo ln -sf "$REPO_DIR/config/hypr/hyprland.lua" /usr/share/nidara/config/hypr/hyprland.lua
sudo cp "$REPO_DIR/config/hypr/hypridle.conf" /usr/share/nidara/config/hypr/hypridle.conf

# Setup payloads consumed by nidara-setup (greetd templates, per-user seeds) —
# the same layout the nidara pacman package ships, so nidara-setup reads ONE
# place regardless of how Nidara was installed. defaults/wallpaper is excluded:
# the wallpaper already ships at its canonical /usr/share/nidara/wallpaper.jpg.
sudo rm -rf /usr/share/nidara/defaults /usr/share/nidara/config/greetd
sudo cp -r "$REPO_DIR/defaults" /usr/share/nidara/defaults
sudo rm -rf /usr/share/nidara/defaults/wallpaper
sudo cp -r "$REPO_DIR/config/greetd" /usr/share/nidara/config/greetd

# Assistant skills: markdown playbooks bin/nidara-agent loads on demand (its
# load_skill tool). Replaced wholesale rather than merged, so a skill deleted
# upstream actually disappears. A --dev install reads the repo's skills/ directly
# (the .dev marker wins in skillsDir()), so this copy is what non-dev installs get.
sudo rm -rf /usr/share/nidara/skills
sudo cp -r "$REPO_DIR/skills" /usr/share/nidara/skills

# Default wallpapers (desktop, greeter, and bundled offline collection).
if [ -d "$REPO_DIR/defaults/wallpaper" ]; then
    sudo mkdir -p /usr/share/nidara/wallpapers
    sudo cp -f "$REPO_DIR/defaults/wallpaper/"*.jpg /usr/share/nidara/wallpapers/ 2>/dev/null || true
    if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper.jpg" ]; then
        sudo cp "$REPO_DIR/defaults/wallpaper/wallpaper.jpg" /usr/share/nidara/wallpaper.jpg
    fi
    if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper-greeter.jpg" ]; then
        sudo cp "$REPO_DIR/defaults/wallpaper/wallpaper-greeter.jpg" /usr/share/nidara/wallpaper-greeter.jpg
    fi
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
sudo cp "$REPO_DIR/ui/greeter/build/nidara-greeter" /usr/share/nidara/ui/greeter/build/
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
sudo cp "$REPO_DIR/ui/lockscreen/build/nidara-lock" /usr/share/nidara/ui/lockscreen/build/

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
sudo cp "$REPO_DIR/bin/nidara-agent" /usr/bin/nidara-agent
sudo cp "$REPO_DIR/bin/nidara-a11y"      /usr/bin/nidara-a11y
sudo cp "$REPO_DIR/bin/nidara-act"       /usr/bin/nidara-act
sudo cp "$REPO_DIR/bin/nidara-type"      /usr/bin/nidara-type
sudo cp "$REPO_DIR/bin/nidara-click"     /usr/bin/nidara-click
sudo cp "$REPO_DIR/bin/nidara-update" /usr/bin/nidara-update
sudo cp "$REPO_DIR/bin/nidara-setup" /usr/bin/nidara-setup
sudo chmod +x /usr/bin/nidara /usr/bin/nidara-ui /usr/bin/nidara-greeter /usr/bin/nidara-lock /usr/bin/nidara-before-sleep /usr/bin/nidara-after-sleep /usr/bin/nidara-game-mode /usr/bin/nidara-doctor /usr/bin/nidara-portal /usr/bin/nidara-mcp /usr/bin/nidara-agent /usr/bin/nidara-a11y /usr/bin/nidara-act /usr/bin/nidara-type /usr/bin/nidara-click /usr/bin/nidara-update /usr/bin/nidara-setup

# Compile the IPC client (nidara-ipc): `Request(as) -> s` on the shell's D-Bus
# name, and the thing every keybind in hyprland.lua runs. C rather than GJS for
# that reason alone — measured 2026-08-18, a GJS build of the same 90 lines cost
# 30 ms per invocation against 2.9 ms here, all of it interpreter startup, paid
# before the shell hears anything. gio-2.0 is already a dependency (glib2).
IPC_BUILD="$(mktemp -d)"
cc -O2 "$REPO_DIR/bin/nidara-ipc.c" $(pkg-config --cflags --libs gio-2.0) -o "$IPC_BUILD/nidara-ipc"
sudo install -m755 "$IPC_BUILD/nidara-ipc" /usr/bin/nidara-ipc
rm -rf "$IPC_BUILD"

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

# libnidara-wl: the Wayland shim GJS cannot do without (window capture for real
# thumbnails, hyprland-surface set_visible_region for the layer-blur cost, and
# hyprland-focus-grab-v1 — which is MANDATORY since 2026-08-05, not an
# enhancement: the full-screen catcher buttons that used to fake "click outside
# closes" are gone, so without this library nothing dismisses. Hence the symbol
# check after the install: a tree that builds an older shim must fail HERE, not
# with a silent desktop.) Built
# the same way as nidara-input — no build system, just cc + wayland-scanner —
# plus g-ir-scanner so `import NidaraWl from "gi://NidaraWl"` resolves.
#
# The typelib goes to the DEFAULT girepository path, so nothing has to set
# GI_TYPELIB_PATH: the shell, the greeter and the lockscreen all find it.
WL_BUILD="$(mktemp -d)"
"$REPO_DIR/lib/nidara-wl/build.sh" "$WL_BUILD" >/dev/null
sudo install -Dm755 "$WL_BUILD/libnidara-wl.so.0.0.0" /usr/lib/libnidara-wl.so.0.0.0
sudo ln -sf libnidara-wl.so.0.0.0 /usr/lib/libnidara-wl.so.0
sudo ln -sf libnidara-wl.so.0    /usr/lib/libnidara-wl.so
sudo install -Dm644 "$WL_BUILD/NidaraWl-1.0.typelib" \
    /usr/lib/girepository-1.0/NidaraWl-1.0.typelib
sudo install -Dm644 "$WL_BUILD/NidaraWl-1.0.gir" \
    /usr/share/gir-1.0/NidaraWl-1.0.gir
sudo ldconfig
# The shim and the shell ship together but are separate artefacts, so "built from
# an older tree" is a real state. Assert the API the shell now REQUIRES.
if ! grep -q "focus_grab_acquire" "$WL_BUILD/NidaraWl-1.0.gir"; then
    echo "FATAL: libnidara-wl built without focus_grab_* — outside-click dismissal would be dead." >&2
    exit 1
fi
rm -rf "$WL_BUILD"

# libnidara-auth: PAM authentication for the lockscreen
AUTH_BUILD="$(mktemp -d)"
"$REPO_DIR/lib/nidara-auth/build.sh" "$AUTH_BUILD" >/dev/null
sudo install -Dm755 "$AUTH_BUILD/libnidara-auth.so.0.0.0" /usr/lib/libnidara-auth.so.0.0.0
sudo ln -sf libnidara-auth.so.0.0.0 /usr/lib/libnidara-auth.so.0
sudo ln -sf libnidara-auth.so.0    /usr/lib/libnidara-auth.so
sudo install -Dm644 "$AUTH_BUILD/NidaraAuth-1.0.typelib" \
    /usr/lib/girepository-1.0/NidaraAuth-1.0.typelib
sudo install -Dm644 "$AUTH_BUILD/NidaraAuth-1.0.gir" \
    /usr/share/gir-1.0/NidaraAuth-1.0.gir
sudo install -Dm644 "$REPO_DIR/config/pam/nidara-lock" /etc/pam.d/nidara-lock
sudo ldconfig
rm -rf "$AUTH_BUILD"

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
pkill -f nidara-portal 2>/dev/null || true
systemctl --user restart xdg-desktop-portal 2>/dev/null || true

# fontconfig: per-language CJK variant. Arch's noto-fonts-cjk ships no
# fontconfig rules and fontconfig's own 65-nonlatin.conf hardcodes the KR face,
# so zh/ja sessions render their Han characters with Korean stroke forms.
# The rules prepend the regional face by text language; the 65-0- filename MUST
# sort before 65-nonlatin.conf (see the file's header comment). (Shared file:
# config/fontconfig/, also shipped by the nidara pacman package — keep ONE source.)
sudo mkdir -p /usr/share/fontconfig/conf.avail /etc/fonts/conf.d
sudo cp "$REPO_DIR/config/fontconfig/65-0-nidara-noto-cjk.conf" /usr/share/fontconfig/conf.avail/65-0-nidara-noto-cjk.conf
sudo ln -sf /usr/share/fontconfig/conf.avail/65-0-nidara-noto-cjk.conf /etc/fonts/conf.d/65-0-nidara-noto-cjk.conf
fi

# The pacman list fingerprint — --update compares it to decide whether
# phase 1 (package sync) can be skipped.
printf '%s\n' "$DEPS_LIST_SHA" | sudo tee "$PACMAN_SHA_FILE" > /dev/null

# ─────────────────────────────────────────────────────────────────────────────
# 5. First-time setup — install-mode markers here; everything else is delegated
#    to nidara-setup (ONE implementation, shared with the pacman-package path).
# ─────────────────────────────────────────────────────────────────────────────
echo "[5/5] Initializing user configuration..."
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
# the installed copy. (The old --dev-repo flag is gone: hypridle.conf is user
# state written by Settings → Power, never a symlink into the repo.)
bash /usr/bin/nidara-setup

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
