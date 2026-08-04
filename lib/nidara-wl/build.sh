#!/usr/bin/env bash
# Build libnidara-wl + its GObject Introspection typelib.
#
# No build system on purpose. The project already depends on cc, wayland-scanner
# and gobject-introspection for `nidara-input`; adding meson here would buy
# nothing but another makedep and another thing to keep in sync with install.sh.
#
# Output (in $OUT_DIR, default ./build):
#   libnidara-wl.so.0.0.0  + libnidara-wl.so.0 + libnidara-wl.so symlinks
#   NidaraWl-1.0.gir
#   NidaraWl-1.0.typelib
#
# Usage:  ./build.sh [OUT_DIR]
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SRC_DIR/build}"
GEN_DIR="$OUT_DIR/gen"

SONAME=libnidara-wl.so.0
REAL=libnidara-wl.so.0.0.0

WL_PROTO_DIR="$(pkg-config --variable=pkgdatadir wayland-protocols)"
HYPR_PROTO_DIR=/usr/share/hyprland-protocols/protocols
WLR_PROTO_DIR=/usr/share/wlr-protocols/unstable

# hyprland-toplevel-mapping-v1 has a zwlr_foreign_toplevel_handle_v1 variant, so
# its generated code references the wlr interface symbol even though we only use
# the ext one. Leave the wlr protocol out and the link fails with an undefined
# reference that says nothing about why — this list is why.
PROTOCOLS=(
  "$WL_PROTO_DIR/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml"
  "$WL_PROTO_DIR/staging/ext-image-capture-source/ext-image-capture-source-v1.xml"
  "$WL_PROTO_DIR/staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml"
  "$HYPR_PROTO_DIR/hyprland-focus-grab-v1.xml"
  "$HYPR_PROTO_DIR/hyprland-surface-v1.xml"
  "$HYPR_PROTO_DIR/hyprland-toplevel-mapping-v1.xml"
  "$WLR_PROTO_DIR/wlr-foreign-toplevel-management-unstable-v1.xml"
)

rm -rf "$OUT_DIR"
mkdir -p "$GEN_DIR"

echo "==> generating protocol glue"
PROTO_SOURCES=()
for xml in "${PROTOCOLS[@]}"; do
  [ -f "$xml" ] || { echo "missing protocol: $xml" >&2; exit 1; }
  name="$(basename "$xml" .xml)"
  wayland-scanner client-header "$xml" "$GEN_DIR/$name-client-protocol.h"
  wayland-scanner private-code  "$xml" "$GEN_DIR/$name-protocol.c"
  PROTO_SOURCES+=("$GEN_DIR/$name-protocol.c")
done

CFLAGS=(-O2 -fPIC -Wall -Wextra -std=gnu11 "-I$SRC_DIR" "-I$GEN_DIR")
PKGS=(gtk4 wayland-client cairo gobject-2.0 gio-2.0)
read -r -a PKG_CFLAGS <<< "$(pkg-config --cflags "${PKGS[@]}")"
read -r -a PKG_LIBS   <<< "$(pkg-config --libs   "${PKGS[@]}")"

echo "==> compiling $REAL"
cc "${CFLAGS[@]}" "${PKG_CFLAGS[@]}" -shared \
   -Wl,-soname,"$SONAME" \
   "$SRC_DIR/nidara-wl.c" "${PROTO_SOURCES[@]}" \
   "${PKG_LIBS[@]}" -o "$OUT_DIR/$REAL"

ln -sf "$REAL" "$OUT_DIR/$SONAME"
ln -sf "$SONAME" "$OUT_DIR/libnidara-wl.so"

echo "==> scanning introspection data"
# Only our own header is scanned: the generated protocol headers are plain C with
# no annotations and would pollute the namespace.
g-ir-scanner \
  --namespace=NidaraWl --nsversion=1.0 \
  --identifier-prefix=NidaraWl --symbol-prefix=nidara_wl \
  --include=Gdk-4.0 --include=Gio-2.0 \
  --pkg=gtk4 --pkg=gio-2.0 \
  --library=nidara-wl --library-path="$OUT_DIR" \
  --warn-all --quiet \
  -I"$SRC_DIR" -I"$GEN_DIR" \
  "$SRC_DIR/nidara-wl.h" "$SRC_DIR/nidara-wl.c" \
  --output="$OUT_DIR/NidaraWl-1.0.gir"

echo "==> compiling typelib"
g-ir-compiler "$OUT_DIR/NidaraWl-1.0.gir" \
  --output="$OUT_DIR/NidaraWl-1.0.typelib"

echo "==> done: $OUT_DIR"
ls -la "$OUT_DIR"
