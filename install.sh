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
        echo "        Commit/stash them (or update manually with git), then retry." >&2
        exit 1
    fi
    run_user git -C "$SRC" fetch --tags origin

    # Dev clones follow their branch; everyone else jumps to the newest release
    # tag when releases exist (the stable channel), or fast-forwards main before
    # the first release.
    latest_tag="$(run_user git -C "$SRC" tag -l 'v*' --sort=-v:refname | head -1)"
    if [ -f "$CONFIG_DIR/.dev" ] || [ -z "$latest_tag" ]; then
        run_user git -C "$SRC" pull --ff-only origin "$(run_user git -C "$SRC" rev-parse --abbrev-ref HEAD)" \
            || { echo "  [ERR] fast-forward pull failed (diverged history?) — update manually with git." >&2; exit 1; }
    else
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
fi

# ─────────────────────────────────────────────────────────────────────────────
# System environment detection
# Reads values the user already set during Arch installation — never asks.
# ─────────────────────────────────────────────────────────────────────────────

# Keyboard layout ─────────────────────────────────────────────────────────────
# vconsole keymaps mostly match X11/Wayland names, but a few differ.
_vconsole_to_xkb() {
    case "$1" in
        uk)          echo "gb"    ;;  # British: vconsole=uk, XKB=gb
        us-acentos)  echo "us"    ;;  # Latin US variant → plain us
        br-abnt2)    echo "br"    ;;
        *)           echo "$1"    ;;  # All others match directly
    esac
}

