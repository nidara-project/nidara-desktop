# 2026-10-04 — the window buttons: GNOME's `appmenu:close` → Nidara's default
#
# Which buttons a window has, and on which side, now has one source:
# org.gnome.desktop.wm.preferences button-layout. The apps that draw their own title bar
# read it, and Hyalo's controls follow it (ui/shell/core/WindowButtons.ts). Nidara's default
# is a SYSTEM dconf default (scripts/gen-dconf-defaults.sh): maximize and close. But an
# account can hold GNOME's factory value as its OWN — measured on the owner's machine: stored
# in the user's dconf, though nobody chose it in Nidara — and the user's value wins over the
# system's, so it kept showing close alone, and would now shrink Hyalo's capsule to close
# alone too.
#
# This resets that one value, once, so the system default applies. Only GNOME's factory string
# exactly: anything else was chosen and stays. Its cost: somebody who did set close-alone by
# hand to exactly that string gets maximize back, once (Settings → Appearance → Windows has
# no switch for it; GNOME Tweaks or `gsettings` sets it again, and this never runs twice).
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
[ "$stored" = "appmenu:close" ] || return 0
gsettings reset "$schema" button-layout
log "button-layout: GNOME's 'appmenu:close' reset to Nidara's default ($(gsettings get "$schema" button-layout))"
