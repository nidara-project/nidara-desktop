# 2026-09-14 — widgets.json, cc_layout.json, dock_pinned.json, region.json → GSettings (#573)
#
# The last four settings files, each reshaped into the schema's types first:
#
#  - widgets.json: { id: {bar, cc} } → org.nidara.widgets `placement` a{s(bb)}.
#  - cc_layout.json → org.nidara.control-center, positions as id → (x, y). The
#    current format {positions, sizes} and the OLDEST one, [{id,x,y,size}], convert
#    here; the `order` format in between (before 2026-06-09) needed a flow-pack
#    only CCLayoutManager could do, so such a file is set aside and the Control
#    Centre starts from its default layout.
#  - dock_pinned.json, a bare array (or its older copy in the bare ~/.config/) →
#    org.nidara.dock `pinned`. The same prefixes the dock strips on every read are
#    stripped here, and an id that is not installed stays: the dock prunes those.
#  - region.json → org.nidara.region: the clock format only. `timezone` is the
#    system's (timedatectl) and `regionalLocale` is environment.d/nidara-locale.conf;
#    both had those homes all along, so they are dropped rather than imported.
#
# A reshaped file is written beside the original as `.<name>.import.json`, imported
# with `settings_import` (which renames IT), and the original is then renamed to
# `<name>.migrated` — so the user's own file is what stays on disk, untouched.

import_reshaped() {   # <file> <schema-name> <jq-program>
    local file="$CONFIG_DIR/$1" tmp=".$1.import.json"
    [ -f "$file" ] || return 0
    jq "$3" "$file" > "$CONFIG_DIR/$tmp" 2>/dev/null || {
        warn "$1 could not be read — left in place, not imported"; rm -f "$CONFIG_DIR/$tmp"; return 0; }
    if [ "$(jq -r 'type' "$CONFIG_DIR/$tmp")" != "object" ]; then
        log "  $1 is in a format this cannot import — set aside, the default is used"
        rm -f "$CONFIG_DIR/$tmp"
    else
        settings_import "$tmp" "$2" || { rm -f "$CONFIG_DIR/$tmp"; return 1; }
        rm -f "$CONFIG_DIR/$tmp.migrated"
    fi
    mv -f "$file" "$file.migrated" || { warn "could not rename $1"; return 1; }
}

legacy_pins="${XDG_CONFIG_HOME:-$HOME/.config}/dock_pinned.json"
if [ ! -f "$CONFIG_DIR/dock_pinned.json" ] && [ -f "$legacy_pins" ]; then
    mv -f "$legacy_pins" "$CONFIG_DIR/dock_pinned.json" || { warn "could not move $legacy_pins"; return 1; }
fi

import_reshaped widgets.json widgets '
  if type == "object" then
    { placement: (with_entries(select(.value | type == "object")
        | .value = [(.value.bar == true), (.value.cc == true)])) }
  else null end' || return 1

import_reshaped cc_layout.json control-center '
  if type == "array" then
    { positions: (map(select(.id != null) | {key: .id, value: [(.x // 0 | floor), (.y // 0 | floor)]}) | from_entries),
      sizes: (map(select(.id != null and .size != null) | {key: .id, value: .size}) | from_entries) }
  elif type == "object" and has("positions") then
    { positions: (.positions | with_entries(.value = [(.value.x // 0 | floor), (.value.y // 0 | floor)])),
      sizes: (.sizes // {}) }
  else null end' || return 1

import_reshaped dock_pinned.json dock '
  if type == "array" then
    { pinned: (map(select(type == "string" and . != "" and (startswith("/") | not))
        | sub("^pinned-"; "") | sub("^pinned-ghost-"; "") | sub("^running-"; ""))
        | reduce .[] as $id ([]; if any(.[]; . == $id) then . else . + [$id] end)) }
  else null end' || return 1

import_reshaped region.json region 'if type == "object" then del(.timezone, .regionalLocale) else null end' || return 1
