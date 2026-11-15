// SPDX-License-Identifier: LGPL-3.0-or-later
//! An app-owned disclosure: a whole-row toggle header followed by an ordinary Reveal.
use super::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Disclosure {
    pub label: String,
    pub expanded: bool,
}
#[derive(Default)]
struct State {
    pending: Option<bool>,
}
impl Disclosure {
    /// Just the header, for a standalone row or a gallery state specimen.
    pub fn header(self, key: impl Into<Key>, action: impl Into<String>) -> Node {
        let key = key.into();
        let mut node = Node::control(
            key.clone(),
            self.label.clone(),
            action,
            Node::spacer(format!("{}/body", key.0)),
        )
        .role(crate::Role::Toggle);
        if let Kind::Control(c) = &mut node.kind {
            c.part = Some(Box::new(Part::Disclosure(self)));
        }
        node
    }
    /// The header and its controlled content. Only the application changes the model;
    /// activation reports a Bool and the next rebuild retargets the header and Reveal.
    pub fn node(self, key: impl Into<Key>, action: impl Into<String>, content: Node) -> Node {
        let key = key.into();
        let open = self.expanded;
        Node::column(
            key.clone(),
            vec![
                self.header(format!("{}/header", key.0), action),
                Node::reveal(format!("{}/content", key.0), open, content),
            ],
        )
    }
    fn current(&self, state: Option<&dyn Any>) -> bool {
        state
            .and_then(|s| s.downcast_ref::<State>())
            .and_then(|s| s.pending)
            .unwrap_or(self.expanded)
    }
    fn set(&self, cx: &mut Input<'_>, expanded: bool) {
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.pending = Some(expanded);
        }
        cx.effects.handled = true;
        cx.effects.activate = true;
        cx.effects.redraw = true;
        cx.effects.value = Some(Value::Bool(expanded));
    }
}
impl Component for Disclosure {
    fn body(&self, cx: &Build<'_>) -> Node {
        Node::row(
            cx.key("body"),
            vec![
                Node::text(
                    cx.key("label"),
                    self.label.clone(),
                    cx.look
                        .types
                        .style(crate::Type::Body, crate::Weight::Regular),
                )
                .grow(),
                Node::row(cx.key("chevron"), vec![])
                    .width(cx.look.tokens.disclosure.icon_size)
                    .height(cx.look.tokens.disclosure.icon_size),
            ],
        )
        .align(crate::Align::Center)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let t = &look.tokens.disclosure;
        FrameSpec {
            inset: (t.padding, t.padding),
            least: (0., t.height),
            body: BodyPlacement::FillWidth,
        }
    }
    fn target(&self) -> Option<f64> {
        Some(f64::from(self.expanded))
    }
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn reconcile(&self, state: Option<&mut dyn Any>) {
        self.cancel(state);
    }
    fn cancel(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.pending = None;
        }
    }
    fn value(&self, state: Option<&dyn Any>) -> Option<Value> {
        Some(Value::Bool(self.current(state)))
    }
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        self.set(cx, !self.current(cx.state.as_deref()));
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        if key == crate::KeyInput::Activate {
            self.release(cx, (0., 0.));
        }
    }
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        match request {
            Request::Activate => self.release(cx, (0., 0.)),
            Request::Set(Value::Bool(v)) | Request::Expanded(v) => self.set(cx, v),
            _ => {}
        }
    }
    fn semantics(&self, cx: &Read<'_>, node: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        node.role = nk_a11y::Role::ToggleButton;
        node.states.expandable = true;
        node.states.expanded = self.current(cx.state);
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let t = &cx.look.tokens.disclosure;
        let r = cx.rect;
        let ink = if cx.interaction.enabled {
            cx.look.tokens.look.primary
        } else {
            cx.look.tokens.look.disabled
        };
        cx.canvas.clip(rect(&cx.visible));
        if cx.interaction.enabled && (cx.interaction.hover || cx.interaction.pressed) {
            cx.canvas
                .rounded_rect(rect(&r), 0., cx.ink(ink.with_alpha(t.hover_opacity as f32)));
        }
        let side = t.icon_size.min(r[2]).min(r[3]);
        let center = (r[0] + r[2] - t.padding - side / 2., r[1] + r[3] / 2.);
        let angle = cx
            .progress
            .unwrap_or(f64::from(self.expanded))
            .clamp(0., 1.)
            * std::f64::consts::FRAC_PI_2;
        let (sin, cos) = angle.sin_cos();
        let points = t.points.map(|(x, y)| {
            let x = (x / t.view_box - 0.5) * side;
            let y = (y / t.view_box - 0.5) * side;
            (center.0 + x * cos - y * sin, center.1 + x * sin + y * cos)
        });
        cx.canvas
            .polyline(&points, t.stroke * side / t.view_box, cx.ink(ink));
        cx.canvas.pop_clip();
        if cx.interaction.focus_ring {
            cx.canvas.rounded_ring(
                rect(&r),
                0.,
                t.focus_width,
                cx.ink(cx.look.tokens.look.focus),
            );
        }
    }
}
