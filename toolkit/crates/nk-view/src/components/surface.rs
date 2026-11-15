// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use crate::{Corner, Role, Wash};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Surface {
    pub wash: Wash,
    pub marked: bool,
    pub on: bool,
    pub surface: bool,
    pub accent: bool,
    pub corner: Corner,
    pub value: Option<Value>,
}
impl Default for Surface {
    fn default() -> Self {
        Self {
            wash: Wash::Glass,
            marked: false,
            on: false,
            surface: false,
            accent: false,
            corner: Corner::Pill,
            value: None,
        }
    }
}
impl Surface {
    pub fn update(&mut self, p: Configure) {
        match p {
            Configure::Wash(v) => self.wash = v,
            Configure::Marked(v) => self.marked = v,
            Configure::On(v) => self.on = v,
            Configure::Surface => self.surface = true,
            Configure::Accent(v) => self.accent = v,
            Configure::Corner(v) => self.corner = v,
            Configure::Value(v) => self.value = Some(v),
            _ => {}
        }
    }
    pub fn under(&self, cx: &mut Paint<'_>) {
        if let Some((r, radius, w)) = cx.wash {
            cx.canvas.clip(rect(&cx.visible));
            cx.canvas
                .rounded_rect(rect(&r), radius, cx.ink(Color::new(w.map(|v| v as f32))));
            cx.canvas.pop_clip();
        }
    }
    pub fn focus(&self, cx: &mut Paint<'_>, silhouette: Rect) {
        if !cx.interaction.focus_ring {
            return;
        }
        let w = cx.look.tokens.look.focus_width;
        let out = if cx.read.owns_mark { 2. * w } else { 0. };
        let r = silhouette;
        let r = [r[0] - out, r[1] - out, r[2] + 2. * out, r[3] + 2. * out];
        cx.canvas.rounded_ring(
            rect(&r),
            self.corner.of(r[2], r[3], &cx.look.tokens.radii),
            w,
            cx.ink(cx.look.tokens.look.focus),
        );
    }
}
impl Component for Surface {
    fn body(&self, cx: &Build<'_>) -> Node {
        cx.child.clone()
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        let mut next = self.clone();
        next.update(p);
        Some(Part::Surface(next))
    }
    fn corner(&self) -> Corner {
        self.corner
    }
    fn value(&self, _state: Option<&dyn Any>) -> Option<Value> {
        self.value.clone()
    }
    fn selected(&self) -> bool {
        self.marked
    }
    fn group(&self, cx: &Read<'_>) -> Membership {
        if cx.role == Some(Role::Radio) {
            Membership::Adjacent {
                selected: self.marked,
            }
        } else {
            Membership::None
        }
    }
    fn content_ink(&self, cx: &Read<'_>, _at: Rect, ink: Color) -> Color {
        if self.on {
            cx.look.tokens.look.focus
        } else if self.marked && self.accent {
            cx.look.tokens.look.accent_fg
        } else {
            ink
        }
    }
    fn glass(&self, cx: &Read<'_>) -> Glass {
        if self.wash == Wash::None {
            return Glass::default();
        }
        let tokens = cx.look.tokens;
        let washes = &tokens.washes;
        let (hover, press) = if self.wash == Wash::Destructive {
            (washes.destructive_hover, washes.destructive_press)
        } else {
            (washes.hover, washes.press)
        };
        let rest = [hover[0], hover[1], hover[2], 0.];
        let well = self.surface.then(|| wash_of(tokens.look.surface));
        let on_well = |w| well.map_or(w, |s| over(w, s));
        let (priority, wash) = if self.on {
            (0, wash_of(tokens.look.on))
        } else if self.marked && self.accent {
            (0, wash_of(tokens.look.accent))
        } else if cx.interaction.pressed {
            (0, on_well(press))
        } else if cx.interaction.hover {
            (1, on_well(hover))
        } else if let Some(well) = well {
            (3, well)
        } else if cx.fading {
            (2, rest)
        } else if self.marked && !cx.owns_mark {
            (3, washes.hover)
        } else {
            (4, rest)
        };
        Glass {
            lit: Some((priority, wash)),
        }
    }
    fn semantics(&self, cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        n.states.checked =
            matches!(cx.role, Some(Role::Toggle | Role::Check | Role::Radio)) && self.marked;
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase == PaintPhase::Under {
            self.under(cx);
            self.focus(cx, cx.visible);
        }
    }
}
fn wash_of(c: Color) -> [f64; 4] {
    c.components.map(f64::from)
}
fn over(top: [f64; 4], under: [f64; 4]) -> [f64; 4] {
    let a = top[3] + under[3] * (1. - top[3]);
    if a <= 0. {
        return [top[0], top[1], top[2], 0.];
    }
    let mix = |i: usize| (top[i] * top[3] + under[i] * under[3] * (1. - top[3])) / a;
    [mix(0), mix(1), mix(2), a]
}
