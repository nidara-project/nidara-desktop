// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DisplayField {
    pub field: crate::view::Field,
    pub style: nk_text::TextStyle,
    pub surface: Surface,
}
impl Component for DisplayField {
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        // This legacy frameless field can be no larger than its glyph advances.
        // Lend the existing entry box, or its enclosing row when that is larger,
        // without changing input/reader geometry or adding another frame.
        let (text, _) = cx.text("text")?;
        let entry = &cx.look.tokens.entry;
        let px = entry.padding_x + entry.border;
        let py = ((entry.min_height - text.rect[3]) / 2.).max(entry.border);
        let left = cx.rect[0].min(text.rect[0] - px);
        let top = cx.rect[1].min(text.rect[1] - py);
        let right = (cx.rect[0] + cx.rect[2]).max(text.rect[0] + text.rect[2] + px);
        let bottom = (cx.rect[1] + cx.rect[3]).max(text.rect[1] + text.rect[3] + py);
        let bounds = [left, top, right - left, bottom - top];
        Some(FocusOutline::rounded(
            bounds,
            self.corner()
                .of(bounds[2], bounds[3], &cx.look.tokens.radii),
        ))
    }

    fn body(&self, cx: &Build<'_>) -> Node {
        Node::text(cx.key("text"), self.field.shown.clone(), self.style.clone())
    }
    fn owner_edits(&self) -> bool {
        true
    }
    fn corner(&self) -> Corner {
        self.surface.corner
    }
    fn selected(&self) -> bool {
        self.surface.marked
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        let mut next = self.clone();
        next.surface.update(p);
        Some(Part::Field(next))
    }
    fn glass(&self, cx: &Read<'_>) -> Glass {
        self.surface.glass(cx)
    }
    fn content_ink(&self, cx: &Read<'_>, at: Rect, ink: Color) -> Color {
        self.surface.content_ink(cx, at, ink)
    }
    fn press(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        cx.effects.focus = true;
        cx.effects.handled = true;
    }
    fn caret(&self, cx: &Read<'_>) -> Option<Rect> {
        let (p, t) = cx.text("text")?;
        let r = t
            .layout
            .caret_rect(self.field.caret, nk_text::Affinity::Downstream)
            .ok()?;
        Some([
            p.rect[0] + r.x as f64,
            p.rect[1] + r.y as f64,
            1.,
            r.height as f64,
        ])
    }
    fn selection(&self, cx: &Read<'_>) -> Vec<Rect> {
        let f = &self.field;
        let range = f.caret.min(f.anchor)..f.caret.max(f.anchor);
        if range.is_empty() {
            return Vec::new();
        }
        let Some((p, t)) = cx.text("text") else {
            return Vec::new();
        };
        t.layout
            .selection_rects(range)
            .unwrap_or_default()
            .into_iter()
            .map(|r| {
                [
                    p.rect[0] + r.x as f64,
                    p.rect[1] + r.y as f64,
                    r.width as f64,
                    r.height as f64,
                ]
            })
            .collect()
    }
    fn semantics(&self, _cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        let f = &self.field;
        let text = if f.secret {
            String::new()
        } else {
            f.shown.clone()
        };
        let end = text.len();
        n.text = Some(nk_a11y::TextInfo {
            caret: f.caret.min(end),
            anchor: f.anchor.min(end),
            words: Vec::new(),
            lines: std::iter::once(0..end).collect(),
            geometry: None,
            text,
        });
        n.role = if f.secret {
            nk_a11y::Role::Password
        } else {
            nk_a11y::Role::TextInput
        };
        n.actions = vec![
            nk_a11y::Action::Focus,
            nk_a11y::Action::Activate,
            nk_a11y::Action::SetText,
        ];
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        self.surface.under(cx);
        if cx.read.focused {
            cx.canvas.clip(rect(&cx.visible));
            let sel = cx.look.tokens.look.accent;
            for r in self.selection(&cx.read) {
                cx.canvas.rounded_rect(
                    rect(&r),
                    0.,
                    cx.ink(sel.with_alpha(sel.components[3] * 0.3)),
                );
            }
            if cx.caret
                && let Some(r) = self.caret(&cx.read)
            {
                cx.canvas.rounded_rect(
                    rect(&r),
                    0.,
                    cx.ink(cx.look.tokens.look.ink(crate::Ink::Primary)),
                );
            }
            cx.canvas.pop_clip();
        }
    }
}
