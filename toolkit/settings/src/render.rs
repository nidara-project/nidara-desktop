// SPDX-License-Identifier: LGPL-3.0-or-later
//! The manifest is the page (PHASE1.md D2): one manifest page drawn into an `nk-widgets` tree,
//! following the data layer. The generic rows are drawn here; every named item — and every
//! `dropdown` row — by a [`Builder`] registered under its name (`CONTRACT.md` → "The native
//! Settings": the builder interface).
//!
//! What this file owns, so no builder has to:
//! - **Which rows exist.** A key the service lists `available: false` gets no row (as the
//!   legacy Settings: `getConfigEntry(key).available() === false` → no row); a key the
//!   snapshot does not list, a control kind or a name with no builder is an error, never a
//!   skipped row — gate 1's "remove one custom builder" control must fail here.
//! - **Visible and sensitive.** `visibleWhen` hides a row (it stays mounted: its builder hears
//!   `shown(false)`); a collapsed disclosure hides what follows it; `sensitiveWhen`, an
//!   unavailable service and a key the service cannot write disable a row. Recomputed after
//!   every notice and every flip.
//! - **What a row shows.** The value the session shows (`Session::shown`: asked and not yet
//!   answered, else in force); a write that failed shows the value in force again and says why
//!   in the row's second line until the next answer for that key.
//! - **Sliders.** One `Apply` per key in flight is the session's; here, `commitOnRelease` holds
//!   the value until the pointer lets go, and `debounce` (ms) waits that long after the last
//!   step — the last value always goes.

use crate::exports::Exports;
use crate::manifest::{Item, Page, Predicate};
use crate::session::{ApplyError, Notice, Session};
use crate::styles::Styles;
use crate::value::Value;
use nk_widgets::{ChoiceKind, Effect, Kind, NodeId, Tree, ValueRange};
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

pub type Result<T> = std::result::Result<T, String>;

/// What changes the settings: the client in the app, a fake in tests.
pub trait Editor {
    fn session(&self) -> &Session;
    fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError>;
    /// Drain/stage external changes during a modal call, without mutating its Tree.
    fn poll(&mut self) -> Vec<Notice> {
        Vec::new()
    }
    /// The one bus connection, for a builder's portal call (the file chooser); None in tests.
    fn connection(&self) -> Option<&zbus::blocking::Connection> {
        None
    }
}

impl Editor for crate::client::Client {
    fn session(&self) -> &Session {
        crate::client::Client::session(self)
    }
    fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError> {
        crate::client::Client::apply(self, key, value)
    }
    fn connection(&self) -> Option<&zbus::blocking::Connection> {
        Some(crate::client::Client::connection(self))
    }
    fn poll(&mut self) -> Vec<Notice> {
        crate::client::Client::poll(self)
    }
}

/// Stage real client notices before modal input/acceptance; apply external changes after return.
pub fn stage_modal_notices(
    editor: &mut dyn Editor,
    notices: &mut Vec<Notice>,
    external: &mut dyn FnMut() -> Result<bool>,
) -> Result<bool> {
    if !notices.is_empty() {
        return Ok(false);
    }
    notices.extend(editor.poll());
    if !notices.is_empty() {
        return Ok(false);
    }
    external()
}

/// Native hosting is lent to builders, separate from the data layer's Editor.
pub trait Modal {
    fn dropdown(
        &mut self,
        tree: &mut Tree,
        window: &mut nk_wayland::Window,
        styles: &Styles,
        editor: &mut dyn Editor,
        combo: NodeId,
    ) -> Result<Effect>;
    fn font(
        &mut self,
        tree: &mut Tree,
        window: Option<&mut nk_wayland::Window>,
        styles: &Styles,
        editor: &mut dyn Editor,
        request: crate::font_chooser::Request,
    ) -> Result<Option<crate::font_chooser::Selection>>;
}

