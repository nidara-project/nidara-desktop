// SPDX-License-Identifier: LGPL-3.0-or-later
//! Fixed structural-widget demo, deliberately independent of Settings/Config1.
mod accessibility;
mod appearance;
mod panel;
use appearance::Appearance;
use nk_a11y::{Request, Role};
use nk_text::{FontSet, ParleyBackend, Point};
use nk_wayland::{Application, Event, Frame, Material, Options, Window, WindowBackground};
use nk_widgets::{Command, Effect, Kind, Result, Surface, Target, Tree, window::Composition};
use std::{
    cell::Cell,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
struct Demo {
    tree: Tree,
    text: ParleyBackend,
    appearance: Appearance,
    appearance_updates: mpsc::Receiver<Result<Appearance>>,
    composition: Composition,
    a11y: Option<accessibility::Bridge>,
    fault: String,
    applied: Cell<bool>,
    scroll: u64,
    sidebar: u64,
    group: u64,
    wide: u64,
    width: u32,
    switch: u64,
    probe: (u64, u64),
    optional: u64,
    buttons: Vec<(u64, &'static str)>,
    window_buttons: [u64; 3],
    ready: bool,
    layout_report: Option<(u32, u32, bool)>,
}
impl Demo {
    fn applied(&self, name: &str) {
        if self.fault == name && !self.applied.replace(true) {
            eprintln!("CONTROL_APPLIED {name}");
        }
    }
    fn project(&self) -> nk_a11y::Tree {
        let mut tree = self.tree.semantics();
        let change = match self.fault.as_str() {
            "frame" => Some((self.tree.root(), Role::Panel)),
            "sidebar" => tree
                .nodes
                .values()
                .find(|n| n.role == Role::List)
                .map(|n| (n.id, Role::Panel)),
            "scroll" => Some((self.scroll, Role::Panel)),
            "group" => tree
                .nodes
                .values()
                .find(|n| {
                    n.role == Role::Panel
                        && n.relations
                            .iter()
                            .any(|r| matches!(r, nk_a11y::Relation::LabelledBy(_)))
                })
                .map(|n| (n.id, Role::Label)),
            "switch-role" => Some((self.switch, Role::CheckBox)),
            "button" => Some((self.buttons[0].0, Role::Label)),
            _ => None,
        };
        if let Some((id, role)) = change {
            tree.nodes.get_mut(&id).unwrap().role = role;
            self.applied(&self.fault);
        }
        match self.fault.as_str() {
            "switch-name" => {
                tree.nodes.get_mut(&self.switch).unwrap().name = "Wrong label".into();
                self.applied("switch-name");
            }
            "selected" => {
                for n in tree.nodes.values_mut() {
                    if n.role == Role::Option {
                        n.states.selected = false;
                    }
                }
                self.applied("selected");
            }
            "row-label" => {
                tree.nodes.get_mut(&self.switch).unwrap().relations.clear();
                self.applied("row-label");
            }
            "group-label" => {
                for n in tree.nodes.values_mut() {
                    if n.role == Role::Panel {
                        n.relations.clear();
                    }
                }
                self.applied("group-label");
            }
            "checked"
                if matches!(
                    self.tree.node(self.switch).unwrap().kind(),
                    Kind::Switch { checked: true }
                ) =>
            {
                tree.nodes.get_mut(&self.switch).unwrap().states.checked = false;
                self.applied("checked");
            }
            "offscreen" => {
                let last = self.probe.1;
                if !self.tree.showing(last) {
                    tree.nodes.get_mut(&last).unwrap().states.offscreen = false;
                    self.applied("offscreen");
                }
            }
            "under-sidebar"
                if self.tree.node(self.probe.0).unwrap().bounds().x
                    + self.tree.node(self.probe.0).unwrap().bounds().width
                    <= self.tree.content_viewport().x =>
            {
                tree.nodes.get_mut(&self.probe.0).unwrap().states.offscreen = false;
                self.applied(&self.fault);
            }
            "under-title"
                if self.tree.node(self.probe.0).unwrap().bounds().y
                    + self.tree.node(self.probe.0).unwrap().bounds().height
                    <= self.tree.content_viewport().y =>
            {
                tree.nodes.get_mut(&self.probe.0).unwrap().states.offscreen = false;
                self.applied(&self.fault);
            }
            _ => {}
        }
        tree
    }
    fn sync(&mut self, window: &mut Window) -> Result<()> {
        self.tree.set_sidebar_frame(
            self.appearance.metrics.padding,
            self.appearance.metrics.group_radius,
        )?;
        let width = window.size().0;
        if width != self.width {
            self.tree.set_min_width(self.wide, width as f32)?;
            if self.fault == "at-rest" {
                self.tree.set_min_width(self.group, width as f32)?;
            }
            self.width = width;
        }
        self.composition
            .set_sidebar_transition((!self.appearance.reduce_motion).then_some((
                1,
                nk_wayland::Curve::Bezier {
                    x1: 0.2,
                    y1: 0.,
                    x2: 0.2,
                    y2: 1.,
                    duration_ms: 180,
                },
            )));
        // Appearance changes already invalidate panes; do not dirty them every frame.
        if !self.ready {
            self.composition
                .set_titlebar_style(self.appearance.titlebar.clone())?;
        }
        self.composition.sync(
            &mut self.tree,
            window,
            &mut self.text,
            self.appearance.palette,
            |side| self.appearance.panel.at(side),
            self.fault != "layers",
        )?;
        let inset = self.tree.content_viewport().x;
        let width = window.size().0 as f32;
        if (self.fault == "collapse" && !self.tree.sidebar_open() && inset < 1.)
            || (self.fault == "overlay" && self.tree.sidebar_overlay() && inset < 1.)
        {
            // Actual wrong layout, not a fabricated accessibility rectangle.
            self.tree
                .set_leading_inset(self.appearance.metrics.sidebar)?;
            self.tree.layout(
                nk_text::Size {
                    width,
                    height: window.size().1 as f32,
                },
                self.fault != "layers" && window.capabilities().layers,
                &mut self.text,
            )?;
            self.applied(&self.fault);
        }
        let report = (
            window.size().0,
            self.tree.content_viewport().x.to_bits(),
            self.composition.at_rest(),
        );
        if self.layout_report != Some(report) {
            eprintln!(
                "LAYOUT width={width} inset={} resting={}",
                self.tree.content_viewport().x,
                self.composition.at_rest()
            );
            self.layout_report = Some(report);
        }
        if self.fault == "at-rest" && !self.tree.showing(self.switch) {
            self.applied("at-rest");
        }
        if self.fault == "layers" && !window.capabilities().layers {
            return Err("layers control requires a baseline with layer support".into());
        }
        if self.tree.invalidation().semantics || self.a11y.is_none() {
            let tree = self.project();
            if let Some(a11y) = &self.a11y {
                a11y.update(self.tree.generation(), tree)?;
            } else {
                self.a11y = Some(accessibility::Bridge::new(self.tree.generation(), tree));
            }
            self.tree.acknowledge_semantics();
        }
        Ok(())
    }
    fn effect(&mut self, effect: Effect, window: &mut Window) -> Result<()> {
        let Effect::Activated(id) = effect else {
            return Ok(());
        };
        if let Some(index) = self.window_buttons.iter().position(|button| *button == id) {
            window.window_action(
                [
                    nk_wayland::WindowAction::Minimize,
                    nk_wayland::WindowAction::ToggleMaximize,
                    nk_wayland::WindowAction::Close,
                ][index],
            );
            return Ok(());
        }

        let Some((_, action)) = self.buttons.iter().find(|(button, _)| *button == id) else {
            return Ok(());
        };
        match *action {
            "Scroll away" => self
                .tree
                .scroll_to(self.scroll, Point { x: 0., y: 100_000. })?,
            "Under sidebar" => {
                self.tree.scroll_to(self.scroll, Point { x: 0., y: 0. })?;
                let r = self.tree.node(self.probe.0).unwrap().bounds();
                let pane = self.tree.node(self.sidebar).unwrap().bounds();
                let leading = pane.x + pane.width;
                self.tree.scroll_to(
                    self.scroll,
                    Point {
                        x: r.x + r.width - leading + 1.,
                        y: (r.y - self.tree.content_viewport().y - self.appearance.metrics.padding)
                            .max(0.),
                    },
                )?;
            }
            "Under title" => {
                self.tree.scroll_to(self.scroll, Point { x: 0., y: 0. })?;
                let r = self.tree.node(self.probe.0).unwrap().bounds();
                self.tree.scroll_to(
                    self.scroll,
                    Point {
                        x: 0.,
                        y: r.y + r.height - self.tree.content_viewport().y + 1.,
                    },
                )?;
            }
            "Reset scroll" => self.tree.scroll_to(self.scroll, Point::default())?,
            "Larger text" => {
                let mut style = self.appearance.style.clone();
                style.size *= 1.5;
                self.tree.set_text_style(style);
            }
            "Hide optional" => self.tree.set_hidden(self.optional, true)?,
            "Toggle sidebar" => {
                let open = self.sidebar_closed();
                self.composition.set_sidebar_open(
                    &mut self.tree,
                    window,
                    open,
                    (!self.appearance.reduce_motion).then_some((
                        1,
                        nk_wayland::Curve::Bezier {
                            x1: 0.2,
                            y1: 0.,
                            x2: 0.2,
                            y2: 1.,
                            duration_ms: 180,
                        },
                    )),
                )?;
            }
            _ => {}
        }
        eprintln!("DEMO_ACTION {action}");
        Ok(())
    }
    fn sidebar_closed(&self) -> bool {
        self.tree
            .node(self.tree.root())
            .unwrap()
            .children()
            .iter()
            .any(|id| {
                let n = self.tree.node(*id).unwrap();
                n.kind() == Kind::Sidebar && n.bounds().x < 0.
            })
    }
    fn keep_scroll_fault(&mut self, old: Point, changed: bool) -> Result<()> {
        if self.fault == "reveal" && changed && self.tree.node(self.scroll).unwrap().scroll() != old
        {
            self.tree.scroll_to(self.scroll, old)?;
            self.applied("reveal");
        }
        Ok(())
    }
}
impl Application for Demo {
    fn window_controls(&self) -> bool {
        self.fault != "window-controls"
    }
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        while let Ok(appearance) = self.appearance_updates.try_recv() {
            let appearance = appearance?;
            if appearance.style.family != self.appearance.style.family {
                self.text = text_backend(&appearance.style)?;
            }
            if appearance.style.family != self.appearance.style.family
                || appearance.style.size != self.appearance.style.size
                || appearance.style.weight != self.appearance.style.weight
                || appearance.style.line_height != self.appearance.style.line_height
            {
                self.tree.set_text_style(appearance.style.clone());
            }
            self.appearance = appearance;
            self.tree
                .invalidate(self.tree.root(), nk_widgets::Invalid::PAINT);
            self.composition
                .set_titlebar_style(self.appearance.titlebar.clone())?;
            self.composition.invalidate_panes();
        }
        if let Some(a11y) = &self.a11y {
            a11y.check()?;
        }
        loop {
            let request = self.a11y.as_ref().and_then(|a| a.requests.try_recv().ok());
            let Some((generation, request)) = request else {
                break;
            };
            let (id, command) = match request {
                Request::Focus(id) => (id, Command::Focus),
                Request::Activate(id) => (id, Command::Activate),
                _ => continue,
            };
            let old = self.tree.node(self.scroll).unwrap().scroll();
            let sidebar_old = self.tree.node(self.sidebar).unwrap().scroll();
            if let Ok(effect) = self.tree.dispatch(Target { id, generation }, command) {
                self.keep_scroll_fault(old, command == Command::Focus)?;
                if self.fault == "sidebar-reveal"
                    && command == Command::Focus
                    && self.tree.node(self.sidebar).unwrap().scroll() != sidebar_old
                {
                    self.tree.scroll_to(self.sidebar, sidebar_old)?;
                    self.applied("sidebar-reveal");
                }
                self.effect(effect, window)?;
            }
        }
        self.sync(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if let Event::Error(e) = &event {
            return Err(e.clone());
        }
        if self.fault == "tab" && matches!(&event,Event::Key(key) if key.sym==0xff09) {
            self.tree.tab(false)?;
            self.applied("tab");
        }
        let old = self.tree.node(self.scroll).unwrap().scroll();
        let focused = self.tree.focused();
        let effect = self.composition.event(&mut self.tree, &event)?;
        self.keep_scroll_fault(old, self.tree.focused() != focused)?;
        self.effect(effect, window)?;
        self.sync(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        let pixels = self
            .tree
            .paint(frame, Surface::Content, self.appearance.palette)?;
        if self.fault == "layers" {
            self.applied("layers");
        }
        Ok(pixels)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn window_background(&self) -> Option<WindowBackground> {
        let c = self.appearance.palette.background.components;
        Some(WindowBackground {
            color: [c[0] as f64, c[1] as f64, c[2] as f64],
            level: None,
        })
    }
    fn committed(&mut self, commit: u64) {
        eprintln!("COMMITTED {commit}");
        self.tree.acknowledge();
        if !self.ready {
            eprintln!("CONTENT_READY commit={commit}");
            self.ready = true;
        }
    }
}
fn text_backend(style: &nk_text::TextStyle) -> Result<ParleyBackend> {
    let mut fonts = FontSet::discover_required()?;
    if !fonts.files.iter().any(|f| f.family == style.family) {
        let result = std::process::Command::new("fc-match")
            .args(["-f", "%{file}\n%{index}\n", &style.family])
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err("fontconfig could not resolve interface font".into());
        }
        let text = String::from_utf8(result.stdout).map_err(|e| e.to_string())?;
        let mut lines = text.lines();
        fonts.files.push(nk_text::FontFile {
            family: style.family.clone(),
            path: lines.next().ok_or("missing font path")?.into(),
            index: lines
                .next()
                .ok_or("missing font face")?
                .parse::<u32>()
                .map_err(|e| e.to_string())?,
        });
        fonts = FontSet::from_files(fonts.files, fonts.variable_family)?;
    }
    ParleyBackend::new(Arc::new(fonts))
}
fn run() -> Result<()> {
    let start = Instant::now();
    let fault = std::env::args()
        .find_map(|s| s.strip_prefix("--fault=").map(str::to_owned))
        .unwrap_or_default();
    let root = std::path::PathBuf::from(
        std::env::var_os("NK_SETTINGS_DATA").unwrap_or_else(|| "build/settings-data".into()),
    );
    let appearance_updates = appearance::watch(root);
    let mut appearance = appearance_updates
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())??;
    // Window geometry is an app property. The checker supplies the exported
    // contentFloor so both scales fit the private output without changing pages.
    if let Some(width) =
        std::env::args().find_map(|a| a.strip_prefix("--content-width=").map(str::to_owned))
    {
        let width: f32 = width.parse().map_err(|e| format!("content width: {e}"))?;
        if !width.is_finite() || width <= 0. {
            return Err("invalid content width".into());
        }
        appearance.metrics.content = width;
        appearance.size.0 = (appearance.metrics.sidebar + width) as u32;
    }
    let size = if std::env::args().any(|a| a == "--narrow") {
        (
            (appearance.metrics.sidebar + appearance.metrics.content - 1.) as u32,
            appearance.size.1,
        )
    } else {
        appearance.size
    };
    let mut tree = Tree::new(
        "Nidara widgets demo",
        appearance.metrics,
        appearance.style.clone(),
    )?;
    let root = tree.root();
    let sidebar = tree.append(root, Kind::Sidebar, "Pages")?;
    tree.append(sidebar, Kind::Page { selected: true }, "Appearance")?;
    tree.append(sidebar, Kind::Page { selected: false }, "Accessibility")?;
    for i in 2..20 {
        tree.append(
            sidebar,
            Kind::Page { selected: false },
            format!("Demo page {i:02}"),
        )?;
    }
    let titlebar = tree.append(root, Kind::TitleBar, "Widget foundations")?;
    tree.sidebar_button(titlebar, "Sidebar")?;
    let window_buttons = if fault == "window-controls" {
        eprintln!("CONTROL_APPLIED window-controls");
        [0; 3] // Deliberately omit both protocol opt-in and retained control registration.
    } else {
        tree.window_controls(titlebar, ["Minimize", "Maximize", "Close"])?
    };
    let scroll = tree.append(root, Kind::Scroll, "Content")?;
    let group = tree.group(scroll, "General")?;
    let (_, switch) = tree.row(group, "Enable feature", Kind::Switch { checked: false })?;
    let mut buttons = vec![];
    for action in [
        "Scroll away",
        "Under sidebar",
        "Under title",
        "Reset scroll",
        "Larger text",
        "Hide optional",
        "Toggle sidebar",
    ] {
        let (_, id) = tree.row(group, action, Kind::Button)?;
        // Short visual text; the row label supplies its accessible name/relation.
        tree.set_name(id, "Run")?;
        buttons.push((id, action));
    }
    let (probe_row, _) = tree.row(group, "Probe", Kind::Switch { checked: false })?;
    tree.set_width(
        probe_row,
        // Match the floating sidebar's inner width (outer margin + inner padding).
        appearance.metrics.sidebar - 4. * appearance.metrics.padding,
    )?;
    let (optional, _) = tree.row(group, "Optional feature", Kind::Switch { checked: false })?;
    let (hidden, _) = tree.row(group, "Hidden feature", Kind::Switch { checked: false })?;
    let mut last = 0;
    for i in 0..20 {
        let (_, control) = tree.row(
            group,
            &format!("Extra feature {i:02}"),
            Kind::Switch { checked: false },
        )?;
        last = control;
    }
    // Only this dedicated row is wider than the viewport. Normal controls must
    // be visible at rest; the scroll extent still permits the D7 occlusion probe.
    let (wide, _) = tree.row(group, "Wide content", Kind::Switch { checked: false })?;

    tree.set_hidden(hidden, true)?;
    if fault == "hidden" {
        tree.set_hidden(hidden, false)?;
        if tree.semantics().nodes.contains_key(&hidden) {
            eprintln!("CONTROL_APPLIED hidden");
        }
    }
    nk_wayland::run(
        Demo {
            tree,
            text: text_backend(&appearance.style)?,
            appearance,
            appearance_updates,
            composition: Composition::default(),
            a11y: None,
            fault,
            applied: Cell::new(false),
            scroll,
            sidebar,
            group,
            wide,
            width: 0,
            switch,
            probe: (probe_row, last),
            optional,
            buttons,
            window_buttons,
            ready: false,
            layout_report: None,
        },
        Options {
            material: true,
            map: true,
            app_id: "nk-widgets-demo",
            title: "Nidara widgets demo",
            size,
            require_material: None,
        },
        start,
    )
}
fn main() {
    if let Err(e) = run() {
        eprintln!("nk-widgets-demo: {e}");
        std::process::exit(1);
    }
}