SYS_KB_LAYOUT="us"
if [ -f /etc/vconsole.conf ]; then
    _keymap=$(grep -E "^KEYMAP=" /etc/vconsole.conf | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$_keymap" ] && SYS_KB_LAYOUT=$(_vconsole_to_xkb "$_keymap")
fi

# Timezone ────────────────────────────────────────────────────────────────────
SYS_TIMEZONE="UTC"
if [ -L /etc/localtime ]; then
    _tz=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')
    [ -n "$_tz" ] && SYS_TIMEZONE="$_tz"
fi

# Locale ──────────────────────────────────────────────────────────────────────
SYS_LOCALE="en_US"
if [ -f /etc/locale.conf ]; then
    _lang=$(grep -E "^LANG=" /etc/locale.conf | head -1 | cut -d= -f2 | cut -d. -f1 | tr -d '"' | tr -d "'")
    [ -n "$_lang" ] && SYS_LOCALE="$_lang"
fi

echo "  Detected: layout=$SYS_KB_LAYOUT  timezone=$SYS_TIMEZONE  locale=$SYS_LOCALE"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 1. System dependencies
# ─────────────────────────────────────────────────────────────────────────────
if [ "$REBUILD_DEPS" = "no" ]; then
echo "[1/7] System dependencies — skipped (pins unchanged)."
else
echo "[1/7] Installing system dependencies..."
# Register nidara-repo — the binary pacman repo (GitHub Pages) that ships the
# Astal/AGS/appmenu stack prebuilt, so installs/updates don't recompile it from
# source every time. Unsigned v0 → `SigLevel = Optional TrustAll`; trust rests on
# HTTPS + GitHub + the auditable CI build (GPG signing is planned pre-ISO).
# Idempotent: only appended if not already present. `$arch` stays literal — pacman
# expands it (single-quoted printf format keeps the shell from touching it).
if ! grep -q '^\[nidara\]' /etc/pacman.conf 2>/dev/null; then
    echo "  Registering nidara-repo in /etc/pacman.conf..."
    printf '\n[nidara]\nSigLevel = Optional TrustAll\nServer = https://nidara-project.github.io/nidara-repo/$arch\n' \
        | sudo tee -a /etc/pacman.conf > /dev/null
fi
# -Syu, never bare -Sy: syncing the DBs without a full upgrade leaves a partial-upgrade
# state, and the next --needed install pulls a new lib (e.g. aquamarine) whose soname no
# longer matches already-installed packages (e.g. hyprtoolkit) → transaction fails.
sudo pacman -Syu --needed --noconfirm \
    base-devel glib2-devel cmake meson ninja gobject-introspection vala \
    gtk3 gtk4 gtk-layer-shell gtk4-layer-shell libpeas-2 \
    libpulse networkmanager bluez-libs upower libnotify \
    intltool scdoc brightnessctl pamixer hyprpicker \
    jq slurp grim wf-recorder wl-clipboard cliphist mesa pam \
    pipewire wireplumber \
    git nodejs npm gjs go \
    at-spi2-core wtype wlr-protocols wayland \
    accountsservice greetd pavucontrol rust cargo \
    hyprland hypridle hyprsunset uwsm power-profiles-daemon python-gobject \
    kitty nautilus \
    polkit-gnome \
    xdg-desktop-portal-gtk xdg-desktop-portal-hyprland \
    ttf-jetbrains-mono-nerd inter-font noto-fonts-emoji \
    papirus-icon-theme adwaita-icon-theme xdg-utils \
    hyprlauncher awww lz4

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
if ! grep -q "GI_TYPELIB_PATH" /etc/environment 2>/dev/null; then
    echo 'GI_TYPELIB_PATH="/usr/lib/girepository-1.0"' | sudo tee -a /etc/environment
fi

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

# Hyprland config
sudo mkdir -p /usr/share/nidara/config/hypr
if [ "$DEV_LIKE" = "yes" ]; then
    sudo ln -sf "$REPO_DIR/config/hypr/hyprland.lua" /usr/share/nidara/config/hypr/hyprland.lua
    sudo cp "$REPO_DIR/config/hypr/hypridle.conf" /usr/share/nidara/config/hypr/hypridle.conf
else
    sudo cp -r "$REPO_DIR/config/hypr/." /usr/share/nidara/config/hypr/
fi

# Default wallpaper
if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper.png" ]; then
    sudo cp "$REPO_DIR/defaults/wallpaper/wallpaper.png" /usr/share/nidara/wallpaper.png
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
sudo chmod +x /usr/bin/nidara /usr/bin/nidara-ui /usr/bin/nidara-greeter /usr/bin/nidara-lock /usr/bin/nidara-before-sleep /usr/bin/nidara-after-sleep /usr/bin/nidara-game-mode /usr/bin/nidara-doctor /usr/bin/nidara-portal /usr/bin/nidara-mcp /usr/bin/nidara-a11y /usr/bin/nidara-act /usr/bin/nidara-type /usr/bin/nidara-click /usr/bin/nidara-update

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

# Wayland session entry
sudo mkdir -p /usr/share/wayland-sessions
cat <<'EOF' | sudo tee /usr/share/wayland-sessions/nidara.desktop > /dev/null
[Desktop Entry]
Name=Nidara
Comment=A fluid, glassmorphic desktop environment based on Hyprland & AGS
Exec=/usr/bin/nidara
Type=Application
DesktopNames=Hyprland
EOF

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
sudo mkdir -p /usr/share/xdg-desktop-portal/portals /usr/share/dbus-1/services /etc/xdg-desktop-portal
sudo rm -f /usr/share/xdg-desktop-portal/portals/nidara.conf  # misplaced legacy
cat <<'EOF' | sudo tee /usr/share/xdg-desktop-portal/portals/nidara.portal > /dev/null
[portal]
DBusName=org.freedesktop.impl.portal.desktop.nidara
Interfaces=org.freedesktop.impl.portal.Settings
EOF
cat <<'EOF' | sudo tee /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.nidara.service > /dev/null
[D-BUS Service]
Name=org.freedesktop.impl.portal.desktop.nidara
Exec=/usr/bin/nidara-portal
EOF
cat <<'EOF' | sudo tee /etc/xdg-desktop-portal/hyprland-portals.conf > /dev/null
[preferred]
default=hyprland;gtk
org.freedesktop.impl.portal.ScreenCast=hyprland
org.freedesktop.impl.portal.Screenshot=hyprland
org.freedesktop.impl.portal.Settings=nidara;gtk
EOF

# ─────────────────────────────────────────────────────────────────────────────
# 7. Initialize user configuration (first run only, never overwrites)
# ─────────────────────────────────────────────────────────────────────────────
echo "[7/7] Initializing user configuration..."
mkdir -p "$CONFIG_DIR"
chown "$REAL_USER" "$CONFIG_DIR"

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

# Default JSON configs (never overwrite user's existing files).
# Bar/CC widget placement + CC tile layout are NOT seeded here: they come from the
# shell's code defaults (DEFAULT_PLACEMENT + CC_DEFAULT_ORDER in widgets/index.ts),
# which are hardware-adaptive. The runtime widgets.json/cc_layout.json are written into
# the config dir only once the user customizes them.
for f in appearance.json; do
    if [ -f "$REPO_DIR/defaults/$f" ] && [ ! -f "$CONFIG_DIR/$f" ]; then
        cp "$REPO_DIR/defaults/$f" "$CONFIG_DIR/$f"
        chown "$REAL_USER" "$CONFIG_DIR/$f"
        echo "  [Init] $CONFIG_DIR/$f"
    fi
done

# Default file manager: a fresh Arch has no inode/directory association, so
# `xdg-open <folder>` (the dock's Files item, apps' "open containing folder", …)
# launches the wrong app. Seed nautilus as the default — only when the user has no
# association yet, so updates never override their choice.
if [ -z "$(run_user xdg-mime query default inode/directory 2>/dev/null)" ]; then
    run_user xdg-mime default org.gnome.Nautilus.desktop inode/directory \
        && echo "  [Init] Default file manager → nautilus (inode/directory)"
fi

# .mcp.json — MCP manifest for the user's AI agent (Claude Code et al). Points at
# the installed binary via PATH. Always (re)written: it's a runtime-managed pointer,
# not user data. Opening an agent inside ~/.config/nidara discovers it
# automatically; any other agent can be pointed at it ("register the MCP server
# described in ~/.config/nidara/.mcp.json").
cat > "$CONFIG_DIR/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "nidara": {
      "command": "nidara-mcp"
    }
  }
}
JSON
chown "$REAL_USER" "$CONFIG_DIR/.mcp.json"
echo "  [Init] $CONFIG_DIR/.mcp.json (agent interface manifest)"