/// What a builder works with, lent for one call.
pub struct Cx<'a> {
    pub tree: &'a mut Tree,
    pub exports: &'a Exports,
    pub styles: &'a Styles,
    /// Lent in `effect` and `idle` (to open a dialog over it), None in `build` and `notice`.
    pub window: Option<&'a mut nk_wayland::Window>,
    pub modal: Option<&'a mut (dyn Modal + 'static)>,
    editor: &'a mut dyn Editor,
    owner: usize,
    owners: &'a mut HashMap<NodeId, Owner>,
    mount: u64,
}

impl Cx<'_> {
    pub fn open_dropdown(&mut self, combo: NodeId) -> Result<Effect> {
        let modal = self
            .modal
            .as_deref_mut()
            .ok_or("dropdown needs a native modal context")?;
        let window = self
            .window
            .as_deref_mut()
            .ok_or("dropdown needs its parent window")?;
        modal.dropdown(self.tree, window, self.styles, self.editor, combo)
    }
    pub fn open_font(
        &mut self,
        request: crate::font_chooser::Request,
    ) -> Result<Option<crate::font_chooser::Selection>> {
        self.modal
            .as_deref_mut()
            .ok_or("font chooser needs a native modal context")?
            .font(
                self.tree,
                self.window.as_deref_mut(),
                self.styles,
                self.editor,
                request,
            )
    }
    pub fn session(&self) -> &Session {
        self.editor.session()
    }

    /// Change a key through the service — the only way a builder edits.
    pub fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError> {
        self.editor.apply(key, value)
    }

    pub fn connection(&self) -> Option<&zbus::blocking::Connection> {
        self.editor.connection()
    }

    /// This builder now owns `id`: its effects are routed to it. Whatever it creates after
    /// `build` too.
    pub fn own(&mut self, id: NodeId) {
        self.owners.insert(id, Owner::Builder(self.owner));
    }

    /// Removes `id` from the tree and from this builder's nodes.
    pub fn remove(&mut self, id: NodeId) -> Result<()> {
        self.owners.remove(&id);
        self.tree.remove(id)
    }

    /// One number per mounting of the page: an async result whose token is not the current
    /// one is dropped.
    pub fn mount(&self) -> u64 {
        self.mount
    }

    /// Focus `id` back (after a dialog), only if it is still there, shown and enabled.
    pub fn focus_if_shown(&mut self, id: NodeId) -> bool {
        if self.tree.node(id).is_none() || self.tree.is_hidden(id) {
            return false;
        }
        self.tree.focus(id).is_ok()
    }
}

