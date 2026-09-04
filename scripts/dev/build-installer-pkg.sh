#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# build-installer-pkg.sh — the `nidara-installer` package, built from THIS tree.
#
#     ./scripts/dev/build-installer-pkg.sh [-o OUT_DIR]      # default: ./out-pkg
#
# Then hand the directory to nidara-iso:
#
#     sudo ./build.sh -L /home/…/nidara-desktop/out-pkg
#
# ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# The ISO installs `nidara-installer` from the published [nidara] repo, which
# nidara-repo builds from the tag in its `pins.env`. So an image built today
# carries the installer of the last RELEASE — and an unreleased change to
# `ui/installer/` cannot be tested on the medium at all without cutting a release
# first. That is the wrong price for every step of the disk migration (#310), and
# it is why testing the installer had been happening by copying a bundle into a
# live session by hand: faithful to the code, not to the artifact.
#
# This builds the artifact. Same PKGBUILD releases ship, same `build()`, same
# three files in the package — only the source is this working tree instead of a
# tag's tarball.
#
# ⚠️ It BUILDS and does not install. `install.sh` has a near-identical recipe
# (`build_local_nidara_pkg`) and it exists to hand somebody the DESKTOP on an
# Arch they already use — it must never hand them a program whose job is to erase
# a disk. This one is the opposite half: it produces the installer package, puts
# it in a directory, and nothing here calls pacman.
#
# ⚠️ Found while writing this: install.sh limits itself with `makepkg --pkg
# nidara-desktop`, and **`--pkg` was removed in pacman 7.0** — makepkg 7.1 exits
# with `invalid option '--pkg'`, so that whole fallback path is dead on a current
# Arch. It fails closed rather than dangerously (the anchored filename, not the
# flag, is what actually keeps the installer out of a user's machine), but it is
# a real bug and it is not this script's to fix.
#
# ⚠️ The two recipes share the TAR: makepkg skips the download when it finds a
# source file of the expected name, so the working tree has to be packed under
# `nidara-desktop-$pkgver.tar.gz` with the prefix the PKGBUILD expects, minus the
# artifacts `build()` regenerates. If install.sh's exclude list changes, this one
# is stale — the symptom is a package that builds from stale `build/` output.
#
# ⚠️ Uncommitted changes are INCLUDED, on purpose: this exists to test what is in
# front of you. The package it writes is therefore not reproducible from any
# commit, which is exactly why the ISO side marks such an image as a test build.
#
# Requires the build toolchain `makepkg` will not install for you here: the same
# one install.sh §4/§5 needs (npm, meson, wayland-scanner, PAM headers).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_DIR/out-pkg"

while getopts 'o:h' opt; do
    case "$opt" in
        o) OUT="$OPTARG" ;;
        h) sed -n '2,30p' "$0"; exit 0 ;;
        *) exit 1 ;;
    esac
done

[ "$(id -u)" -ne 0 ] || { echo "build-installer-pkg.sh must NOT run as root (makepkg refuses)." >&2; exit 1; }

PKGVER="$(grep '^pkgver=' "$REPO_DIR/packaging/nidara/PKGBUILD" | head -1 | cut -d= -f2)"
VERSION="$(cat "$REPO_DIR/VERSION")"
if [ "$PKGVER" != "$VERSION" ]; then
    echo "  [WARN] PKGBUILD pkgver=$PKGVER ≠ VERSION=$VERSION — packaging this tree as $PKGVER." >&2
fi

