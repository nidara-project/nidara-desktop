# 2026-09-02 — appearance.json: `transparency` → `windowOpacity`
#
# The window glass was once stored as TRANSPARENCY (how much you see through)
# and is now stored as OPACITY (how much body the glass has), so the conversion
# is `1 - t`. `ThemeManager.loadSettings` did it inline on every single load,
# forever, because nothing recorded which machines had already been converted.
# This is that record; the inline read goes with this commit.
#
# 🔑 `glassModel` is deliberately NOT touched. A file that predates the glass
# rescale has no `glassModel`, and the reader still rescales what it finds
# through `0.2 + 0.8·α`. Writing the raw `1 - t` and leaving the marker alone is
# what makes this migration EXACTLY equivalent to the ternary it replaces —
# stamping the model here would skip a rescale the old code performed.
#
# ⚠️ Precedence matches the reader's `??`: a file carrying BOTH keys was already
# answering with `windowOpacity`, so the legacy one is dropped, never applied.
# Same for a `transparency` that is not a number — the reader ignored it too.

json_edit "$CONFIG_DIR/appearance.json" '
  if (has("transparency") | not) then .
  else
    (if (has("windowOpacity") | not) and (.transparency | type == "number")
     then .windowOpacity = (1 - .transparency)
     else . end)
    | del(.transparency)
  end
'
