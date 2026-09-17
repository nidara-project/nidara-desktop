#!/usr/bin/env bash
# icon-registry-probe.sh — the interface-icon chain, off-screen, both ways round.
#
# The concept registry (#587) promises two things that are invisible when they
# break: with no interface icon theme set NOTHING changes on screen, and with one
# set the standard names win. Both failures draw *an* icon, so neither shows up as
# an error — only as the wrong glyph, on somebody's machine, later.
#
# So this runs `ui/shell/core/Icons.ts` against a PRIVATE GSettings database, and
# requires the runs to disagree:
#
#   1. interface-icon-theme = ""        → every concept resolves to our drawing;
#   2. interface-icon-theme = <a theme> → a good share resolve to the theme's;
#   3. the same name MISSPELLED         → our drawing again, and a log line saying why;
#   4. a theme WITHOUT the spec key     → our drawing again, and a log line saying why.
#
# Run 4 is the Nidara icon spec (#587, 2026-09-17): only a theme that declares
# `X-Nidara-Icon-Spec` in its index.theme is used. The control is the SAME theme
# directory as run 2 with that one line removed, so nothing but the key differs.
#
# Run 2 is the control that can fail: if the resolver silently ignored the theme,
# run 2 would look exactly like run 1 and the probe says so. Run 3 is the other
# half of that: a theme name is a case-sensitive DIRECTORY name, `set_theme_name`
# accepts anything, and a name that is not there resolves nothing — which looks
# identical to the setting never having been touched. The owner hit exactly that
# with `adwaita` for `Adwaita`, so the resolver must SAY so.
#
# The display is `cage` with wlroots' headless backend — GTK4 starts and resolves
# icons for real, and nothing appears on the user's screen.
#
# Usage: scripts/dev/icon-registry-probe.sh [theme-directory]
#   A theme that declares the spec. Defaults to Nidara's own, in this checkout
#   (ui/shell/assets/icons/nidara); a theme you are making works the same.
#   It is put on a private XDG_DATA_HOME and asked for by its directory name, so
#   nothing gets installed anywhere.
#
# Needs: gjs, esbuild, cage, glib-compile-schemas. No display of your own.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
arg="${1:-$repo/ui/shell/assets/icons/nidara}"
work="$(mktemp -d -t nidara-icon-probe-XXXXXX)"
trap 'rm -rf "$work"' EXIT

[ -d "$arg" ] || { echo "icon-registry-probe: $arg is not a theme directory" >&2; exit 2; }
grep -q '^X-Nidara-Icon-Spec=' "$arg/index.theme" || {
    echo "icon-registry-probe: $arg does not declare X-Nidara-Icon-Spec — run 2 needs a theme made for the spec" >&2; exit 2; }
