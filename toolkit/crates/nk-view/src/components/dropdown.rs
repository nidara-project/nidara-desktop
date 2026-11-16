// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dropdown {
    pub options: Vec<String>,
    pub chosen: usize,
}
#[derive(Default)]
struct State {
    set: Option<usize>,
    expanded: bool,
}
impl Dropdown {
    fn current(&self, state: Option<&dyn Any>) -> usize {
        state
            .and_then(|s| s.downcast_ref::<State>())
            .and_then(|s| s.set)
            .unwrap_or(self.chosen)
    }
    fn open(&self, cx: &mut Input<'_>) {
        let Some(read) = cx.context else {
            return;
        };
        let read = Read {
            state: cx.state.as_deref(),
            ..read
        };
        if let Some(list) = self.list(&read) {
            cx.effects.host.push(HostRequest::OpenList {
                owner: read.key.clone(),
                list: Box::new(list),
            });
            cx.effects.activate = true;
            cx.effects.handled = true;
        }
    }
}
impl Component for Dropdown {
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        Some(FocusOutline::rounded(
            self.silhouette(cx),
            cx.look.tokens.dropdown.trigger.radius,
        ))
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let t = &cx.look.tokens.dropdown.trigger;
        let chosen = self.chosen.min(self.options.len().saturating_sub(1));
        let label = self.options.get(chosen).cloned().unwrap_or_default();
        Node::row(
            cx.key("row"),
            vec![
                Node::spacer(cx.key("margin")).width(t.label_margin),
                Node::text(
                    cx.key("label"),
                    label,
                    cx.look.types.style(t.font.0, t.font.1),
                )
                .room(self.options.clone())
                .grow(),
                Node::spacer(cx.key("gap")).width(t.arrow_gap),
                Node::icon(cx.key("arrow"), t.arrow.clone(), t.arrow_size).ink(crate::Ink::Dim),
            ],
        )
        .align(crate::Align::Center)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let (x, y, h) = look.tokens.dropdown.trigger.inset();
        FrameSpec {
            inset: (x, y),
            least: (0., h),
            body: BodyPlacement::FillWidth,
        }
    }
    fn ink(&self, look: ComponentLook<'_>, _i: Interaction, glyph: bool) -> Option<Color> {
        let t = &look.tokens.dropdown.trigger;
        Some(if glyph { t.arrow_color } else { t.text })
    }
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn reconcile(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.set = None;
        }
    }
    fn value(&self, state: Option<&dyn Any>) -> Option<Value> {
        Some(Value::Index(self.current(state)))
    }
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        self.open(cx);
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        if matches!(
            key,
            crate::KeyInput::Activate | crate::KeyInput::Up | crate::KeyInput::Down
        ) {
            cx.effects.keyboard_focus = matches!(key, crate::KeyInput::Up | crate::KeyInput::Down);
            self.open(cx);
        }
    }
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        match request {
            Request::Activate => self.open(cx),
            Request::Expanded(on) => {
                if let Some(s) = cx
                    .state
                    .as_deref_mut()
                    .and_then(|s| s.downcast_mut::<State>())
                {
                    s.expanded = on;
                }
                cx.effects.handled = true;
            }
            Request::Set(Value::Index(n)) if n < self.options.len() => {
                let before = self.current(cx.state.as_deref());
                if let Some(s) = cx
                    .state
                    .as_deref_mut()
                    .and_then(|s| s.downcast_mut::<State>())
                {
                    s.set = Some(n);
                }
                cx.effects.handled = true;
                cx.effects.activate = before != n;
                cx.effects.value = Some(Value::Index(n));
                cx.effects.redraw = before != n;
            }
            _ => {}
        }
    }
    fn list(&self, cx: &Read<'_>) -> Option<ListSpec> {
        if self.options.is_empty() {
            return None;
        }
        let m = &cx.look.tokens.dropdown.menu;
        let selected = self.current(cx.state);
        let items: Vec<_> = self
            .options
            .iter()
            .enumerate()
            .map(|(n, name)| ListItem {
                key: format!("menu/row/{n}").into(),
                value: Value::Index(n),
                name: name.clone(),
            })
            .collect();
        let rows = self
            .options
            .iter()
            .enumerate()
            .map(|(n, name)| {
                Node::menu_row(
                    format!("menu/row/{n}"),
                    name.clone(),
                    "choose",
                    n == selected,
                )
            })
            .collect();
        Some(ListSpec {
            node: Node::scroll("menu/scroll", Node::column("menu/rows", rows)),
            items,
            selected,
            scroll: "menu/scroll".into(),
            edge: m.edge(),
            radius: m.radius,
            border: m.border,
            border_color: m.border_color,
            background: m.background,
        })
    }
    fn semantics(&self, cx: &Read<'_>, n: &mut nk_a11y::Node, children: &mut Vec<SemanticChild>) {
        n.states.expandable = true;
        n.states.expanded = cx
            .state
            .and_then(|s| s.downcast_ref::<State>())
            .is_some_and(|s| s.expanded);
        let chosen = self.current(cx.state);
        for (index, name) in self.options.iter().enumerate() {
            let mut node = nk_a11y::Node::new(0, nk_a11y::Role::Option, name.clone());
            node.states.selected = chosen == index;
            node.states.disabled = !cx.interaction.enabled;
            node.states.offscreen = true;
            node.actions = vec![nk_a11y::Action::Activate];
            children.push(SemanticChild {
                key: cx.key(&format!("option/{index}")),
                node,
                value: Some(Value::Index(index)),
            });
        }
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let t = &cx.look.tokens.dropdown.trigger;
        let i = cx.interaction;
        let fill = if i.enabled && i.pressed {
            t.pressed
        } else if i.enabled && i.hover {
            t.hover
        } else {
            t.background
        };
        let a = if i.enabled {
            1.
        } else {
            t.disabled_opacity as f32
        };
        let (r, b) = (cx.rect, t.border);
        let inner = [
            r[0] + b,
            r[1] + b,
            (r[2] - 2. * b).max(0.),
            (r[3] - 2. * b).max(0.),
        ];
        cx.canvas.clip(rect(&cx.visible));
        cx.canvas.rounded_rect(
            rect(&inner),
            (t.radius - b).max(0.),
            cx.ink(fill.with_alpha(fill.components[3] * a)),
        );
        cx.canvas.pop_clip();
    }
}
