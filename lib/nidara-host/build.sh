#!/usr/bin/env bash
# Build one real executable file per name in ./hosts: symlinks would share
# /proc/PID/exe's name. Atomic replacement also permits rebuilding while an
# older host is running.
set -euo pipefail
src=$(dirname "$(realpath "$0")")
out=${1:-$src/build}
mkdir -p "$out"
mapfile -t hosts < <(grep -v '^\s*\(#\|$\)' "$src/hosts")
compiled=$(mktemp "$out/.nidara-host.XXXXXX")
trap 'rm -f "$compiled" "$out"/.nidara-host-copy.*' EXIT
read -r -a flags <<< "$(pkg-config --cflags gjs-1.0)"
read -r -a libs <<< "$(pkg-config --libs gjs-1.0)"
cc -std=c11 -O2 -Wall -Wextra -Werror "${flags[@]}" "$src/nidara-host.c" "${libs[@]}" -o "$compiled"
chmod 755 "$compiled"
for host in "${hosts[@]}"; do
    # Opening Settings must not mark an unchanged running shell executable deleted.
    cmp -s "$compiled" "$out/$host" && continue
    copy=$(mktemp "$out/.nidara-host-copy.XXXXXX")
    cp "$compiled" "$copy"
    chmod 755 "$copy"
    mv -f "$copy" "$out/$host"
done
