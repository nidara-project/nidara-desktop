#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/bundle.sh — Nidara's bundler. Replaces `ags bundle` (2026-08-18).
#
#   scripts/bundle.sh <entry.ts> <outfile> [extra esbuild args…]
#   scripts/bundle.sh --js <entry.ts> <out.js> [extra esbuild args…]
#
# Default output is a SELF-CONTAINED EXECUTABLE: a bash wrapper carrying the
# bundled JS base64-encoded, which decodes it to $XDG_RUNTIME_DIR and runs gjs
# on it. That shape is not a preference — every packaging site (install.sh,
# packaging/nidara/PKGBUILD) installs ONE file per bundle, so a two-file output
# would break them silently. `--js` emits the plain ESM instead (what run.sh and
# the offscreen probes want).
#
# WHY THE FLAGS BELOW ARE WHAT THEY ARE. They are not "what worked": they are
# `ags bundle`'s (v3.1.2 cli/lib/esbuild.go + cli/cmd/bundle.go), transcribed,
# and the transcription was VERIFIED — with these exact flags esbuild 0.28.2
# emits a bundle byte-identical to AGS's for all three (shell, greeter,
# lockscreen). Change one and you are no longer building what shipped:
#
#   --target=es2022,firefox115  GJS is SpiderMonkey. This pair is why private
#                               fields and static blocks survive but \p{…}
#                               regexes get rewritten.
#   --tsconfig=…                load-bearing, NOT decoration. tsconfig's
#                               `target: ES2020` is what turns
#                               useDefineForClassFields OFF, so a class field
#                               lowers to a constructor ASSIGNMENT instead of
#                               Object.defineProperty. On a GObject subclass
#                               define-semantics would shadow the GObject
#                               property accessors — silently.
#   --external:…                gjs's built-in module names. Without them the
#                               build fails loudly (`system`, `console`), which
#                               is the good case; `file://*` and `resource://*`
#                               are the ones that would fail late.
#   --loader:.css=text          AGS parity. (The scss/blp/inline: plugins are
#                               NOT reproduced — nothing in this repo imports
#                               one; style.css is READ AT RUNTIME, never
#                               bundled. env.d.ts is trimmed to match.)
#
# ⚠️ THE WRAPPER'S `LD_PRELOAD` IS LOAD-BEARING AND FAILS MUTE. It is what makes
# gtk4-layer-shell work; without it the shell starts, logs nothing unusual, and
# has NO BAR AND NO DOCK (the surfaces silently become ordinary windows). It
# lives here, in the generated wrapper — not in bin/nidara-ui.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

JS_ONLY="no"
if [ "${1:-}" = "--js" ]; then JS_ONLY="yes"; shift; fi

if [ $# -lt 2 ]; then
    echo "usage: bundle.sh [--js] <entry> <outfile> [extra esbuild args…]" >&2
    exit 2
fi

entry="$1"; outfile="$2"; shift 2

[ -f "$entry" ] || { echo "bundle.sh: no such entry file: $entry" >&2; exit 1; }

esbuild="${ESBUILD:-esbuild}"
command -v "$esbuild" >/dev/null 2>&1 || {
    echo "bundle.sh: esbuild not found — install it: sudo pacman -S esbuild" >&2
    exit 1
}

entry_abs="$(realpath "$entry")"
entry_dir="$(dirname "$entry_abs")"
out_abs="$(realpath -m "$outfile")"
mkdir -p "$(dirname "$out_abs")"

# esbuild finds tsconfig.json on its own, but ONLY next to the entry file; being
# explicit means a probe bundled from scripts/dev/ gets the same one the app does.
tsconfig="$entry_dir/tsconfig.json"
tsconfig_args=()
[ -f "$tsconfig" ] && tsconfig_args=(--tsconfig="$tsconfig")

js_out="$out_abs"
if [ "$JS_ONLY" = "no" ]; then
    js_out="$(mktemp -t nidara-bundle-XXXXXX.js)"
    trap 'rm -f "$js_out"' EXIT
fi

"$esbuild" "$entry_abs" \
    --bundle \
    --format=esm \
    --platform=neutral \
    --target=es2022,firefox115 \
    --sourcemap=inline \
    "${tsconfig_args[@]}" \
    --loader:.css=text \
    --define:SRC="\"$entry_dir\"" \
    --external:'gi://*' \
    --external:'file://*' \
    --external:'resource://*' \
    --external:system \
    --external:console \
    --external:cairo \
    --external:gettext \
    --outfile="$js_out" \
    "$@"

[ "$JS_ONLY" = "yes" ] && exit 0

# ── The executable wrapper ───────────────────────────────────────────────────
# The runtime filename carries a CONTENT hash, so two builds of different code
# never race over the same path, and the decode is written to a temp + mv'd so
# an interrupted launch can never leave a truncated JS behind.
gjs_bin="$(command -v gjs || echo /usr/bin/gjs)"
layer_shell="${NIDARA_GTK4_LAYER_SHELL:-}"
if [ -z "$layer_shell" ]; then
    _libdir="$(pkg-config --variable=libdir gtk4-layer-shell-0 2>/dev/null || true)"
    layer_shell="${_libdir:-/usr/lib}/libgtk4-layer-shell.so"
fi
[ -f "$layer_shell" ] || echo "bundle.sh: WARNING — $layer_shell not found; the bundle will have no layer surfaces (no bar, no dock)" >&2

hash="$(sha256sum "$js_out" | cut -c1-12)"
name="$(basename "$out_abs")"

{
    printf '#!/usr/bin/env bash\n'
    printf '# Generated by scripts/bundle.sh — do not edit.\n'
    printf 'js="${XDG_RUNTIME_DIR:-/tmp}/%s-%s.js"\n' "$name" "$hash"
    printf 'if [ ! -s "$js" ]; then\n'
    printf '    tmp="$js.$$"\n'
    printf '    if ! base64 --decode > "$tmp" <<'"'"'NIDARA_BUNDLE_EOF'"'"'\n'
    base64 -w0 "$js_out"
    printf '\nNIDARA_BUNDLE_EOF\n'
    printf '    then\n'
    printf '        echo "%s: could not unpack the bundle into $tmp" >&2\n' "$name"
    printf '        rm -f "$tmp"; exit 1\n'
    printf '    fi\n'
    printf '    mv -f "$tmp" "$js" || { echo "%s: could not install $js" >&2; exit 1; }\n' "$name"
    printf 'fi\n'
    printf 'exec env LD_PRELOAD=%s %s -m "$js" "$@"\n' "$layer_shell" "$gjs_bin"
} > "$out_abs"

chmod 755 "$out_abs"
