// SPDX-License-Identifier: LGPL-3.0-or-later
//! Production composition; CPU tests exercise View without fabricating a Window/provider.
use nk_a11y::{Request, bridge::Bridge};
use nk_settings::{
    Value,
    client::Client,
    dropdown::Native,
    exports::Exports,
    font_chooser,
    image_load::Budget,
    material::{
        control::{ControlRecipe, capsule_metrics},
        panel::PanelMaterial,
    },
    page::Mounted,
    portal::{Appearance, Portal},
    render::{Builders, Editor, Host},
    routing::{self, Incoming, Route, Router},
    search::{self, Match, Results},
    session::Notice,
    styles::Styles,
    window::{Action, Labels, Look, Shell},
};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{
    Application, ControlsSide, Event, Frame, Material, Options, Window, WindowBackground,
};
use nk_widgets::{Command, Effect, Kind, NodeId, PopupSnapshot, Result, Tree, ValueRange};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
    time::Instant,
};

const IMAGE_BUDGET: Budget = Budget {
    encoded_bytes: 64 * 1024 * 1024,
    decoded_bytes: 256 * 1024 * 1024,
};

struct View {
    exports: Exports,
    styles: Styles,
    appearance: Appearance,
    shell: Shell,
    page: Option<Mounted>,
    builders: Builders,
    fonts: Arc<FontSet>,
    mount: u64,
    status: NodeId,
    status_root: NodeId,
    suggestions: nk_widgets::suggestions::Suggestions,
    search_query: String,
    search_stamp: Option<(u64, u64)>,
    search_matches: Vec<Match>,
    results: Option<Results>,
    results_cache: Option<(String, Vec<Match>)>,
}
impl View {
    fn new(exports: Exports, appearance: Appearance) -> Result<Self> {
        let styles = Styles::new(&exports, &appearance)?;
        let fonts = Arc::new(FontSet::discover_required()?);
        let metrics = capsule_metrics(
            &exports.components,
            appearance.dark,
            appearance.reduce_transparency,
        )?;
        let mut shell = Shell::build(
            &exports,
            &styles,
            Labels {
                application: exports.text("settings.native.application")?,
                sidebar: exports.text("settings.native.pages")?,
                sidebar_button: exports.text("settings.window.sidebar-toggle")?,
                content: exports.text("settings.native.content")?,
                controls: exports.text("settings.native.controls")?,
                minimize: exports.text("settings.native.minimize")?,
                maximize: exports.text("settings.native.maximize")?,
                close: exports.text("settings.window.close")?,
            },
            metrics,
            "appearance",
            fonts.clone(),
        )?;
        let suggestions = nk_widgets::suggestions::Suggestions::new(
            &mut shell.tree,
            shell.search,
            exports.text("settings.search.results")?,
            styles.menu.clone(),
        )?;
        let status_root = shell.tree.group(shell.content, "")?;
        let status_row = shell.tree.append(status_root, Kind::Row, "")?;
        let status = shell.tree.append(
            status_row,
            Kind::Label,
            exports.text("settings.native.loading")?,
        )?;
        let mut builders = Builders::default();
        nk_settings::builders::register(&mut builders);
        nk_settings::dropdown_builder::register(&mut builders);
        nk_settings::font_builder::register(&mut builders);
        nk_settings::wallpaper::register(&mut builders, IMAGE_BUDGET);
        nk_settings::wallpaper_picker::register(&mut builders);
        Ok(Self {
            exports,
            styles,
            appearance,
            shell,
            page: None,
            builders,
            fonts,
            mount: 0,
            status,
            status_root,
            suggestions,
            search_query: String::new(),
            search_stamp: None,
            search_matches: vec![],
            results: None,
            results_cache: None,
        })
    }
    fn status(&mut self, text: &str) -> Result<()> {
        self.shell.tree.set_name(self.status, text)?;
        self.shell
            .tree
            .set_hidden(self.status_root, text.is_empty())
    }
    fn mount(&mut self, editor: &mut dyn Editor) -> Result<()> {
        if let Some(results) = self.results.take() {
            self.shell.tree.remove(results.root)?;
        }
        self.shell
            .tree
            .scroll_to(self.shell.content, nk_text::Point::default())?;
        let next = self
            .mount
            .checked_add(1)
            .ok_or("page mount token exhausted")?;
        let page = self
            .exports
            .page("appearance")
            .ok_or("Appearance manifest missing")?;
        let replacement = Mounted::build(
            Host {
                tree: &mut self.shell.tree,
                editor,
                exports: &self.exports,
                styles: &self.styles,
                window: None,
                modal: None,
            },
            page,
            &mut self.builders,
            self.shell.content,
            next,
        )?;
        let old = self.page.replace(replacement);
        self.mount = next;
        if let Some(old) = old {
            old.unmount(Host {
                tree: &mut self.shell.tree,
                editor,
                exports: &self.exports,
                styles: &self.styles,
                window: None,
                modal: None,
            })?;
        }
        self.shell.selected(&self.exports, "appearance")?;
        self.status("")
    }
    fn notices(&mut self, editor: &mut dyn Editor, notices: &[Notice]) -> Result<()> {
        if notices.contains(&Notice::Ready)
            && editor.session().available()
            && self.results.is_none()
        {
            // A new snapshot can add formerly unavailable rows. Build transactionally first.
            self.mount(editor)?;
        }
        if let Some(page) = &mut self.page {
            page.renderer().notices(
                Host {
                    tree: &mut self.shell.tree,
                    editor,
                    exports: &self.exports,
                    styles: &self.styles,
                    window: None,
                    modal: None,
                },
                notices,
            )?;
        }
        if let Some(Notice::Error(error)) =
            notices.iter().rev().find(|n| matches!(n, Notice::Error(_)))
        {
            self.status(&error.clone())?;
        } else if notices.contains(&Notice::Unavailable) {
            let message = self.exports.text("settings.native.unavailable")?.to_owned();
            self.status(&message)?;
        }
        Ok(())
    }
    fn restyle(&mut self, appearance: Appearance) -> Result<()> {
        let styles = Styles::new(&self.exports, &appearance)?;
        let metrics = capsule_metrics(
            &self.exports.components,
            appearance.dark,
            appearance.reduce_transparency,
        )?;
        styles.apply(&mut self.shell.tree)?;
        self.shell
            .tree
            .set_capsule_metrics(self.shell.controls, metrics)?;
        self.shell.restyle(&styles)?;
        self.shell.composition.invalidate_panes();
        self.shell.capsules.invalidate();
        self.suggestions
            .restyle(&self.shell.tree, styles.menu.clone())?;
        self.search_stamp = None;
        self.styles = styles;
        self.appearance = appearance;
        Ok(())
    }
    fn show_results(&mut self, editor: &mut dyn Editor, cached: bool) -> Result<()> {
        self.suggestions.dismiss(&mut self.shell.tree)?;
        let (query, matches) = if cached {
            self.results_cache.clone().ok_or("no cached results page")?
        } else {
            (self.search_query.clone(), self.search_matches.clone())
        };
        if let Some(page) = self.page.take() {
            page.unmount(Host {
                tree: &mut self.shell.tree,
                editor,
                exports: &self.exports,
                styles: &self.styles,
                window: None,
                modal: None,
            })?;
        }
        if let Some(results) = self.results.take() {
            self.shell.tree.remove(results.root)?;
        }
        self.results = Some(Results::build(
            &mut self.shell.tree,
            self.shell.content,
            &self.exports,
            &query,
            &matches,
        )?);
        self.results_cache = Some((query, matches));
        self.shell
            .selected_results(self.exports.text("settings.search.results")?)?;
        self.shell
            .tree
            .scroll_to(self.shell.content, nk_text::Point::default())?;
        self.status("")
    }
    fn update_search(
        &mut self,
        store: Option<&nk_settings::session::Store>,
        text: &mut ParleyBackend,
    ) -> Result<()> {
        let query = self.shell.tree.search_text(self.shell.search)?.to_owned();
        let stamp = store.map(|s| (s.epoch, s.revision));
        if query != self.search_query || stamp != self.search_stamp {
            self.search_matches = search::find(&self.exports, store, &query)?;
            self.search_query = query;
            self.search_stamp = stamp;
            let values = if self.search_query.trim().is_empty() {
                vec![]
            } else {
                search::suggestions(&self.search_matches, &self.exports)?
            };
            self.suggestions
                .set_values(&mut self.shell.tree, values, text)?;
        }
        Ok(())
    }
    fn invalidate_external(&mut self, editor: &mut dyn Editor) -> Result<()> {
        if self.external_modal() && editor.session().available() {
            self.mount(editor)?;
        }
        Ok(())
    }
    fn external_modal(&mut self) -> bool {
        self.page
            .as_mut()
            .is_some_and(|p| p.renderer().external_modal_active())
    }
}

