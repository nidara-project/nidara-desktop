// SPDX-License-Identifier: LGPL-3.0-or-later
//! Real manifest/Client/modal composition on the private native harness; not the app main.
use nk_a11y::bridge::Bridge;
use nk_settings::{
    Value,
    client::Client,
    dropdown::Native,
    exports::Exports,
    portal::Portal,
    render::{Builders, Editor, Host, Rendered},
    session::{ApplyError, Notice, Session},
    styles::Styles,
};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_wayland::{Application, Event, Frame, Material, Options, Window};
use nk_widgets::{Effect, Kind, PopupSnapshot, Result, Tree, window::Composition};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

// Fault adapter retains the REAL Client/session/Apply transport. Only modal polling
// can be sabotaged; it is never used for baseline data or to supply a fake snapshot.
struct Editing {
    client: Client,
    fault: String,
}
impl Editor for Editing {
    fn session(&self) -> &Session {
        self.client.session()
    }
    fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError> {
        self.client.apply(key, value)
    }
    fn poll(&mut self) -> Vec<Notice> {
        let notices = self.client.poll();
        if !notices.is_empty() {
            eprintln!("CONFIG_POLLED notices={}", notices.len());
            if self.fault == "ignore-config" {
                eprintln!("CONTROL_APPLIED ignore-config");
                return Vec::new();
            }
        }
        notices
    }
}
struct External {
    portal: Portal,
    changed: bool,
}
struct Probe {
    tree: Tree,
    exports: Exports,
    styles: Styles,
    editor: Editing,
    rendered: Rendered,
    native: Native,
    external: Rc<RefCell<External>>,
    combo: u64,
    input: Composition,
    ready: bool,
    pending: bool,
    published: Option<u64>,
    finish: PathBuf,
}
impl Probe {
    fn publish(&mut self) -> Result<u64> {
        let snapshot = PopupSnapshot::new(self.tree.semantics())?;
        self.native.revision = snapshot.revision;
        self.native
            .bridge
            .update(snapshot.revision, snapshot.tree)?;
        self.tree.acknowledge_semantics();
        Ok(self.native.revision)
    }
    fn drain(&mut self, w: &mut Window) -> Result<()> {
        let mut notices = std::mem::take(&mut self.native.notices);
        notices.extend(self.editor.client.poll());
        if !notices.is_empty() {
            self.rendered.notices(
                Host {
                    tree: &mut self.tree,
                    editor: &mut self.editor,
                    exports: &self.exports,
                    styles: &self.styles,
                    window: None,
                    modal: None,
                },
                &notices,
            )?;
            self.pending = true;
        }
        {
            let mut external = self.external.borrow_mut();
            if external.changed || external.portal.changed() {
                self.styles = Styles::new(&self.exports, &external.portal.read()?)?;
                self.styles.apply(&mut self.tree)?;
                external.changed = false;
                self.pending = true;
                eprintln!("PORTAL_APPLIED");
            }
        }
        self.tree.layout(
            Size {
                width: w.size().0 as f32,
                height: w.size().1 as f32,
            },
            false,
            &mut self.native.text,
        )?;
        if self.tree.invalidation().semantics {
            self.published = Some(self.publish()?);
        }
        if self.pending || self.tree.invalidation().paint {
            w.redraw();
        }
        Ok(())
    }
}
impl Application for Probe {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        self.native.bridge.check()?;
        while let Ok(revision) = self.native.bridge.published.try_recv() {
            if self.published == Some(revision) {
                eprintln!("PARENT_PUBLISHED revision={revision}");
            }
        }
        self.drain(w)?;
        if self.finish.exists() {
            w.close();
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        self.native.serial = match &event {
            Event::Key(k) => k.serial,
            _ => None,
        };
        self.drain(w)?;
        let effect = self.input.event(&mut self.tree, &event)?;
        if effect != Effect::None {
            let opened = effect == Effect::Activated(self.combo);
            self.rendered.effect(
                Host {
                    tree: &mut self.tree,
                    editor: &mut self.editor,
                    exports: &self.exports,
                    styles: &self.styles,
                    window: Some(w),
                    modal: Some(&mut self.native),
                },
                effect,
            )?;
            if opened {
                self.pending = true;
                eprintln!("MODAL_RETURN");
                self.published = Some(self.publish()?);
            }
        }
        self.drain(w)
    }
    fn paint(&mut self, mut frame: Frame) -> Result<Vec<u8>> {
        frame.material = false;
        self.tree
            .paint(frame, nk_widgets::Surface::Content, self.styles.palette)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn committed(&mut self, commit: u64) {
        self.tree.acknowledge();
        if !self.ready {
            self.ready = true;
            eprintln!("PARENT_READY commit={commit}");
        }
        if self.pending {
            self.pending = false;
            eprintln!(
                "PARENT_RESULT commit={commit} pending={} value={:?} focused={}",
                self.editor.session().pending("appearance.cursorTheme"),
                self.editor.session().shown("appearance.cursorTheme"),
                self.tree.focused() == Some(self.combo)
            );
        }
    }
}
fn run() -> Result<()> {
    let exports = Exports::load(&Exports::root())?;
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let portal = Portal::watch(&bus)?;
    let styles = Styles::new(&exports, &portal.read()?)?;
    let mut client = Client::start(bus)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !client.session().available() && Instant::now() < deadline {
        client.wait(deadline);
    }
    if !client.session().available() {
        return Err("initial Config1 snapshot unavailable".into());
    }
    let fault = std::env::var("NK_DROPDOWN_FAULT").unwrap_or_default();
    let mut editor = Editing {
        client,
        fault: fault.clone(),
    };
    let mut tree = Tree::new(
        "Dropdown provider probe",
        styles.metrics,
        styles.text.clone(),
    )?;
    styles.apply(&mut tree)?;
    let reference =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &reference)?);
    let scroll = tree.append(tree.root(), Kind::Scroll, "Content")?;
    let page = nk_settings::manifest::parse(&serde_json::json!([{"id":"test","kind":"preference",
        "label":"settings.appearance.title","groups":[{"items":["appearance.cursorTheme"]}]}]))?
    .remove(0);
    let mut builders = Builders::default();
    nk_settings::dropdown_builder::register(&mut builders);
    let rendered = Rendered::build(
        Host {
            tree: &mut tree,
            editor: &mut editor,
            exports: &exports,
            styles: &styles,
            window: None,
            modal: None,
        },
        &page,
        &mut builders,
        scroll,
        1,
    )?;
    let snapshot = PopupSnapshot::new(tree.semantics())?;
    let combo = snapshot
        .tree
        .nodes
        .values()
        .find(|n| n.role == nk_a11y::Role::ComboBox)
        .ok_or("no real combo")?
        .id;
    let external = Rc::new(RefCell::new(External {
        portal,
        changed: false,
    }));
    let staged = external.clone();
    let native = Native {
        font: None,
        bridge: Bridge::new(snapshot.revision, snapshot.tree),
        revision: snapshot.revision,
        text: ParleyBackend::new(Arc::new(FontSet::discover_required()?))?,
        panel: None,
        serial: None,
        poll_interval_ms: 16,
        notices: Vec::new(),
        keep_open: Box::new(move || {
            let mut ext = staged.borrow_mut();
            if ext.portal.changed() {
                ext.changed = true;
                eprintln!("PORTAL_STAGED");
            }
            if ext.changed && fault == "ignore-portal" {
                eprintln!("CONTROL_APPLIED ignore-portal");
                return Ok(true);
            }
            Ok(!ext.changed)
        }),
    };
    nk_wayland::run(
        Probe {
            tree,
            exports,
            styles,
            editor,
            rendered,
            native,
            external,
            combo,
            input: Default::default(),
            ready: false,
            pending: false,
            published: None,
            finish: std::env::var_os("NK_DROPDOWN_FINISH")
                .ok_or("missing finish path")?
                .into(),
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-dropdown-builder-probe",
            title: "Dropdown provider probe",
            size: (640, 480),
            require_material: None,
        },
        Instant::now(),
    )
}
fn main() {
    if let Err(error) = run() {
        eprintln!("PROBE_ERROR {error}");
        std::process::exit(1);
    }
}
