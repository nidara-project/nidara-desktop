// SPDX-License-Identifier: LGPL-3.0-or-later
//! Uniform-height virtualization: the app's source lives only during its rebuild.
use super::*;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RowInfo {
    /// Stable model identity, scoped to this list; never a recycled viewport position.
    pub key: Key,
    pub name: String,
}
/// Model access during a rebuild only. `build` receives the row namespace; append
/// stable suffixes for its content nodes. Metadata keys must be unique within the model.
pub trait ListSource {
    fn item(&self, index: usize) -> RowInfo;
    fn build(&self, index: usize, key: &Key) -> Node;
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Row {
    index: usize,
    item: RowInfo,
    content: Node,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LongList {
    pub count: usize,
    pub selected: usize,
    pub row_height: f64,
    pub activate: Option<String>,
    first: usize,
    rows: Vec<Row>,
    selected_item: Option<RowInfo>,
}
#[derive(Default)]
struct State {
    model: Option<(usize, Option<Key>)>,
    pending: Option<usize>,
    hover: Option<usize>,
    last_clicked: Option<Key>,
    reveal: bool,
    requested: Option<Range<usize>>,
    revision: u64,
}
impl State {
    fn advance(&mut self) {
        self.revision = self
            .revision
            .checked_add(1)
            .expect("list revision exhausted");
    }
}
fn item_suffix(item: &Key) -> String {
    format!("item/{}", item.0.replace('%', "%25").replace('/', "%2F"))
}
fn item_key(owner: &Key, item: &Key) -> Key {
    format!("{}/{}", owner.0, item_suffix(item)).into()
}
fn inside(r: Rect, at: (f64, f64)) -> bool {
    at.0 >= r[0] && at.0 < r[0] + r[2] && at.1 >= r[1] && at.1 < r[1] + r[3]
}
fn decorative(node: &Node) -> bool {
    match &node.kind {
        Kind::Control(_) | Kind::Scroll(_) => false,
        Kind::Stack(s) => s.children.iter().all(decorative),
        Kind::Pane(p) => decorative(&p.child),
        Kind::Group(g) => decorative(&g.child),
        Kind::Reveal(r) => decorative(&r.child),
        Kind::Overlay(o) => decorative(&o.base) && o.layers.iter().all(|l| decorative(&l.child)),
        Kind::Grid(g) => g.cells.iter().all(|c| decorative(&c.child)),
        Kind::Drawing(d) => !d.part.component().contains_controls() && decorative(&d.child),
        _ => true,
    }
}
// Row names/selection come from the list; decorative structure must not introduce
// extra reader containers beside its Option nodes. Layout and material stay intact.
fn presentational(node: &mut Node) {
    node.presentation = true;
    match &mut node.kind {
        Kind::Stack(s) => s.children.iter_mut().for_each(presentational),
        Kind::Pane(p) => presentational(&mut p.child),
        Kind::Group(g) => presentational(&mut g.child),
        Kind::Reveal(r) => presentational(&mut r.child),
        Kind::Overlay(o) => {
            presentational(&mut o.base);
            for l in &mut o.layers {
                presentational(&mut l.child);
            }
        }
        Kind::Grid(g) => {
            for c in &mut g.cells {
                presentational(&mut c.child);
            }
        }
        Kind::Drawing(d) => presentational(&mut d.child),
        _ => {}
    }
}
impl LongList {
    pub fn new(count: usize, selected: usize, row_height: f64) -> Self {
        Self {
            count,
            selected,
            row_height,
            activate: None,
            first: 0,
            rows: vec![],
            selected_item: None,
        }
    }
    pub fn scroll_key(key: &Key) -> Key {
        format!("{}/scroll", key.0).into()
    }
    pub fn range(&self, window: Option<(f64, f64)>) -> Range<usize> {
        if self.count == 0 || !self.row_height.is_finite() || self.row_height <= 0. {
            return 0..0;
        }
        let Some((offset, height)) =
            window.filter(|(o, h)| o.is_finite() && h.is_finite() && *h > 0.)
        else {
            let start = self.selected.min(self.count - 1);
            return start..start + 1;
        };
        let start = (offset.max(0.) / self.row_height).floor() as usize;
        let end = ((offset.max(0.) + height) / self.row_height).ceil() as usize;
        start.saturating_sub(1).min(self.count)..end.saturating_add(1).min(self.count)
    }
    /// Query metadata for visible rows (+ the selection), build only the requested range.
    pub fn node<S: ListSource + ?Sized>(
        mut self,
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
        window: Option<(f64, f64)>,
        source: &S,
    ) -> Node {
        let key = key.into();
        let range = self.range(window);
        self.first = range.start;
        self.rows = range
            .map(|index| {
                let item = source.item(index);
                let mut content = source.build(index, &item_key(&key, &item.key));
                presentational(&mut content);
                Row {
                    index,
                    item,
                    content,
                }
            })
            .collect();
        self.selected_item = self.count.checked_sub(1).map(|last| {
            let selected = self.selected.min(last);
            self.rows
                .iter()
                .find(|r| r.index == selected)
                .map_or_else(|| source.item(selected), |r| r.item.clone())
        });
        let mut n = Node::control(
            key.clone(),
            name,
            changed,
            Node::spacer(format!("{}/body", key.0)),
        );
        if let Kind::Control(c) = &mut n.kind {
            c.part = Some(Box::new(Part::LongList(self)));
        }
        n
    }
    fn built(&self) -> Range<usize> {
        self.first..self.first + self.rows.len()
    }
    fn current(&self, state: Option<&dyn Any>) -> Option<usize> {
        let last = self.count.checked_sub(1)?;
        Some(
            state
                .and_then(|s| s.downcast_ref::<State>())
                .and_then(|s| s.pending)
                .unwrap_or(self.selected)
                .min(last),
        )
    }
    fn row_rect(&self, read: &Read<'_>, item: &RowInfo) -> Option<Rect> {
        read.part(&item_suffix(&item.key)).map(|p| p.rect)
    }
    fn viewport(&self, read: &Read<'_>) -> Option<(Rect, f64)> {
        let p = read.part("scroll")?;
        let crate::layout::What::Scroll { offset, .. } = p.what else {
            return None;
        };
        Some((p.rect, offset))
    }
    fn clip(&self, read: &Read<'_>) -> Option<Rect> {
        crate::layout::intersect(self.viewport(read)?.0, read.visible)
    }
    fn hit(&self, read: &Read<'_>, at: (f64, f64)) -> Option<usize> {
        let viewport = self.clip(read)?;
        if !inside(viewport, at) {
            return None;
        }
        self.rows
            .iter()
            .find(|row| {
                self.row_rect(read, &row.item)
                    .is_some_and(|r| inside(r, at))
            })
            .map(|r| r.index)
    }
    fn choose(&self, cx: &mut Input<'_>, index: usize) {
        cx.effects.handled = true;
        if self.count == 0 || index >= self.count {
            return;
        }
        let before = self.current(cx.state.as_deref());
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.pending = Some(index);
            s.reveal = true;
        }
        if let Some(read) = &cx.context {
            cx.effects.reveal = Some(RevealRect {
                region: Self::scroll_key(read.key),
                rect: [0., index as f64 * self.row_height, 0., self.row_height],
            });
        }
        if before != Some(index) {
            cx.effects.redraw = true;
            cx.effects.activate = true;
            cx.effects.value = Some(Value::Index(index));
        }
    }
    fn info(&self, index: usize) -> Option<&RowInfo> {
        self.rows
            .iter()
            .find(|r| r.index == index)
            .map(|r| &r.item)
            .or_else(|| {
                (self.count > 0 && self.selected.min(self.count - 1) == index)
                    .then_some(self.selected_item.as_ref())
                    .flatten()
            })
    }
}
impl Component for LongList {
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn prepare(&self, _cx: &mut Prepare<'_>) -> Result<(), String> {
        if !self.row_height.is_finite()
            || self.row_height <= 0.
            || !(self.row_height * self.count as f64).is_finite()
        {
            return Err("list requires finite positive uniform row height".into());
        }
        if self.first > self.count || self.rows.len() > self.count - self.first {
            return Err("list range exceeds model".into());
        }
        let mut keys = HashSet::new();
        for (at, row) in self.rows.iter().enumerate() {
            if row.index != self.first + at || !keys.insert(&row.item.key) {
                return Err("list rows need ordered indices and unique model keys".into());
            }
            if !decorative(&row.content) {
                return Err(
                    "list row content must be decorative (no nested controls/scroll regions)"
                        .into(),
                );
            }
        }
        if let Some(index) = self.current(None) {
            let item = self
                .selected_item
                .as_ref()
                .ok_or("list selection has no metadata")?;
            if let Some(row) = self.rows.iter().find(|r| r.index == index) {
                if row.item != *item {
                    return Err("list selection identity disagrees with row".into());
                }
            } else if keys.contains(&item.key) {
                return Err("list selection reuses another item's key".into());
            }
        } else if self.selected_item.is_some() {
            return Err("empty list has a selection".into());
        }
        Ok(())
    }
    fn reconcile(&self, state: Option<&mut dyn Any>) {
        let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) else {
            return;
        };
        let model = self
            .current(None)
            .map(|i| (i, self.selected_item.as_ref().map(|m| m.key.clone())));
        if s.model != model {
            s.reveal = true;
        }
        s.model = model;
        s.pending = None;
        if s.requested.as_ref() == Some(&self.built()) {
            s.requested = None;
            s.advance();
        }
    }
    fn revision(&self, state: Option<&dyn Any>) -> Option<u64> {
        state
            .and_then(|s| s.downcast_ref::<State>())
            .map(|s| s.revision)
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let inset = cx.look.tokens.list.inset + cx.look.tokens.spacing.px(crate::Space::S2);
        let mut nodes = vec![Node::placeholder(
            cx.key("before"),
            self.first as f64 * self.row_height,
        )];
        for row in &self.rows {
            let key = item_key(cx.key, &row.item.key);
            nodes.push(
                Node::row(
                    key.clone(),
                    vec![
                        Node::row(format!("{}/leading", key.0), vec![]).width(inset),
                        row.content.clone().grow(),
                        Node::row(format!("{}/trailing", key.0), vec![]).width(inset),
                    ],
                )
                .align(crate::Align::Center)
                .height(self.row_height),
            );
        }
        nodes.push(Node::placeholder(
            cx.key("after"),
            (self.count - self.built().end) as f64 * self.row_height,
        ));
        Node::scroll(cx.key("scroll"), Node::column(cx.key("rows"), nodes))
            .presentational()
            .grow()
    }
    fn frame(&self, _look: ComponentLook<'_>) -> FrameSpec {
        FrameSpec {
            least: (0., self.row_height),
            body: BodyPlacement::Inset,
            ..Default::default()
        }
    }
    fn arrange(&self, cx: &mut Input<'_>) {
        let Some(read) = cx.context else {
            return;
        };
        if !read.showing || self.viewport(&read).is_none() {
            if let Some(s) = cx
                .state
                .as_deref_mut()
                .and_then(|s| s.downcast_mut::<State>())
            {
                if s.requested.take().is_some() {
                    s.advance();
                }
                s.hover = None;
            }
            return;
        }
        let (viewport, offset) = self.viewport(&read).unwrap();
        if viewport[3] <= 0. {
            return;
        }
        let selected = self.current(cx.state.as_deref());
        let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        let mut wanted_offset = offset;
        if s.reveal
            && let Some(index) = selected
        {
            let top = index as f64 * self.row_height;
            wanted_offset = if top < offset || self.row_height > viewport[3] {
                top
            } else if top + self.row_height > offset + viewport[3] {
                top + self.row_height - viewport[3]
            } else {
                offset
            };
            cx.effects.reveal = Some(RevealRect {
                region: Self::scroll_key(read.key),
                rect: [0., top, 0., self.row_height],
            });
        }
        s.reveal = false;
        let range = self.range(Some((wanted_offset, viewport[3])));
        if self.built() == range {
            if s.requested.take().is_some() {
                s.advance();
            }
        } else if s.requested.as_ref() != Some(&range) {
            s.requested = Some(range);
            s.advance();
            cx.effects.host.push(HostRequest::Rebuild {
                target: read.reply_target(TypeId::of::<Self>(), s.revision),
            });
        }
    }
    fn value(&self, state: Option<&dyn Any>) -> Option<Value> {
        self.current(state).map(Value::Index)
    }
    fn pointer_motion(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        let hover = cx.context.as_ref().and_then(|r| self.hit(r, at));
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
            && s.hover != hover
        {
            s.hover = hover;
            cx.effects.redraw = true;
        }
    }
    fn pointer_leave(&self, cx: &mut Input<'_>) {
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
            && s.hover.take().is_some()
        {
            cx.effects.redraw = true;
        }
    }
    fn press(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        let Some(read) = cx.context else {
            return;
        };
        let Some(index) = self.hit(&read, at) else {
            return;
        };
        let Some(info) = self.info(index) else {
            return;
        };
        let double = cx
            .state
            .as_deref()
            .and_then(|s| s.downcast_ref::<State>())
            .is_some_and(|s| s.last_clicked.as_ref() == Some(&info.key))
            && read.clicks == 2;
        self.choose(cx, index);
        cx.effects.focus = true;
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.last_clicked = Some(info.key.clone());
        }
        if double && let Some(action) = &self.activate {
            cx.effects.activate = true;
            cx.effects.action = Some(action.clone());
            cx.effects.value = Some(Value::Index(index));
        }
    }
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        cx.effects.handled = true;
    }
    fn key_event(&self, cx: &mut Input<'_>, key: &nk_wayland::Key) {
        if key.sym == 0x20 {
            cx.effects.handled = true;
        }
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        use crate::KeyInput::*;
        let Some(current) = self.current(cx.state.as_deref()) else {
            cx.effects.handled = matches!(
                key,
                Up | Down | Home | End | LineStart | LineEnd | PageUp | PageDown | Activate
            );
            return;
        };
        let page = cx
            .context
            .as_ref()
            .and_then(|r| self.viewport(r))
            .map_or(1, |(r, _)| {
                (r[3] / self.row_height).floor().max(1.) as usize
            });
        let index = match key {
            Up => current.saturating_sub(1),
            Down => current.saturating_add(1).min(self.count - 1),
            Home | LineStart => 0,
            End | LineEnd => self.count - 1,
            PageUp => current.saturating_sub(page),
            PageDown => current.saturating_add(page).min(self.count - 1),
            Activate => {
                cx.effects.handled = true;
                if let Some(action) = &self.activate {
                    cx.effects.activate = true;
                    cx.effects.action = Some(action.clone());
                    cx.effects.value = Some(Value::Index(current));
                }
                return;
            }
            _ => return,
        };
        self.choose(cx, index);
        cx.effects.keyboard_focus = true;
    }
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        match request {
            Request::Set(Value::Index(index)) => {
                if index < self.count {
                    self.choose(cx, index);
                    cx.effects.focus = true;
                    cx.effects.keyboard_focus = true;
                } else {
                    cx.effects.handled = true;
                }
            }
            Request::Activate => self.key(cx, crate::KeyInput::Activate),
            _ => {}
        }
    }
    fn content_ink(&self, cx: &Read<'_>, at: Rect, ink: Color) -> Color {
        if !cx.interaction.enabled {
            return cx.look.tokens.look.disabled;
        }
        if let Some(i) = self.current(cx.state)
            && let Some(item) = self.info(i)
            && self
                .row_rect(cx, item)
                .is_some_and(|r| inside(r, (at[0] + at[2] / 2., at[1] + at[3] / 2.)))
        {
            return cx.look.tokens.look.accent_fg;
        }
        ink
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let Some(viewport) = self.clip(&cx.read) else {
            return;
        };
        let selected = self.current(cx.state);
        let hover = cx
            .state
            .and_then(|s| s.downcast_ref::<State>())
            .and_then(|s| s.hover);
        let style = &cx.look.tokens.list;
        let radius = cx.look.tokens.radii.px(crate::Radius::Sm);
        cx.canvas.clip(rect(&viewport));
        for row in &self.rows {
            let Some(mut bounds) = self.row_rect(&cx.read, &row.item) else {
                continue;
            };
            bounds = [
                bounds[0] + style.inset,
                bounds[1] + style.inset,
                (bounds[2] - 2. * style.inset).max(0.),
                (bounds[3] - 2. * style.inset).max(0.),
            ];
            if selected == Some(row.index) {
                let color = cx.ink(cx.look.tokens.look.accent).with_alpha(
                    cx.alpha as f32
                        * if cx.interaction.enabled {
                            1.
                        } else {
                            cx.look.tokens.button.disabled_opacity as f32
                        },
                );
                cx.canvas.rounded_rect(rect(&bounds), radius, color);
            } else if cx.interaction.enabled && cx.interaction.hover && hover == Some(row.index) {
                let color = cx
                    .ink(cx.look.tokens.look.primary)
                    .with_alpha(style.hover_opacity * cx.alpha as f32);
                cx.canvas.rounded_rect(rect(&bounds), radius, color);
            }
            if selected == Some(row.index) && cx.interaction.enabled && cx.interaction.focus_ring {
                let color = cx.ink(cx.look.tokens.look.focus);
                cx.canvas
                    .rounded_ring(rect(&bounds), radius, style.focus_width, color);
            }
        }
        if self.count == 0 && cx.interaction.focus_ring && cx.interaction.enabled {
            let color = cx.ink(cx.look.tokens.look.focus);
            cx.canvas
                .rounded_ring(rect(&viewport), radius, style.focus_width, color);
        }
        cx.canvas.pop_clip();
    }
    fn semantics(
        &self,
        cx: &Read<'_>,
        node: &mut nk_a11y::Node,
        children: &mut Vec<SemanticChild>,
    ) {
        node.role = nk_a11y::Role::ListBox;
        node.attributes
            .insert("setsize".into(), self.count.to_string());
        let selected = self.current(cx.state);
        let mut items: Vec<_> = self.rows.iter().map(|r| (r.index, &r.item)).collect();
        if let Some(index) = selected
            && !items.iter().any(|(i, _)| *i == index)
            && let Some(item) = self.info(index)
        {
            items.push((index, item));
            items.sort_by_key(|(i, _)| *i);
        }
        let viewport = self.clip(cx);
        for (index, item) in items {
            let mut n = nk_a11y::Node::new(0, nk_a11y::Role::Option, item.name.clone());
            n.states.selected = selected == Some(index);
            n.states.disabled = !cx.interaction.enabled;
            n.states.offscreen = true;
            n.actions = vec![nk_a11y::Action::Activate];
            n.attributes
                .insert("posinset".into(), (index + 1).to_string());
            n.attributes
                .insert("setsize".into(), self.count.to_string());
            if let Some(r) = self.row_rect(cx, item) {
                n.bounds = nk_a11y::Bounds {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                };
                n.states.offscreen =
                    viewport.is_none_or(|v| crate::layout::intersect(r, v).is_none());
            }
            children.push(SemanticChild {
                key: item_key(cx.key, &item.key),
                node: n,
                value: Some(Value::Index(index)),
            });
        }
    }
}
