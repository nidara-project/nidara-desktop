// SPDX-License-Identifier: LGPL-3.0-or-later
//! Opt-in acceptance client: the production SearchInput and FontChooser View.
use super::*;
use crate::{exports::Exports, portal::Portal};
use std::{collections::BTreeSet, io::Write, path::PathBuf, time::Instant};

struct Probe {
    tree: Tree,
    view: Option<View>,
    search: NodeId,
    styles: Styles,
    text: ParleyBackend,
    input: Composition,
    load: Load,
    configured: bool,
    ime_count: u64,
    applied: BTreeSet<String>,
    log: std::fs::File,
    fault: PathBuf,
    barrier: PathBuf,
}
impl Probe {
    fn sync(&mut self, window: &mut Window) -> Result<()> {
        if !self.configured {
            return Ok(());
        }
        let (w, h) = window.size();
        self.tree.layout(
            Size {
                width: w as f32,
                height: h as f32,
            },
            false,
            &mut self.text,
        )?;
        let input = self.tree.search_text_input();
        if self.fault_name() == "cursor" && input.focused {
            let mut displaced = input.clone();
            displaced.rect[0] += 80;
            window.set_text_input(displaced);
            self.applied.insert("cursor".into());
        } else {
            self.input.sync_search_input(&self.tree, window)?;
        }
        let (display, preedit) = self.tree.search_probe(self.search)?;
        let state = serde_json::json!({"text":self.tree.search_text(self.search)?,
            "display":display,"preedit":preedit,"rect":input.rect,
            "ime_count":self.ime_count,"faults":self.applied,
            "barrier":std::fs::read_to_string(&self.barrier).map_err(|e|e.to_string())?,
            "catalogue_ready": self.view.as_ref().is_none_or(|v| !v.rows.is_empty())});
        writeln!(self.log, "IME_STATE {state}").map_err(|e| e.to_string())?;
        self.log.flush().map_err(|e| e.to_string())?;
        if self.tree.invalidation().paint {
            window.redraw();
        }
        Ok(())
    }
    fn fault_name(&self) -> String {
        std::fs::read_to_string(&self.fault)
            .unwrap_or_default()
            .trim()
            .into()
    }
}
impl Application for Probe {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        if let Some(result) = self.load.poll(Operation {
            mount: 1,
            request: 1,
        }) && let Some(view) = &mut self.view
        {
            let catalogue = result?;
            view.loaded(&mut self.tree, &catalogue, "Noto Sans")?;
        }
        self.sync(window)
    }
    fn event(&mut self, mut event: Event, window: &mut Window) -> Result<()> {
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        if matches!(event, Event::Configure) {
            self.configured = true;
        }
        let fault = self.fault_name();
        if let Event::Ime(batch) = &mut event {
            self.ime_count += 1;
            if fault == "preedit" && batch.preedit.as_ref().is_some_and(|p| !p.0.is_empty()) {
                batch.preedit = None;
                self.applied.insert(fault.clone());
            }
            if fault == "commit" && batch.commit.is_some() {
                batch.commit = None;
                self.applied.insert(fault.clone());
            }
            if fault == "cancel" && self.tree.search_composing(self.search)? {
                self.applied.insert(fault);
                return self.sync(window);
            }
        }
        if fault == "cancel"
            && matches!(&event,Event::Key(k) if k.sym==0xff1b)
            && self.tree.search_composing(self.search)?
        {
            self.applied.insert(fault);
            return self.sync(window);
        }
        // A cursor control must displace only the transmitted rectangle, without
        // alternating it with the normal sync on every IME echo.
        let effect = if fault == "cursor" {
            self.input.event(&mut self.tree, &event)?
        } else {
            self.input
                .event_with_window(&mut self.tree, &event, window)?
        };
        if let Some(view) = &mut self.view {
            view.effect(&mut self.tree, effect)?;
        }
        self.sync(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.tree
            .paint(frame, Surface::Content, self.styles.palette)
    }
    fn committed(&mut self, _: u64) {
        self.tree.acknowledge();
    }
    fn material(&self) -> Option<Material> {
        None
    }
}
pub fn run() -> Result<()> {
    let mode = std::env::args().nth(1).ok_or("expected search or fonts")?;
    if mode != "search" && mode != "fonts" {
        return Err("expected search or fonts".into());
    }
    let exports = Exports::load(&Exports::root())?;
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let appearance = Portal::watch(&bus)?.read()?;
    let styles = Styles::new(&exports, &appearance)?;
    let fonts = Arc::new(FontSet::discover_required()?);
    let mut tree = Tree::new(
        "Settings IME acceptance",
        styles.metrics,
        styles.text.clone(),
    )?;
    styles.apply(&mut tree)?;
    let reference =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &reference)?);
    let mut load = Load::default();
    let view = if mode == "fonts" {
        let view = View::build(
            &mut tree,
            &styles,
            &Labels {
                title: "Choose font",
                search: "Search families",
                placeholder: "Search",
                families: "Font families",
                styles: "Font styles",
                unnamed: "Unnamed",
                unsupported_style: "Unsupported",
                preview: "The quick brown fox",
                point_size: "Point size",
                loading: "Loading",
                cancel: "Cancel",
                select: "Select",
            },
            160.,
            fonts.clone(),
            PointSize {
                attributes: Attributes::default(),
                initial: 11.,
                range: nk_widgets::ValueRange {
                    min: 1.,
                    max: 100.,
                    step: 0.5,
                    wrap: false,
                    digits: 0,
                    decimals: 1,
                    unit: " pt".into(),
                },
                scale: 1.,
            },
        )?;
        load.start(Operation {
            mount: 1,
            request: 1,
        })?;
        Some(view)
    } else {
        None
    };
    let search = match &view {
        Some(view) => view.search,
        None => {
            let scroll = tree.append(tree.root(), Kind::Scroll, "Settings search")?;
            tree.search_input(
                scroll,
                "Settings search",
                "Search",
                Box::new(ParleyBackend::with_system_fonts(fonts.clone())?),
            )?
        }
    };
    tree.focus(search)?;
    let path = |name| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .ok_or_else(|| format!("missing {name}"))
    };
    let app = Probe {
        tree,
        view,
        search,
        styles,
        text: ParleyBackend::with_system_fonts(fonts)?,
        input: Composition::default(),
        load,
        configured: false,
        ime_count: 0,
        applied: BTreeSet::new(),
        log: std::fs::File::create(path("NK_IME_STATE_LOG")?).map_err(|e| e.to_string())?,
        fault: path("NK_IME_FAULT_FILE")?,
        barrier: path("NK_IME_BARRIER_FILE")?,
    };
    nk_wayland::run(
        app,
        Options {
            app_id: "nidara-settings-ime",
            title: "Settings IME acceptance",
            size: (640, 720),
            map: true,
            material: false,
            require_material: None,
        },
        Instant::now(),
    )
}
