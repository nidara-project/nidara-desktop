# 2026-09-14 — appearance.json → GSettings (#573, #536)
#
# The last appearance file. Its keys go to their two homes:
#
#  - themeFamily / iconTheme / cursorTheme / isDark / accent live in
#    org.gnome.desktop.interface. NOTHING to import: until this change every shell
#    start pushed the file's values into those keys, so on a machine that has run
#    the shell they already agree. They are deleted from the file first so the
#    import does not report them as retired settings — they are not retired, they
#    have lived somewhere else all along.
#
#  - the four glass opacities and shellAppearance go to org.nidara.appearance, with
#    the two conversions the shell's reader applied on every load until today, so
#    what lands is exactly what the desktop was showing:
#      1. a file without barOpacity/overlayOpacity seeded both from the old single
#         `shellOpacity`;
#      2. a file whose `glassModel` is not 2 predates the glass rescale (2026-08-23)
#         and each stored opacity becomes 0.2 + 0.8·α;
#    and every opacity is clamped to GLASS_RANGE [0.24, 0.8], as the reader did — the
#    schema's range would otherwise DROP a value just outside it back to the default.
#
# ⚠️ Runs after 2026-09-02-window-opacity-from-transparency, which depends on the
# file still being there. The edited file is what `settings_import` renames to
# appearance.json.migrated.

json_edit "$CONFIG_DIR/appearance.json" '
  def clamp: if . < 0.24 then 0.24 elif . > 0.8 then 0.8 else . end;
  (.glassModel != 2) as $stale
  | (if has("shellOpacity") then
       (if has("barOpacity") | not then .barOpacity = .shellOpacity else . end)
       | (if has("overlayOpacity") | not then .overlayOpacity = .shellOpacity else . end)
     else . end)
  | reduce ("barOpacity", "overlayOpacity", "dockOpacity", "windowOpacity") as $k (.;
      if (.[$k] | type) == "number" then
        .[$k] = ((if $stale then 0.2 + 0.8 * .[$k] else .[$k] end) | clamp)
      else . end)
  | del(.glassModel, .shellOpacity, .themeFamily, .iconTheme, .cursorTheme, .isDark, .accent)
' || return 1

settings_import appearance.json appearance || return 1