# region.json — generated with detected timezone (not copied from defaults)
if [ ! -f "$CONFIG_DIR/region.json" ]; then
    cat > "$CONFIG_DIR/region.json" <<JSON
{
  "timeFormat": "24h",
  "dateFormat": "long",
  "timezone": "$SYS_TIMEZONE",
  "showSeconds": false
}
JSON
    chown "$REAL_USER" "$CONFIG_DIR/region.json"
    echo "  [Init] $CONFIG_DIR/region.json (timezone=$SYS_TIMEZONE)"
fi

# Hyprland user overrides (created once, never overwritten)
if [ ! -f "$CONFIG_DIR/hyprland-user.lua" ]; then
    cat > "$CONFIG_DIR/hyprland-user.lua" <<LUA
-- ── hyprland-user.lua ────────────────────────────────────────────────────────
-- Your personal Hyprland overrides. Nidara updates will never touch this.
-- Add monitor setup, startup apps, custom keybinds, etc.
--
-- Note: environment variables go in ~/.config/uwsm/env (toolkit/NVIDIA)
-- or ~/.config/uwsm/env-hyprland (HYPR* / AQ_* variables) — not here.
-- ─────────────────────────────────────────────────────────────────────────────

-- @autostart start
hl.on("hyprland.start", function()
end)
-- @autostart end
LUA
    chown "$REAL_USER" "$CONFIG_DIR/hyprland-user.lua"
    echo "  [Init] $CONFIG_DIR/hyprland-user.lua"
fi

# Nidara generated config (Hyprland settings from UI)
# Seeded with the detected system keyboard layout on first install.
if [ ! -f "$CONFIG_DIR/nidara-settings.lua" ]; then
    cat > "$CONFIG_DIR/nidara-settings.lua" <<LUA
-- NIDARA SHELL SETTINGS
-- Auto-generated by the Nidara Settings UI. Do not edit manually.
hl.config({
    input = {
        sensitivity        = 0.00,
        accel_profile      = "adaptive",
        natural_scroll     = false,
        numlock_by_default = false,
        kb_layout          = "$SYS_KB_LAYOUT",
        kb_variant         = "",
        repeat_delay       = 600,
        repeat_rate        = 25,
        touchpad = {
            natural_scroll = false,
            tap_to_click   = true,
        },
    },
})
LUA
    chown "$REAL_USER" "$CONFIG_DIR/nidara-settings.lua"
    echo "  [Init] $CONFIG_DIR/nidara-settings.lua (kb_layout=$SYS_KB_LAYOUT)"
fi

# Monitor config — generated by Display settings page
if [ ! -f "$CONFIG_DIR/nidara-monitor.lua" ]; then
    touch "$CONFIG_DIR/nidara-monitor.lua"
    chown "$REAL_USER" "$CONFIG_DIR/nidara-monitor.lua"
    echo "  [Init] $CONFIG_DIR/nidara-monitor.lua"
fi

# Hypridle config
# Dev mode:    symlink directly to repo so edits take effect immediately
# System mode: copy to $CONFIG_DIR once (never overwritten), symlink from there
mkdir -p "${REAL_HOME}/.config/hypr"

