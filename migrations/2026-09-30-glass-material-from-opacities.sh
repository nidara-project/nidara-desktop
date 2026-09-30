# 2026-09-30 — the four glass opacities → one glass material (#674)
#
# Settings → Appearance offered a master glass slider and four per-surface ones
# (bar-opacity, overlay-opacity, dock-opacity, window-opacity in
# org.nidara.appearance). They are replaced by ONE choice of three —
# glass-material = clear | regular | frosted — whose per-surface values are a table
# in the kit (GLASS_FLOORS, ui/lib/nidara-kit/platform/theme-tokens.ts). Nothing
# reads the four keys any more; this turns them into the nearest material, once,
# and resets them.
#
# The rule: the mean of the BAR and the PANELS — the two surfaces that carry text,
# and the two the old master slider was mostly moved for. The dock is not counted: it
# sat at the floor by default. Nor are the windows: they left the material the same day
# for a switch of their own (window-transparency, ON by default), and every stored window
# opacity was translucent — which is what "on" keeps. Thresholds are the midpoints between the table's
# means (clear 0.24, regular 0.34, frosted 0.46):
#     mean < 0.29 → clear · mean ≥ 0.40 → frosted · otherwise nothing (regular stays)
# A key never set counts as its old default (0.48), but only if at least one of the
# two was set — an install that never touched either keeps the new default.
#
# ⚠️ `gsettings set` EXITS 0 WHILE FAILING with no session bus (#295); under dconf the
# writer is pinged first, as settings_import does, and a failure retries next session.

schema=org.nidara.appearance
command -v gsettings >/dev/null 2>&1 || { warn "gsettings is missing"; return 1; }
gsettings list-keys "$schema" 2>/dev/null | grep -qx glass-material \
    || { warn "schema $schema has no glass-material yet — not migrated"; return 1; }
if [ "${GSETTINGS_BACKEND:-dconf}" = dconf ]; then
    gdbus call --session --dest ca.desrt.dconf --object-path /ca/desrt/dconf/Writer/user \
        --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 \
        || { warn "dconf is not reachable on the session bus — glass not migrated yet"; return 1; }
fi

# Whether the user set a key: `gsettings get` answers the default for an unset key,
# so compare against the schema's default instead of trusting dconf (CI runs keyfile).
is_set() { [ "$(gsettings get "$schema" "$1")" != "$(GSETTINGS_BACKEND=memory gsettings get "$schema" "$1")" ]; }

if is_set bar-opacity || is_set overlay-opacity; then
    bar="$(gsettings get "$schema" bar-opacity)"
    overlay="$(gsettings get "$schema" overlay-opacity)"
    material="$(awk -v b="$bar" -v o="$overlay" 'BEGIN {
        m = (b + o) / 2
        if (m < 0.29) print "clear"; else if (m >= 0.40) print "frosted"; else print ""
    }')"
    # A material already chosen (a shell that ran before this migration could not
    # have written it, but a re-run with the marker cleared can find one) wins.
    if [ -n "$material" ] && ! is_set glass-material; then
        gsettings set "$schema" glass-material "$material" || return 1
        [ "$(gsettings get "$schema" glass-material)" = "'$material'" ] \
            || { warn "glass-material did not land"; return 1; }
        log "  glass: bar $bar, panels $overlay → $material"
    fi
fi

# Only the keys that were set: a reset of an unset key still writes the store, and a
# fresh install must come out of the chain untouched.
for key in bar-opacity overlay-opacity dock-opacity window-opacity; do
    is_set "$key" && gsettings reset "$schema" "$key"
done
return 0
