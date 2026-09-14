# 2026-09-14 — six settings files → GSettings `org.nidara.*` (#573)
#
# The stores behind these files now live in GSettings (`defineSettings`,
# ui/shell/core/configFile.ts), so the values a user chose have to be carried
# over once, before the shell reads them. Each file is renamed to
# `<name>.migrated` when it has been taken: that is what makes a second run a
# no-op (there is nothing left to import), and it leaves the user's data on disk
# instead of deleting it.
#
# Field names are camelCase in the file and kebab-case in the schema. A field the
# schema no longer has is a retired setting and is dropped, the same rule
# `loadKnown` applied on every load. A value the schema refuses (out of range,
# not one of the choices, wrong type) is dropped too, and the key keeps its
# default — again what `loadKnown` did, now enforced by the schema.
#
# 🔑 A value EQUAL to the default is not written. The old store persisted every
# field on every save, so almost every file carries defaults the user never
# chose; importing them as user values would freeze them and a future default
# change would never reach that machine.
#
# ⚠️ `gsettings set` EXITS 0 WHILE FAILING when it has no session bus (#295,
# reproduced 2026-09-14: `dconf-WARNING failed to commit`, exit 0, nothing
# written). So under the dconf backend this refuses to start unless dconf's
# writer answers on the bus, and checks with `dconf read` that each value really
# landed. A failure returns non-zero BEFORE any file is renamed: no marker, and
# the next session retries with the files intact.
#
# 🔑 The same goes for a default that is COMPUTED on the machine — the store's
# `computed` fields (recording's `hardware` and `saveDir`). The old store saved
# them like everything else, so a file holding `~/Videos` is almost always the
# default, not a choice; imported, it would stop following the XDG videos folder.
# `computed_default` answers with the value the shell itself would compute, with
# the SAME expression (RecordingConfig.ts), and a file value equal to it is
# skipped. Keep the two in step when a store gains or changes a computed field.
#
# ⚠️ A key that already holds a user value is left alone. It can only have been
# written after the shell switched to GSettings — i.e. by the user, since an
# earlier failed run of this migration — and that is newer than the file.
#
# CI runs this with GSETTINGS_BACKEND=keyfile (scripts/ci/migrations-check.mjs),
# where there is no bus and no dconf; the bus checks are skipped there only.

settings_files=(
    "notif-config.json:notifications"
    "night-light.json:night-light"
    "bar-settings.json:bar"
    "dock_settings.json:dock"
    "workspaces.json:workspaces"
    "recording.json:recording"
)

# The dock kept its file in the bare ~/.config/ before it moved under nidara/.
# The shell's own one-time move for it is gone with this migration, so take the
# legacy file from here when the current one does not exist.
legacy_dock="${XDG_CONFIG_HOME:-$HOME/.config}/dock_settings.json"
if [ ! -f "$CONFIG_DIR/dock_settings.json" ] && [ -f "$legacy_dock" ]; then
    mv -f "$legacy_dock" "$CONFIG_DIR/dock_settings.json" || { warn "could not move $legacy_dock"; return 1; }
fi

# JSON of the value the shell computes for a `computed` field on this machine, or
# nothing when the field is not computed (or cannot be computed here, in which
# case the file value is imported — the conservative side).
computed_default() {
    case "$1.$2" in
        recording.hardware)
            [ -e /dev/dri/renderD128 ] && echo true || echo false ;;
        recording.saveDir)
            command -v gjs >/dev/null 2>&1 || return 0
            gjs -c 'const G = imports.gi.GLib; print(JSON.stringify(
                G.get_user_special_dir(G.UserDirectory.DIRECTORY_VIDEOS)
                ?? G.build_filenamev([G.get_home_dir(), "Videos"])))' 2>/dev/null ;;
    esac
}

pending=()
for entry in "${settings_files[@]}"; do
    [ -f "$CONFIG_DIR/${entry%%:*}" ] && pending+=("$entry")
done
[ "${#pending[@]}" -eq 0 ] && return 0

using_dconf=1
case "${GSETTINGS_BACKEND:-dconf}" in dconf) ;; *) using_dconf=0 ;; esac

if [ "$using_dconf" = 1 ]; then
    gdbus call --session --dest ca.desrt.dconf --object-path /ca/desrt/dconf/Writer/user \
        --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 \
        || { warn "dconf is not reachable on the session bus — settings not imported yet"; return 1; }
fi
command -v gsettings >/dev/null 2>&1 || { warn "gsettings is missing"; return 1; }

for entry in "${pending[@]}"; do
    file="$CONFIG_DIR/${entry%%:*}"
    name="${entry#*:}"
    schema="org.nidara.$name"

    gsettings list-keys "$schema" >/dev/null 2>&1 \
        || { warn "schema $schema is not installed — settings not imported yet"; return 1; }
    jq -e 'type == "object"' "$file" >/dev/null 2>&1 \
        || { warn "$(basename "$file") is not a JSON object — left in place, not imported"; continue; }

    while IFS= read -r field; do
        key="$(printf '%s' "$field" | sed -E 's/([A-Z])/-\L\1/g')"
        if ! gsettings list-keys "$schema" | grep -qx -- "$key"; then
            log "  $name: dropped retired field $field"
            continue
        fi
        if [ "$using_dconf" = 1 ] && [ -n "$(dconf read "/org/nidara/$name/$key")" ]; then
            continue
        fi

        type="$(gsettings range "$schema" "$key" | head -1)"
        case "$type" in
            "range "*|"type "*) type="${type#* }"; type="${type%% *}" ;;
            enum) type=s ;;
        esac
        case "$type" in
            y|n|q|i|u|x|t) value="$(jq -c --arg f "$field" '.[$f] | if type == "number" then round else . end' "$file")" ;;
            *)             value="$(jq -c --arg f "$field" '.[$f]' "$file")" ;;
        esac

        computed="$(computed_default "$name" "$field")"
        [ -n "$computed" ] && [ "$computed" = "$value" ] && continue

        before="$(gsettings get "$schema" "$key")"
        if ! gsettings set "$schema" "$key" "$value" 2>/dev/null; then
            log "  $name: dropped $field=$value (the schema refuses it)"
            continue
        fi
        if [ "$(gsettings get "$schema" "$key")" = "$before" ]; then
            gsettings reset "$schema" "$key"
            continue
        fi
        if [ "$using_dconf" = 1 ] && [ -z "$(dconf read "/org/nidara/$name/$key")" ]; then
            warn "$schema $key did not reach dconf — settings not imported yet"
            return 1
        fi
    done < <(jq -r 'keys[]' "$file")

    mv -f "$file" "$file.migrated" || { warn "could not rename $(basename "$file")"; return 1; }
    log "  imported $(basename "$file") into $schema"
done
