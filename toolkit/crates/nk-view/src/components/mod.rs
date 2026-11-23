// SPDX-License-Identifier: LGPL-3.0-or-later
//! Components answer questions; the view owns traversal, motion and input routing.
use crate::{Corner, Key, Kind, Node, Rect, Tokens, TypeScale};
use nk_render::{Canvas, Color};
use serde::{Deserialize, Serialize};
use std::{
    any::{Any, TypeId},
    collections::{HashMap, HashSet},
};
mod arrangement;
use arrangement::ArrangementRect;
pub use arrangement::{Arrangement, ArrangementItem, ArrangementProjection};
mod long_list;
pub use long_list::{ListSource, LongList, MultipleSelection, RowInfo};
mod editable;
pub use editable::EditableField;
mod search;
use search::Clear;
pub use search::Search;
mod disclosure;
pub use disclosure::Disclosure;
mod slider_end;
pub use slider_end::SliderRow;
mod slider;
pub use slider::SliderControl;
mod field;
pub use field::DisplayField;
mod time_field;
pub use time_field::{TimeField, parse_time};
mod dropdown;
pub use dropdown::Dropdown;
mod menu_row;
pub use menu_row::MenuRow;
mod surface;
pub use surface::Surface;
mod context;
pub use context::*;
mod button;
mod check;
mod segmented;
pub use segmented::SegmentedRow;
mod swatches;
pub use swatches::SwatchRow;
mod segment;
mod swatch;
mod switch;
pub use button::{Button, ButtonAppearance};
pub use check::Check;
pub use segment::Segment;
pub use swatch::Swatch;
pub use switch::Switch;

