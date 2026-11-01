// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's popup (DOCK.md §8): one at a time, a menu of rows (menu.rs), drawn by the
//! kit's bounded action menu (#971) on a popup of the dock's own layer surface, on the
//! dock's own event queue: no nested loop, so the dock keeps drawing and Hyalo keeps
//! answering while it is open. Hyalo paints its glass; the rows are ours.
//!
//! Its look is Settings' (`nk-settings`' exports and styles) with the shell's dark skin:
//! the accent, the font and the text scale follow the appearance portal, and no portal
//! is an error said once, never a guessed palette (PHASE1.md D4).
use crate::menu::{Command, Label, Mark, Row};
use nk_settings::exports::Exports;
use nk_settings::material::panel::PanelMaterial;
use nk_settings::portal::{Appearance, Portal};
use nk_settings::styles::Styles;
use nk_text::{FontSet, ParleyBackend, Size, TextBackend};
use nk_wayland::{
    Event, LayerEvent, Material, MenuPopupPlacement, Pane, PopupEvent, PopupId, PopupPlacement,
    PopupSide, Window,
};
use nk_widgets::{
    ActionMenuRow, ActionMenuStyle, Effect, MenuActionKind, NodeId, Surface, Tree,
    window::Composition,
};
use std::collections::HashMap;
use std::sync::Arc;

/// A popup's semantic IDs start here, far above the dock's own (one per item key), and
/// each popup takes a fresh range: an ID is never given to two nodes in one dock's life.
const FIRST_ID: NodeId = 1 << 40;
const ID_RANGE: NodeId = 1 << 20;

/// The first node ID of the `ordinal`th popup: each one its own range, past the dock's.
pub fn first_id(ordinal: u64) -> NodeId {
    FIRST_ID + (ordinal % (1 << 20)) * ID_RANGE
}
const ESCAPE: u32 = 0xff1b;
/// The corners of the dock's menus and chooser: the kit's bubble menu's squircle (menu.ts `n`).
pub const MENU_EXPONENT: f64 = 3.2;

/// Everything a popup is drawn with, loaded on the first one a dock opens.
pub struct Look {
    pub text: ParleyBackend,
    pub exports: Exports,
    pub styles: Styles,
    pub style: ActionMenuStyle,
    pub panel: Option<PanelMaterial>,
    pub appearance: Appearance,
    portal: Portal,
}

fn reference() -> std::path::PathBuf {
    crate::paths::icon_reference()
}

impl Look {
    pub fn load(bus: &zbus::blocking::Connection) -> Result<Self, String> {
        let exports = Exports::load(&Exports::root())?;
        let portal = Portal::watch(bus)?;
        let appearance = portal.read()?;
        let mut icons = nk_icons::Icons::new("", &[], &reference())?;
        let mut icon = |name| icons.get(name, 16).map(|i| (*i).clone());
        let (up, down, submenu) = (
            icon("nd-pan-up")?,
            icon("nd-pan-down")?,
            icon("nd-pan-end")?,
        );
        let (styles, panel) = Self::styles(&exports, &appearance)?;
        let style = ActionMenuStyle {
            row: styles.menu.clone(),
            band_height: styles.metrics.control,
            up,
            down,
            submenu,
        };
        Ok(Self {
            text: ParleyBackend::new(Arc::new(FontSet::discover_required()?))?,
            exports,
            styles,
            style,
            panel,
            appearance,
            portal,
        })
    }

    /// The shell always wears the dark skin (owner's decision); the rest is the portal's.
    fn styles(
        exports: &Exports,
        appearance: &Appearance,
    ) -> Result<(Styles, Option<PanelMaterial>), String> {
        let skin = Appearance {
            dark: true,
            ..appearance.clone()
        };
        let mut styles = Styles::new(exports, &skin)?;
        // The dock's menus are the kit's bubble menu (menu.ts), not the settings dropdown's:
        // the window radius on a `MENU_EXPONENT` squircle, and no rim of our own: Hyalo draws
        // the glass's edge, around the pointer too.
        styles.menu.radius = exports.statics["ts"]["RADIUS"]["lg"]
            .as_f64()
            .ok_or("tokens: RADIUS.lg missing")? as f32;
        styles.menu.border = 0.;
        let panel = PanelMaterial::load(exports.glass.clone(), true, skin.reduce_transparency)
            .map_err(|e| eprintln!("nidara-shell: no menu glass ({e}); an opaque menu instead"))
            .ok();
        Ok((styles, panel))
    }