for daemon in hypridle; do
    LINK="${REAL_HOME}/.config/hypr/${daemon}.conf"
    if [ "$DEV_LIKE" = "yes" ]; then
        TARGET="$REPO_DIR/config/hypr/${daemon}.conf"
    else
        TARGET="$CONFIG_DIR/${daemon}.conf"
        if [ ! -f "$TARGET" ]; then
            cp "$REPO_DIR/config/hypr/${daemon}.conf" "$TARGET"
            chown "$REAL_USER" "$TARGET"
            echo "  [Init] $TARGET"
        fi
    fi
    # Always (re)create the symlink so it points to the right target for the current mode
    ln -sf "$TARGET" "$LINK"
    echo "  [Symlink] $LINK -> $TARGET"
done

# hyprland-user.lua — symlink into ~/.config/hypr/ so Autostart settings page
# can read/write it from a predictable location regardless of install mode
USERCONF_LINK="${REAL_HOME}/.config/hypr/hyprland-user.lua"
USERCONF_TARGET="$CONFIG_DIR/hyprland-user.lua"
ln -sf "$USERCONF_TARGET" "$USERCONF_LINK"
echo "  [Symlink] $USERCONF_LINK -> $USERCONF_TARGET"

# uwsm environment files (created once, never overwritten)
UWSM_DIR="${REAL_HOME}/.config/uwsm"
mkdir -p "$UWSM_DIR"
chown "$REAL_USER" "$UWSM_DIR"
for f in env env-hyprland; do
    if [ ! -f "$UWSM_DIR/$f" ]; then
        cp "$REPO_DIR/defaults/uwsm/$f" "$UWSM_DIR/$f"
        chown "$REAL_USER" "$UWSM_DIR/$f"
        echo "  [Init] $UWSM_DIR/$f"
    fi
done

ENVFILE="$UWSM_DIR/env"

# Migrate two objectively-broken shipped defaults in pre-0.1 env files. These match
# the exact bad lines only, so a user's own edits are never touched. uwsm SOURCES
# this file as shell:
#   - QT_QPA_PLATFORM=wayland;xcb  → the bare ';' ran 'xcb' as a command, truncating
#     the var to just 'wayland'. Quote it.
#   - QT_QPA_PLATFORMTHEME=qt6ct   → contradicts the portal-based Qt theming the
#     launcher sets; since the env file is sourced AFTER the launcher it wins, so the
#     stale qt6ct value was actually overriding xdgdesktopportal.
# sed -i recreates the file as root when we run under sudo, so chown it back after.
sed -i \
    -e 's|^export QT_QPA_PLATFORM=wayland;xcb$|export QT_QPA_PLATFORM="wayland;xcb"|' \
    -e 's|^export QT_QPA_PLATFORMTHEME=qt6ct$|export QT_QPA_PLATFORMTHEME=xdgdesktopportal|' \
    "$ENVFILE"
chown "$REAL_USER" "$ENVFILE"

# ── NVIDIA GPU autodetection ──────────────────────────────────────────────────
# A fresh NVIDIA user otherwise gets a black screen / glitches until they manually
# uncomment the GPU vars. Detect the hardware AND the active driver: the nvidia-drm
# GBM backend vars apply ONLY to the proprietary/open driver — under nouveau they
# break the session (nouveau uses the standard mesa GBM path). Idempotent: only flips
# the commented hint lines to active, so it's safe to re-run (e.g. after installing
# the driver later).
if command -v lspci >/dev/null 2>&1 \
   && lspci -nn 2>/dev/null | grep -iE 'VGA|3D|Display' | grep -qi nvidia; then
    echo "  [GPU] NVIDIA hardware detected."
    if lsmod 2>/dev/null | grep -q '^nouveau'; then
        echo "  [GPU] nouveau driver in use — leaving NVIDIA env vars commented (nouveau uses mesa/GBM)."
    elif ! lsmod 2>/dev/null | grep -q '^nvidia'; then
        echo "  [GPU] NVIDIA card present but no nvidia kernel module loaded."
        echo "        Install nvidia-dkms (or nvidia-open-dkms) + nvidia-utils + egl-wayland, then re-run."
    else
        echo "  [GPU] Proprietary/open driver active — enabling Wayland GPU env vars in $ENVFILE."
        sed -i \
            -e 's|^# *export LIBVA_DRIVER_NAME=nvidia|export LIBVA_DRIVER_NAME=nvidia|' \
            -e 's|^# *export GBM_BACKEND=nvidia-drm|export GBM_BACKEND=nvidia-drm|' \
            -e 's|^# *export __GLX_VENDOR_LIBRARY_NAME=nvidia|export __GLX_VENDOR_LIBRARY_NAME=nvidia|' \
            "$ENVFILE"
        if pacman -Qq libva-nvidia-driver >/dev/null 2>&1; then
            sed -i 's|^# *export NVD_BACKEND=direct|export NVD_BACKEND=direct|' "$ENVFILE"
            echo "  [GPU] libva-nvidia-driver found — enabled NVD_BACKEND=direct (VA-API)."
        else
            echo "  [GPU] (optional) install libva-nvidia-driver for hardware video acceleration."
        fi
        chown "$REAL_USER" "$ENVFILE"

        # DRM modeset must be ON for Wayland. Arch enables it by default; only warn.
        # Never edit /etc/modprobe.d or rebuild initramfs silently — that touches boot.
        if [ -r /sys/module/nvidia_drm/parameters/modeset ] \
           && [ "$(cat /sys/module/nvidia_drm/parameters/modeset)" != "Y" ]; then
            echo "  [GPU] WARNING: nvidia_drm modeset is OFF — Wayland needs it ON."
            echo "        Add 'options nvidia_drm modeset=1' to /etc/modprobe.d/nvidia.conf,"
            echo "        then run 'sudo mkinitcpio -P' and reboot."
        fi

        # Hybrid graphics (iGPU + NVIDIA dGPU): don't guess the card — just inform.
        if lspci -nn 2>/dev/null | grep -iE 'VGA|3D|Display' | grep -qiE 'intel|amd|radeon|ati'; then
            echo "  [GPU] Hybrid graphics detected (iGPU + NVIDIA)."
            echo "        If displays on the NVIDIA GPU misbehave, set AQ_DRM_DEVICES in"
            echo "        ~/.config/uwsm/env-hyprland (see the commented hint there)."
        fi
    fi