struct External {
    portal: Portal,
    router: Router,
    portal_changed: bool,
    incoming: Vec<Incoming>,
}
impl External {
    fn stage(&mut self) {
        self.portal_changed |= self.portal.changed();
        self.incoming.extend(self.router.poll());
    }
}
struct Materials {
    panel: PanelMaterial,
    control: ControlRecipe,
    opaque: ControlRecipe,
}
impl Materials {
    fn load(view: &View) -> Result<Self> {
        let a = &view.appearance;
        Ok(Self {
            panel: PanelMaterial::load(view.exports.glass.clone(), a.dark, a.reduce_transparency)?,
            control: ControlRecipe::load(&view.exports.glass, a.dark, a.reduce_transparency)?,
            opaque: ControlRecipe::load(&view.exports.glass, a.dark, true)?,
        })
    }
}
struct App {
    opaque_preview: bool,
    materials: Materials,
    view: View,
    client: Client,
    external: Rc<RefCell<External>>,
    native: Option<Native>,
    text: ParleyBackend,
    fonts: Arc<FontSet>,
    theme: Rc<RefCell<String>>,
    reference: PathBuf,
    icon_theme: Option<String>,
    publication: Option<(u64, u64, bool)>,
    active: bool,
    ready: bool,
    forwarding: Option<mpsc::Receiver<Result<String>>>,
    configured: bool,
    startup_activation: Option<String>,
    activations: Vec<Incoming>,
}
/// The reference theme's own name (`ui/shell/assets/icons/nidara`).
const REFERENCE_THEME: &str = "nidara";
fn icons(theme: &str, reference: &std::path::Path) -> Result<nk_icons::Icons> {
    nk_icons::Icons::new(theme, &nk_icons::search_path(), reference)
}
fn text_key(editor: &dyn Editor, key: &str) -> Result<String> {
    match editor.session().store().and_then(|s| s.value(key)) {
        Some(Value::Text(value)) => Ok(value.clone()),
        _ => Err(format!("Config1 has no string {key}")),
    }
}
fn open_size(exports: &Exports) -> Result<(u32, u32)> {
    let layout = &exports.statics["ts"]["WINDOW_LAYOUT"];
    let number = |key: &str| -> Result<f64> {
        let v = layout[key]
            .as_f64()
            .ok_or_else(|| format!("WINDOW_LAYOUT {key} missing"))?;
        if v.is_finite() && v > 0. {
            Ok(v)
        } else {
            Err(format!("invalid WINDOW_LAYOUT {key}"))
        }
    };
    let width = number("sidebar")? + number("content")? + number("openGutter")?;
    let height = number("minHeight")?;
    if width > u32::MAX as f64 || height > u32::MAX as f64 {
        return Err("window size overflow".into());
    }
    Ok((width.ceil() as u32, height.ceil() as u32))
}
fn font_configuration(
    view: &View,
    fonts: Arc<FontSet>,
    theme: Rc<RefCell<String>>,
    reference: PathBuf,
) -> Result<font_chooser::Configuration> {
    let label = |key: &str| {
        view.exports
            .text(&format!("settings.native.{key}"))
            .map(str::to_owned)
    };
    let size = open_size(&view.exports)?;
    Ok(font_chooser::Configuration {
        fonts,
        labels: font_chooser::DialogLabels {
            search: label("font.search")?,
            placeholder: label("font.placeholder")?,
            families: label("font.families")?,
            styles: label("font.styles")?,
            unnamed: label("font.unnamed")?,
            unsupported_style: label("font.unsupported")?,
            preview: label("font.preview")?,
            point_size: label("font.points")?,
            loading: label("font.loading")?,
            cancel: label("cancel")?,
            select: label("select")?,
        },
        size,
        // Two independently scrolling lists share the form's available vertical space.
        list_height: (size.1 as f32
            - view.styles.metrics.titlebar
            - 2. * view.styles.metrics.padding)
            / 4.,
        point_range: ValueRange {
            min: 1. / 1024.,
            max: (i32::MAX - 127) as f32 / 1024.,
            step: 1. / 1024.,
            wrap: false,
            digits: 0,
            decimals: 3,
            unit: String::new(),
        },
        prepare: Box::new(move |tree| {
            tree.set_icon_theme(icons(&theme.borrow(), &reference)?);
            Ok(())
        }),
    })
}
fn project(tree: &Tree, blocked: bool) -> nk_a11y::Tree {
    let mut snapshot = tree.semantics();
    if blocked {
        for node in snapshot.nodes.values_mut() {
            node.actions.clear();
            node.states.focused = false;
            node.states.active = false;
        }
    }
    snapshot
}
fn request(
    tree: &mut Tree,
    publication: Option<(u64, u64, bool)>,
    revision: u64,
    action: Request,
    blocked: bool,
) -> Result<Effect> {
    if blocked || publication != Some((revision, tree.generation(), false)) {
        return Err("stale or suspended parent action".into());
    }
    match action {
        Request::Focus(id) => tree.dispatch(tree.target(id), Command::Focus),
        Request::Activate(id) => tree.dispatch(tree.target(id), Command::Activate),
        Request::SetValue(id, value) => tree.request_value(tree.target(id), value as f32),
        action @ (Request::SetText(..) | Request::SetSelection(..)) => {
            let id = match &action {
                Request::SetText(id, _) | Request::SetSelection(id, _) => *id,
                _ => unreachable!(),
            };
            tree.search_request(tree.target(id), action)
        }
    }
}
/// `queryUI` to the legacy Settings, only if it already runs: a query never starts it.
fn query_legacy(connection: &zbus::blocking::Connection, args: Vec<String>) -> Result<String> {
    connection
        .call_method(
            Some(routing::LEGACY),
            routing::PATH,
            Some(routing::ENTRY),
            "Request",
            &(args,),
        )
        .map_err(|e| format!("legacy Settings: {e}"))?
        .body()
        .deserialize()
        .map_err(|e| e.to_string())
}
fn forward(connection: &zbus::blocking::Connection, args: Vec<String>) -> Result<String> {
    connection
        .call_method(
            Some(routing::ENTRY),
            routing::PATH,
            Some(routing::ENTRY),
            "Request",
            &(args,),
        )
        .map_err(|e| format!("Settings entry point: {e}"))?
        .body()
        .deserialize()
        .map_err(|e| e.to_string())
}
impl App {
    fn dependencies(&mut self) -> Result<()> {
        if self.client.session().available() {
            let theme = text_key(&self.client, "appearance.interfaceIconTheme")?;
            if self.icon_theme.as_ref() != Some(&theme) {
                self.view
                    .shell
                    .tree
                    .set_icon_theme(icons(&theme, &self.reference)?);
                *self.theme.borrow_mut() = theme.clone();
                self.icon_theme = Some(theme);
            }
        }
        Ok(())
    }
    fn stage(&mut self) -> Result<()> {
        let changed = {
            let mut ext = self.external.borrow_mut();
            ext.stage();
            if ext.portal_changed {
                ext.portal_changed = false;
                Some(ext.portal.read()?)
            } else {
                None
            }
        };
        if let Some(appearance) = changed {
            self.view.invalidate_external(&mut self.client)?;
            self.view.restyle(appearance)?;
            self.materials = Materials::load(&self.view)?;
            if let Some(native) = &mut self.native {
                native.panel = Some(PanelMaterial::load(
                    self.view.exports.glass.clone(),
                    self.view.appearance.dark,
                    self.view.appearance.reduce_transparency,
                )?);
            }
        }
        let mut notices = self
            .native
            .as_mut()
            .map(|n| std::mem::take(&mut n.notices))
            .unwrap_or_default();
        notices.extend(self.client.poll());
        self.view.notices(&mut self.client, &notices)?;
        self.dependencies()?;
        let incoming = std::mem::take(&mut self.external.borrow_mut().incoming);
        if !incoming.is_empty() {
            self.view.invalidate_external(&mut self.client)?;
        }
        for message in incoming {
            if message.activation.is_some()
                && matches!(&message.route, Route::Raise | Route::Navigate(_))
            {
                if let Route::Navigate(page) = &message.route {
                    self.navigate(page.clone())?;
                }
                self.activations.push(message);
                continue;
            }
            if let Route::Query(id) = &message.route {
                // The legacy window answers for the pages it draws; the native tree's own
                // serialization is not integrated yet, so with no legacy window there is none.
                let args: Vec<String> = std::iter::once("queryUI".to_string())
                    .chain(id.clone())
                    .collect();
                let connection = self.client.connection().clone();
                std::thread::Builder::new()
                    .name("settings-query".into())
                    .spawn(move || {
                        let answer = query_legacy(&connection, args).unwrap_or_else(|e| {
                            format!("unsupported: native queryUI is not integrated ({e})")
                        });
                        message.respond(answer);
                    })
                    .map_err(|e| e.to_string())?;
                continue;
            }
            // The legacy contract: "ok" once the page is shown. Without an activation token
            // the compositor may keep the window where it is, as the legacy one could.
            let answer: String = match &message.route {
                Route::Raise => "ok".into(),
                Route::Navigate(page) if page == "appearance" => {
                    self.navigate(page.clone())?;
                    "ok".into()
                }
                _ => "unsupported native route".into(),
            };
            message.respond(answer);
        }
        if let Some(receiver) = &self.forwarding {
            match receiver.try_recv() {
                Ok(answer) => {
                    self.forwarding = None;
                    if let Err(error) = answer {
                        self.view.status(&error)?;
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.forwarding = None;
                    self.view.status("Settings entry-point worker exited")?;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        Ok(())
    }
    fn sync(&mut self, window: &mut Window) -> Result<()> {
        // Initial empty commit is1. The next app loop follows a real painted root.
        if window.commits() > 1 {
            if let Some(token) = self.startup_activation.take()
                && window.activate(token)? == nk_wayland::Activation::Unsupported
            {
                eprintln!("ACTIVATION_UNSUPPORTED");
            }
            for mut incoming in std::mem::take(&mut self.activations) {
                let token = incoming
                    .activation
                    .take()
                    .ok_or("activation metadata disappeared")?;
                let answer = match window.activate(token) {
                    Ok(nk_wayland::Activation::Requested) => "activation requested".to_owned(),
                    Ok(nk_wayland::Activation::Unsupported) => {
                        "activation protocol unavailable".to_owned()
                    }
                    Err(error) => error,
                };
                incoming.respond(answer);
            }
        }
        let (dark, reduce, reduced_motion) = (
            self.view.appearance.dark,
            self.view.appearance.reduce_transparency,
            self.view.appearance.reduced_motion,
        );

        let side = if self
            .client
            .session()
            .store()
            .and_then(|s| s.value("appearance.windowControls"))
            == Some(&Value::Text("left".into()))
        {
            ControlsSide::Left
        } else {
            ControlsSide::Right
        };
        self.view.shell.sync(
            window,
            &mut self.text,
            Look {
                styles: &self.view.styles,
                panel: &self.materials.panel,
                control: &self.materials.control,
                opaque_control: &self.materials.opaque,
                reduced_motion,
                controls_side: side,
                layers_allowed: window.capabilities().material && window.capabilities().layers,
            },
        )?;
        self.view
            .shell
            .composition
            .sync_search_input(&self.view.shell.tree, window)?;
        let blocked = self.view.external_modal();
        self.view
            .update_search(self.client.session().store(), &mut self.text)?;
        if blocked {
            self.view
                .suggestions
                .close(&mut self.view.shell.tree, window)?;
        } else {
            self.view.suggestions.sync(
                &mut self.view.shell.tree,
                window,
                &mut self.text,
                self.view.styles.palette,
                |side| {
                    if self.opaque_preview {
                        Ok(None)
                    } else {
                        self.materials.panel.at(side).map(Some)
                    }
                },
            )?;
        }
        if self.publication.is_none_or(|(_, generation, old)| {
            generation != self.view.shell.tree.generation() || old != blocked
        }) || self.view.shell.tree.invalidation().semantics
        {
            let snapshot = PopupSnapshot::new(project(&self.view.shell.tree, blocked))?;
            if let Some(native) = &mut self.native {
                native.bridge.update(snapshot.revision, snapshot.tree)?;
                native.revision = snapshot.revision;
            } else {
                let staged = self.external.clone();
                self.native = Some(Native {
                    font: Some(font_configuration(
                        &self.view,
                        self.fonts.clone(),
                        self.theme.clone(),
                        self.reference.clone(),
                    )?),
                    bridge: Bridge::new(snapshot.revision, snapshot.tree),
                    revision: snapshot.revision,
                    text: ParleyBackend::with_system_fonts(self.fonts.clone())?,
                    panel: Some(PanelMaterial::load(
                        self.view.exports.glass.clone(),
                        dark,
                        reduce,
                    )?),
                    serial: None,
                    poll_interval_ms: 16,
                    notices: Vec::new(),
                    keep_open: Box::new(move || {
                        let mut ext = staged.borrow_mut();
                        ext.stage();
                        Ok(!ext.portal_changed && ext.incoming.is_empty())
                    }),
                });
            }
            self.publication = Some((
                self.native.as_ref().unwrap().revision,
                self.view.shell.tree.generation(),
                blocked,
            ));
            self.view.shell.tree.acknowledge_semantics();
        }
        if self.view.shell.tree.invalidation().paint {
            window.redraw();
        }
        Ok(())
    }
    fn navigate(&mut self, page: String) -> Result<()> {
        self.view.suggestions.dismiss(&mut self.view.shell.tree)?;
        if page == "search-results" {
            return self.view.show_results(&mut self.client, true);
        }
        if page == "appearance" {
            // Before Config1's snapshot there is nothing to draw yet; the first mount comes
            // with it, and the page selected here is the one it shows.
            if (self.view.results.is_some() || self.view.page.is_none())
                && self.client.session().available()
            {
                self.view.mount(&mut self.client)?;
            }
            return self.view.shell.selected(&self.view.exports, &page);
        }
        if self.forwarding.is_none() {
            let connection = self.client.connection().clone();
            let (tx, rx) = mpsc::sync_channel(1);
            std::thread::Builder::new()
                .name("settings-forward".into())
                .spawn(move || {
                    let _ = tx.send(forward(&connection, vec!["page".into(), page]));
                })
                .map_err(|e| e.to_string())?;
            self.forwarding = Some(rx);
        }
        Ok(())
    }
    fn choose_search(&mut self, key: u64) -> Result<()> {
        if key == search::ALL {
            return self.view.show_results(&mut self.client, false);
        }
        let target = self
            .view
            .search_matches
            .get(usize::try_from(key).map_err(|_| "invalid suggestion")?)
            .ok_or("stale suggestion")?
            .page
            .clone();
        self.view
            .shell
            .tree
            .set_search_text(self.view.shell.search, "")?;
        self.navigate(target)
    }
    fn effect(&mut self, effect: Effect, window: &mut Window) -> Result<()> {
        if matches!(effect, Effect::None | Effect::Focused(_)) {
            return Ok(());
        }
        let result_target = if let Effect::Activated(id) = effect {
            self.view
                .results
                .as_ref()
                .and_then(|r| r.target(id))
                .map(str::to_owned)
        } else {
            None
        };
        let action = if let Some(page) = result_target {
            Action::Page(page)
        } else {
            self.view.shell.action(effect)?
        };
        match action {
            Action::Page(page) => self.navigate(page)?,
            Action::Window(action) => window.window_action(action),
            Action::None => {
                if let Some(page) = &mut self.view.page {
                    page.renderer().effect(
                        Host {
                            tree: &mut self.view.shell.tree,
                            editor: &mut self.client,
                            exports: &self.view.exports,
                            styles: &self.view.styles,
                            window: Some(window),
                            modal: self
                                .native
                                .as_mut()
                                .map(|n| n as &mut dyn nk_settings::render::Modal),
                        },
                        effect,
                    )?;
                    // A nested dialog may have published/restored another namespace.
                    self.publication = None;
                }
            }
        }
        Ok(())
    }
}
impl Application for App {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        self.stage()?;
        if !self.configured {
            return Ok(());
        }
        if let Some(page) = &mut self.view.page {
            let notices = page.renderer().idle(Host {
                tree: &mut self.view.shell.tree,
                editor: &mut self.client,
                exports: &self.view.exports,
                styles: &self.view.styles,
                window: Some(window),
                modal: None,
            })?;
            self.view.notices(&mut self.client, &notices)?;
        }
        if self.view.page.is_none() {
            let notices = self.client.poll();
            self.view.notices(&mut self.client, &notices)?;
        }
        self.dependencies()?;
        self.sync(window)?;
        if let Some(native) = &self.native {
            native.bridge.check()?;
            while native.bridge.published.try_recv().is_ok() {}
        }
        loop {
            let queued = self
                .native
                .as_ref()
                .and_then(|n| n.bridge.requests.try_recv().ok());
            let Some((revision, action)) = queued else {
                break;
            };
            self.stage()?;
            let blocked = self.view.external_modal();
            let handled = if !blocked
                && self.publication == Some((revision, self.view.shell.tree.generation(), false))
            {
                self.view
                    .suggestions
                    .request(&mut self.view.shell.tree, &action, window)?
            } else {
                None
            };
            if let Some(key) = handled {
                if let Some(key) = key {
                    self.choose_search(key)?;
                }
            } else if let Ok(effect) = request(
                &mut self.view.shell.tree,
                self.publication,
                revision,
                action,
                blocked,
            ) {
                self.effect(effect, window)?;
            }
            self.stage()?;
            self.sync(window)?;
        }
        Ok(())
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        self.stage()?;
        if matches!(event, Event::Configure) {
            window.set_title(self.view.exports.text("settings.native.application")?)?;
            self.configured = true;
        }
        if !self.configured {
            return Ok(());
        }
        if let Event::Focus(active) = event {
            self.active = active;
        }
        // Keep physical focus state even while parent actions are masked.
        self.view.shell.tree.set_active(self.active);
        self.sync(window)?;
        let blocked = self.view.external_modal();
        if !blocked {
            if let Some(native) = &mut self.native {
                native.serial = match &event {
                    Event::Key(key) => key.serial,
                    Event::Button {
                        serial,
                        pressed: true,
                        ..
                    } => Some(*serial),
                    _ => None,
                };
            }
            if let Some(key) =
                self.view
                    .suggestions
                    .event(&mut self.view.shell.tree, &event, window)?
            {
                if let Some(key) = key {
                    self.choose_search(key)?;
                }
            } else {
                let effect = self.view.shell.event(&event, window)?;
                self.effect(effect, window)?;
            }
        }
        self.stage()?;
        self.sync(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.view.shell.paint(frame, &self.view.styles)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn window_background(&self) -> Option<WindowBackground> {
        if self.opaque_preview {
            return None;
        }
        let c = self.view.styles.palette.background.components;
        Some(WindowBackground {
            color: [c[0] as f64, c[1] as f64, c[2] as f64],
            level: None,
        })
    }
    fn committed(&mut self, commit: u64) {
        self.view.shell.tree.acknowledge();
        if !self.ready && self.view.page.is_some() && self.client.session().available() {
            self.ready = true;
            eprintln!("CONTENT_READY commit={commit}");
        }
    }
}

pub fn run(activation: Option<String>) -> Result<()> {
    let start = Instant::now();
    let opaque_preview = std::env::var_os("NK_SETTINGS_OPAQUE_PREVIEW").is_some_and(|v| v == "1");
    let (mode, args) = routing::launch_mode(std::env::args().skip(1).collect());
    let args = if args.is_empty() {
        vec!["open".into()]
    } else {
        args
    };
    let args = match &activation {
        Some(token) => routing::with_activation(&args, token.clone())?,
        None => args,
    };
    let route = routing::route(&args, routing::DRAWN)?;
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let router = match Router::start(&bus, mode, routing::legacy_launcher(), &args)? {
        Ok(router) => router,
        Err(_) => return Ok(()),
    };
    match route {
        Route::Forward(args) => {
            println!("{}", forward(&bus, args)?);
            return Ok(());
        }
        Route::Query(_) => {
            return Err("native queryUI policy/serialization is not integrated".into());
        }
        _ => {}
    }
    let exports = Exports::load(&Exports::root())?;
    let size = open_size(&exports)?;
    let portal = Portal::watch(&bus)?;
    let mut view = View::new(exports, portal.read()?)?;
    let client = Client::start(bus)?;
    let fonts = view.fonts.clone();
    let reference = std::env::var_os("NK_ICON_REFERENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let installed = PathBuf::from("/usr/share/nidara/ui/shell/assets/icons/nidara");
            if installed.is_dir() {
                installed
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara")
            }
        });
    // The header draws icons in its first frame, and Config1 — which names the user's theme —
    // may answer after it (it did in the CI boot): until then, the reference theme, which has
    // every name. `dependencies` swaps in the user's own as soon as the session is up.
    view.shell
        .tree
        .set_icon_theme(icons(REFERENCE_THEME, &reference)?);
    let materials = Materials::load(&view)?;
    let app = App {
        opaque_preview,
        view,
        client,
        materials,
        external: Rc::new(RefCell::new(External {
            portal,
            router,
            portal_changed: false,
            incoming: Vec::new(),
        })),
        native: None,
        text: ParleyBackend::with_system_fonts(fonts.clone())?,
        fonts,
        theme: Rc::new(RefCell::new(String::new())),
        reference,
        icon_theme: None,
        publication: None,
        active: false,
        ready: false,
        forwarding: None,
        configured: false,
        startup_activation: activation,
        activations: Vec::new(),
    };
    nk_wayland::run(
        app,
        Options {
            app_id: "nidara-settings",
            title: "Nidara Settings",
            size,
            map: true,
            material: !opaque_preview,
            require_material: None,
        },
        start,
    )
}

#[cfg(test)]
mod tests;