    /// Re-read the portal if it said something changed; true when the look did.
    pub fn refresh(&mut self) -> bool {
        if !self.portal.changed() {
            return false;
        }
        match self.portal.read().and_then(|a| {
            let (styles, panel) = Self::styles(&self.exports, &a)?;
            Ok((a, styles, panel))
        }) {
            Ok((a, styles, panel)) => {
                self.style.row = styles.menu.clone();
                self.style.band_height = styles.metrics.control;
                (self.appearance, self.styles, self.panel) = (a, styles, panel);
                true
            }
            Err(e) => {
                eprintln!("nidara-shell: the appearance portal: {e}");
                false
            }
        }
    }

    pub fn text_of(&self, label: &Label) -> String {
        match label {
            Label::Text(t) => t.clone(),
            Label::Key(k) => self
                .exports
                .text(k)
                .map(str::to_string)
                .unwrap_or_else(|e| {
                    eprintln!("nidara-shell: {e}");
                    k.to_string()
                }),
        }
    }
}

/// What a popup event came to.
pub enum Outcome {
    None,
    /// It closed without a choice (Escape, a click elsewhere, the compositor).
    Closed,
    /// A row was chosen; `serial` is the input that chose it, when there was one.
    Chosen(Command, Option<u32>),
}

pub struct Popup {
    pub id: PopupId,
    tree: Tree,
    commands: HashMap<NodeId, Command>,
    input: Composition,
    /// The item it belongs to (None: the dock's own menu), to follow or close with it.
    pub anchor: Option<String>,
    pub side: PopupSide,
    pub rect: [i32; 4],
    /// The rows' size, and the popup's: that and the pointer toward its item (bubble.rs).
    natural: (u32, u32),
    size: (u32, u32),
    /// Where it was placed, and for which anchor: the body and its pointer follow both.
    placed: Option<([i32; 4], [i32; 4])>,
    /// The rows' place in the popup, beside the pointer's room.
    body: [f64; 4],
    material: Option<Material>,
    dirty: bool,
}

pub struct Request<'a> {
    pub rows: &'a [Row],
    pub title: &'a str,
    pub anchor: Option<String>,
    /// The item's rectangle (or the pointer's spot) in dock coordinates.
    pub rect: [i32; 4],
    pub side: PopupSide,
    /// The pointer press or key that opened it: the popup's grab.
    pub serial: Option<u32>,
    /// Opened from the keyboard: its first row takes the focus.
    pub keyboard: bool,
    /// Which popup of this dock's life it is (its ID range).
    pub ordinal: u64,
}

impl Popup {
    pub fn open(w: &mut Window, look: &mut Look, r: Request) -> Result<Self, String> {
        let rows: Vec<ActionMenuRow> = r
            .rows
            .iter()
            .map(|row| ActionMenuRow {
                label: look.text_of(&row.label),
                kind: match row.mark {
                    Mark::Plain => MenuActionKind::Action,
                    Mark::Check(on) => MenuActionKind::Check(on),
                    Mark::Radio(on) => MenuActionKind::Radio(on),
                    Mark::Separator => MenuActionKind::Separator,
                },
                enabled: row.enabled,
                icon: None,
            })
            .collect();
        let first = first_id(r.ordinal);
        let (mut tree, ids) = Tree::action_menu_at(
            r.title,
            look.styles.metrics,
            look.styles.text.clone(),
            look.style.clone(),
            &rows,
            ["Scroll up", "Scroll down"],
            first,
        )?;
        tree.set_active(true);
        let commands: HashMap<NodeId, Command> = ids
            .iter()
            .zip(r.rows)
            .filter(|(_, row)| row.mark != Mark::Separator)
            .map(|(id, row)| (*id, row.command.clone()))
            .collect();
        if r.keyboard
            && let Some((id, _)) = ids
                .iter()
                .zip(r.rows)
                .find(|(_, row)| row.enabled && row.mark != Mark::Separator)
        {
            tree.focus(*id)?;
        }
        let natural = Self::natural(&mut tree, look, &rows)?;
        let size = crate::bubble::with_pointer(natural, r.side);
        let id = w.open_menu_popup(MenuPopupPlacement {
            placement: PopupPlacement {
                anchor: r.rect,
                size,
            },
            workarea: None,
            side: r.side,
            parent: None,
            grab_serial: r.serial,
        })?;
        Ok(Self {
            id,
            tree,
            commands,
            input: Default::default(),
            anchor: r.anchor,
            side: r.side,
            rect: r.rect,
            natural,
            size,
            placed: None,
            body: [0., 0., natural.0 as f64, natural.1 as f64],
            material: None,
            dirty: true,
        })
    }

