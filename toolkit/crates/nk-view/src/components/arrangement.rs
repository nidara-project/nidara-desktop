// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use crate::{Align, Label, Overlay, Padding, Role, Space};
use nk_text::TextStyle;

/// A named rectangle in a shared logical coordinate system.
pub struct ArrangementItem {
    pub key: Key,
    pub label: String,
    pub name: String,
    pub action: String,
    pub bounds: Rect,
    pub selected: bool,
    pub movable: bool,
}

/// The projection can be held constant while the application updates its model during a drag.
#[derive(Clone, Copy, Debug)]
pub struct ArrangementProjection {
    origin: (f64, f64),
    scale: f64,
    inset: f64,
}

impl ArrangementProjection {
    pub fn fit(items: &[ArrangementItem], size: (f64, f64), inset: f64) -> Self {
        let region = items.iter().map(|item| item.bounds).reduce(|a, b| {
            let x = a[0].min(b[0]);
            let y = a[1].min(b[1]);
            [
                x,
                y,
                (a[0] + a[2]).max(b[0] + b[2]) - x,
                (a[1] + a[3]).max(b[1] + b[3]) - y,
            ]
        });
        let [x, y, width, height] = region.unwrap_or([0., 0., 1., 1.]);
        let scale = ((size.0 - 2. * inset).max(1.) / width.max(1.))
            .min((size.1 - 2. * inset).max(1.) / height.max(1.));
        Self {
            origin: (x, y),
            scale,
            inset,
        }
    }
}

/// A diagram of selectable rectangles. Pointer activations carry displacement in
/// the logical coordinates of the items. The app owns their actual positions.
pub struct Arrangement;

impl Arrangement {
    pub fn view(
        key: impl Into<Key>,
        size: (f64, f64),
        projection: ArrangementProjection,
        items: Vec<ArrangementItem>,
        style: TextStyle,
    ) -> Node {
        let key = key.into();
        let base = Node::spacer(format!("{}/base", key.0))
            .width(size.0)
            .height(size.1);
        let count = items.len();
        let mut overlay = Overlay::new(key.clone(), base);
        for (index, item) in items.into_iter().enumerate() {
            // Keep the painted controls inside the arrangement even while the pointer
            // moves beyond its edges. The app still receives the full displacement.
            let [x, y, width, height] = item.bounds;
            let label: Node =
                Label::new(format!("{}/label", item.key.0), item.label, style.clone())
                    .lines(1)
                    .into();
            let width = (width * projection.scale).clamp(1., size.0.max(1.));
            let height = (height * projection.scale).clamp(1., size.1.max(1.));
            let mut node = Node::control(item.key, item.name, item.action, label)
                .width(width)
                .height(height);
            if let crate::Kind::Control(control) = &mut node.kind {
                control.role = Role::Radio;
                control.part = Some(Box::new(Part::ArrangementRect(ArrangementRect {
                    group: key.clone(),
                    index,
                    count,
                    selected: item.selected,
                    movable: item.movable,
                    scale: projection.scale,
                })));
            }
            overlay = overlay.layer_at(
                (projection.inset + (x - projection.origin.0) * projection.scale)
                    .clamp(0., (size.0 - width).max(0.)),
                (projection.inset + (y - projection.origin.1) * projection.scale)
                    .clamp(0., (size.1 - height).max(0.)),
                node,
            );
        }
        overlay.into()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArrangementRect {
    group: Key,
    index: usize,
    count: usize,
    selected: bool,
    movable: bool,
    scale: f64,
}

#[derive(Default)]
struct Drag {
    start: Option<((f64, f64), f64)>,
    change: Option<Value>,
}

impl Drag {
    fn displacement(&self, at: (f64, f64)) -> Option<Value> {
        let ((x, y), scale) = self.start?;
        Some(Value::Displacement((at.0 - x) / scale, (at.1 - y) / scale))
    }
}

impl Component for ArrangementRect {
    fn body(&self, cx: &Build<'_>) -> Node {
        Overlay::new(cx.key("content"), Node::spacer(cx.key("size")))
            .layer(
                Align::Stretch,
                Align::Center,
                Padding::all(Space::S1),
                cx.child.clone(),
            )
            .into()
    }

    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let radius = self
            .corner()
            .of(cx.rect[2], cx.rect[3], &cx.look.tokens.radii);
        let fill = cx.ink(segment::choice_fill(
            &cx.look.tokens.segmented,
            cx.interaction,
        ));
        cx.canvas.clip(rect(&cx.visible));
        cx.canvas.rounded_rect(rect(&cx.rect), radius, fill);
        cx.canvas.pop_clip();
    }

    fn ink(
        &self,
        look: ComponentLook<'_>,
        interaction: Interaction,
        _glyph: bool,
    ) -> Option<Color> {
        let style = &look.tokens.segmented;
        Some(if interaction.marked {
            style.selected_text
        } else {
            style.text
        })
    }

    fn corner(&self) -> Corner {
        Corner::Token(crate::Radius::Sm)
    }

    fn selected(&self) -> bool {
        self.selected
    }

    fn group(&self, _cx: &Read<'_>) -> Membership {
        Membership::Named {
            key: self.group.clone(),
            selected: self.selected,
        }
    }

    fn semantics(&self, _cx: &Read<'_>, node: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        node.states.checked = self.selected;
        node.states.selected = self.selected;
        node.attributes
            .insert("posinset".into(), (self.index + 1).to_string());
        node.attributes
            .insert("setsize".into(), self.count.to_string());
    }

    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<Drag>::default())
    }

    fn press(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        cx.effects.arm = true;
        cx.effects.focus = true;
        if self.movable
            && let Some(state) = cx
                .state
                .as_deref_mut()
                .and_then(|s| s.downcast_mut::<Drag>())
        {
            state.start = Some((at, self.scale));
            cx.effects.capture = Capture::Take;
            cx.effects.activate = true;
            cx.effects.value = Some(Value::Displacement(0., 0.));
        }
    }

    fn drag(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        if let Some(state) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<Drag>())
        {
            state.change = state.displacement(at);
            cx.effects.redraw = true;
        }
    }

    fn release(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        if let Some(state) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<Drag>())
        {
            cx.effects.value = state.displacement(at);
            *state = Drag::default();
        }
        cx.effects.capture = Capture::Release;
        cx.effects.activate = true;
    }

    fn reports_drag(&self) -> bool {
        true
    }

    fn take_changed(&self, state: Option<&mut dyn Any>) -> Option<Value> {
        state?.downcast_mut::<Drag>()?.change.take()
    }

    fn cancel(&self, state: Option<&mut dyn Any>) {
        if let Some(state) = state.and_then(|s| s.downcast_mut::<Drag>()) {
            *state = Drag::default();
        }
    }
}