theme="$(basename "$(cd "$arg" && pwd)")"
mkdir -p "$work/data/icons"
ln -s "$(cd "$arg" && pwd)" "$work/data/icons/$theme"
# The control for run 4: the same drawings, the index.theme without the key.
nospec="$theme-nospec"
mkdir -p "$work/data/icons/$nospec"
for entry in "$arg"/*; do
    [ "$(basename "$entry")" = index.theme ] || ln -s "$(cd "$(dirname "$entry")" && pwd)/$(basename "$entry")" "$work/data/icons/$nospec/"
done
grep -v '^X-Nidara-Icon-Spec=' "$arg/index.theme" > "$work/data/icons/$nospec/index.theme"
data_home="$work/data"

"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/icon-registry-probe.ts" "$work/probe.js" >/dev/null

mkdir -p "$work/config" "$work/runtime" "$work/schemas"
chmod 700 "$work/runtime"
# This checkout's schemas, not the installed ones — interface-icon-theme is new.
cp "$repo"/config/gsettings/*.gschema.xml "$work/schemas/"
glib-compile-schemas "$work/schemas"

# ⚠️ The environment goes on the `env` line, BEFORE dbus-run-session, never inside
# the shell it runs: a D-Bus-ACTIVATED service (dconf-service is one) inherits the
# DAEMON's environment, not the caller's. Set it the other way round and
# `gsettings set` lands in the REAL ~/.config/dconf/user — this probe's first
# version did exactly that, the write did not stick, and both runs looked
# identical. The canary below proves the database is private before anything is
# written to it.
run() {  # run <theme-name>
    env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
        XDG_CONFIG_HOME="$work/config" XDG_RUNTIME_DIR="$work/runtime" \
        XDG_DATA_HOME="$data_home" \
        GSETTINGS_SCHEMA_DIR="$work/schemas" GIO_USE_VFS=local \
        NIDARA_SHELL_ROOT="$repo/ui/shell" \
        WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
        work="$work" theme="$1" \
        dbus-run-session -- bash -c '
            dconf write /org/nidara/probe/canary "true"
            sleep 0.3
            [ -s "$XDG_CONFIG_HOME/dconf/user" ] || {
                echo "ABORT the dconf canary did not reach the private database" >&2; exit 1; }
            gsettings set org.nidara.appearance interface-icon-theme "$theme"
            exec cage -- gjs -m "$work/probe.js"
        ' 2>"$work/stderr.txt" | grep -E '^(THEME|ICON|TOTAL|LISTED)'
}

fail=0
say() { printf '%s\n' "$*"; }

say "── 1. no interface theme: every concept must come from our own drawings ──"
run "" > "$work/off.txt"
off_theme=$(awk '$1=="TOTAL"{print $2}' "$work/off.txt")
off_shipped=$(awk '$1=="TOTAL"{print $3}' "$work/off.txt")
say "   from the theme: $off_theme · shipped: $off_shipped"
if [ "$off_theme" != "0" ]; then
    say "   FAIL with no theme set, $off_theme concepts still came from somewhere else:"
    awk '$1=="ICON" && $3=="theme"{print "     " $2 " " $4}' "$work/off.txt" | head -10
    fail=1
else
    say "   ok   nothing changes on screen, which is the promise of this step"
fi

say "── 2. interface theme = $theme: its drawings must win ──"
run "$theme" > "$work/on.txt"
on_theme=$(awk '$1=="TOTAL"{print $2}' "$work/on.txt")
on_shipped=$(awk '$1=="TOTAL"{print $3}' "$work/on.txt")
say "   from the theme: $on_theme · shipped: $on_shipped"
if [ "$on_theme" = "0" ]; then
    say "   FAIL the theme was set and NOT ONE concept resolved to it — the resolver is ignoring it."
    fail=1
else
    say "   ok   $on_theme concepts drew from $theme; the other $on_shipped fell through to ours"
    say "   (the fall-through list — these are the names $theme does not carry:)"
    awk '$1=="ICON" && $3=="shipped"{print "     " $2}' "$work/on.txt" | head -20
fi

listed=" $(awk '$1=="LISTED"{$1=""; print}' "$work/on.txt") "
if [[ "$listed" != *" $theme "* ]]; then
    say "   FAIL Settings would not offer $theme — the list is:$listed"
    fail=1
elif [[ "$listed" == *" $nospec "* ]]; then
    say "   FAIL Settings would offer $nospec, which does not declare the spec"
    fail=1
else
    say "   ok   Settings offers $theme and not $nospec"
fi

say "── 3. the same name misspelled: our drawings, and the log must say why ──"
bad="$(printf '%s' "$theme" | tr '[:upper:]' '[:lower:]')x"
run "$bad" > "$work/bad.txt"
bad_theme=$(awk '$1=="TOTAL"{print $2}' "$work/bad.txt")
if [ "$bad_theme" != "0" ]; then
    say "   FAIL \"$bad\" is not a theme, yet $bad_theme concepts came from one"
    fail=1
elif ! grep -q "is not installed" "$work/stderr.txt"; then
    say "   FAIL nothing was logged — a mistyped theme name would fail silently:"
    sed 's/^/     /' "$work/stderr.txt" | head -5
    fail=1
else
    say "   ok   fell back to ours AND said why:"
    grep -o "\[Icons\].*" "$work/stderr.txt" | head -1 | sed 's/^/     /'
fi

say "── 4. $nospec (same drawings, no X-Nidara-Icon-Spec): our drawings, and the log must say why ──"
run "$nospec" > "$work/nospec.txt"
nospec_theme=$(awk '$1=="TOTAL"{print $2}' "$work/nospec.txt")
if [ "$nospec_theme" != "0" ]; then
    say "   FAIL \"$nospec\" does not declare the spec, yet $nospec_theme concepts came from it"
    fail=1
elif ! grep -q "does not follow Nidara's icon spec" "$work/stderr.txt"; then
    say "   FAIL nothing was logged — a theme ignored for lacking the key would look like a broken setting:"
    sed 's/^/     /' "$work/stderr.txt" | head -5
    fail=1
else
    say "   ok   ignored AND said why:"
    grep -o "\[Icons\].*" "$work/stderr.txt" | head -1 | sed 's/^/     /'
fi

if [ "$fail" = "0" ]; then say "icon-registry-probe: OK"; else say "icon-registry-probe: FAILED"; fi
exit "$fail"
