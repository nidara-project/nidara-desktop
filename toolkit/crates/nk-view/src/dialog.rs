// SPDX-License-Identifier: LGPL-3.0-or-later
//! Modal window policy and publication namespace, owned by AppWindow.
use super::*;
use nk_a11y::{NodeId, Relation, Tree};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
    sync::atomic::{AtomicU32, Ordering},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogButton {
    pub id: String,
    pub label: String,
    pub default: bool,
    pub cancel: bool,
    pub destructive: bool,
    pub enabled: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DialogAnswer {
    Button(String),
    Cancel,
}
#[derive(Clone, Debug)]
pub struct Dialog {
    pub title: String,
    pub buttons: Vec<DialogButton>,
    pub close_label: String,
}
impl Dialog {
    pub fn validate(&self) -> Result<()> {
        let mut ids = std::collections::HashSet::new();
        let mut defaults = 0;
        let mut cancels = 0;
        for button in &self.buttons {
            if button.id.is_empty()
                || button.id.contains('\0')
                || button.label.is_empty()
                || button.label.contains('\0')
                || !ids.insert(&button.id)
            {
                return Err("dialog response needs a unique id and label".into());
            }
            if button.default && button.destructive {
                return Err("a destructive response cannot be the default".into());
            }
            if button.default && button.cancel && self.buttons.len() > 1 {
                return Err("cancel-first and default-last require separate responses".into());
            }
            defaults += usize::from(button.default);
            cancels += usize::from(button.cancel);
        }
        if defaults > 1 || cancels > 1 {
            return Err("dialog has multiple default or cancel responses".into());
        }
        if self.title.contains('\0') {
            return Err("dialog title contains NUL".into());
        }
        Ok(())
    }
    fn ordered(&self) -> Vec<&DialogButton> {
        let mut buttons: Vec<_> = self.buttons.iter().collect();
        buttons.sort_by_key(|b| {
            if b.cancel {
                0
            } else if b.default {
                2
            } else {
                1
            }
        });
        buttons
    }
    fn answer(&self, id: &str) -> Option<DialogAnswer> {
        self.buttons
            .iter()
            .find(|b| b.id == id && b.enabled)
            .map(|b| {
                if b.cancel {
                    DialogAnswer::Cancel
                } else {
                    DialogAnswer::Button(b.id.clone())
                }
            })
    }
}

/// A dialog owns its draft. The parent model remains its caller's, and a response
/// is the caller's decision about whether to commit that draft.
pub trait DialogContent {
    fn content(&mut self, host: &AppWindow) -> Node;
    fn activated(&mut self, action: Activated) -> Result<()>;
    /// Current response eligibility. Signal later changes with `content_changed`.
    fn buttons(&self) -> Option<Vec<DialogButton>> {
        None
    }
    fn poll(&mut self) -> Result<DialogUpdate> {
        Ok(DialogUpdate::default())
    }
}
#[derive(Default)]
pub struct DialogUpdate {
    pub appearance: Option<(WindowLook, bool)>,
    pub content_changed: bool,
    pub parent_changed: bool,
}
#[derive(Clone, Debug)]
pub struct Alert {
    pub title: String,
    pub message: String,
    pub detail: Option<String>,
    pub buttons: Vec<DialogButton>,
}

// Low 32 bits are an AppWindow's existing local namespace. High bits give every
// modal lifetime a process-unique namespace, so a stale object cannot address a
// later dialog even when both have a response named "confirm".
static NEXT_MODAL: AtomicU32 = AtomicU32::new(1);
#[derive(Clone, Debug)]
pub(super) struct Namespace(u64);
impl Namespace {
    fn new() -> Result<Self> {
        let mut generation = NEXT_MODAL.load(Ordering::Relaxed);
        loop {
            let next = generation
                .checked_add(1)
                .ok_or("modal publication namespace exhausted")?;
            match NEXT_MODAL.compare_exchange_weak(
                generation,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Ok(Self(u64::from(generation) << 32)),
                Err(current) => generation = current,
            }
        }
    }
    fn id(&self, local: NodeId) -> Result<NodeId> {
        if local > u64::from(u32::MAX) {
            return Err("modal local semantic id overflow".into());
        }
        Ok(self.0 | local)
    }
    fn local(&self, id: NodeId) -> Option<NodeId> {
        (id & !u64::from(u32::MAX) == self.0).then_some(id & u64::from(u32::MAX))
    }
    fn tree(&self, tree: Tree) -> Result<Tree> {
        let root = self.id(tree.root)?;
        let mut nodes = BTreeMap::new();
        for (id, mut node) in tree.nodes {
            node.id = self.id(id)?;
            node.children = node
                .children
                .into_iter()
                .map(|id| self.id(id))
                .collect::<Result<_>>()?;
            node.active_descendant = node.active_descendant.map(|id| self.id(id)).transpose()?;
            node.relations = node
                .relations
                .into_iter()
                .map(|r| {
                    Ok(match r {
                        Relation::LabelledBy(id) => Relation::LabelledBy(self.id(id)?),
                        Relation::LabelFor(id) => Relation::LabelFor(self.id(id)?),
                    })
                })
                .collect::<Result<_>>()?;
            nodes.insert(node.id, node);
        }
        Ok(Tree { root, nodes })
    }
    fn request(&self, request: Request) -> Option<Request> {
        Some(match request {
            Request::Named(id, name) => Request::Named(self.local(id)?, name),
            Request::Focus(id) => Request::Focus(self.local(id)?),
            Request::Activate(id) => Request::Activate(self.local(id)?),
            Request::SetText(id, text) => Request::SetText(self.local(id)?, text),
            Request::SetSelection(id, range) => Request::SetSelection(self.local(id)?, range),
            Request::SetValue(id, value) => Request::SetValue(self.local(id)?, value),
        })
    }
}
fn modal_tree(mut parent: Tree, child: Tree) -> Tree {
    for node in parent.nodes.values_mut() {
        if !node.actions.is_empty() {
            node.states.disabled = true;
        }
        node.actions.clear();
        node.states.active = false;
        node.states.focused = false;
    }
    parent
        .nodes
        .get_mut(&parent.root)
        .expect("parent root")
        .children
        .push(child.root);
    parent.nodes.extend(child.nodes);
    parent
}

pub(super) struct ModalFrame {
    pub(super) spec: Dialog,
    pub(super) alert: bool,
    pub(super) description: String,
    pub(super) namespace: Namespace,
    pub(super) parent: Rc<RefCell<Tree>>,
    pub(super) close_label: String,
}
impl ModalFrame {
    pub(super) fn request(&self, request: Request) -> Option<Request> {
        self.namespace.request(request)
    }
    pub(super) fn publish(&self, mut tree: Tree, active: bool) -> Result<Tree> {
        let root = tree
            .nodes
            .get_mut(&tree.root)
            .ok_or("dialog semantic root missing")?;
        root.role = if self.alert {
            nk_a11y::Role::Alert
        } else {
            nk_a11y::Role::Dialog
        };
        root.description = self.description.clone();
        root.states.modal = true;
        if !active {
            for node in tree.nodes.values_mut() {
                node.states.focused = false;
            }
        }
        Ok(modal_tree(
            self.parent.borrow().clone(),
            self.namespace.tree(tree)?,
        ))
    }
    pub(super) fn content(
        &self,
        page: &Page,
        look: &WindowLook,
        controls: Option<ControlsLayout>,
    ) -> Node {
        use crate::{Corner, Padding, Space};
        let mut header = vec![
            Node::text(
                "dialog/title",
                self.spec.title.clone(),
                look.types.style(Type::Subtitle, Weight::Semibold),
            )
            .lines(1)
            .grow(),
        ];
        if !self.alert {
            header.push(if let Some(c) = controls {
                Node::column("dialog/server-close", vec![])
                    .width(c.width)
                    .height(c.height)
            } else {
                Node::control(
                    "dialog/close",
                    self.close_label.clone(),
                    "dialog:cancel",
                    Node::icon("dialog/close/glyph", "nd-window-close", look.frame.icon),
                )
                .width(look.frame.button)
                .height(look.frame.button)
            });
            if controls.is_some_and(|c| c.side == nk_wayland::ControlsSide::Left) {
                header.reverse();
            }
        }
        let responses = self
            .spec
            .ordered()
            .into_iter()
            .map(|b| {
                Node::button(
                    format!("dialog/response/{}", b.id),
                    b.label.clone(),
                    format!("dialog:response:{}", b.id),
                    look.types.style(Type::Small, Weight::Medium),
                )
                .enabled(b.enabled)
                .button_appearance(if b.destructive {
                    crate::components::ButtonAppearance::Destructive
                } else if b.default {
                    crate::components::ButtonAppearance::Default
                } else {
                    crate::components::ButtonAppearance::Normal
                })
            })
            .collect();
        Node::pane(
            "dialog/pane",
            Corner::Token(crate::Radius::Md),
            Node::column(
                "dialog/layout",
                vec![
                    Node::row("dialog/header", header)
                        .gap(Space::S3)
                        .align(crate::Align::Center),
                    Node::scroll(
                        "dialog/scroll",
                        Node::column("dialog/content", vec![page.content.clone()]),
                    ),
                    Node::row("dialog/responses", responses)
                        .gap(Space::S2)
                        .justify(crate::Justify::End),
                ],
            )
            .gap(Space::S3)
            .padding(Padding::all(Space::S3)),
        )
    }
}

struct SuspendedParent<'a> {
    host: &'a mut AppWindow,
    rebuild: &'a mut dyn FnMut(&AppWindow) -> Page,
    snapshot: Rc<RefCell<Tree>>,
    dirty: bool,
    published: Rc<Cell<bool>>,
}
impl nk_wayland::Application for SuspendedParent<'_> {
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        self.host.event(event, window)?;
        Ok(())
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        let changed = self.dirty || self.host.changed || self.host.paint_dirty;
        if self.dirty {
            let page = (self.rebuild)(self.host);
            self.host.show(page);
            self.dirty = false;
        }
        self.host.commit(window, &mut *self.rebuild)?;
        if changed {
            *self.snapshot.borrow_mut() = self.host.semantic_tree(window);
            self.published.set(true);
        }
        Ok(())
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.host.paint(frame)
    }
    fn material(&self) -> Option<Material> {
        self.host.material()
    }
    fn window_background(&self) -> Option<WindowBackground> {
        self.host.window_background()
    }
}
struct Runner<'a> {
    parent: SuspendedParent<'a>,
    child: &'a mut AppWindow,
    model: &'a mut dyn DialogContent,
    answer: &'a mut Option<DialogAnswer>,
    limits: ((u32, u32), (u32, u32)),
    first_focus: bool,
    dirty: bool,
}
impl Runner<'_> {
    fn page(&mut self) -> Page {
        Page {
            sidebar: Node::spacer("dialog/unused-sidebar"),
            content: self.model.content(self.child),
            title: self.child.name.clone(),
            can_back: false,
            can_forward: false,
        }
    }
    fn rebuild(&mut self) -> Result<()> {
        if let Some(buttons) = self.model.buttons() {
            self.child
                .modal_frame
                .as_mut()
                .expect("modal host")
                .spec
                .buttons = buttons;
        }
        self.child
            .modal_frame
            .as_ref()
            .expect("modal host")
            .spec
            .validate()?;
        let page = self.page();
        self.child.show(page);
        Ok(())
    }
    fn activated(&mut self, action: Activated, window: &mut Window) -> Result<()> {
        // A batch can contain more than one already-accepted reader response.
        // The first completion owns the answer; later actions cannot replace it.
        if self.answer.is_some() || window.is_closed() {
            return Ok(());
        }
        if action.action == "dialog:cancel" && action.key.0 == "dialog/close" {
            *self.answer = Some(DialogAnswer::Cancel);
            window.close();
            return Ok(());
        }
        if let Some(id) = action.action.strip_prefix("dialog:response:")
            && action.key.0 == format!("dialog/response/{id}")
        {
            if let Some(answer) = self
                .child
                .modal_frame
                .as_ref()
                .expect("modal host")
                .spec
                .answer(id)
            {
                *self.answer = Some(answer);
                window.close();
            }
            return Ok(());
        }
        self.model.activated(action)?;
        self.dirty = true;
        Ok(())
    }
    fn focus(&mut self) {
        let modal = self.child.modal_frame.as_ref().expect("modal host");
        if !modal.alert && self.child.state.focus_first_under(&"dialog/content".into()) {
            return;
        }
        let target = modal
            .spec
            .buttons
            .iter()
            .find(|b| b.default && b.enabled)
            .or_else(|| modal.spec.ordered().into_iter().find(|b| b.enabled))
            .map(|b| Key(format!("dialog/response/{}", b.id)));
        if let Some(key) = target {
            self.child.state.request(&key, false);
        }
    }
    fn commit(&mut self, window: &mut Window) -> Result<()> {
        if self.parent.published.replace(false) {
            self.child.changed = true;
        }
        if self.dirty {
            self.rebuild()?;
            self.dirty = false;
        }
        if self.first_focus && self.child.active {
            self.focus();
            self.first_focus = false;
            self.child.changed = true;
        }
        let model = &mut self.model;
        self.child.commit(window, |host| Page {
            sidebar: Node::spacer("dialog/unused-sidebar"),
            content: model.content(host),
            title: host.name.clone(),
            can_back: false,
            can_forward: false,
        })
    }
}
impl nk_wayland::Application for Runner<'_> {
    fn modal_parent(&mut self) -> Option<&mut dyn nk_wayland::Application> {
        Some(&mut self.parent)
    }
    fn window_controls(&self) -> bool {
        !self.child.modal_frame.as_ref().expect("modal host").alert
    }
    fn window_control_buttons(&self) -> nk_wayland::ControlsButtons {
        nk_wayland::ControlsButtons::Close
    }
    fn poll_interval_ms(&self) -> u32 {
        self.child.poll_interval_ms()
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        let update = self.model.poll()?;
        if let Some((look, reduced)) = update.appearance {
            self.parent.host.set_look(look.clone(), reduced);
            self.parent.dirty = true;
            self.child.set_look(look, reduced);
            self.dirty = true;
        }
        self.dirty |= update.content_changed;
        self.parent.dirty |= update.parent_changed;
        // Reconcile external changes before accepting queued reader actions.
        if self.dirty {
            self.rebuild()?;
            self.dirty = false;
        }
        for action in self.child.idle()? {
            self.activated(action, window)?;
        }
        self.commit(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if matches!(&event, Event::Configure) {
            window.set_title(&self.child.name)?;
            window.set_size_limits(self.limits.0, self.limits.1)?;
        }
        if let Event::Button {
            button: 0x110,
            pressed: true,
            serial,
            ..
        } = &event
            && let Some((x, y)) = window.root_pointer_position()
            && let Some([hx, hy, hw, hh]) = self.child.state.rect(&"dialog/header".into())
            && x >= hx
            && x < hx + hw
            && y >= hy
            && y < hy + hh
            && !self
                .child
                .state
                .rect(&"dialog/close".into())
                .is_some_and(|[cx, cy, cw, ch]| x >= cx && x < cx + cw && y >= cy && y < cy + ch)
        {
            window.move_from_pointer_press(*serial)?;
            return Ok(());
        }
        if let Event::Key(key) = &event
            && self.child.menu.is_none()
            && matches!(key.sym, 0xff0d | 0xff8d)
            && !key.ctrl
            && !key.alt
        {
            let (handled, action) = self.child.state.enter();
            if let Some(action) = action {
                self.activated(action, window)?;
            }
            if !handled {
                let key = self
                    .child
                    .modal_frame
                    .as_ref()
                    .expect("modal host")
                    .spec
                    .buttons
                    .iter()
                    .find(|b| b.default && b.enabled)
                    .map(|b| Key(format!("dialog/response/{}", b.id)));
                if let Some(key) = key
                    && let Some(action) = self.child.state.request(&key, true)
                {
                    self.activated(action, window)?;
                }
            }
            self.child.changed = true;
            self.child.paint_dirty = true;
            return self.commit(window);
        }
        let escape = matches!(&event,Event::Key(k) if k.sym==0xff1b);
        let (handled, actions) = self.child.event(event, window)?;
        for action in actions {
            self.activated(action, window)?;
        }
        if escape && !handled {
            *self.answer = Some(DialogAnswer::Cancel);
            window.close();
        }
        self.commit(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.child.paint(frame)
    }
    fn material(&self) -> Option<Material> {
        self.child.material()
    }
    fn window_background(&self) -> Option<WindowBackground> {
        None
    }
}

fn size(value: (f64, f64)) -> (u32, u32) {
    (value.0.ceil().max(1.) as u32, value.1.ceil().max(1.) as u32)
}
fn fit_size(natural: (f64, f64), minimum: (f64, f64), maximum: (f64, f64)) -> Result<(f64, f64)> {
    if [
        natural.0, natural.1, minimum.0, minimum.1, maximum.0, maximum.1,
    ]
    .into_iter()
    .any(|n| !n.is_finite() || n < 0.)
        || minimum.0 > maximum.0
        || minimum.1 > maximum.1
        || maximum.0 < 1.
        || maximum.1 < 1.
    {
        return Err("dialog header/responses do not fit the parent's available size".into());
    }
    Ok((
        natural.0.clamp(minimum.0, maximum.0),
        natural.1.clamp(minimum.1, maximum.1),
    ))
}
impl AppWindow {
    /// A modal draft on this window. The parent builder sees the latest owner model
    /// on appearance/explicit model updates, and once more before focus restoration.
    pub fn run_dialog(
        &mut self,
        window: &mut Window,
        launcher: &Key,
        spec: Dialog,
        model: &mut dyn DialogContent,
        mut parent_page: impl FnMut(&AppWindow) -> Page,
    ) -> Result<DialogAnswer> {
        self.run_modal(
            window,
            launcher,
            spec,
            ModalKind::Dialog,
            model,
            &mut parent_page,
        )
    }
    pub fn run_alert(
        &mut self,
        window: &mut Window,
        launcher: &Key,
        alert: Alert,
        mut updates: impl FnMut() -> Result<DialogUpdate>,
        mut parent_page: impl FnMut(&AppWindow) -> Page,
    ) -> Result<DialogAnswer> {
        let spec = Dialog {
            title: alert.title,
            buttons: alert.buttons,
            close_label: String::new(),
        };
        let description = alert.message.clone();
        let mut model = AlertContent {
            message: alert.message,
            detail: alert.detail,
            updates: &mut updates,
        };
        self.run_modal(
            window,
            launcher,
            spec,
            ModalKind::Alert(description),
            &mut model,
            &mut parent_page,
        )
    }
    fn run_modal(
        &mut self,
        window: &mut Window,
        launcher: &Key,
        spec: Dialog,
        kind: ModalKind,
        model: &mut dyn DialogContent,
        parent_page: &mut dyn FnMut(&AppWindow) -> Page,
    ) -> Result<DialogAnswer> {
        let (alert, description) = match kind {
            ModalKind::Dialog => (false, String::new()),
            ModalKind::Alert(message) => (true, message),
        };
        let mut spec = spec;
        if let Some(buttons) = model.buttons() {
            spec.buttons = buttons;
        }
        spec.validate()?;
        if !alert && (spec.close_label.is_empty() || spec.close_label.contains('\0')) {
            return Err("dialog requires a localized close label".into());
        }
        if self.suspended || self.modal_frame.is_some() {
            return Err("another modal host is already active".into());
        }
        let lease = self
            .state
            .focus_lease(launcher)
            .ok_or("dialog launcher is not an eligible retained control")?;
        self.close_menu(window);
        let snapshot = Rc::new(RefCell::new(self.semantic_tree(window)));
        let mut child = AppWindow::new(
            self.look.clone(),
            Labels {
                show_sidebar: String::new(),
                hide_sidebar: String::new(),
                back: String::new(),
                forward: String::new(),
            },
            spec.title.clone(),
            self.text.fork()?,
            self.glyphs.clone(),
            self.reduced,
        );
        child.modal_frame = Some(ModalFrame {
            close_label: spec.close_label.clone(),
            spec,
            alert,
            description,
            namespace: Namespace::new()?,
            parent: snapshot.clone(),
        });
        let parent_size = window.size();
        let maximum = (
            f64::from(parent_size.0).min(self.look.frame.content),
            f64::from(parent_size.1),
        );
        child.scale = self.scale;
        child.size = maximum;
        let page = Page {
            sidebar: Node::spacer("dialog/unused-sidebar"),
            content: model.content(&child),
            title: child.name.clone(),
            can_back: false,
            can_forward: false,
        };
        child.show(page);
        let natural = child.state.natural_size(child.text.as_mut());
        let modal = child.modal_frame.as_ref().expect("modal host");
        let chrome = Page {
            sidebar: Node::spacer("unused"),
            content: Node::spacer("dialog/empty-measure"),
            title: child.name.clone(),
            can_back: false,
            can_forward: false,
        };
        let root = modal.content(&chrome, &child.look, None);
        let mut measured = ViewState::new(0);
        measured.layout(
            &root,
            maximum,
            child.scale,
            child.look.tokens.with_types(&child.look.types),
            child.text.as_mut(),
            Instant::now(),
        );
        let minimum = measured.natural_size(child.text.as_mut());
        child.size = fit_size(natural, minimum, maximum)?;
        child.lay(Instant::now());
        self.publish(window)?;
        self.suspended = true;
        self.active = false;
        self.changed = true;
        self.paint_dirty = true;
        self.band_dirty = true;
        self.state.blur();
        self.band.blur();
        self.paste_targets.clear();
        window.set_text_input(Default::default());
        child.a11y = self.a11y.take();
        child.revision = self.revision;
        let mut answer = None;
        let options = nk_wayland::Options {
            material: true,
            map: true,
            app_id: "",
            title: "",
            size: size(child.size),
            require_material: Some("dialog requires Nidara material support"),
        };
        let result = nk_wayland::run_dialog_with_options(
            Runner {
                parent: SuspendedParent {
                    host: self,
                    rebuild: parent_page,
                    snapshot,
                    dirty: false,
                    published: Rc::new(Cell::new(false)),
                },
                child: &mut child,
                model,
                answer: &mut answer,
                limits: (size(minimum), size(maximum)),
                first_focus: true,
                dirty: true,
            },
            window,
            options,
        );
        self.a11y = child.a11y.take();
        self.revision = child.revision;
        self.suspended = false;
        let page = parent_page(self);
        self.show(page);
        self.focus_restore = (!window.is_closed()).then_some(lease);
        // Removing the modal namespace and restoring the one parent publication
        // happens on ordinary cancellation and every returned error.
        let restored = self.commit(window, &mut *parent_page);
        result?;
        restored?;
        Ok(answer.unwrap_or(DialogAnswer::Cancel))
    }
}
enum ModalKind {
    Dialog,
    Alert(String),
}

struct AlertContent<'a> {
    message: String,
    detail: Option<String>,
    updates: &'a mut dyn FnMut() -> Result<DialogUpdate>,
}
impl DialogContent for AlertContent<'_> {
    fn poll(&mut self) -> Result<DialogUpdate> {
        (self.updates)()
    }
    fn content(&mut self, host: &AppWindow) -> Node {
        let mut nodes = vec![
            Node::text(
                "alert/message",
                self.message.clone(),
                host.look.types.style(Type::Body, Weight::Regular),
            )
            .lines(usize::MAX),
        ];
        if let Some(detail) = &self.detail {
            nodes.push(
                Node::text(
                    "alert/detail",
                    detail.clone(),
                    host.look.types.style(Type::Small, Weight::Regular),
                )
                .lines(usize::MAX),
            );
        }
        Node::column("alert/content", nodes).gap(crate::Space::S3)
    }
    fn activated(&mut self, _: Activated) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn button(id: &str, default: bool, cancel: bool, destructive: bool) -> DialogButton {
        DialogButton {
            id: id.into(),
            label: id.into(),
            default,
            cancel,
            destructive,
            enabled: true,
        }
    }
    #[test]
    fn natural_bounds_scroll_content_without_inventing_a_window_floor() {
        assert_eq!(
            fit_size((240., 90.), (200., 70.), (800., 600.)).unwrap(),
            (240., 90.)
        );
        assert_eq!(
            fit_size((1200., 1000.), (200., 70.), (800., 600.)).unwrap(),
            (800., 600.)
        );
        assert_eq!(
            fit_size((10., 10.), (200., 70.), (800., 600.)).unwrap(),
            (200., 70.)
        );
        assert!(fit_size((200., 90.), (200., 70.), (150., 600.)).is_err());
        assert!(fit_size((f64::NAN, 90.), (200., 70.), (800., 600.)).is_err());
    }
    #[test]
    fn responses_validate_and_order_cancel_before_default() {
        let mut d = Dialog {
            title: "Dialog".into(),
            close_label: "Close".into(),
            buttons: vec![
                button("ok", true, false, false),
                button("other", false, false, false),
                button("cancel", false, true, false),
            ],
        };
        d.validate().unwrap();
        assert_eq!(
            d.ordered()
                .iter()
                .map(|b| b.id.as_str())
                .collect::<Vec<_>>(),
            ["cancel", "other", "ok"]
        );
        assert_eq!(d.answer("ok"), Some(DialogAnswer::Button("ok".into())));
        assert_eq!(d.answer("cancel"), Some(DialogAnswer::Cancel));
        assert_eq!(d.answer("unknown"), None);
        d.buttons[0].destructive = true;
        assert!(d.validate().unwrap_err().contains("destructive"));
    }
    #[test]
    fn modal_namespace_never_reuses_ids_or_accepts_parent_requests() {
        let a = Namespace::new().unwrap();
        let b = Namespace::new().unwrap();
        assert_ne!(a.id(2).unwrap(), b.id(2).unwrap());
        assert!(a.request(Request::Activate(2)).is_none());
        assert!(b.request(Request::Activate(a.id(2).unwrap())).is_none());
        assert!(matches!(
            a.request(Request::Activate(a.id(2).unwrap())),
            Some(Request::Activate(2))
        ));
        assert!(a.id(u64::from(u32::MAX) + 1).is_err());
    }
    #[test]
    fn modal_projection_disables_parent_and_remaps_relations_and_selection() {
        let mut root = nk_a11y::Node::new(1, nk_a11y::Role::Window, "Parent");
        root.children.push(2);
        let mut opener = nk_a11y::Node::new(2, nk_a11y::Role::Button, "Open");
        opener.actions.push(nk_a11y::Action::Activate);
        opener.states.focused = true;
        let parent = Tree {
            root: 1,
            nodes: [(1, root), (2, opener)].into(),
        };
        let mut root = nk_a11y::Node::new(1, nk_a11y::Role::Dialog, "Dialog");
        root.children.push(2);
        root.active_descendant = Some(2);
        let mut item = nk_a11y::Node::new(2, nk_a11y::Role::Button, "Confirm");
        item.relations.push(Relation::LabelledBy(1));
        item.actions.push(nk_a11y::Action::Activate);
        let n = Namespace::new().unwrap();
        let tree = modal_tree(
            parent,
            n.tree(Tree {
                root: 1,
                nodes: [(1, root), (2, item)].into(),
            })
            .unwrap(),
        );
        tree.validate().unwrap();
        assert!(tree.nodes[&2].actions.is_empty());
        assert!(tree.nodes[&2].states.disabled);
        assert!(!tree.nodes[&2].states.focused);
        assert_eq!(
            tree.nodes[&n.id(1).unwrap()].active_descendant,
            Some(n.id(2).unwrap())
        );
        assert_eq!(
            tree.nodes[&n.id(2).unwrap()].relations,
            vec![Relation::LabelledBy(n.id(1).unwrap())]
        );
        assert!(!tree.nodes[&n.id(2).unwrap()].actions.is_empty());
    }
}
