#!/usr/bin/env bash
# Build two real executable files: symlinks would share /proc/PID/exe's name.
# Atomic replacement also permits rebuilding while an older host is running.
set -euo pipefail
src=$(dirname "$(realpath "$0")")
out=${1:-$src/build}
mkdir -p "$out"
first=$(mktemp "$out/.nidara-shell.XXXXXX")
second=$(mktemp "$out/.nidara-settings.XXXXXX")
trap 'rm -f "$first" "$second"' EXIT
read -r -a flags <<< "$(pkg-config --cflags gjs-1.0)"
read -r -a libs <<< "$(pkg-config --libs gjs-1.0)"
cc -std=c11 -O2 -Wall -Wextra -Werror "${flags[@]}" "$src/nidara-host.c" "${libs[@]}" -o "$first"
cp "$first" "$second"
chmod 755 "$first" "$second"
# Opening Settings must not mark an unchanged running shell executable deleted.
if ! cmp -s "$first" "$out/nidara-shell"; then mv -f "$first" "$out/nidara-shell"; fi
if ! cmp -s "$second" "$out/nidara-settings"; then mv -f "$second" "$out/nidara-settings"; fi
