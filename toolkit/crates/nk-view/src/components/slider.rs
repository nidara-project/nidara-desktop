// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
/// A tile slider keeps its content in the same ink as its fill.
const FILL_INK: crate::Ink = crate::Ink::Primary;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SliderControl {
    pub range: crate::view::Slider,
    pub surface: Surface,
}
#[derive(Default)]
struct State {
    held: Option<f64>,
    set: Option<f64>,
    slid: Option<Value>,
}
impl SliderControl {
    fn current(&self, state: Option<&dyn Any>) -> f64 {
        let s = state.and_then(|s| s.downcast_ref::<State>());
        s.and_then(|s| s.held.or(s.set))
            .unwrap_or_else(|| self.range.shown(self.range.value))
    }
    fn top(&self, cx: &Read<'_>) -> Option<f64> {
        if !self.range.fill {
            return None;
        }
        let s = &self.range;
        let f =
            ((self.current(cx.state) - s.min) / (s.max - s.min).max(f64::EPSILON)).clamp(0., 1.);
        Some(cx.rect[1] + cx.rect[3] * (1. - f))
    }
    fn thumb(&self, cx: &Read<'_>) -> Option<Rect> {
        if self.range.fill {
            return None;
        }
        let s = &self.range;
        let radius = cx.look.tokens.slider.thumb_radius;
        let r = cx.rect;
        let f =
            ((self.current(cx.state) - s.min) / (s.max - s.min).max(f64::EPSILON)).clamp(0., 1.);
        let x = r[0] + radius + f * (r[2] - 2. * radius).max(0.);
        let y = r[1] + r[3] / 2.;
        Some([x - radius, y - radius, 2. * radius, 2. * radius])
    }
    fn at(&self, cx: &Read<'_>, (x, y): (f64, f64)) -> f64 {
        let r = cx.rect;
        if self.range.fill {
            return f64::from(
                self.range
                    .range()
                    .at((1. - (y - r[1]) / r[3].max(1.)) as f32),
            );
        }
        let thumb = cx.look.tokens.slider.thumb_radius;
        let span = (r[2] - 2. * thumb).max(1.);
        f64::from(self.range.range().at(((x - r[0] - thumb) / span) as f32))
    }
    fn change(&self, cx: &mut Input<'_>, value: f64, hold: bool, drag: bool) {
        let before = self.current(cx.state.as_deref());
        let Some(state) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        if hold {
            state.held = Some(value);
        } else {
            state.set = Some(value);
        }
        if (value - before).abs() > f64::EPSILON {
            let value = Value::Number(value);
            cx.effects.value = Some(value.clone());
            cx.effects.redraw = true;
            if drag {
                state.slid = Some(value);
            } else {
                cx.effects.activate = true;
            }
        }
    }
}
impl Component for SliderControl {
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        // Ancestors clip the outline after painting, without rounding a cut edge.
        let bounds = self.thumb(cx).unwrap_or(cx.rect);
        Some(FocusOutline::rounded(
            bounds,
            self.surface
                .corner
                .of(bounds[2], bounds[3], &cx.look.tokens.radii),
        ))
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        Node::spacer(cx.key("track"))
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        FrameSpec {
            least: (0., 2. * look.tokens.slider.thumb_radius),
            ..FrameSpec::default()
        }
    }
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn reconcile(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.set = None;
        }
    }
    fn cancel(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.held = None;
            s.slid = None;
        }
    }
    fn reports_drag(&self) -> bool {
        self.range.live
    }
    fn take_changed(&self, state: Option<&mut dyn Any>) -> Option<Value> {
        state?.downcast_mut::<State>()?.slid.take()
    }
    fn value(&self, state: Option<&dyn Any>) -> Option<Value> {
        Some(Value::Number(self.current(state)))
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        let mut next = self.clone();
        next.surface.update(p);
        Some(Part::Slider(next))
    }
    fn selected(&self) -> bool {
        self.surface.marked
    }
    fn corner(&self) -> Corner {
        self.surface.corner
    }
    fn glass(&self, cx: &Read<'_>) -> Glass {
        self.surface.glass(cx)
    }
    fn silhouette(&self, cx: &Read<'_>) -> Rect {
        self.thumb(cx)
            .and_then(|r| crate::layout::intersect(r, cx.visible))
            .unwrap_or(cx.visible)
    }
    fn content_ink(&self, cx: &Read<'_>, at: Rect, ink: Color) -> Color {
        if self.surface.on || (self.surface.marked && self.surface.accent) {
            return self.surface.content_ink(cx, at, ink);
        }
        if self.top(cx).is_some_and(|top| at[1] + at[3] / 2. >= top) {
            Color::new([0., 0., 0., 0.85])
        } else {
            ink
        }
    }
    fn press(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        let Some(read) = cx.context else {
            return;
        };
        let value = self.at(&read, at);
        self.change(cx, value, true, false);
        cx.effects.capture = Capture::Take;
        cx.effects.arm = true;
        cx.effects.focus = true;
    }
    fn drag(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        if let Some(read) = cx.context {
            self.change(cx, self.at(&read, at), true, true);
        }
    }
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        let value = self.current(cx.state.as_deref());
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.held = None;
            s.slid = None;
            s.set = Some(value);
        }
        cx.effects.capture = Capture::Release;
        cx.effects.activate = true;
        cx.effects.value = Some(Value::Number(value));
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        use crate::KeyInput::*;
        let sym = match key {
            Left => 0xff51,
            Up => 0xff52,
            Right => 0xff53,
            Down => 0xff54,
            PageUp => 0xff55,
            PageDown => 0xff56,
            LineStart => 0xff50,
            LineEnd => 0xff57,
            _ => return,
        };
        let Some(read) = cx.context else {
            return;
        };
        let value = self.current(cx.state.as_deref());
        cx.effects.handled = true;
        cx.effects.keyboard_focus = true;
        if let Some(next) = self.range.range().key(
            value as f32,
            sym,
            true,
            read.look.tokens.slider.page_steps as f32,
        ) {
            self.change(cx, f64::from(next), false, false);
            cx.effects.handled = true;
        }
    }
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        if let Request::Set(value) = request
            && let Some(value) = value.number()
        {
            self.change(
                cx,
                self.range
                    .shown(value)
                    .clamp(self.range.min, self.range.max),
                false,
                false,
            );
            cx.effects.handled = true;
        }
    }
    fn semantics(&self, cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        let s = &self.range;
        let current = self.current(cx.state);
        n.value = Some(nk_a11y::ValueInfo {
            min: s.min,
            max: s.max,
            current,
            step: s.step,
            text: s.range().text(current as f32),
        });
        n.actions = vec![nk_a11y::Action::Focus, nk_a11y::Action::SetValue];
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        self.surface.under(cx);
        let r = cx.rect;
        let visible = cx.visible;
        let tokens = cx.look.tokens;
        let alpha = cx.alpha;
        let ink = |c: Color| c.with_alpha(c.components[3] * alpha as f32);
        if let Some(top) = self.top(&cx.read) {
            let primary = tokens.look.ink(FILL_INK);
            let fill =
                primary.with_alpha(primary.components[3] * tokens.slider.fill_opacity as f32);
            cx.canvas.clip(rect(&visible));
            cx.canvas
                .clip_rounded_rect(rect(&r), self.corner().of(r[2], r[3], &tokens.radii));
            cx.canvas
                .rect(rect(&[r[0], top, r[2], r[1] + r[3] - top]), ink(fill));
            cx.canvas.pop_clip();
            cx.canvas.pop_clip();
        }
        if let Some(thumb) = self.thumb(&cx.read) {
            let s = &tokens.slider;
            let y = r[1] + (r[3] - s.track) / 2.;
            let track = [r[0], y, r[2], s.track];
            let centre = thumb[0] + thumb[2] / 2.;
            let ink_of = |a: f64| {
                let c = tokens.look.ink(FILL_INK);
                ink(c.with_alpha(c.components[3] * a as f32))
            };
            cx.canvas.clip(rect(&visible));
            cx.canvas
                .rounded_rect(rect(&track), s.track / 2., ink_of(0.18));
            cx.canvas.rounded_rect(
                rect(&[r[0], y, centre - r[0], s.track]),
                s.track / 2.,
                ink_of(s.fill_opacity),
            );
            let inner = [thumb[0] + 1., thumb[1] + 1., thumb[2] - 2., thumb[3] - 2.];
            cx.canvas
                .rounded_rect(rect(&inner), inner[2] / 2., ink_of(1.));
            cx.canvas.pop_clip();
        }
    }
}
