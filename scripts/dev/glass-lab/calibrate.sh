#!/usr/bin/env bash
# The reference probe's calibration set, drawn by Hyalo in the glass lab.
#
#   scripts/dev/glass-lab/calibrate.sh OUTDIR [--preset FILE] [--combos "regular-dark clear-light …"]
#
# OUTDIR/<scenario>/window.png for every scenario of glass-probe's scripts/calibration.sh at the
# base size, with the same names — `none-<backdrop>` (no glass) and `<variant>-<appearance>-
# <backdrop>` — so the probe's tools/calibrate.py reads a lab run exactly as it reads one of the
# reference, and the two can be compared capture by capture. The lab's specimen is the probe's: a
# 240 px square, corner radius 30, nothing in it, centred in an 800×600 output.
#
# --preset   start every recipe from this lab preset (what «Guardar» writes); the variant and
#            the appearance are set on top of it per combination
# --combos   which recipes (default: all four)
set -euo pipefail
here=$(dirname "$(realpath "$0")")
out=""; preset=""; combos="regular-light regular-dark clear-light clear-dark"
while [ $# -gt 0 ]; do
    case "$1" in
        --preset) preset=$(realpath "$2"); shift ;;
        --combos) combos="$2"; shift ;;
        -*) echo "calibrate: unknown option $1" >&2; exit 2 ;;
        *) out=$(realpath -m "$1") ;;
    esac
    shift
done
[ -n "$out" ] || { echo "usage: calibrate.sh OUTDIR [--preset FILE] [--combos LIST]" >&2; exit 2; }
mkdir -p "$out"
work=$(mktemp -d "${TMPDIR:-/tmp}/glass-cal.XXXXXX")
trap 'rm -rf "$work"' EXIT

# The probe's backdrops (glass-probe scripts/calibration.sh), in the lab's `cal <kind>` form.
backdrops=()
for l in 0 0.1 0.2 0.35 0.5 0.65 0.8 0.9 1; do backdrops+=("level:$l"); done
for c in E53935 43A047 1E88E5 FDD835 8E24AA 00ACC1; do backdrops+=("rgb:$c"); done
backdrops+=(edge edge:0.4:0.6 ramp-x ramp-y)
slug() { echo "$1" | tr ':' '-'; }

# One lab session per recipe: a preset that is the base plus the bench, the variant and the mode.
recipe() {  # recipe NAME VARIANT DARK SHOW PREFIX
    local name=$1 variant=$2 dark=$3 show=$4 prefix=$5
    python3 - "$preset" "$work/$name.json" "$variant" "$dark" "$show" <<'PY'
import json, sys
base, dest, variant, dark, show = sys.argv[1:]
p = json.load(open(base)) if base else {}
p.update({"variant": variant, "show": show, "backdropPolicy": "ninguna", "inkPolicy": "según rol"})
p.setdefault("flags", {})["dark"] = dark == "1"
json.dump(p, open(dest, "w"))
PY
    : > "$work/$name.batch"
    for b in "${backdrops[@]}"; do printf '%s\t%s\n' "$prefix$(slug "$b")" "cal $b" >> "$work/$name.batch"; done
    echo "calibrate: $name (${#backdrops[@]} captures)" >&2
    "$here/glass-lab.sh" --headless "$out/.$name.png" --preset "$work/$name.json" --show "$show" \
        --size 800x600 --batch "$work/$name.batch" >/dev/null
    rm -f "$out/.$name.png" "$out/.$name.txt"
}

recipe none regular 1 "calibración: sin cristal" "none-"
for c in $combos; do
    variant=${c%-*} appearance=${c#*-}
    recipe "$c" "$variant" "$([ "$appearance" = dark ] && echo 1 || echo 0)" "calibración" "$c-"
done
echo "calibrate: $(find "$out" -name window.png | wc -l) captures in $out" >&2
