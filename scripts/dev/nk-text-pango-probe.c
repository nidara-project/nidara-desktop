// SPDX-License-Identifier: LGPL-3.0-or-later
// Independent native repro for the failures in nk-text's common corpus.
// cc scripts/dev/nk-text-pango-probe.c -o /tmp/nk-text-pango-probe $(pkg-config --cflags --libs pangocairo)
#include <pango/pangocairo.h>
#include <stdio.h>

static PangoLayout *layout_for(PangoContext *context, const char *text) {
    PangoLayout *layout = pango_layout_new(context);
    PangoFontDescription *font = pango_font_description_from_string(
        "Noto Sans, Noto Sans Devanagari, Noto Sans CJK JP, Noto Sans Hebrew");
    pango_font_description_set_absolute_size(font, 20 * PANGO_SCALE);
    pango_layout_set_font_description(layout, font);
    pango_font_description_free(font);
    pango_layout_set_text(layout, text, -1);
    pango_layout_set_width(layout, 320 * PANGO_SCALE);
    PangoAttrList *attrs = pango_attr_list_new();
    pango_attr_list_insert(attrs, pango_attr_line_height_new_absolute(30 * PANGO_SCALE));
    pango_layout_set_attributes(layout, attrs);
    pango_attr_list_unref(attrs);
    return layout;
}
int main(void) {
    int failed = 0;
    printf("Native Pango %s (no nk-text adapter)\n", pango_version_string());
    PangoFontMap *map = pango_cairo_font_map_new();
    PangoContext *context = pango_font_map_create_context(map);
    pango_context_set_round_glyph_positions(context, FALSE);
    const char *text = "हिन्दी";
    const int end = 18; // UTF-8 bytes, not a scalar index.
    PangoLayout *hindi = layout_for(context, text);
    PangoRectangle strong, weak;
    pango_layout_get_cursor_pos(hindi, end, &strong, &weak);
    int index, trailing;
    pango_layout_xy_to_index(hindi, weak.x, weak.y + weak.height / 2, &index, &trailing);
    // Convert Pango's temporary trailing count only at the native API edge.
    const int hit = (int)(g_utf8_offset_to_pointer(text + index, trailing) - text);
    printf("Hindi weak caret byte=%d x=%.3f -> native hit=(%d, trailing=%d) -> byte=%d\n",
        end, weak.x / (double)PANGO_SCALE, index, trailing, hit);
    if (hit != end) {
        puts("FAIL: native weak end caret does not hit the end byte");
        failed = 1;
    }
    g_object_unref(hindi);

    pango_context_set_base_dir(context, PANGO_DIRECTION_RTL);
    PangoLayout *rtl = layout_for(context, "日本 abc שלום 12");
    pango_layout_set_auto_dir(rtl, FALSE);
    pango_layout_set_alignment(rtl, PANGO_ALIGN_RIGHT);
    pango_layout_get_cursor_pos(rtl, 0, &strong, &weak);
    pango_layout_move_cursor_visually(rtl, FALSE, 0, 0, 1, &index, &trailing);
    printf("Forced RTL weak caret byte=0 x=%.3f -> native Right=(%d, trailing=%d)\n",
        weak.x / (double)PANGO_SCALE, index, trailing);
    if (index < 0 || index == G_MAXINT || (index == 0 && trailing == 0)) {
        puts("FAIL: native Right does not enter the text to the right of the weak caret");
        failed = 1;
    }
    g_object_unref(rtl);
    g_object_unref(context);
    g_object_unref(map);
    return failed;
}