/// Tokens and type scale belong to the same window appearance. Never infer a font scale
/// from geometry tokens or keep an expanded body across a look rebuild.
#[derive(Clone, Copy)]
pub struct ComponentLook<'a> {
    pub tokens: &'a Tokens,
    pub types: &'a TypeScale,
}
impl Tokens {
    pub fn with_types<'a>(&'a self, types: &'a TypeScale) -> ComponentLook<'a> {
        ComponentLook {
            tokens: self,
            types,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Interaction {
    pub hover: bool,
    pub pressed: bool,
    pub focus_ring: bool,
    pub enabled: bool,
    pub marked: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum BodyPlacement {
    #[default]
    Fill,
    NaturalCentered,
    FillWidth,
    /// Fill both axes inside the frame inset, rather than centering natural height.
    Inset,
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameSpec {
    pub inset: (f64, f64),
    pub least: (f64, f64),
    pub body: BodyPlacement,
}
pub struct Build<'a> {
    pub key: &'a Key,
    pub look: ComponentLook<'a>,
    pub child: &'a Node,
    pub state: Option<&'a dyn Any>,
}
impl Build<'_> {
    pub fn key(&self, suffix: &str) -> Key {
        format!("{}/{suffix}", self.key.0).into()
    }
}
pub struct Prepare<'a> {
    pub look: ComponentLook<'a>,
    pub state: Option<&'a mut dyn Any>,
    pub text: &'a mut dyn nk_text::TextBackend,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaintPhase {
    Under,
    Over,
}
pub struct Paint<'a> {
    pub canvas: &'a mut Canvas,
    pub look: ComponentLook<'a>,
    pub rect: Rect,
    pub visible: Rect,
    pub alpha: f64,
    pub interaction: Interaction,
    pub progress: Option<f64>,
    pub corner: Corner,
    pub state: Option<&'a dyn Any>,
    pub read: Read<'a>,
    pub wash: Option<(Rect, f64, [f64; 4])>,
}
impl Paint<'_> {
    pub fn ink(&self, c: Color) -> Color {
        c.with_alpha(c.components[3] * self.alpha as f32)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Membership {
    None,
    Adjacent { selected: bool },
    Named { key: Key, selected: bool },
    List { key: Key, selected: bool },
}
/// A component may own its selected mark, so its enclosing glass control must not add
/// another selected wash or draw the focus ring through the mark.
#[derive(Clone, Copy, Debug, Default)]
pub struct Glass {
    pub lit: Option<(u8, [f64; 4])>,
}
/// Effects compose: a later host component can change a value, redraw and capture in one
/// event. Input borrows only its own state and effects, never the whole ViewState.
#[derive(Default, Debug)]
pub struct Outcome {
    pub handled: bool,
    pub redraw: bool,
    pub arm: bool,
    pub activate: bool,
    pub action: Option<String>,
    pub value: Option<Value>,
    pub capture: Capture,
    pub focus: bool,
    pub keyboard_focus: bool,
    pub host: Vec<HostRequest>,
    pub reveal: Option<RevealRect>,
}
pub struct Input<'a> {
    pub state: Option<&'a mut (dyn Any + 'static)>,
    pub effects: &'a mut Outcome,
    pub context: Option<Read<'a>>,
}
pub trait Component: Any {
    fn prepare(&self, _cx: &mut Prepare<'_>) -> Result<(), String> {
        Ok(())
    }
    fn arrange(&self, _cx: &mut Input<'_>) {}
    fn pointer_motion(&self, _cx: &mut Input<'_>, _at: (f64, f64)) {}
    fn pointer_leave(&self, _cx: &mut Input<'_>) {}
    fn key_event(&self, _cx: &mut Input<'_>, _key: &nk_wayland::Key) {}
    fn ime(&self, _cx: &mut Input<'_>, _batch: &nk_wayland::ImeBatch) {}
    fn text_input(&self, _cx: &Read<'_>) -> Option<nk_wayland::TextInput> {
        None
    }
    fn revision(&self, _state: Option<&dyn Any>) -> Option<u64> {
        None
    }
    fn body(&self, cx: &Build<'_>) -> Node;
    fn frame(&self, _look: ComponentLook<'_>) -> FrameSpec {
        FrameSpec::default()
    }
    fn paint(&self, _cx: &mut Paint<'_>, _phase: PaintPhase) {}
    fn ink(
        &self,
        _look: ComponentLook<'_>,
        _interaction: Interaction,
        _glyph: bool,
    ) -> Option<Color> {
        None
    }
    fn glass(&self, _cx: &Read<'_>) -> Glass {
        Glass::default()
    }
    fn silhouette(&self, cx: &Read<'_>) -> Rect {
        cx.rect
    }
    /// The focused outline, independent of input and reader geometry. Corners are
    /// clockwise from top-left; a composite may delegate to its decorative mark.
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let bounds = self.silhouette(cx);
        Some(FocusOutline::rounded(
            bounds,
            self.corner()
                .of(bounds[2], bounds[3], &cx.look.tokens.radii),
        ))
    }
    fn target(&self) -> Option<f64> {
        None
    }
    fn press_with_modifiers(
        &self,
        cx: &mut Input<'_>,
        at: (f64, f64),
        _modifiers: nk_wayland::PointerModifiers,
    ) {
        self.press(cx, at);
    }
    fn press(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        cx.effects.arm = true;
    }
    fn drag(&self, _cx: &mut Input<'_>, _at: (f64, f64)) {}
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        cx.effects.activate = true;
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        if key == crate::KeyInput::Activate {
            cx.effects.handled = true;
            cx.effects.activate = true;
        }
    }
    /// Enter offered by a host with a default response. A component can consume
    /// it without an activation (composition), or leave it to that host.
    fn enter(&self, cx: &mut Input<'_>) {
        self.key(cx, crate::KeyInput::Activate);
    }
    fn text(&self, _cx: &mut Input<'_>, _text: &str) {}
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        if matches!(request, Request::Activate) {
            self.key(cx, crate::KeyInput::Activate);
        }
    }
    fn owns_mark(&self) -> bool {
        false
    }
    fn contains_controls(&self) -> bool {
        false
    }
    fn selected(&self) -> bool {
        false
    }
    fn configure(&self, _property: Configure) -> Option<Part> {
        None
    }
    fn corner(&self) -> Corner {
        Corner::Pill
    }
    fn content_ink(&self, _cx: &Read<'_>, _at: Rect, ink: Color) -> Color {
        ink
    }
    fn owner_edits(&self) -> bool {
        false
    }
    fn caret(&self, _cx: &Read<'_>) -> Option<Rect> {
        None
    }
    fn selection(&self, _cx: &Read<'_>) -> Vec<Rect> {
        Vec::new()
    }
    fn value(&self, _state: Option<&dyn Any>) -> Option<Value> {
        None
    }
    /// Publish a captured pointer change from AppWindow while the drag is in progress.
    fn reports_drag(&self) -> bool {
        false
    }
    fn take_changed(&self, _state: Option<&mut dyn Any>) -> Option<Value> {
        None
    }
    fn list(&self, _cx: &Read<'_>) -> Option<ListSpec> {
        None
    }
    fn reconcile(&self, _state: Option<&mut dyn Any>) {}
    fn cancel(&self, _state: Option<&mut dyn Any>) {}
    fn blur(&self, _state: Option<&mut dyn Any>) {}
    fn group(&self, _cx: &Read<'_>) -> Membership {
        Membership::None
    }
    fn semantics(
        &self,
        _cx: &Read<'_>,
        _node: &mut nk_a11y::Node,
        _children: &mut Vec<SemanticChild>,
    ) {
    }
    fn state(&self) -> Option<Box<dyn Any>> {
        None
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Part {
    LongList(LongList),
    ArrangementRect(ArrangementRect),
    Button(Button),
    Segment(Segment),
    Swatch(Swatch),
    Switch(Switch),
    Check(Check),
    Segmented(SegmentedRow),
    Swatches(SwatchRow),
    Surface(Surface),
    Slider(SliderControl),
    SliderRow(SliderRow),
    Field(DisplayField),
    Dropdown(Dropdown),
    MenuRow(MenuRow),
    Disclosure(Disclosure),
    Editable(EditableField),
    Time(TimeField),
    Search(Search),
    SearchClear(Clear),
}
impl Part {
    pub fn configured(&self, property: Configure) -> Self {
        let said = format!("{property:?}");
        self.component().configure(property).unwrap_or_else(|| {
            let name = format!("{self:?}");
            let name = name.split(['(', ' ']).next().unwrap_or_default();
            crate::diagnostics::critical(format!(
                "a {name} does not take {said}: the setting is lost"
            ));
            self.clone()
        })
    }
    /// The only dispatch that names concrete components.
    pub fn component(&self) -> &dyn Component {
        match self {
            Self::LongList(c) => c,
            Self::ArrangementRect(c) => c,
            Self::Button(c) => c,
            Self::Segment(c) => c,
            Self::Swatch(c) => c,
            Self::Switch(c) => c,
            Self::Check(c) => c,
            Self::Segmented(c) => c,
            Self::Swatches(c) => c,
            Self::Surface(c) => c,
            Self::Slider(c) => c,
            Self::SliderRow(c) => c,
            Self::Field(c) => c,
            Self::Dropdown(c) => c,
            Self::MenuRow(c) => c,
            Self::Disclosure(c) => c,
            Self::Editable(c) => c,
            Self::Time(c) => c,
            Self::Search(c) => c,
            Self::SearchClear(c) => c,
        }
    }
}
/// A drawn component inherits interaction from its enclosing control. It has no hit
/// target, Tab stop or semantic node of its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Drawing {
    pub part: Box<Part>,
    pub child: Box<Node>,
}
struct Entry {
    part: Option<Part>,
    kind: TypeId,
    value: Option<Box<dyn Any>>,
    instance: u64,
    error: Option<String>,
}
#[derive(Default)]
pub(crate) struct StateStore {
    entries: HashMap<Key, Entry>,
}
impl StateStore {
    fn see(&mut self, key: &Key, c: &dyn Component) {
        let kind = c.type_id();
        if self.entries.get(key).is_some_and(|e| e.kind == kind) {
            return;
        }
        if let Some(mut old) = self.entries.remove(key)
            && let Some(part) = old.part
        {
            part.component().cancel(old.value.as_deref_mut());
        }
        static NEXT_INSTANCE: std::sync::Mutex<u64> = std::sync::Mutex::new(0);
        let instance = {
            let mut next = NEXT_INSTANCE
                .lock()
                .expect("component instance lock poisoned");
            *next = next.checked_add(1).expect("component instance exhausted");
            *next
        };
        self.entries.insert(
            key.clone(),
            Entry {
                part: None,
                kind,
                value: c.state(),
                instance,
                error: None,
            },
        );
    }
    pub fn instance(&self, key: &Key) -> u64 {
        self.entries.get(key).map_or(0, |e| e.instance)
    }
    pub fn errors(&self) -> Vec<(Key, String)> {
        self.entries
            .iter()
            .filter_map(|(k, e)| e.error.as_ref().map(|s| (k.clone(), s.clone())))
            .collect()
    }
    pub fn get(&self, key: &Key) -> Option<&dyn Any> {
        self.entries.get(key)?.value.as_deref()
    }
    #[cfg(test)]
    pub fn input(&mut self, key: &Key, effects: &mut Outcome, f: impl FnOnce(&mut Input<'_>)) {
        let state = self
            .entries
            .get_mut(key)
            .and_then(|e| e.value.as_deref_mut());
        f(&mut Input {
            state,
            effects,
            context: None,
        });
    }
    pub fn input_context(
        &mut self,
        key: &Key,
        effects: &mut Outcome,
        context: Read<'_>,
        f: impl FnOnce(&mut Input<'_>),
    ) {
        let state = self
            .entries
            .get_mut(key)
            .and_then(|e| e.value.as_deref_mut());
        f(&mut Input {
            state,
            effects,
            context: Some(context),
        });
    }
    pub fn cancel(&mut self, key: &Key) {
        if let Some(e) = self.entries.get_mut(key)
            && let Some(part) = &e.part
        {
            part.component().cancel(e.value.as_deref_mut());
        }
    }
    pub fn blur(&mut self, key: &Key) {
        if let Some(e) = self.entries.get_mut(key)
            && let Some(part) = &e.part
        {
            part.component().blur(e.value.as_deref_mut());
        }
    }
    pub fn take_changed(&mut self, key: &Key) -> Option<Value> {
        let e = self.entries.get_mut(key)?;
        e.part
            .as_ref()?
            .component()
            .take_changed(e.value.as_deref_mut())
    }
    pub fn expand(
        &mut self,
        tree: &Node,
        look: ComponentLook<'_>,
        text: &mut dyn nk_text::TextBackend,
    ) -> Node {
        let mut tree = tree.clone();
        let mut live = HashSet::new();
        fn walk(
            n: &mut Node,
            look: ComponentLook<'_>,
            store: &mut StateStore,
            live: &mut HashSet<Key>,
            text: &mut dyn nk_text::TextBackend,
        ) {
            let part = match &n.kind {
                Kind::Control(c) => c.part.as_deref(),
                Kind::Drawing(d) => Some(d.part.as_ref()),
                _ => None,
            };
            if let Some(part) = part {
                let component = part.component();
                store.see(&n.key, component);
                store.entries.get_mut(&n.key).unwrap().part = Some(part.clone());
                live.insert(n.key.clone());
                let child = match &n.kind {
                    Kind::Control(c) => &*c.child,
                    Kind::Drawing(d) => &*d.child,
                    _ => unreachable!(),
                };
                component.reconcile(
                    store
                        .entries
                        .get_mut(&n.key)
                        .and_then(|e| e.value.as_deref_mut()),
                );
                let entry = store.entries.get_mut(&n.key).unwrap();
                entry.error = component
                    .prepare(&mut Prepare {
                        look,
                        state: entry.value.as_deref_mut(),
                        text,
                    })
                    .err();
                let body = component.body(&Build {
                    key: &n.key,
                    look,
                    child,
                    state: store.get(&n.key),
                });
                match &mut n.kind {
                    Kind::Control(c) => *c.child = body,
                    Kind::Drawing(d) => *d.child = body,
                    _ => unreachable!(),
                }
            }
            match &mut n.kind {
                Kind::Control(c) => walk(&mut c.child, look, store, live, text),
                Kind::Drawing(d) => walk(&mut d.child, look, store, live, text),
                Kind::Stack(s) => {
                    for c in &mut s.children {
                        walk(c, look, store, live, text);
                    }
                }
                Kind::Pane(p) => walk(&mut p.child, look, store, live, text),
                Kind::Group(g) => walk(&mut g.child, look, store, live, text),
                Kind::Reveal(r) => walk(&mut r.child, look, store, live, text),
                Kind::Scroll(s) => walk(&mut s.child, look, store, live, text),
                Kind::Overlay(o) => {
                    walk(&mut o.base, look, store, live, text);
                    for l in &mut o.layers {
                        walk(&mut l.child, look, store, live, text);
                    }
                }
                Kind::Grid(g) => {
                    for c in &mut g.cells {
                        walk(&mut c.child, look, store, live, text);
                    }
                }
                _ => {}
            }
        }
        walk(&mut tree, look, self, &mut live, text);
        self.entries.retain(|k, e| {
            if !live.contains(k) {
                if let Some(part) = &e.part {
                    part.component().cancel(e.value.as_deref_mut());
                }
                false
            } else {
                true
            }
        });
        tree
    }
}
pub(crate) fn part(n: &Node) -> Option<&Part> {
    match &n.kind {
        Kind::Control(c) => c.part.as_deref(),
        Kind::Drawing(d) => Some(d.part.as_ref()),
        _ => None,
    }
}
pub(crate) fn rect(r: &Rect) -> nk_text::Rect {
    nk_text::Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}
pub(crate) fn mix(a: Color, b: Color, t: f32) -> Color {
    Color::new(std::array::from_fn(|i| {
        a.components[i] + (b.components[i] - a.components[i]) * t
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    struct Saved(Rc<Cell<usize>>);
    impl Drop for Saved {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }
    struct Stateful {
        made: Rc<Cell<usize>>,
        dropped: Rc<Cell<usize>>,
    }
    impl Component for Stateful {
        fn body(&self, cx: &Build<'_>) -> Node {
            Node::spacer(cx.key("body"))
        }
        fn state(&self) -> Option<Box<dyn Any>> {
            self.made.set(self.made.get() + 1);
            Some(Box::new(Saved(self.dropped.clone())))
        }
    }
    #[test]
    fn keyed_state_survives_reconciliation_and_input_borrows_only_its_entry() {
        let made = Rc::new(Cell::new(0));
        let dropped = Rc::new(Cell::new(0));
        let c = Stateful {
            made: made.clone(),
            dropped: dropped.clone(),
        };
        let mut store = StateStore::default();
        let key = Key::from("stable");
        store.see(&key, &c);
        store.see(&key, &c);
        assert_eq!(made.get(), 1);
        assert_eq!(dropped.get(), 0);
        let mut effects = Outcome::default();
        store.input(&key, &mut effects, |cx| {
            assert!(cx.state.as_ref().unwrap().is::<Saved>());
            cx.effects.redraw = true;
            cx.effects.activate = true;
        });
        assert!(effects.redraw && effects.activate);
        assert!(store.get(&key).unwrap().is::<Saved>());
        store.see(&key, &Switch { on: true });
        assert_eq!(dropped.get(), 1, "a new component type drops the old state");
        assert!(store.get(&key).is_none());
    }
    #[test]
    fn gone_state_is_dropped_but_a_disabled_or_drawn_component_is_live() {
        let made = Rc::new(Cell::new(0));
        let dropped = Rc::new(Cell::new(0));
        let c = Stateful {
            made: made.clone(),
            dropped: dropped.clone(),
        };
        let mut store = StateStore::default();
        store.see(&"gone".into(), &c);
        let tokens = crate::tests::tokens();
        let types = crate::tests::types();
        let mut control =
            Node::button("disabled", "Button", "go", nk_text::TextStyle::default()).enabled(false);
        let tree = Node::row("row", vec![control.clone(), Node::switch("drawn", true)]);
        store.expand(
            &tree,
            tokens.with_types(&types),
            &mut crate::tests::backend(),
        );
        assert_eq!(dropped.get(), 1);
        assert!(store.entries.contains_key(&"disabled".into()));
        assert!(store.entries.contains_key(&"drawn".into()));
        if let Kind::Control(c) = &mut control.kind {
            c.enabled = true;
        }
        store.expand(
            &control,
            tokens.with_types(&types),
            &mut crate::tests::backend(),
        );
        assert!(store.entries.contains_key(&"disabled".into()));
        assert!(!store.entries.contains_key(&"drawn".into()));
    }
}

/// Focus geometry only. Width, gap and colour belong to the kit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FocusOutline {
    pub bounds: Rect,
    /// Top-left, top-right, bottom-right, bottom-left.
    pub corners: [f64; 4],
    pub clip: Option<Rect>,
}
impl FocusOutline {
    pub fn rounded(bounds: Rect, radius: f64) -> Self {
        Self {
            bounds,
            corners: [radius; 4],
            clip: None,
        }
    }
}
