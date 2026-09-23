# 2026-09-23 — `ags request <cmd>` → `nidara-ipc <cmd>` in the user's own keybinds
#
# The shell served AGS's bus name (`io.Astal.ags`) as a compatibility door after
# the AGS host went (2026-08-18), so that keybinds a user wrote against 0.7.x kept
# working. The owner closed that door on 2026-09-23 (tech-debt #76). Every caller
# in the repo moved to `nidara-ipc` then; the ones left are in files only the USER
# writes — `hyprland-user.lua`, in its current home and in the legacy one that is
# still read in place (tech-debt #31). This rewrites the command in both, once.
#
# `nidara-ipc` takes the same arguments, and it skips a leading `--` exactly as
# `ags request -- <cmd>` needed one (bin/nidara-ipc.c), so the rewrite is the
# command name and nothing else.
#
# ⚠️ Follows symlinks: on a `--dev` machine the user file can be a link into a
# checkout, and replacing the link with a file would silently fork it. The edit is
# temp + rename in the TARGET's directory, as `json_edit` does, so a half-written
# keybind file is never left behind.

for f in "$CONFIG_DIR/hyprland-user.lua" \
         "${XDG_CONFIG_HOME:-$HOME/.config}/hypr/hyprland-user.lua"; do
    [ -f "$f" ] || continue
    grep -q '\bags request\b' "$f" || continue   # word-bounded, like the sed: "bags request" is not a call
    target="$(readlink -f "$f")" || { warn "could not resolve $f"; return 1; }
    tmp="$(mktemp "$(dirname "$target")/.hyprland-user.lua.XXXXXX")" || { warn "could not create a temp file beside $target"; return 1; }
    if ! sed 's/\bags request\b/nidara-ipc/g' "$target" > "$tmp"; then
        rm -f "$tmp"; warn "sed failed on $target — leaving it untouched"; return 1
    fi
    if cmp -s "$tmp" "$target"; then rm -f "$tmp"; continue; fi
    chmod --reference="$target" "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$target" || { rm -f "$tmp"; warn "could not replace $target"; return 1; }
    log "rewrote \`ags request\` → \`nidara-ipc\` in $f"
done
