#!/usr/bin/env bash
# Build libnidara-auth + its GObject Introspection typelib.
#
# Output (in $OUT_DIR, default ./build):
#   libnidara-auth.so.0.0.0  + libnidara-auth.so.0 + libnidara-auth.so symlinks
#   NidaraAuth-1.0.gir
#   NidaraAuth-1.0.typelib
#
# Usage:  ./build.sh [OUT_DIR]
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SRC_DIR/build}"

SONAME=libnidara-auth.so.0
REAL=libnidara-auth.so.0.0.0

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

CFLAGS=(-O2 -fPIC -Wall -Wextra -std=gnu11 "-I$SRC_DIR")
read -r -a PKG_CFLAGS <<< "$(pkg-config --cflags gobject-2.0 gio-2.0)"
read -r -a PKG_LIBS   <<< "$(pkg-config --libs   gobject-2.0 gio-2.0) -lpam"

echo "==> compiling $REAL"
cc "${CFLAGS[@]}" "${PKG_CFLAGS[@]}" -shared \
   -Wl,-soname,"$SONAME" \
   "$SRC_DIR/nidara-auth.c" \
   "${PKG_LIBS[@]}" -o "$OUT_DIR/$REAL"

ln -sf "$REAL" "$OUT_DIR/$SONAME"
ln -sf "$SONAME" "$OUT_DIR/libnidara-auth.so"

echo "==> scanning introspection data"
g-ir-scanner \
  --namespace=NidaraAuth --nsversion=1.0 \
  --identifier-prefix=NidaraAuth --symbol-prefix=nidara_auth \
  --include=GObject-2.0 --include=Gio-2.0 \
  --pkg=gobject-2.0 --pkg=gio-2.0 \
  --library=nidara-auth --library-path="$OUT_DIR" \
  --warn-all --quiet \
  -I"$SRC_DIR" \
  "$SRC_DIR/nidara-auth.h" "$SRC_DIR/nidara-auth.c" \
  --output="$OUT_DIR/NidaraAuth-1.0.gir"

echo "==> compiling typelib"
g-ir-compiler "$OUT_DIR/NidaraAuth-1.0.gir" \
  --output="$OUT_DIR/NidaraAuth-1.0.typelib"

echo "==> done: $OUT_DIR"
ls -la "$OUT_DIR"
