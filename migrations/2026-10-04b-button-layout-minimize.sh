# 2026-10-04 — the window buttons gain minimize (#724)
#
# Hyalo minimizes now, so Nidara's default button-layout (a SYSTEM dconf default,
# scripts/gen-dconf-defaults.sh) is `appmenu:minimize,maximize,close`. An account that moved
# its buttons to the left in Settings holds its OWN value — `close,maximize:appmenu`, or
# `appmenu:maximize,close` if it moved them back — written while minimize did not exist, so it
# would never see the new button: the user's value wins over the system's.
#
# This gives those two values their minimize, once: exactly the strings Settings wrote before
# minimize existed (core/WindowButtons.ts `formatButtonLayout`), nothing else — a layout
# chosen elsewhere (GNOME Tweaks, `gsettings`) is left as it is. Right → reset, so the system
# default applies; left → the same buttons with minimize, on the left. Settings → Appearance →
# Windows → "Minimize button" takes it away again.
#
# ⚠️ `gsettings set` EXITS 0 WHILE FAILING with no session bus (#295); under dconf the
# writer is pinged first, as the glass migration does, and a failure retries next session.

schema=org.gnome.desktop.wm.preferences
command -v gsettings >/dev/null 2>&1 || { warn "gsettings is missing"; return 1; }
# Not installed (gsettings-desktop-schemas is a dependency; a bare CI schema dir has none of it).
gsettings list-keys "$schema" 2>/dev/null | grep -qx button-layout || return 0
if [ "${GSETTINGS_BACKEND:-dconf}" = dconf ]; then
    gdbus call --session --dest ca.desrt.dconf --object-path /ca/desrt/dconf/Writer/user \
        --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 \
        || { warn "dconf is not reachable on the session bus — button-layout not migrated yet"; return 1; }
fi
# The account's OWN value, not what it reads: a fresh account reads the default and holds none.
stored="$(gjs -c "const Gio = imports.gi.Gio; const v = new Gio.Settings({ schema_id: '$schema' }).get_user_value('button-layout'); print(v ? v.unpack() : '')")" \
    || { warn "could not read button-layout"; return 1; }
case "$stored" in
    "appmenu:maximize,close")
        gsettings reset "$schema" button-layout
        log "button-layout: minimize added — reset to Nidara's default ($(gsettings get "$schema" button-layout))" ;;
    "close,maximize:appmenu")
        gsettings set "$schema" button-layout "close,minimize,maximize:appmenu"
        log "button-layout: minimize added on the left ($(gsettings get "$schema" button-layout))" ;;
esac
return 0