    /// The widest row's text plus the row's own gutters; the rows' height. The compositor
    /// may give it less (a short output): the menu then scrolls inside its bands.
    fn natural(
        tree: &mut Tree,
        look: &mut Look,
        rows: &[ActionMenuRow],
    ) -> Result<(u32, u32), String> {
        let s = &look.style.row;
        let mut text = look.styles.text.clone();
        text.size *= s.text_scale;
        text.weight = s.weight;
        let mut widest: f32 = 0.;
        for row in rows.iter().filter(|r| r.kind != MenuActionKind::Separator) {
            let l = look.text.layout(&row.label, &text, 4096.)?;
            widest = widest.max(l.measured_size().width);
        }
        let width = (widest + 2. * (s.padding_x + s.check_gap + s.check_size + s.border + s.inset))
            .ceil()
            .clamp(160., 420.);
        tree.layout(
            Size {
                width,
                height: 4096.,
            },
            false,
            &mut look.text,
        )?;
        let scroll = tree.node(tree.root()).ok_or("menu root")?.children()[0];
        let height = tree.node(scroll).ok_or("menu rows")?.measured().height + 2. * s.border;
        Ok((width as u32, height.ceil().max(1.) as u32))
    }

    /// Follow its item to a new place (a layout change), at the same size.
    pub fn follow(
        &mut self,
        w: &mut Window,
        rect: [i32; 4],
        side: PopupSide,
    ) -> Result<(), String> {
        if rect == self.rect && side == self.side {
            return Ok(());
        }
        (self.rect, self.side) = (rect, side);
        self.size = crate::bubble::with_pointer(self.natural, side);
        w.reposition_popup_overlay(
            self.id,
            PopupPlacement {
                anchor: rect,
                size: self.size,
            },
            0,
        )
    }

    pub fn close(self, w: &mut Window) {
        w.close_menu_popup(self.id);
    }

    pub fn event(&mut self, w: &mut Window, event: PopupEvent) -> Result<Outcome, String> {
        let effect = match event {
            PopupEvent::Done => return Ok(Outcome::Closed),
            PopupEvent::Configure => {
                self.dirty = true;
                return Ok(Outcome::None);
            }
            PopupEvent::FrameDone | PopupEvent::Repositioned(_) => return Ok(Outcome::None),
            PopupEvent::Key(key) => {
                if key.sym == ESCAPE {
                    return Ok(Outcome::Closed);
                }
                let serial = key.serial;
                let effect = self.input.event(&mut self.tree, &Event::Key(key))?;
                (effect, serial)
            }
            PopupEvent::Input(input) => {
                // The rows are laid out in the body, beside the pointer's room.
                let (bx, by) = (self.body[0], self.body[1]);
                let (event, serial) = match input {
                    LayerEvent::Motion(x, y) => (Event::Motion(x - bx, y - by), None),
                    LayerEvent::Leave => (Event::PointerLeave, None),
                    LayerEvent::Scroll(d) => (Event::Scroll(d), None),
                    LayerEvent::HorizontalScroll(d) => (Event::HorizontalScroll(d), None),
                    LayerEvent::Button {
                        button,
                        pressed,
                        serial,
                        time,
                        x,
                        y,
                    } => {
                        self.input
                            .event(&mut self.tree, &Event::Motion(x - bx, y - by))?;
                        (
                            Event::Button {
                                button,
                                pressed,
                                serial,
                                time,
                            },
                            Some(serial),
                        )
                    }
                    _ => return Ok(Outcome::None),
                };
                (self.input.event(&mut self.tree, &event)?, serial)
            }
        };
        self.dirty |= self.tree.invalidation().paint;
        let _ = w;
        Ok(match effect {
            (Effect::Activated(id), serial) => match self.commands.get(&id) {
                Some(c) => Outcome::Chosen(c.clone(), serial),
                None => Outcome::None,
            },
            _ => Outcome::None,
        })
    }

    /// An assistive technology's request on one of its nodes.
    pub fn request(&mut self, id: NodeId, activate: bool) -> Result<Outcome, String> {
        if self.tree.node(id).is_none() {
            return Ok(Outcome::None);
        }
        let command = if activate {
            nk_widgets::Command::Activate
        } else {
            nk_widgets::Command::Focus
        };
        let effect = self.tree.dispatch(self.tree.target(id), command)?;
        self.dirty = true;
        Ok(match effect {
            Effect::Activated(id) => match self.commands.get(&id) {
                Some(c) => Outcome::Chosen(c.clone(), None),
                None => Outcome::None,
            },
            _ => Outcome::None,
        })
    }