fi

# ── Display manager ───────────────────────────────────────────────────────────
# Only install and enable greetd if no other display manager is already active.
# If the user already has sddm/gdm/lightdm/etc. enabled we leave it untouched.
_detect_dm() {
    for dm in sddm gdm lightdm lxdm xdm slim ly greetd; do
        if systemctl is-enabled "$dm" 2>/dev/null | grep -qE "^enabled"; then
            echo "$dm"; return 0
        fi
    done
    echo "none"
}

ACTIVE_DM=$(_detect_dm)
if [ "$ACTIVE_DM" = "none" ]; then
    echo "  No display manager detected — installing greetd..."

    # Install greetd config files (inject detected keyboard layout)
    sudo mkdir -p /etc/greetd
    sudo cp "$REPO_DIR/config/greetd/config.toml" /etc/greetd/config.toml
    sudo sed 's/kb_layout = "us"/kb_layout = "'"$SYS_KB_LAYOUT"'"/' \
        "$REPO_DIR/config/greetd/hyprland-greeter.lua" \
        | sudo tee /etc/greetd/hyprland-greeter.lua > /dev/null
    sudo chmod 644 /etc/greetd/config.toml /etc/greetd/hyprland-greeter.lua

    # Symlink greeter Hyprland config to the greeter user's default location
    # (HYPRLAND_CONFIG in config.toml already points here; symlink is a fallback)
    GREETER_HOME=$(getent passwd greeter | cut -d: -f6)
    if [ -n "$GREETER_HOME" ]; then
        sudo mkdir -p "$GREETER_HOME/.config/hypr"
        sudo ln -sf /etc/greetd/hyprland-greeter.lua "$GREETER_HOME/.config/hypr/hyprland.lua"
        sudo chown -R greeter:greeter "$GREETER_HOME/.config"
        echo "  [OK] Greeter Hyprland config symlinked to $GREETER_HOME/.config/hypr/hyprland.lua"
    fi

    sudo systemctl enable greetd
    echo "  [OK] greetd enabled."
else
    echo "  Display manager '$ACTIVE_DM' already enabled — skipping greetd setup."
fi

# ── Nidara unit ────────────────────────────────────────────────────────
# Deliberately NOT enabled via graphical-session.target — that would start the
# Nidara UI in every uwsm-managed Hyprland session, not just ours. The Nidara
# Hyprland config starts it (config/hypr/hyprland.lua → systemctl --user start),
# which only loads in the Nidara session. Restart=on-failure still respawns it
# on crash. Migration: disable any enablement left by older installs.
echo "  Refreshing nidara.service (started by the Nidara session, not enabled)..."
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user disable nidara.service 2>/dev/null || true

# ── Audio services ────────────────────────────────────────────────────────────
echo "  Enabling audio services..."
systemctl --user enable --now wireplumber pipewire pipewire-pulse 2>/dev/null || true

# ── Power profiles ────────────────────────────────────────────────────────────
# Game mode toggles performance/balanced via powerprofilesctl (hyprland.lua).
echo "  Enabling power-profiles-daemon..."
sudo systemctl enable --now power-profiles-daemon 2>/dev/null || true

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