# ── the pkgrel is stamped, and that is not cosmetic ──────────────────────────
#
# `pkgver` is the RELEASED one, because this tree has not been released. Built
# with the PKGBUILD's own `pkgrel=1`, the package would land on disk as
# `nidara-installer-0.11.0-1-x86_64.pkg.tar.zst` — byte for byte a DIFFERENT file
# with byte for byte the SAME name as the one the [nidara] repo serves. Two things
# go wrong at once, and the first one is not obvious:
#
#   1. `pacstrap` shares /var/cache/pacman/pkg with the build host. A published
#      copy sitting there from an earlier build is found by that name, checked
#      against the local repo's checksum, and reported as
#      `is corrupted (invalid or corrupted package (checksum))` — which is a lie
#      about the cache and aborts the whole transaction. Measured 2026-09-04; it
#      is the same shape as nidara-iso's known trap about republished packages.
#   2. With equal versions, only repository ORDER decides which one an image gets,
#      and order is a request rather than a receipt.
#
# A stamped pkgrel removes both: the filename cannot collide with anything, and
# the package wins on VERSION rather than on where it sits in a list. It also
# makes the resulting image self-describing — `pacman -Q nidara-installer` on the
# medium says `0.11.0-1.<stamp>`, which no release will ever produce.
PKGREL="1.$(date +%s)"
echo "==> Building nidara-installer $PKGVER-$PKGREL from $REPO_DIR"
echo "    (pkgrel stamped so it cannot collide with the published package)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$REPO_DIR/packaging/nidara/PKGBUILD" "$REPO_DIR/packaging/nidara/nidara.install" "$WORK/"
sed -i "s/^pkgrel=.*/pkgrel=$PKGREL/" "$WORK/PKGBUILD"
tar -C "$REPO_DIR" -czf "$WORK/nidara-desktop-$PKGVER.tar.gz" \
    --exclude='./.git' \
    --exclude='./ui/shell/node_modules' --exclude='./ui/shell/@girs' \
    --exclude='./ui/shell/build' --exclude='./ui/greeter/build' \
    --exclude='./ui/greeter/node_modules' --exclude='./ui/lockscreen/build' \
    --exclude='./ui/lockscreen/node_modules' \
    --exclude='./ui/installer/build' --exclude='./ui/installer/node_modules' \
    --exclude='./out-pkg' \
    --exclude='./packaging/nidara/src' --exclude='./packaging/nidara/pkg' \
    --exclude='./packaging/nidara/*.tar.*' \
    --transform "s|^\.|nidara-desktop-$PKGVER|SH" .

# ⚠️ NO `--pkg`. That option was removed in pacman 7.0 and `makepkg` 7.1 answers
# `invalid option '--pkg'` — install.sh still passes it, which is a separate bug
# (its local-build fallback cannot run on a current Arch at all). Losing it costs
# nothing here: `build()` is shared by both packages and runs whole either way,
# so `--pkg` only ever skipped `package_nidara-desktop()`. What it must NOT cost
# is the guarantee behind it — that a desktop package built here never travels to
# an ISO — and that guarantee never lived in the flag: it lives in the anchored
# filename below, which is also how install.sh really enforces it.
#
# This therefore compiles the shell, the greeter, the lock screen and the two C
# libraries as well. That is the price of using the recipe the release uses.
( cd "$WORK" && makepkg -f --noconfirm --nodeps --skipinteg --noprogressbar )

mkdir -p "$OUT"
# Every run stamps a new pkgrel, so without this the directory accumulates one
# package per build and the ISO's repo would carry all of them. Only the newest
# would ever be chosen, which is right — and a directory of near-identical
# packages is how somebody eventually tests the wrong one by hand.
rm -f "$OUT"/nidara-installer-*.pkg.tar.*
# Anchored to the name: `nidara-*` would also match `nidara-desktop-*`, which is
# the package that must never travel to an ISO by accident.
pkgfile="$(ls -t "$WORK"/nidara-installer-"$PKGVER"-"$PKGREL"-*.pkg.tar.* 2>/dev/null | head -1)"
[ -n "$pkgfile" ] || { echo "  [ERR] makepkg produced no nidara-installer package" >&2; exit 1; }
cp "$pkgfile" "$OUT/"

echo
echo "==> $OUT/$(basename "$pkgfile")"
echo "    sudo ./build.sh -L $OUT      # from nidara-iso"
echo "    on the medium it identifies itself: pacman -Q nidara-installer -> $PKGVER-$PKGREL"
