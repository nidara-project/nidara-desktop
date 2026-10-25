// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic composition: retained dropdown + standard popup, forced D5 on private Hyalo.
use nk_settings::{exports::Exports, portal::Portal, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_wayland::{Application, Event, Frame, Material, Options, PopupPlacement, Window};
use nk_widgets::{Effect, Kind, Tree, window::Composition};
use std::{sync::Arc, time::Instant};
type Result<T> = std::result::Result<T, String>;
const NAMES: [&str; 3] = ["English", "Español", "日本語"];
struct Menu<'a> {
    tree: Tree,
    text: &'a mut ParleyBackend,
    palette: nk_widgets::Palette,
    input: Composition,
    ids: Vec<u64>,
    result: &'a mut Option<usize>,
    ready: bool,
    fault: &'a str,
}
impl Application for Menu<'_> {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn event(&mut self, e: Event, w: &mut Window) -> Result<()> {
        if matches!(e, Event::Configure) {
            self.tree.layout(
                Size {
                    width: w.size().0 as f32,
                    height: w.size().1 as f32,
                },
                false,
                self.text,
            )?;
        }
        if matches!(e,Event::Key(ref k) if k.sym==0xff1b) {
            eprintln!("MENU_CANCEL_HANDLED");
            w.close();
            return Ok(());
        }
        let effect = self.input.event(&mut self.tree, &e)?;
        if let Effect::Focused(id) = effect
            && self.fault == "commit-focus-on-cancel"
        {
            *self.result = self.ids.iter().position(|v| *v == id);
        }
        if let Effect::Activated(id) = effect {
            if self.fault != "ignore-selection" {
                *self.result = self.ids.iter().position(|v| *v == id);
            }
            eprintln!("MENU_ACTIVATION_HANDLED");
            w.close();
        }
        if let Event::Key(k) = e {
            eprintln!("MENU_KEY_HANDLED {}", k.sym);
        }
        self.tree.layout(
            Size {
                width: w.size().0 as f32,
                height: w.size().1 as f32,
            },
            false,
            self.text,
        )?;
        if self.tree.invalidation().paint {
            w.redraw();
        }
        Ok(())
    }
    fn paint(&mut self, mut f: Frame) -> Result<Vec<u8>> {
        f.material = false;
        self.tree
            .paint(f, nk_widgets::Surface::Content, self.palette)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn committed(&mut self, c: u64) {
        self.tree.acknowledge();
        if !self.ready {
            self.ready = true;
            eprintln!("MENU_READY commit={c}");
        }
    }
}
struct Parent {
    tree: Tree,
    text: ParleyBackend,
    styles: Styles,
    combo: u64,
    input: Composition,
    ready: bool,
    pending: bool,
    done: bool,
    fault: String,
}
impl Application for Parent {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        if self.done {
            w.close();
        }
        Ok(())
    }
    fn event(&mut self, e: Event, w: &mut Window) -> Result<()> {
        if matches!(e, Event::Configure) {
            self.tree.layout(
                Size {
                    width: w.size().0 as f32,
                    height: w.size().1 as f32,
                },
                false,
                &mut self.text,
            )?;
        }
        let serial = match &e {
            Event::Key(k) => k.serial,
            _ => None,
        };
        let effect = self.input.event(&mut self.tree, &e)?;
        if effect == Effect::Activated(self.combo) {
            let chosen = self.tree.dropdown_selected(self.combo)?;
            let (mut list, ids) = Tree::menu_list(
                "Language",
                self.styles.metrics,
                self.styles.text.clone(),
                self.styles.menu.clone(),
                &NAMES,
                chosen,
            )?;
            let r = self.tree.node(self.combo).unwrap().bounds();
            list.layout(
                Size {
                    width: r.width,
                    height: w.size().1 as f32,
                },
                false,
                &mut self.text,
            )?;
            let scroll = list.node(list.root()).unwrap().children()[0];
            let height =
                list.node(scroll).unwrap().measured().height + 2. * self.styles.menu.border;
            list.focus(ids[chosen])?;
            let mut result = None;
            self.tree.set_dropdown_expanded(self.combo, true)?;
            nk_wayland::run_popup(
                Menu {
                    tree: list,
                    text: &mut self.text,
                    palette: self.styles.palette,
                    input: Default::default(),
                    ids,
                    result: &mut result,
                    ready: false,
                    fault: &self.fault,
                },
                w,
                PopupPlacement {
                    anchor: [
                        r.x.floor() as i32,
                        r.y.floor() as i32,
                        r.width.ceil() as i32,
                        r.height.ceil() as i32,
                    ],
                    size: (r.width.ceil() as u32, height.ceil() as u32),
                },
                serial,
            )?;
            self.tree.set_dropdown_expanded(self.combo, false)?;
            if let Some(selected) = result {
                self.tree.set_dropdown_selected(self.combo, selected)?;
            }
            self.tree.focus(self.combo)?;
            self.pending = true;
            eprintln!("MENU_FINISHED");
        }
        self.tree.layout(
            Size {
                width: w.size().0 as f32,
                height: w.size().1 as f32,
            },
            false,
            &mut self.text,
        )?;
        if self.tree.invalidation().paint {
            w.redraw();
        }
        Ok(())
    }
    fn paint(&mut self, mut f: Frame) -> Result<Vec<u8>> {
        f.material = false;
        self.tree
            .paint(f, nk_widgets::Surface::Content, self.styles.palette)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn committed(&mut self, c: u64) {
        self.tree.acknowledge();
        if !self.ready {
            self.ready = true;
            eprintln!("PARENT_READY commit={c}");
        }
        if self.pending {
            self.pending = false;
            self.done = true;
            let index = self.tree.dropdown_selected(self.combo).unwrap();
            let semantic = self.tree.semantics();
            let selected = semantic.selected_children(self.combo);
            eprintln!(
                "RESULT index={index} caption={} selected={} focus={} expanded=false commit={c}",
                self.tree.node(self.combo).unwrap().name(),
                semantic.nodes[&selected[0]].name,
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
    let mut tree = Tree::new("Dropdown D5 probe", styles.metrics, styles.text.clone())?;
    styles.apply(&mut tree)?;
    let reference =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &reference)?);
    let scroll = tree.append(tree.root(), Kind::Scroll, "Content")?;
    let group = tree.append(scroll, Kind::Group, "Options")?;
    let (_, combo) = tree.dropdown(group, "Language", &NAMES, 0)?;
    let text = ParleyBackend::new(Arc::new(FontSet::discover_required()?))?;
    let fault = std::env::args()
        .find_map(|s| s.strip_prefix("--fault=").map(str::to_owned))
        .unwrap_or_default();
    nk_wayland::run(
        Parent {
            tree,
            text,
            styles,
            combo,
            input: Default::default(),
            ready: false,
            pending: false,
            done: false,
            fault,
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-dropdown-probe",
            title: "Dropdown D5 probe",
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
