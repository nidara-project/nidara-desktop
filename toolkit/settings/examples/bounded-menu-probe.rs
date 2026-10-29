// SPDX-License-Identifier: LGPL-3.0-or-later
//! Isolated diagnostic for the retained action menu and nonblocking popup stack.
use nk_a11y::{Request, bridge::Bridge};
use nk_settings::{exports::Exports, portal::Portal, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Point, Size};
use nk_wayland::{
    Application, Event, Frame, LayerEvent, Material, MenuPopupPlacement, Options, PopupEvent,
    PopupId, PopupPlacement, PopupSide, Window,
};
use nk_widgets::{
    ActionMenuRow, ActionMenuStyle, Command, Effect, Kind, MenuActionKind, PopupSnapshot, Result,
    Surface, Tree, action_menu_snapshot, window::Composition,
};
use std::{path::PathBuf, sync::Arc, time::Instant};
struct Level {
    id: PopupId,
    tree: Tree,
    input: Composition,
    dirty: bool,
    geometry: Option<[i32; 4]>,
}
struct Probe {
    parent: Tree,
    text: ParleyBackend,
    styles: Styles,
    exports: Exports,
    portal: Portal,
    input: Composition,
    bridge: Bridge,
    revision: u64,
    trigger: u64,
    menu_style: ActionMenuStyle,
    levels: Vec<Level>,
    ready: bool,
    publish: bool,
    finish: PathBuf,
    fault: String,
    hint: Option<[i32; 4]>,
    commits: u64,
    tags: Vec<String>,
    publications: std::collections::BTreeMap<u64, Vec<String>>,
}
impl Probe {
    fn rows(child: bool) -> Vec<ActionMenuRow> {
        (0..if child { 100 } else { 1000 })
            .map(|n| ActionMenuRow {
                label: if child {
                    format!("Child {n}")
                } else {
                    format!("Action {n}")
                },
                kind: if n == 0 && !child {
                    MenuActionKind::Submenu { expanded: false }
                } else if n == 1 {
                    MenuActionKind::Check(true)
                } else if n == 2 {
                    MenuActionKind::Radio(true)
                } else if n == 3 {
                    MenuActionKind::Separator
                } else {
                    MenuActionKind::Action
                },
                enabled: n != 5,
                icon: None,
            })
            .collect()
    }
    fn open(&mut self, w: &mut Window, serial: Option<u32>, child: bool) -> Result<()> {
        let (mut tree, items) = self.parent.action_menu_child(
            if child { "Submenu" } else { "Actions" },
            self.menu_style.clone(),
            &Self::rows(child),
            ["Scroll up", "Scroll down"],
        )?;
        tree.set_active(true);
        tree.focus(items[0])?;
        let parent = self.levels.last().map(|l| l.id);
        let anchor = if let Some(level) = self.levels.last() {
            let focused = level
                .tree
                .focused()
                .ok_or("submenu has no focused parent row")?;
            let r = level
                .tree
                .node(focused)
                .ok_or("submenu parent disappeared")?
                .bounds();
            [
                r.x as i32,
                r.y as i32,
                (r.width as i32).max(1),
                (r.height as i32).max(1),
            ]
        } else {
            let r = self.parent.node(self.trigger).unwrap().bounds();
            [
                r.x as i32,
                r.y as i32,
                (r.width as i32).max(1),
                (r.height as i32).max(1),
            ]
        };
        let id = w.open_menu_popup(MenuPopupPlacement {
            placement: PopupPlacement {
                anchor,
                size: (300, 30000),
            },
            workarea: self.hint,
            side: if child {
                PopupSide::Right
            } else {
                PopupSide::Below
            },
            parent,
            grab_serial: serial,
        })?;
        if let Some(level) = self.levels.last_mut()
            && let Some(focused) = level.tree.focused()
        {
            level
                .tree
                .set_menu_action_kind(focused, MenuActionKind::Submenu { expanded: true })?;
            level.dirty = true;
        }
        self.levels.push(Level {
            id,
            tree,
            input: Default::default(),
            dirty: true,
            geometry: None,
        });
        eprintln!("OPEN level={} serial={serial:?}", self.levels.len());
        Ok(())
    }
    fn close_from(&mut self, w: &mut Window, at: usize) -> Result<()> {
        if let Some(level) = self.levels.get(at) {
            w.close_menu_popup(level.id);
        }
        self.levels.truncate(at);
        if let Some(level) = self.levels.last_mut()
            && let Some(focused) = level.tree.focused()
        {
            if matches!(
                level.tree.menu_action_kind(focused),
                Some(MenuActionKind::Submenu { .. })
            ) {
                level
                    .tree
                    .set_menu_action_kind(focused, MenuActionKind::Submenu { expanded: false })?;
            }
            level.dirty = true;
        } else if self.parent.node(self.trigger).is_some() {
            self.parent.focus(self.trigger)?;
            w.redraw();
        }
        self.publish = true;
        eprintln!("CLOSE remaining={}", self.levels.len());
        Ok(())
    }
    fn activate(&mut self, w: &mut Window, at: usize, id: u64, serial: Option<u32>) -> Result<()> {
        if matches!(
            self.levels[at].tree.menu_action_kind(id),
            Some(MenuActionKind::Submenu { .. })
        ) {
            if at + 1 < self.levels.len() {
                self.close_from(w, at + 1)?;
            }
            self.levels[at].tree.focus(id)?;
            self.open(w, serial, true)?;
        } else {
            eprintln!("ACTIVATE {}", self.levels[at].tree.node(id).unwrap().name());
            self.close_from(w, 0)?;
        }
        Ok(())
    }
    fn menu_event(&mut self, w: &mut Window, id: PopupId, event: PopupEvent) -> Result<()> {
        let Some(at) = self.levels.iter().position(|l| l.id == id) else {
            return Ok(());
        };
        match event {
            PopupEvent::Done => self.close_from(w, at)?,
            PopupEvent::Configure => self.levels[at].dirty = true,
            PopupEvent::FrameDone => {}
            PopupEvent::Repositioned(token) => eprintln!("REPOSITIONED {token}"),
            PopupEvent::Key(key) => {
                self.tags.push(format!("key:{}", key.sym));
                eprintln!("MENU_KEY {}", key.sym);
                match key.sym {
                    0xff1b | 0xff51 => self.close_from(w, at)?,
                    0xff53 => {
                        if let Some(id) = self.levels[at].tree.focused()
                            && matches!(
                                self.levels[at].tree.menu_action_kind(id),
                                Some(MenuActionKind::Submenu { .. })
                            )
                        {
                            self.activate(w, at, id, key.serial)?;
                        }
                    }
                    0xffc6 => w.protocol_barrier(99)?,
                    0xffc5 => {
                        // F8 changes a host workarea hint while the parent stays alive.
                        self.hint = Some([0, 0, 240, 140]);
                        let placement = PopupPlacement {
                            anchor: [20, 20, 80, 30],
                            size: (240, 140),
                        };
                        w.reposition_popup_overlay(self.levels[at].id, placement, 71)?;
                        eprintln!("HINT_CHANGED");
                    }
                    _ => {
                        let level = &mut self.levels[at];
                        let effect = level
                            .input
                            .event(&mut level.tree, &Event::Key(key.clone()))?;
                        if self.fault == "no-reveal" && key.sym == 0xff57 {
                            let scroll = level.tree.node(level.tree.root()).unwrap().children()[0];
                            level.tree.scroll_to(scroll, Point::default())?;
                            eprintln!("CONTROL_APPLIED no-reveal");
                        }
                        level.dirty |= level.tree.invalidation().paint;
                        if let Effect::Activated(id) = effect {
                            self.activate(w, at, id, key.serial)?;
                        }
                    }
                }
            }
            PopupEvent::Input(input) => {
                let serial = match &input {
                    LayerEvent::Button { serial, .. } => Some(*serial),
                    _ => None,
                };
                let event = match input {
                    LayerEvent::Motion(x, y) => Some(Event::Motion(x, y)),
                    LayerEvent::Leave => Some(Event::PointerLeave),
                    LayerEvent::Button {
                        button,
                        pressed,
                        serial,
                        time,
                        x,
                        y,
                    } => {
                        let level = &mut self.levels[at];
                        level.input.event(&mut level.tree, &Event::Motion(x, y))?;
                        Some(Event::Button {
                            button,
                            pressed,
                            serial,
                            time,
                        })
                    }
                    LayerEvent::Scroll(delta) => Some(Event::Scroll(delta)),
                    LayerEvent::HorizontalScroll(delta) => Some(Event::HorizontalScroll(delta)),
                    _ => None,
                };
                if let Some(event) = event {
                    let level = &mut self.levels[at];
                    let effect = level.input.event(&mut level.tree, &event)?;
                    level.dirty |= level.tree.invalidation().paint;
                    if let Effect::Activated(id) = effect {
                        self.activate(w, at, id, serial)?;
                    }
                }
            }
        }
        Ok(())
    }
    fn sync(&mut self, w: &mut Window) -> Result<()> {
        for level in &mut self.levels {
            let Some(geometry) = w.popup_overlay_geometry(level.id) else {
                continue;
            };
            if level.geometry != Some(geometry) {
                level.geometry = Some(geometry);
                level.dirty = true;
            }
            if level.dirty {
                level.tree.layout(
                    Size {
                        width: geometry[2] as f32,
                        height: if self.fault == "no-clamp" {
                            30000.
                        } else {
                            geometry[3] as f32
                        },
                    },
                    false,
                    &mut self.text,
                )?;
                if self.fault == "no-clamp" {
                    eprintln!("CONTROL_APPLIED no-clamp");
                }
                if let Some(frame) = w.popup_overlay_frame(level.id)? {
                    let bytes = level
                        .tree
                        .paint(frame, Surface::Content, self.styles.palette)?;
                    if w.paint_popup_overlay(level.id, frame, &bytes, None)? {
                        level.tree.acknowledge();
                        level.dirty = false;
                        self.publish = true;
                        eprintln!(
                            "MENU_FRAME id={:?} geometry={geometry:?} viewport={:?} focused={:?} scale={}",
                            level.id,
                            level.tree.content_viewport(),
                            level.tree.focused(),
                            frame.scale
                        );
                    }
                }
            }
        }
        if self.publish && self.levels.iter().all(|l| l.geometry.is_some() && !l.dirty) {
            let views = self
                .levels
                .iter()
                .map(|l| {
                    let (x, y) = w
                        .menu_popup_origin(l.id)
                        .ok_or("popup origin not configured")?;
                    Ok((
                        &l.tree,
                        Point {
                            x: x as f32,
                            y: y as f32,
                        },
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let snapshot = action_menu_snapshot(&self.parent, &views)?;
            self.revision = snapshot.revision;
            self.publications
                .insert(snapshot.revision, std::mem::take(&mut self.tags));
            self.bridge.update(snapshot.revision, snapshot.tree)?;
            for level in &mut self.levels {
                level.tree.acknowledge_semantics();
            }
            self.parent.acknowledge_semantics();
            self.publish = false;
        }
        Ok(())
    }
}
impl Application for Probe {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        self.bridge.check()?;
        while let Ok(revision) = self.bridge.published.try_recv() {
            let keys = self
                .publications
                .range(..=revision)
                .map(|(k, _)| *k)
                .collect::<Vec<_>>();
            for key in keys {
                for tag in self.publications.remove(&key).unwrap_or_default() {
                    eprintln!("RESULT_PUBLISHED {tag}");
                }
            }
        }
        if self.finish.exists() {
            w.close();
            return Ok(());
        }
        if self.portal.changed() {
            self.tags.push("appearance".into());
            self.styles = Styles::new(&self.exports, &self.portal.read()?)?;
            self.styles.apply(&mut self.parent)?;
            self.menu_style.row = self.styles.menu.clone();
            for level in &mut self.levels {
                level.tree.set_action_menu_style(self.menu_style.clone())?;
                level.tree.set_text_style(self.styles.text.clone());
                level.dirty = true;
            }
            self.publish = true;
            w.redraw();
            eprintln!("APPEARANCE_CHANGED");
        }
        while let Ok((revision, request)) = self.bridge.requests.try_recv() {
            if revision != self.revision {
                eprintln!("STALE_ACTION");
                continue;
            }
            let (id, command) = match request {
                Request::Focus(id) => (id, Command::Focus),
                Request::Activate(id) => (id, Command::Activate),
                _ => continue,
            };
            self.tags.push(format!("request:{id}"));
            if let Some(at) = self.levels.iter().position(|l| l.tree.node(id).is_some()) {
                let level = &mut self.levels[at];
                let effect = level.tree.dispatch(level.tree.target(id), command)?;
                level.dirty = true;
                if let Effect::Activated(id) = effect {
                    self.activate(w, at, id, None)?;
                }
            } else if self.levels.is_empty() {
                let effect = self.parent.dispatch(self.parent.target(id), command)?;
                if effect == Effect::Activated(self.trigger) {
                    self.open(w, None, false)?;
                }
                w.redraw();
                self.publish = true;
            }
        }
        self.sync(w)
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::ProtocolBarrier(token) => {
                self.tags.push(format!("server:{token}"));
                self.publish = true;
            }
            Event::PopupOverlay { id, event } => self.menu_event(w, id, event)?,
            Event::Configure => {
                self.parent.layout(
                    Size {
                        width: w.size().0 as f32,
                        height: w.size().1 as f32,
                    },
                    false,
                    &mut self.text,
                )?;
                eprintln!(
                    "PARENT_CONFIGURE {:?} menus={}",
                    w.size(),
                    self.levels.len()
                );
                w.redraw();
                self.publish = true;
            }
            Event::Error(e) => return Err(e),
            event => {
                if let Event::Key(key) = &event {
                    self.tags.push(format!("key:{}", key.sym));
                    eprintln!("PARENT_KEY {}", key.sym);
                }
                let serial = match &event {
                    Event::Key(k) => k.serial,
                    Event::Button { serial, .. } => Some(*serial),
                    _ => None,
                };
                let effect = self.input.event(&mut self.parent, &event)?;
                if effect == Effect::Activated(self.trigger) {
                    self.open(w, serial, false)?;
                }
                if self.parent.invalidation().paint {
                    w.redraw();
                    self.publish = true;
                }
            }
        }
        self.sync(w)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.parent
            .paint(frame, Surface::Content, self.styles.palette)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn committed(&mut self, commit: u64) {
        self.parent.acknowledge();
        self.commits = commit;
        eprintln!("PARENT_COMMIT {commit} menus={}", self.levels.len());
        if !self.ready {
            self.ready = true;
            eprintln!("PARENT_READY");
        }
    }
}
fn run() -> Result<()> {
    let exports = Exports::load(&Exports::root())?;
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let portal = Portal::watch(&bus)?;
    let styles = Styles::new(&exports, &portal.read()?)?;
    let reference =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    let mut icons = nk_icons::Icons::new("", &[], &reference)?;
    let menu_style = ActionMenuStyle {
        row: styles.menu.clone(),
        band_height: styles.metrics.control,
        up: (*icons.get("nd-pan-up", 16)?).clone(),
        down: (*icons.get("nd-pan-down", 16)?).clone(),
        submenu: (*icons.get("nd-pan-end", 16)?).clone(),
    };
    let mut parent = Tree::new("Bounded menu probe", styles.metrics, styles.text.clone())?;
    styles.apply(&mut parent)?;
    let scroll = parent.append(parent.root(), Kind::Scroll, "Content")?;
    let group = parent.group(scroll, "Menu test")?;
    let (_, trigger) = parent.row(group, "Open actions", Kind::Button)?;
    parent.focus(trigger)?;
    let snapshot = PopupSnapshot::new(parent.semantics())?;
    let revision = snapshot.revision;
    let bridge = Bridge::new(revision, snapshot.tree);
    nk_wayland::run(
        Probe {
            parent,
            text: ParleyBackend::new(Arc::new(FontSet::discover_required()?))?,
            styles,
            exports,
            portal,
            input: Default::default(),
            bridge,
            revision,
            trigger,
            menu_style,
            levels: vec![],
            ready: false,
            publish: true,
            finish: std::env::var_os("NK_MENU_FINISH")
                .ok_or("missing private finish path")?
                .into(),
            fault: std::env::var("NK_MENU_FAULT").unwrap_or_default(),
            hint: None,
            commits: 0,
            tags: Vec::new(),
            publications: Default::default(),
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-bounded-menu-probe",
            title: "Bounded menu probe",
            size: (640, 480),
            require_material: None,
        },
        Instant::now(),
    )
}
fn main() {
    if let Err(e) = run() {
        eprintln!("PROBE_ERROR {e}");
        std::process::exit(1);
    }
}
