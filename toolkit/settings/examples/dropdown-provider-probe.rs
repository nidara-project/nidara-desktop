// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic real provider/controller composition; Config1 builder and Orca remain separate.
use nk_a11y::bridge::Bridge;
use nk_settings::{dropdown, exports::Exports, portal::Portal, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_wayland::{Application, Event, Frame, Material, Options, Window};
use nk_widgets::{Effect, Kind, PopupSnapshot, Result, Tree, window::Composition};
use std::{path::PathBuf, sync::Arc, time::Instant};
struct Probe {
    tree: Tree,
    text: ParleyBackend,
    styles: Styles,
    combo: u64,
    bridge: Bridge,
    revision: u64,
    input: Composition,
    ready: bool,
    pending: bool,
    published: Option<u64>,
    fault: String,
    finish: PathBuf,
    abort: PathBuf,
}
impl Probe {
    fn publish(&mut self) -> Result<u64> {
        let snapshot = PopupSnapshot::new(self.tree.semantics())?;
        let revision = snapshot.revision;
        self.bridge.update(revision, snapshot.tree)?;
        self.revision = revision;
        self.tree.acknowledge_semantics();
        Ok(revision)
    }
}
impl Application for Probe {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        self.bridge.check()?;
        while let Ok(revision) = self.bridge.published.try_recv() {
            if self.published == Some(revision) {
                eprintln!("PARENT_PUBLISHED revision={revision}");
            }
        }
        if self.finish.exists() {
            w.close();
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        let serial = match &event {
            Event::Key(k) => k.serial,
            _ => None,
        };
        if matches!(event, Event::Configure) {
            self.tree.layout(
                Size {
                    width: w.size().0 as f32,
                    height: w.size().1 as f32,
                },
                false,
                &mut self.text,
            )?;
        }
        if self.input.event(&mut self.tree, &event)? == Effect::Activated(self.combo) {
            let old = self.tree.dropdown_selected(self.combo)?;
            let mut keep_open = || {
                if self.fault == "ignore-invalidation" && self.abort.exists() {
                    eprintln!("CONTROL_APPLIED ignore-invalidation");
                    Ok(true)
                } else {
                    Ok(!self.abort.exists())
                }
            };
            let effect = dropdown::show(
                dropdown::Host {
                    tree: &mut self.tree,
                    window: w,
                    text: &mut self.text,
                    styles: &self.styles,
                    bridge: &self.bridge,
                    revision: &mut self.revision,
                    panel: None,
                    serial,
                    poll_interval_ms: 16,
                    keep_open: &mut keep_open,
                },
                self.combo,
            )?;
            if self.fault == "ignore-selection" {
                eprintln!("CONTROL_APPLIED ignore-selection");
                self.tree.set_dropdown_selected(self.combo, old)?;
            }
            if self.fault == "commit-on-cancel" && effect == Effect::None {
                eprintln!("CONTROL_APPLIED commit-on-cancel");
                self.tree.set_dropdown_selected(self.combo, 1)?;
            }
            self.pending = true;
            self.published = Some(self.publish()?);
        }
        self.tree.layout(
            Size {
                width: w.size().0 as f32,
                height: w.size().1 as f32,
            },
            false,
            &mut self.text,
        )?;
        if self.tree.invalidation().semantics {
            self.publish()?;
        }
        if self.tree.invalidation().paint {
            w.redraw();
        }
        Ok(())
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
                "PARENT_RESULT commit={commit} index={} focused={}",
                self.tree.dropdown_selected(self.combo).unwrap(),
                self.tree.focused() == Some(self.combo)
            );
        }
    }
}
fn run() -> Result<()> {
    let exports = Exports::load(&Exports::root())?;
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let styles = Styles::new(&exports, &Portal::watch(&bus)?.read()?)?;
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
    let group = tree.append(scroll, Kind::Group, "Options")?;
    let (_, combo) = tree.dropdown(group, "Language", &["English", "Español", "日本語"], 0)?;
    let snapshot = PopupSnapshot::new(tree.semantics())?;
    let revision = snapshot.revision;
    let bridge = Bridge::new(snapshot.revision, snapshot.tree);
    nk_wayland::run(
        Probe {
            tree,
            text: ParleyBackend::new(Arc::new(FontSet::discover_required()?))?,
            styles,
            combo,
            bridge,
            revision,
            input: Default::default(),
            ready: false,
            pending: false,
            published: None,
            fault: std::env::var("NK_DROPDOWN_FAULT").unwrap_or_default(),
            finish: std::env::var_os("NK_DROPDOWN_FINISH")
                .ok_or("missing finish path")?
                .into(),
            abort: std::env::var_os("NK_DROPDOWN_ABORT")
                .ok_or("missing abort path")?
                .into(),
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-dropdown-provider-probe",
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