/// A named item's drawer (`custom`, `decoration`, and the `dropdown` control).
pub trait Builder {
    /// Adds its nodes under `group` (owning them with `cx.own`) and says which node
    /// `visibleWhen` hides and which keys it shows.
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built>;
    /// A notice that names one of its keys (`Changed`, `Failed`), or `Ready`/`Unavailable`.
    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()>;
    /// An effect on one of its nodes.
    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()>;
    /// From the app's idle: timers, async results, dialogs.
    fn idle(&mut self, _cx: &mut Cx<'_>) -> Result<()> {
        Ok(())
    }
    /// Content visibility, combined with renderer predicates and availability.
    fn row_visible(&self, _row: NodeId) -> bool {
        true
    }
    /// Its row was hidden or shown (it stays mounted): cancel or resume visual work.
    fn shown(&mut self, _cx: &mut Cx<'_>, _visible: bool) -> Result<()> {
        Ok(())
    }
    /// The page is going away; it is not called again.
    fn unmount(&mut self, _cx: &mut Cx<'_>) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Built {
    /// The rows `visibleWhen`/`sensitiveWhen` and the disclosure act on (an item may draw
    /// more than one: the schedule's two times).
    pub rows: Vec<NodeId>,
    /// The keys it shows: the notices naming them reach it.
    pub keys: Vec<String>,
}

type Factory = Box<dyn FnMut() -> Box<dyn Builder>>;

/// Builders by the name the manifest gives them (`dropdown` draws every dropdown row): a
/// factory each, so every item gets a builder of its own, mounted with the page.
#[derive(Default)]
pub struct Builders(HashMap<String, Factory>);

impl Builders {
    pub fn register(&mut self, name: &str, factory: impl FnMut() -> Box<dyn Builder> + 'static) {
        self.0.insert(name.to_owned(), Box::new(factory));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Owner {
    Row(usize),
    Builder(usize),
    Disclosure(usize),
}

enum Control {
    Toggle(NodeId),
    /// A radio group: each choice's node and the value it stands for.
    Choices(Vec<(NodeId, Value)>),
    Slider {
        id: NodeId,
        /// The widget's numbers are the key's times this (100 for a percentage).
        factor: f32,
        commit_on_release: bool,
        debounce: Duration,
        /// A value stepped and not yet sent, and when it may go.
        held: Option<(f32, Instant)>,
    },
}

struct Row {
    key: String,
    row: NodeId,
    control: Control,
    /// The second line the schema gives, and the failure said in its place.
    subtitle: Option<String>,
    error: Option<String>,
    visible_when: Option<Predicate>,
    sensitive_when: Option<Predicate>,
    under: Vec<usize>,
}

struct Mounted {
    builder: Box<dyn Builder>,
    built: Built,
    visible_when: Option<Predicate>,
    sensitive_when: Option<Predicate>,
    under: Vec<usize>,
    shown: bool,
}

struct Disclosure {
    id: NodeId,
    under: Vec<usize>,
}

struct Footer {
    id: NodeId,
    when: Option<Predicate>,
}

/// One manifest page, drawn and kept in step with the session.
pub struct Rendered {
    rows: Vec<Row>,
    builders: Vec<Mounted>,
    disclosures: Vec<Disclosure>,
    footers: Vec<Footer>,
    owners: HashMap<NodeId, Owner>,
    mount: u64,
}

/// The tree, the data and the styles a page is drawn with, lent for one call.
pub struct Host<'a> {
    pub tree: &'a mut Tree,
    pub editor: &'a mut dyn Editor,
    pub exports: &'a Exports,
    pub styles: &'a Styles,
    pub window: Option<&'a mut nk_wayland::Window>,
    pub modal: Option<&'a mut (dyn Modal + 'static)>,
}

impl Rendered {
    /// Draws `page` under `content` (the scroll region). `mount` is this mounting's number.
    pub fn build(
        h: Host<'_>,
        page: &Page,
        builders: &mut Builders,
        content: NodeId,
        mount: u64,
    ) -> Result<Self> {
        let mut r = Self {
            rows: Vec::new(),
            builders: Vec::new(),
            disclosures: Vec::new(),
            footers: Vec::new(),
            owners: HashMap::new(),
            mount,
        };
        let Host {
            tree,
            editor,
            exports,
            styles,
            ..
        } = h;
        let before: BTreeSet<_> = tree
            .node(content)
            .ok_or("missing page content")?
            .children()
            .iter()
            .copied()
            .collect();
        let built = (|| -> Result<()> {
            if let Some(header) = &page.header {
                return Err(format!(
                    "page {}: a header builder ({header}) is not drawn by this build",
                    page.id
                ));
            }
            for g in &page.groups {
                if let Some(custom) = &g.custom {
                    return Err(format!(
                        "page {}: a custom group ({custom}) is not drawn by this build",
                        page.id
                    ));
                }
                let header = match &g.i18n {
                    Some(k) => exports.text(k)?.to_owned(),
                    None => String::new(),
                };
                let group = tree.group(content, &header)?;
                for item in &g.items {
                    r.item(tree, editor, exports, styles, builders, group, item, &[])?;
                }
                if let Some(footer) = &g.footer {
                    let id = tree
                        .set_footer(group, Some(exports.text(footer)?))?
                        .expect("a footer with text is a node");
                    r.footers.push(Footer {
                        id,
                        when: g.footer_when.clone(),
                    });
                }
            }
            r.refresh(tree, editor, exports, styles)?;
            Ok(())
        })();
        if let Err(error) = built {
            let cleanup = r.unmount(Host {
                tree,
                editor,
                exports,
                styles,
                window: None,
                modal: None,
            });
            let added: Vec<_> = tree
                .node(content)
                .into_iter()
                .flat_map(|n| n.children())
                .copied()
                .filter(|id| !before.contains(id))
                .collect();
            for id in added {
                tree.remove(id)?;
            }
            return Err(match cleanup {
                Ok(()) => error,
                Err(e) => format!("{error}; unmount: {e}"),
            });
        }
        Ok(r)
    }

