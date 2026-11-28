// SPDX-License-Identifier: LGPL-3.0-or-later
//! A button with a glyph that opens a list (`Gtk.MenuButton`): the power menu, a bar's
//! language. Its window opens the list as it opens a dropdown's (an `AppWindow`'s popup, a
//! `LayerMenu` on a surface without popups); a row chosen reports the button's action with
//! the row's index, every time, the same row again included: these are commands, not a
//! choice it keeps. A row may carry the tick (`ticked`), for a menu that also shows what is
//! current (the language in use); or several rows may (`checks`), for a menu of things each
//! on or off (`Gtk.CheckButton` rows: large text, the screen reader), whose owner flips the
//! row it hears.
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MenuButton {
    pub glyph: String,
    pub options: Vec<String>,
    pub ticked: Option<usize>,
    /// Rows that are on, in a menu of things each on or off.
    #[serde(default)]
    pub checks: Vec<usize>,
}
#[derive(Default)]
struct State {
    expanded: bool,
}
impl MenuButton {
    /// Whether row `n` carries the tick.
    fn on(&self, n: usize) -> bool {
        self.ticked == Some(n) || self.checks.contains(&n)
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
            cx.effects.handled = true;
        }
    }
}
impl Component for MenuButton {
    fn body(&self, cx: &Build<'_>) -> Node {
        let t = &cx.look.tokens.dropdown.trigger;
        Node::icon(cx.key("glyph"), self.glyph.clone(), t.arrow_size.max(16.))
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        // Square: the trigger's height, the glyph in its middle.
        let (_, _, h) = look.tokens.dropdown.trigger.inset();
        let side = (h - look.tokens.dropdown.trigger.arrow_size.max(16.)) / 2.;
        FrameSpec {
            inset: (side.max(0.), side.max(0.)),
            least: (h, h),
            body: BodyPlacement::NaturalCentered,
        }
    }
    fn corner(&self) -> Corner {
        Corner::Pill
    }
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn value(&self, _state: Option<&dyn Any>) -> Option<Value> {
        self.ticked.map(Value::Index)
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
                cx.effects.handled = true;
                cx.effects.activate = true;
                cx.effects.value = Some(Value::Index(n));
            }
            _ => {}
        }
    }
    fn list(&self, cx: &Read<'_>) -> Option<ListSpec> {
        if self.options.is_empty() {
            return None;
        }
        let m = &cx.look.tokens.dropdown.menu;
        let items = self
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
                Node::menu_row(format!("menu/row/{n}"), name.clone(), "choose", self.on(n))
            })
            .collect();
        Some(ListSpec {
            node: Node::scroll("menu/scroll", Node::column("menu/rows", rows)),
            items,
            selected: self.ticked.unwrap_or(0),
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
        for (index, name) in self.options.iter().enumerate() {
            let mut node = nk_a11y::Node::new(0, nk_a11y::Role::Option, name.clone());
            node.states.selected = self.ticked == Some(index);
            node.states.checked = self.checks.contains(&index);
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
}