    pub fn owns(&self, id: NodeId) -> bool {
        self.tree.node(id).is_some()
    }

    /// Lay out and draw for the size Hyalo configured, when anything changed. True when a
    /// new frame went out (the semantics follow it).
    pub fn sync(&mut self, w: &mut Window, look: &mut Look) -> Result<bool, String> {
        let Some(geometry) = w.popup_overlay_geometry(self.id) else {
            return Ok(false);
        };
        if self.placed != Some((geometry, self.rect)) {
            self.placed = Some((geometry, self.rect));
            let (width, height) = (geometry[2].max(1) as f64, geometry[3].max(1) as f64);
            let radius = f64::from(look.styles.menu.radius);
            let (body, pane) = crate::bubble::place(geometry, self.rect, radius, MENU_EXPONENT)
                .unwrap_or((
                    [0., 0., width, height],
                    Pane {
                        x: 0.,
                        y: 0.,
                        width,
                        height,
                        radius,
                        exponent: MENU_EXPONENT,
                        pointer: None,
                    },
                ));
            self.body = body;
            self.material = look
                .panel
                .as_ref()
                .and_then(|p| p.at(pane.width.min(pane.height)).ok())
                .map(|mut m| {
                    m.shapes = vec![pane];
                    m
                });
            self.dirty = true;
        }
        if !self.dirty {
            return Ok(false);
        }
        self.tree.layout(
            Size {
                width: self.body[2] as f32,
                height: self.body[3] as f32,
            },
            false,
            &mut look.text,
        )?;
        let Some(mut frame) = w.popup_overlay_frame(self.id)? else {
            return Ok(false);
        };
        frame.material &= self.material.is_some();
        // The rows fill the body; the pointer's room beside it stays clear.
        let (inner, at) = crate::bubble::inset(frame, self.body);
        let bytes = self
            .tree
            .paint(inner, Surface::Content, look.styles.palette)?;
        let bytes = crate::bubble::blit(frame, inner, at, &bytes);
        if w.paint_popup_overlay(self.id, frame, &bytes, self.material.as_ref())? {
            self.tree.acknowledge();
            self.dirty = false;
            return Ok(true);
        }
        Ok(false)
    }

    /// Its nodes for the dock's tree, at the popup's configured place in dock coordinates:
    /// one provider, no second window (#971).
    pub fn semantics(&mut self, w: &Window) -> Option<nk_a11y::Tree> {
        let (x, y) = w.menu_popup_origin(self.id)?;
        let mut tree = self.tree.semantics();
        for node in tree.nodes.values_mut() {
            node.bounds.x += f64::from(x) + self.body[0];
            node.bounds.y += f64::from(y) + self.body[1];
        }
        self.tree.acknowledge_semantics();
        Some(tree)
    }
}

/// The dock's one popup: a menu, or the window chooser.
pub enum Overlay {
    Menu(Box<Popup>),
    Chooser(Box<crate::chooser::Chooser>),
}

macro_rules! each {
    ($self:expr, $p:ident => $e:expr) => {
        match $self {
            Overlay::Menu($p) => $e,
            Overlay::Chooser($p) => $e,
        }
    };
}

impl Overlay {
    pub fn id(&self) -> PopupId {
        each!(self, p => p.id)
    }
    pub fn anchor(&self) -> Option<&String> {
        each!(self, p => p.anchor.as_ref())
    }
    pub fn follow(
        &mut self,
        w: &mut Window,
        rect: [i32; 4],
        side: PopupSide,
    ) -> Result<(), String> {
        each!(self, p => p.follow(w, rect, side))
    }
    pub fn close(self, w: &mut Window) {
        each!(self, p => p.close(w))
    }
    pub fn event(&mut self, w: &mut Window, event: PopupEvent) -> Result<Outcome, String> {
        match self {
            Overlay::Menu(p) => p.event(w, event),
            Overlay::Chooser(p) => p.event(event),
        }
    }
    pub fn request(&mut self, id: NodeId, activate: bool) -> Result<Outcome, String> {
        each!(self, p => p.request(id, activate))
    }
    pub fn owns(&self, id: NodeId) -> bool {
        each!(self, p => p.owns(id))
    }
    pub fn sync(&mut self, w: &mut Window, look: &mut Look) -> Result<bool, String> {
        each!(self, p => p.sync(w, look))
    }
    pub fn semantics(&mut self, w: &Window) -> Option<nk_a11y::Tree> {
        each!(self, p => p.semantics(w))
    }
}