    #[allow(clippy::too_many_arguments)]
    fn item(
        &mut self,
        tree: &mut Tree,
        editor: &mut dyn Editor,
        exports: &Exports,
        styles: &Styles,
        builders: &mut Builders,
        group: NodeId,
        item: &Item,
        under: &[usize],
    ) -> Result<()> {
        match item {
            Item::Key {
                key,
                visible_when,
                sensitive_when,
            } => {
                let entry = editor
                    .session()
                    .store()
                    .ok_or("a page drawn before the snapshot")?
                    .key(key)
                    .ok_or_else(|| format!("{key}: not in the snapshot"))?
                    .clone();
                if !entry.available {
                    return Ok(());
                }
                let ui = &entry.entry["ui"];
                let control = ui["control"].as_str().unwrap_or_default();
                if control == "dropdown" {
                    return self.builder(
                        tree, editor, exports, styles, builders, "dropdown", group, item, under,
                    );
                }
                let title = ui["title"]
                    .as_str()
                    .ok_or_else(|| format!("{key}: no title"))?
                    .to_owned();
                let shown = editor.session().shown(key).cloned();
                let (row, control) = match control {
                    "toggle" => {
                        let checked = shown.as_ref().and_then(Value::as_bool).unwrap_or(false);
                        let (row, switch) = tree.row(group, &title, Kind::Switch { checked })?;
                        (row, Control::Toggle(switch))
                    }
                    "segmented" | "preset" => {
                        let options = choice_options(key, &entry.entry, control)?;
                        let (row, choices) = choice_row(
                            tree,
                            group,
                            &title,
                            ChoiceKind::Segmented,
                            options,
                            shown.as_ref(),
                        )?;
                        let _ = styles;
                        (row, choices)
                    }
                    "slider" => {
                        let (range, factor, commit, debounce) = slider_range(key, &entry.entry)?;
                        let value = shown.as_ref().and_then(Value::as_number).unwrap_or(0.) as f32;
                        let (row, slider) = tree.slider(
                            group,
                            &title,
                            range,
                            (value * factor).clamp(f32::MIN, f32::MAX),
                        )?;
                        if let Some(icons) = ui["slider"]["icons"].as_array() {
                            let names: Vec<String> = icons
                                .iter()
                                .map(|i| {
                                    i.as_str()
                                        .map(|n| n.trim_end_matches("-symbolic").to_owned())
                                        .ok_or_else(|| format!("{key}: an icon that is no name"))
                                })
                                .collect::<Result<_>>()?;
                            let [a, b]: [String; 2] = names
                                .try_into()
                                .map_err(|_| format!("{key}: a slider has two icons"))?;
                            tree.set_slider_icons(slider, Some([a, b]))?;
                        }
                        (
                            row,
                            Control::Slider {
                                id: slider,
                                factor,
                                commit_on_release: commit,
                                debounce,
                                held: None,
                            },
                        )
                    }
                    other => {
                        return Err(format!(
                            "{key}: a control this build does not draw: {other:?}"
                        ));
                    }
                };
                let subtitle = ui["subtitle"].as_str().map(str::to_owned);
                tree.set_subtitle(row, subtitle.as_deref())?;
                let index = self.rows.len();
                self.owners.insert(row, Owner::Row(index));
                for id in control_nodes(&control) {
                    self.owners.insert(id, Owner::Row(index));
                }
                self.rows.push(Row {
                    key: key.clone(),
                    row,
                    control,
                    subtitle,
                    error: None,
                    visible_when: visible_when.clone(),
                    sensitive_when: sensitive_when.clone(),
                    under: under.to_vec(),
                });
                Ok(())
            }
            Item::Custom { name, .. } | Item::Decoration { name, .. } => self.builder(
                tree, editor, exports, styles, builders, name, group, item, under,
            ),
            Item::Disclosure { i18n, items } => {
                let id = tree.disclosure(group, exports.text(i18n)?, true)?;
                let index = self.disclosures.len();
                self.owners.insert(id, Owner::Disclosure(index));
                self.disclosures.push(Disclosure {
                    id,
                    under: under.to_vec(),
                });
                let mut inner = under.to_vec();
                inner.push(index);
                for it in items {
                    self.item(tree, editor, exports, styles, builders, group, it, &inner)?;
                }
                Ok(())
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn builder(
        &mut self,
        tree: &mut Tree,
        editor: &mut dyn Editor,
        exports: &Exports,
        styles: &Styles,
        builders: &mut Builders,
        name: &str,
        group: NodeId,
        item: &Item,
        under: &[usize],
    ) -> Result<()> {
        let mut builder = builders
            .0
            .get_mut(name)
            .ok_or_else(|| format!("no builder for {name}"))?();
        let owner = self.builders.len();
        let built = {
            let mut cx = Cx {
                tree,
                exports,
                styles,
                window: None,
                modal: None,
                editor,
                owner,
                owners: &mut self.owners,
                mount: self.mount,
            };
            match builder.build(&mut cx, group, item) {
                Ok(built) => built,
                Err(error) => {
                    return Err(match builder.unmount(&mut cx) {
                        Ok(()) => error,
                        Err(cleanup) => format!("{error}; unmount: {cleanup}"),
                    });
                }
            }
        };
        self.builders.push(Mounted {
            builder,
            built,
            visible_when: item.visible_when().cloned(),
            sensitive_when: item.sensitive_when().cloned(),
            under: under.to_vec(),
            shown: true,
        });
        Ok(())
    }

    /// The data layer's notices, after `client.poll()`.
    pub fn notices(&mut self, h: Host<'_>, notices: &[Notice]) -> Result<()> {
        let Host {
            tree,
            editor,
            exports,
            styles,
            ..
        } = h;
        let mut keys: BTreeSet<String> = BTreeSet::new();
        let mut all = false;
        for n in notices {
            match n {
                Notice::Ready | Notice::Unavailable => all = true,
                Notice::Changed(k) => keys.extend(k.iter().cloned()),
                Notice::Failed { key, error } => {
                    keys.insert(key.clone());
                    for row in self.rows.iter_mut().filter(|r| &r.key == key) {
                        row.error = Some(failure(error));
                    }
                }
                Notice::Error(_) => all = true,
            }
        }
        for row in &mut self.rows {
            if all || keys.contains(&row.key) {
                // An answer (or a fresh store) for this key clears what a failure said,
                // unless the same batch failed it again.
                let answered = all
                    || notices
                        .iter()
                        .any(|n| matches!(n, Notice::Changed(k) if k.contains(&row.key)));
                let failed = notices
                    .iter()
                    .any(|n| matches!(n, Notice::Failed { key, .. } if *key == row.key));
                if answered && !failed {
                    row.error = None;
                }
                show(tree, editor.session(), row)?;
            }
        }
        for (i, m) in self.builders.iter_mut().enumerate() {
            let mut cx = Cx {
                tree,
                exports,
                styles,
                window: None,
                modal: None,
                editor,
                owner: i,
                owners: &mut self.owners,
                mount: self.mount,
            };
            // A failed reply also carries Changed: show the canonical value first,
            // then retain its error until a later batch changes the key again.
            for n in notices
                .iter()
                .filter(|n| !matches!(n, Notice::Failed { .. }))
                .chain(
                    notices
                        .iter()
                        .filter(|n| matches!(n, Notice::Failed { .. })),
                )
            {
                let names = match n {
                    Notice::Changed(k) => k.iter().any(|k| m.built.keys.contains(k)),
                    Notice::Failed { key, .. } => m.built.keys.contains(key),
                    Notice::Ready | Notice::Unavailable => true,
                    Notice::Error(_) => false,
                };
                if names {
                    m.builder.notice(&mut cx, n)?;
                }
            }
        }
        self.refresh(tree, editor, exports, styles)
    }

    /// A tree effect (from a click, a key or AT-SPI). Whether it was this page's.
    pub fn effect(&mut self, h: Host<'_>, effect: Effect) -> Result<bool> {
        let id = match effect {
            Effect::Activated(id) | Effect::Changed(id) => id,
            Effect::Focused(_) | Effect::None => return Ok(false),
        };
        let Host {
            tree,
            editor,
            exports,
            styles,
            window,
            modal,
        } = h;
        match self.owners.get(&id).copied() {
            Some(Owner::Row(i)) => {
                let row = &mut self.rows[i];
                match &mut row.control {
                    Control::Toggle(switch) if *switch == id => {
                        let checked = matches!(
                            tree.node(id).map(|n| n.kind()),
                            Some(Kind::Switch { checked: true })
                        );
                        send(editor, tree, row, Value::Bool(checked))?;
                    }
                    Control::Choices(options) => {
                        if let Some((_, value)) = options.iter().find(|(c, _)| *c == id) {
                            let value = value.clone();
                            send(editor, tree, row, value)?;
                        }
                    }
                    Control::Slider {
                        id: slider,
                        factor,
                        commit_on_release,
                        debounce,
                        held,
                    } if *slider == id => {
                        let v = tree.value(id).ok_or("a slider without its value")?;
                        let dragging = tree.captured() == Some(id);
                        if (*commit_on_release && dragging) || !debounce.is_zero() {
                            *held = Some((v, Instant::now() + *debounce));
                        } else {
                            let value = Value::Number((v / *factor) as f64);
                            send(editor, tree, row, value)?;
                        }
                    }
                    _ => {}
                }
            }
            Some(Owner::Disclosure(_)) => {}
            Some(Owner::Builder(i)) => {
                let mut cx = Cx {
                    tree,
                    exports,
                    styles,
                    window,
                    modal,
                    editor,
                    owner: i,
                    owners: &mut self.owners,
                    mount: self.mount,
                };
                self.builders[i].builder.effect(&mut cx, effect)?;
            }
            None => return Ok(false),
        }
        self.refresh(tree, editor, exports, styles)?;
        Ok(true)
    }

    /// From the app's idle: a held slider value goes (its drag ended, its debounce passed),
    /// and every builder's own idle.
    pub fn idle(&mut self, h: Host<'_>) -> Result<()> {
        let Host {
            tree,
            editor,
            exports,
            styles,
            mut window,
            mut modal,
        } = h;
        let now = Instant::now();
        for row in &mut self.rows {
            let Control::Slider {
                id,
                factor,
                commit_on_release,
                held,
                ..
            } = &mut row.control
            else {
                continue;
            };
            let Some((v, at)) = *held else { continue };
            let released = !*commit_on_release || tree.captured() != Some(*id);
            if released && now >= at {
                *held = None;
                let value = Value::Number((v / *factor) as f64);
                send(editor, tree, row, value)?;
            }
        }
        for (i, m) in self.builders.iter_mut().enumerate() {
            let mut cx = Cx {
                tree,
                exports,
                styles,
                window: window.as_deref_mut(),
                modal: modal
                    .as_mut()
                    .map(|m| &mut **m as &mut (dyn Modal + 'static)),
                editor,
                owner: i,
                owners: &mut self.owners,
                mount: self.mount,
            };
            m.builder.idle(&mut cx)?;
        }
        self.refresh(tree, editor, exports, styles)
    }

    /// The page goes away: every builder's `unmount`; the caller removes the nodes.
    pub fn unmount(mut self, h: Host<'_>) -> Result<()> {
        let Host {
            tree,
            editor,
            exports,
            styles,
            ..
        } = h;
        let mut failure = None;
        for (i, mut m) in std::mem::take(&mut self.builders).into_iter().enumerate() {
            let mut cx = Cx {
                tree,
                exports,
                styles,
                window: None,
                modal: None,
                editor,
                owner: i,
                owners: &mut self.owners,
                mount: self.mount,
            };
            if let Err(error) = m.builder.unmount(&mut cx) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Visible and sensitive, for every row, builder row, disclosure and footer.
    fn refresh(
        &mut self,
        tree: &mut Tree,
        editor: &mut dyn Editor,
        exports: &Exports,
        styles: &Styles,
    ) -> Result<()> {
        let open: Vec<bool> = self
            .disclosures
            .iter()
            .map(|d| tree.expanded(d.id).unwrap_or(true))
            .collect();
        let inside = |under: &[usize]| under.iter().all(|i| open[*i]);
        let session = editor.session();
        let live = session.available();
        let holds = |p: &Option<Predicate>| p.as_ref().is_none_or(|p| p.holds(session));
        for d in &self.disclosures {
            tree.set_hidden(d.id, !inside(&d.under))?;
        }
        for f in &self.footers {
            tree.set_hidden(f.id, !holds(&f.when))?;
        }
        for row in &self.rows {
            let writable = session
                .store()
                .and_then(|s| s.key(&row.key))
                .is_some_and(|k| k.available && k.writable());
            let available = session
                .store()
                .and_then(|s| s.key(&row.key))
                .is_some_and(|k| k.available);
            tree.set_hidden(
                row.row,
                !(available && inside(&row.under) && holds(&row.visible_when)),
            )?;
            let sensitive = live && writable && holds(&row.sensitive_when);
            for id in control_nodes(&row.control) {
                tree.set_disabled(id, !sensitive)?;
            }
        }
        let mut transitions = Vec::new();
        for (i, m) in self.builders.iter_mut().enumerate() {
            let available = m.built.keys.iter().all(|key| {
                session
                    .store()
                    .and_then(|s| s.key(key))
                    .is_some_and(|k| k.available)
            });
            let writable = m.built.keys.iter().all(|key| {
                session
                    .store()
                    .and_then(|s| s.key(key))
                    .is_some_and(|k| k.writable())
            });
            let visible = available && inside(&m.under) && holds(&m.visible_when);
            for row in &m.built.rows {
                tree.set_hidden(*row, !(visible && m.builder.row_visible(*row)))?;
                tree.set_disabled(*row, !(live && writable && holds(&m.sensitive_when)))?;
            }
            if visible != m.shown {
                m.shown = visible;
                transitions.push((i, visible));
            }
        }
        for (i, visible) in transitions {
            let mut cx = Cx {
                tree,
                exports,
                styles,
                window: None,
                modal: None,
                editor,
                owner: i,
                owners: &mut self.owners,
                mount: self.mount,
            };
            self.builders[i].builder.shown(&mut cx, visible)?;
        }
        Ok(())
    }
}

fn control_nodes(c: &Control) -> Vec<NodeId> {
    match c {
        Control::Toggle(id) | Control::Slider { id, .. } => vec![*id],
        Control::Choices(options) => options.iter().map(|(id, _)| *id).collect(),
    }
}

/// Sends a row's value; a refusal before sending is said like a failed answer.
fn send(editor: &mut dyn Editor, tree: &mut Tree, row: &mut Row, value: Value) -> Result<()> {
    if let Err(e) = editor.apply(&row.key, value) {
        row.error = Some(failure(&e));
        show(tree, editor.session(), row)?;
    }
    Ok(())
}

/// What a row says when its write did not land.
pub(crate) fn failure(error: &ApplyError) -> String {
    match error {
        ApplyError::Invalid(m) | ApplyError::Denied(m) | ApplyError::Failed(m) => m.clone(),
        ApplyError::NoReply => "No answer from the settings service".into(),
        ApplyError::Unavailable => "The settings service is not available".into(),
    }
}

/// The control shows what the session shows; the second line, the failure if there is one.
fn show(tree: &mut Tree, session: &Session, row: &Row) -> Result<()> {
    let shown = session.shown(&row.key);
    match &row.control {
        Control::Toggle(id) => {
            if let Some(b) = shown.and_then(Value::as_bool) {
                tree.set_checked(*id, b)?;
            }
        }
        Control::Choices(options) => {
            if let Some((id, _)) = options.iter().find(|(_, v)| Some(v) == shown) {
                tree.set_choice(*id)?;
            }
        }
        Control::Slider {
            id, factor, held, ..
        } => {
            // A value held for its drag or debounce is the one the thumb is at: leave it.
            if held.is_none()
                && let Some(n) = shown.and_then(Value::as_number)
            {
                tree.set_value(*id, n as f32 * factor)?;
            }
        }
    }
    tree.set_subtitle(row.row, row.error.as_deref().or(row.subtitle.as_deref()))?;
    Ok(())
}

/// A radio group's options: the schema's `ui.options` (segmented) or `ui.presets` (preset).
fn choice_options(
    key: &str,
    entry: &serde_json::Value,
    control: &str,
) -> Result<Vec<(String, Value)>> {
    let ui = &entry["ui"];
    if control == "preset" {
        let unit = ui["presetUnit"].as_str().unwrap_or_default();
        return ui["presets"]
            .as_array()
            .ok_or_else(|| format!("{key}: a preset row without presets"))?
            .iter()
            .map(|p| {
                let v = Value::from_json(p).ok_or_else(|| format!("{key}: a preset of no kind"))?;
                Ok((format!("{}{unit}", v.predicate_text()), v))
            })
            .collect();
    }
    ui["options"]
        .as_array()
        .ok_or_else(|| format!("{key}: a segmented row without options"))?
        .iter()
        .map(|o| {
            let value = o["value"]
                .as_str()
                .ok_or_else(|| format!("{key}: an option without its value"))?;
            let label = o["label"].as_str().unwrap_or(value);
            Ok((label.to_owned(), Value::Text(value.to_owned())))
        })
        .collect()
}

/// A row of choices. A current value none of the options is shown as it is, as one more
/// choice labelled with the value itself (D2: "an unknown current enum value is shown").
fn choice_row(
    tree: &mut Tree,
    group: NodeId,
    title: &str,
    kind: ChoiceKind,
    mut options: Vec<(String, Value)>,
    shown: Option<&Value>,
) -> Result<(NodeId, Control)> {
    let selected = match shown {
        Some(v) => match options.iter().position(|(_, o)| o == v) {
            Some(i) => i,
            None => {
                options.push((v.predicate_text(), v.clone()));
                options.len() - 1
            }
        },
        None => 0,
    };
    let labels: Vec<&str> = options.iter().map(|(l, _)| l.as_str()).collect();
    let (row, _, ids) = tree.choices(group, title, kind, &labels, selected)?;
    Ok((
        row,
        Control::Choices(
            ids.into_iter()
                .zip(options.into_iter().map(|(_, v)| v))
                .collect(),
        ),
    ))
}

/// A slider's range from the schema: `min`/`max`, and `ui.slider`'s unit, pct, decimals,
/// step, commitOnRelease and debounce — with the legacy row's defaults where it has them
/// (`NidaraSliderRow`: whole numbers unless decimals or pct; a debounce of 32 ms).
fn slider_range(key: &str, entry: &serde_json::Value) -> Result<(ValueRange, f32, bool, Duration)> {
    let s = &entry["ui"]["slider"];
    let num = |v: &serde_json::Value, what: &str| {
        v.as_f64()
            .map(|n| n as f32)
            .ok_or_else(|| format!("{key}: no {what}"))
    };
    let pct = s["pct"].as_bool().unwrap_or(false);
    let factor = if pct { 100. } else { 1. };
    let decimals = s["decimals"].as_u64().map(|d| d as usize);
    let step = match s["step"].as_f64() {
        Some(step) => step as f32 * factor,
        None => match decimals {
            Some(d) if !pct => 10f32.powi(-(d as i32)),
            _ => 1.,
        },
    };
    let range = ValueRange {
        min: num(&entry["min"], "min")? * factor,
        max: num(&entry["max"], "max")? * factor,
        step,
        wrap: false,
        digits: 0,
        decimals: if pct { 0 } else { decimals.unwrap_or(0) },
        unit: if pct {
            "%".into()
        } else {
            s["unit"].as_str().unwrap_or_default().to_owned()
        },
    };
    let debounce = Duration::from_millis(s["debounce"].as_u64().unwrap_or(32));
    Ok((
        range,
        factor,
        s["commitOnRelease"].as_bool().unwrap_or(false),
        debounce,
    ))
}
