//! The window manager: workspaces, which windows are tiled or floating, fullscreen and
//! maximized, focus, and where each window goes.
//!
//! Hyalo is dual (#682): every workspace is floating or tiling, as the desktop has been on
//! Hyprland (`WorkspaceModes`, #513), floating by default. A tiled window's box comes from the
//! workspace's tiling layout (`layout/`); a floating one keeps the box it asked for or was
//! dragged to, held inside the usable area (#11).
//!
//! `Wm` is the model; Smithay's `Space` holds only what is VISIBLE, in stacking order, and is
//! rebuilt from the model by `sync_space` after every change — so a window on a hidden
//! workspace is not in the space at all, and gets no frames, no input and no outputs.
//!
//! #594, by construction: a workspace remembers its HOME output. When that output goes away
//! the workspace is shown on another one; when it returns (same connector name), the workspace
//! goes back. A floating window's box is kept relative to its output, so it comes back where
//! it was.

pub mod actions;
pub mod games;
pub mod grabs;
pub mod layout;
pub mod rules;

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use smithay::{
    desktop::Window,
    output::Output,
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{Resource, protocol::wl_surface::WlSurface},
    },
    utils::{Logical, Point, Rectangle, SERIAL_COUNTER, Size},
    wayland::{
        compositor::with_states,
        seat::WaylandFocus,
        shell::xdg::{SurfaceCachedState, XdgToplevelSurfaceData, dialog::ToplevelDialogHint},
    },
};

use crate::{
    config::LayoutConfig,
    state::Hyalo,
};
use layout::{Layout, Rect};

pub type WindowId = u64;

/// How much of the screen a window takes, over its tiled or floating box. (Named for the
/// question the shell asks — "is it fullscreen?" — hence a variant of the same name.)
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fullscreen {
    None,
    /// The usable area, inside the gaps: bar and dock stay.
    Maximized,
    /// The whole output, over the bar.
    Fullscreen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    Floating,
    Tiling,
}

impl WorkspaceMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "floating" => Some(Self::Floating),
            "tiling" => Some(Self::Tiling),
            _ => None,
        }
    }
}

/// A window and everything the window manager knows about it.
#[derive(Debug)]
pub struct Managed {
    pub id: WindowId,
    pub window: Window,
    pub workspace: i32,
    pub floating: bool,
    /// The floating box (the client's own geometry, no border), relative to the origin of the
    /// workspace's output. `None` until the window has been floating once.
    pub float_rect: Option<Rect>,
    pub fullscreen: Fullscreen,
    pub pseudo: bool,
    pub pinned: bool,
    /// Placed for the first time (it has a buffer and a size).
    pub mapped: bool,
    /// Where it is, global logical pixels: the box it was laid out at.
    pub rect: Rect,
    /// The order of focus, most recent highest.
    pub focus_serial: u64,
    /// A size we asked a floating window to shrink to, and the size it had then: a client
    /// whose minimum is larger than the usable area refuses, and must not be asked forever.
    pub clamp_ask: Option<(Size<i32, Logical>, Size<i32, Logical>)>,
    /// The app id and title the window had when it was first shown — what a rule that
    /// runs once, at open, matches against (Hyprland's `initialClass`/`initialTitle`).
    pub initial_app_id: String,
    pub initial_title: String,
    /// The rules that have applied to it, by name: a rule applies once (wm/rules.rs).
    pub rules_applied: Vec<String>,
    /// The Steam app id its process (or a parent) carries, read when it was created
    /// (games.rs).
    pub steam_app: Option<u32>,
    /// Its entry in ext-foreign-toplevel-list, once shown (capture.rs).
    pub listed: Option<smithay::wayland::foreign_toplevel_list::ForeignToplevelHandle>,
    /// Rounded corners and the blur behind it, unless a rule said no (render/window.rs).
    pub rounded: bool,
    pub backdrop: bool,
    /// Hyalo's title bar for it, unless a rule said no (render/title_bar.rs).
    pub title_bar: bool,
    /// It has Hyalo's title bar now: it asked for server-side decorations and its surface is
    /// its box (`wants_title_bar`). The bar sits on top of `rect`, inside the window's box.
    pub has_title_bar: bool,
    /// The geometry a client was last sent a configure for, because it declared it stale
    /// (`poke_stale_geometry`): sent once per geometry, never in a loop.
    pub poked_geometry: Option<Rectangle<i32, Logical>>,
}

impl Managed {
    /// The height of Hyalo's title bar over it, logical px: 0 when it has none, and in
    /// fullscreen, where nothing is drawn over a window.
    pub fn bar(&self) -> i32 {
        if self.has_title_bar && self.fullscreen != Fullscreen::Fullscreen { TITLE_BAR_H } else { 0 }
    }

    /// The window's whole box, its title bar included: what the user sees as the window.
    pub fn frame(&self) -> Rect {
        with_bar(self.rect, self.bar())
    }
}

/// The height of the title bar Hyalo draws for an app that asks for one (render/title_bar.rs),
/// logical px: the capsule and the same gap above, below and beside it (owner, 2026-10-03:
/// equal gaps, on the interface's 4 px scale) — `window_controls::BAR_MARGIN`.
pub const TITLE_BAR_H: i32 = 32;

/// The client's box `r` with a bar of `bar` px on top of it: the window's whole box.
pub fn with_bar(r: Rect, bar: i32) -> Rect {
    Rectangle::new((r.loc.x, r.loc.y - bar).into(), (r.size.w, r.size.h + bar).into())
}

/// The client's part of a whole box `r` whose top `bar` px are the title bar.
pub fn without_bar(r: Rect, bar: i32) -> Rect {
    Rectangle::new((r.loc.x, r.loc.y + bar).into(), (r.size.w, (r.size.h - bar).max(1)).into())
}

/// A client's box held inside `area` with its title bar: the bar, not the client, is what may
/// never leave by the top (`clamp_floating`).
pub fn clamp_floating_with_bar(r: Rect, area: Rect, bar: i32) -> Rect {
    without_bar(clamp_floating(with_bar(r, bar), area), bar)
}

pub struct Workspace {
    pub id: i32,
    /// `"3"`; `"special:magic"` for a special one; a name for a named one (`gamespace`).
    pub name: String,
    /// The output it is on now, and the one it belongs to.
    pub output: String,
    pub home: String,
    pub layout: Box<dyn Layout>,
}

impl std::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace").field("id", &self.id).field("name", &self.name).field("output", &self.output).finish()
    }
}

/// Where the ids of named workspaces start, going down — Hyprland's numbering, so the shell
/// reads a named workspace the same way from both compositors (negative, not special).
const FIRST_NAMED_ID: i32 = -1337;

impl Workspace {
    /// Shown OVER an output's workspace, toggled (a scratchpad). Named `special:NAME`.
    pub fn is_special(&self) -> bool {
        self.name.starts_with("special:")
    }

    /// One of the numbered workspaces the user moves between (1, 2…). Named and special
    /// workspaces have negative ids, as on Hyprland.
    pub fn is_numbered(&self) -> bool {
        self.id > 0
    }
}

/// The window control under the pointer (protocols/window_controls.rs), and whether it is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlsHover {
    pub window: WindowId,
    pub button: crate::protocols::window_controls::Button,
    pub pressed: bool,
}

#[derive(Debug, Default)]
pub struct Wm {
    /// Every window, in stacking order, bottom first.
    pub windows: Vec<Managed>,
    pub workspaces: BTreeMap<i32, Workspace>,
    /// The workspace each output shows, by connector name.
    pub active: HashMap<String, i32>,
    /// A special workspace shown over an output.
    pub special_shown: HashMap<String, i32>,
    pub focused: Option<WindowId>,
    /// The window control under the pointer, drawn hovered (render/controls.rs).
    pub controls_hover: Option<ControlsHover>,
    /// The pointer is over Hyalo's chrome of a window (a control, a title bar).
    pub over_chrome: bool,
    /// The last left press on a title bar, for a double click (input.rs).
    pub last_bar_press: Option<(WindowId, u32)>,
    /// The output the user is on: the focused window's, or the pointer's.
    pub focused_output: Option<String>,
    /// Where `workspace previous` goes back to.
    pub previous_workspace: Option<i32>,
    /// Per-workspace modes set at runtime (IPC), over the configuration's.
    pub mode_overrides: BTreeMap<i32, WorkspaceMode>,
    next_id: WindowId,
    focus_counter: u64,
    /// What changed since the last IPC broadcast (`Hyalo::broadcast_wm_changes`).
    pub dirty_windows: bool,
    pub dirty_workspaces: bool,
    pub announced_focus: Option<Option<WindowId>>,
    /// A window being moved or resized with the pointer.
    pub grab: Option<grabs::Active>,
    /// The real pointer is not drawn (input is unaffected): the shell's agent pointer draws
    /// its own, and a hardware cursor plane would always be on top of it.
    pub cursor_hidden: bool,
}

impl Wm {
    pub fn get(&self, id: WindowId) -> Option<&Managed> {
        self.windows.iter().find(|m| m.id == id)
    }

    pub fn get_mut(&mut self, id: WindowId) -> Option<&mut Managed> {
        self.windows.iter_mut().find(|m| m.id == id)
    }

    pub fn by_window(&self, window: &Window) -> Option<&Managed> {
        self.windows.iter().find(|m| &m.window == window)
    }

    pub fn by_surface(&self, surface: &WlSurface) -> Option<&Managed> {
        self.windows
            .iter()
            .find(|m| m.window.toplevel().is_some_and(|t| t.wl_surface() == surface))
    }

    pub fn on_workspace(&self, ws: i32) -> impl Iterator<Item = &Managed> {
        self.windows.iter().filter(move |m| m.workspace == ws && m.mapped)
    }

    /// The workspaces on screen: each output's active one, and any special one shown.
    pub fn visible_workspaces(&self) -> Vec<i32> {
        self.active.values().chain(self.special_shown.values()).copied().collect()
    }

    pub fn is_visible(&self, ws: i32) -> bool {
        self.active.values().any(|w| *w == ws) || self.special_shown.values().any(|w| *w == ws)
    }

    /// The most recently focused window of a workspace.
    pub fn last_focused_on(&self, ws: i32) -> Option<WindowId> {
        self.on_workspace(ws).filter(|m| m.focus_serial > 0).max_by_key(|m| m.focus_serial).map(|m| m.id)
            .or_else(|| self.on_workspace(ws).last().map(|m| m.id))
    }

    pub fn special_id(&self, name: &str) -> Option<i32> {
        self.workspaces.values().find(|w| w.is_special() && w.name == format!("special:{name}")).map(|w| w.id)
    }

    pub fn named_id(&self, name: &str) -> Option<i32> {
        self.workspaces.values().find(|w| !w.is_numbered() && !w.is_special() && w.name == name).map(|w| w.id)
    }

    pub fn is_special(&self, ws: i32) -> bool {
        self.workspaces.get(&ws).is_some_and(|w| w.is_special())
    }
}

/// `r` shrunk by `by` on every side.
pub fn inset(r: Rect, by: i32) -> Rect {
    Rectangle::new(
        (r.loc.x + by, r.loc.y + by).into(),
        ((r.size.w - 2 * by).max(1), (r.size.h - 2 * by).max(1)).into(),
    )
}

/// A floating box held inside `area`: no larger than it, and moved in with the TOP edge
/// winning — if it still does not fit it hangs off the bottom, never off the top, where its
/// header is. The law KWin, mutter and niri implement (#11; `config/hypr/hyprland.lua` has
/// the long version for Hyprland, which does neither).
pub fn clamp_floating(r: Rect, area: Rect) -> Rect {
    let w = r.size.w.min(area.size.w).max(1);
    let h = r.size.h.min(area.size.h).max(1);
    let mut x = r.loc.x;
    let mut y = r.loc.y;
    x = x.min(area.loc.x + area.size.w - w);
    x = x.max(area.loc.x);
    y = y.min(area.loc.y + area.size.h - h);
    y = y.max(area.loc.y);
    Rectangle::new((x, y).into(), (w, h).into())
}

/// The corner radius windows are drawn with (`config/hypr/hyprland.lua` ROUNDING): the
/// cascade's smallest step leaves a covered window's corner reading as a corner.
const WINDOW_ROUNDING: i32 = 24;

/// A new floating window that would COMPLETELY cover another is stepped down and right
/// until it does not — KWin's `Placement::cascadeIfCovering`, as the Hyprland session does it
/// (`config/hypr/hyprland.lua`, "A new floating window does not land on top of the last
/// one"). It does not cascade everything: the first window of a workspace stays centred, and
/// a small dialog over its big parent never moves. Out of room, the original place stays.
pub fn cascade(r: Rect, others: &[Rect], area: Rect, gaps_out: i32) -> Rect {
    let step = (WINDOW_ROUNDING + gaps_out).max(area.size.w.min(area.size.h) / 48);
    let mut p = r;
    for _ in 0..8 {
        let covered = others.iter().find(|o| {
            p.loc.x <= o.loc.x
                && p.loc.y <= o.loc.y
                && p.loc.x + p.size.w >= o.loc.x + o.size.w
                && p.loc.y + p.size.h >= o.loc.y + o.size.h
        });
        let Some(o) = covered else { return p };
        p.loc = (o.loc.x + step, o.loc.y + step).into();
        if p.loc.x + p.size.w > area.loc.x + area.size.w || p.loc.y + p.size.h > area.loc.y + area.size.h {
            return r;
        }
    }
    p
}

/// A box of `size` centred in `area`.
pub fn centered(size: Size<i32, Logical>, area: Rect) -> Rect {
    Rectangle::new(
        (area.loc.x + (area.size.w - size.w) / 2, area.loc.y + (area.size.h - size.h) / 2).into(),
        size,
    )
}

fn toplevel_data<T>(
    window: &Window,
    f: impl FnOnce(&smithay::wayland::shell::xdg::XdgToplevelSurfaceRoleAttributes) -> T,
) -> Option<T> {
    let t = window.toplevel()?;
    Some(with_states(t.wl_surface(), |states| {
        f(&states.data_map.get::<XdgToplevelSurfaceData>().unwrap().lock().unwrap())
    }))
}

pub fn app_id(window: &Window) -> String {
    toplevel_data(window, |d| d.app_id.clone()).flatten().unwrap_or_default()
}

pub fn title(window: &Window) -> String {
    toplevel_data(window, |d| d.title.clone()).flatten().unwrap_or_default()
}

/// Whether `window` gets Hyalo's title bar: it asked for server-side decorations (or left the
/// choice to us), it is not one of our own apps (those carry Hyalo's controls in their own
/// header, protocols/window_controls.rs) — and, once it has drawn (`predict` false), its surface
/// is its box, so it took the answer and dropped its own frame. A client told server-side that
/// draws its own frame anyway keeps a shadow margin, and gets no second bar over it.
fn wants_title_bar(window: &Window, predict: bool) -> bool {
    let Some(t) = window.toplevel() else { return false };
    let surface = t.wl_surface();
    if crate::shell::decoration::asked(surface) != Some(true) || crate::protocols::window_controls::rect(surface).is_some() {
        return false;
    }
    predict || crate::render::window::fits(window)
}

/// Whether `surface`'s opaque region reaches outside `geo` (surface-local): pixels it calls
/// opaque cannot be a shadow margin.
fn opaque_outside(surface: &WlSurface, geo: Rectangle<i32, Logical>) -> bool {
    use smithay::backend::renderer::utils::RendererSurfaceStateUserData;
    with_states(surface, |states| {
        let Some(s) = states.data_map.get::<RendererSurfaceStateUserData>() else { return false };
        let s = s.lock().unwrap();
        s.opaque_regions().is_some_and(|rs| rs.iter().any(|r| r.intersection(geo) != Some(*r)))
    })
}

/// A dialog, or a window that cannot be resized: these float wherever they open, as on
/// every desktop — a tile would stretch a fixed-size window or tear a dialog off its parent.
fn wants_floating(window: &Window) -> bool {
    let Some(t) = window.toplevel() else { return false };
    if t.parent().is_some() {
        return true;
    }
    with_states(t.wl_surface(), |states| {
        let mut cached = states.cached_state.get::<SurfaceCachedState>();
        let s = cached.current();
        s.min_size.w > 0 && s.min_size == s.max_size
    })
}

impl Hyalo {
    // ── Lookups ────────────────────────────────────────────────────────────────────────

    pub fn output_named(&self, name: &str) -> Option<Output> {
        self.space.outputs().find(|o| o.name() == name).cloned()
    }

    /// The output the user is on.
    pub fn focused_output(&self) -> Option<Output> {
        self.wm
            .focused_output
            .as_deref()
            .and_then(|n| self.output_named(n))
            .or_else(|| {
                let p = self.seat.get_pointer()?.current_location();
                self.space.output_under(p).next().cloned()
            })
            .or_else(|| self.space.outputs().next().cloned())
    }

    /// The usable area of an output: what the bar and dock leave, global coordinates.
    pub fn work_area(&self, output: &Output) -> Rect {
        let Some(og) = self.space.output_geometry(output) else { return Rect::default() };
        let zone = crate::shell::layer::usable_zone(output);
        Rectangle::new(og.loc + zone.loc, zone.size)
    }

    /// Where floating windows may be: the usable area inside the gaps and the border.
    fn floating_area(&self, output: &Output) -> Rect {
        let l = &self.config.layout;
        inset(self.work_area(output), l.gaps_out + l.border)
    }

    pub fn workspace_mode(&self, ws: i32) -> WorkspaceMode {
        if let Some(m) = self.wm.mode_overrides.get(&ws) {
            return *m;
        }
        self.config.workspaces.mode_of(ws)
    }

    /// The workspace an output shows, created if it shows none yet.
    pub fn active_workspace(&mut self, output: &str) -> i32 {
        if let Some(ws) = self.wm.active.get(output) {
            return *ws;
        }
        // A workspace that belongs here and is not shown elsewhere, else the lowest free number.
        let shown: Vec<i32> = self.wm.active.values().copied().collect();
        let id = self
            .wm
            .workspaces
            .values()
            .find(|w| w.is_numbered() && w.home == output && !shown.contains(&w.id))
            .map(|w| w.id)
            .unwrap_or_else(|| (1..).find(|i| !self.wm.workspaces.contains_key(i)).unwrap());
        self.ensure_workspace(id, output);
        if let Some(w) = self.wm.workspaces.get_mut(&id) {
            w.output = output.into();
        }
        self.wm.active.insert(output.into(), id);
        self.wm.dirty_workspaces = true;
        id
    }

    /// A numbered workspace, created if it does not exist. (A named or special one is made
    /// by name: `ensure_named`, `ensure_special`.)
    fn ensure_workspace(&mut self, id: i32, output: &str) {
        if id <= 0 || self.wm.workspaces.contains_key(&id) {
            return;
        }
        let layout = layout::new(&self.config.layout.tiling).unwrap_or_else(|| layout::new("dwindle").unwrap());
        self.wm.workspaces.insert(
            id,
            Workspace { id, name: id.to_string(), output: output.into(), home: output.into(), layout },
        );
        self.wm.dirty_workspaces = true;
    }

    /// A named workspace (`gamespace`): a whole workspace like a numbered one, shown in its
    /// output's place, but outside the numbered row the user cycles through.
    fn ensure_named(&mut self, name: &str, output: &str) -> i32 {
        if let Some(id) = self.wm.named_id(name) {
            return id;
        }
        let id = (0..).map(|i: i32| FIRST_NAMED_ID - i).find(|i| !self.wm.workspaces.contains_key(i)).unwrap();
        let layout = layout::new(&self.config.layout.tiling).unwrap_or_else(|| layout::new("dwindle").unwrap());
        self.wm.workspaces.insert(id, Workspace { id, name: name.into(), output: output.into(), home: output.into(), layout });
        self.wm.dirty_workspaces = true;
        id
    }

    fn ensure_special(&mut self, name: &str, output: &str) -> i32 {
        if let Some(id) = self.wm.special_id(name) {
            return id;
        }
        let id = (1..).map(|i: i32| -i).find(|i| !self.wm.workspaces.contains_key(i)).unwrap();
        let layout = layout::new(&self.config.layout.tiling).unwrap_or_else(|| layout::new("dwindle").unwrap());
        self.wm.workspaces.insert(
            id,
            Workspace { id, name: format!("special:{name}"), output: output.into(), home: output.into(), layout },
        );
        self.wm.dirty_workspaces = true;
        id
    }

    /// Drops workspaces nobody sees and nothing is on.
    fn prune_workspaces(&mut self) {
        let keep: Vec<i32> = self
            .wm
            .workspaces
            .keys()
            .copied()
            .filter(|id| self.wm.is_visible(*id) || self.wm.windows.iter().any(|m| m.workspace == *id))
            .collect();
        let before = self.wm.workspaces.len();
        self.wm.workspaces.retain(|id, _| keep.contains(id));
        if self.wm.workspaces.len() != before {
            self.wm.dirty_workspaces = true;
        }
    }

    // ── Windows coming and going ──────────────────────────────────────────────────────────

    /// A new toplevel: known from now on, placed on its first buffer (`window_mapped`).
    pub fn window_created(&mut self, window: Window) {
        let output = self.focused_output().map(|o| o.name()).unwrap_or_default();
        // A special workspace shown over the output takes the windows opened there, as on
        // Hyprland — the scratchpad is opened to be filled.
        let workspace = match self.wm.special_shown.get(&output).copied() {
            Some(s) => s,
            None => self.active_workspace(&output),
        };
        let dh = &self.display_handle;
        let steam_app = window
            .toplevel()
            .and_then(|t| t.wl_surface().client())
            .and_then(|c| c.get_credentials(dh).ok())
            .and_then(|c| games::steam_app_of(c.pid));
        self.wm.next_id += 1;
        let id = self.wm.next_id;
        self.wm.windows.push(Managed {
            id,
            window,
            workspace,
            floating: true,
            float_rect: None,
            fullscreen: Fullscreen::None,
            pseudo: false,
            pinned: false,
            mapped: false,
            rect: Rect::default(),
            focus_serial: 0,
            clamp_ask: None,
            initial_app_id: String::new(),
            initial_title: String::new(),
            rules_applied: Vec::new(),
            steam_app,
            listed: None,
            rounded: true,
            backdrop: true,
            title_bar: true,
            has_title_bar: false,
            poked_geometry: None,
        });
    }

    /// Before the first configure: a window that will be tiled is told its tile's size, so
    /// it draws its first frame at the size it will have.
    pub fn initial_configure(&mut self, window: &Window) {
        let Some(m) = self.wm.by_window(window) else { return };
        let (id, mut ws) = (m.id, m.workspace);
        let Some(t) = window.toplevel() else { return };
        // What the rules will want when it is shown, so its first frame is already right.
        let fx = self.new_rule_effects(id, false);
        if let Some(w) = &fx.workspace {
            let output = self.wm.workspaces.get(&ws).map(|w| w.output.clone()).unwrap_or_default();
            ws = self.rule_workspace(w, &output);
            self.wm.get_mut(id).unwrap().workspace = ws;
        }
        let tiled = fx.float.map_or(self.workspace_mode(ws) == WorkspaceMode::Tiling && !wants_floating(window), |f| !f);
        // Whether it will have Hyalo's title bar, before it has drawn anything: it asked for
        // server-side decorations — corrected at map, when its surface can be measured.
        let bar = fx.title_bar.unwrap_or(true) && wants_title_bar(window, true);
        self.wm.get_mut(id).unwrap().has_title_bar = bar;
        if tiled
            && let Some(rect) = self.predicted_tile(ws, id)
        {
            t.with_pending_state(|s| {
                s.size = Some(rect.size);
                for st in TILED {
                    s.states.set(st);
                }
            });
        }
        if let Some(o) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) {
            let bounds = self.floating_area(&o).size;
            t.with_pending_state(|s| s.bounds = Some(bounds));
        }
        t.send_configure();
    }

    /// The box `id` would get if tiled on `ws` now.
    fn predicted_tile(&self, ws: i32, id: WindowId) -> Option<Rect> {
        let w = self.wm.workspaces.get(&ws)?;
        let output = self.output_named(&w.output)?;
        let area = inset(self.work_area(&output), self.config.layout.gaps_out);
        // A throwaway copy of the layout: the same placement `window_mapped` will make.
        let mut probe = layout::new(w.layout.name())?;
        for other in w.layout.windows() {
            probe.insert(other, area, None, None);
        }
        // Rebuilding loses the split ratios; good enough for a first size, corrected at map.
        let near = self.wm.last_focused_on(ws).filter(|n| w.layout.contains(*n));
        probe.insert(id, area, near, None);
        let b = probe.arrange(area, self.config.layout.gaps_in).into_iter().find(|(w, _)| *w == id)?.1;
        let bar = self.wm.get(id).map_or(0, |m| m.bar());
        Some(without_bar(inset(b, self.config.layout.border), bar))
    }

    /// The window's first buffer: it is placed — tiled or floating — and takes the focus.
    pub fn window_mapped(&mut self, window: &Window) {
        let Some(m) = self.wm.by_window(window) else { return };
        let (id, mut ws) = (m.id, m.workspace);
        let fx = self.new_rule_effects(id, true);
        self.apply_look(id, &fx);
        // Its first buffer: now its surface says whether it took the server-side decorations.
        let wants = self.wm.get(id).is_some_and(|m| m.title_bar) && wants_title_bar(window, false);
        self.wm.get_mut(id).unwrap().has_title_bar = wants;
        let bar = if wants { TITLE_BAR_H } else { 0 };
        if let Some(w) = &fx.workspace {
            let output = self.wm.workspaces.get(&ws).map(|w| w.output.clone()).unwrap_or_default();
            ws = self.rule_workspace(w, &output);
            self.wm.get_mut(id).unwrap().workspace = ws;
        }
        let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { return };
        let tiled = fx.float.map_or(self.workspace_mode(ws) == WorkspaceMode::Tiling && !wants_floating(window), |f| !f);
        let size = window.geometry().size;
        let og = self.space.output_geometry(&output).unwrap_or_default();
        // A dialog opens over its parent; anything else in the middle of the usable area.
        let parent_rect = window
            .toplevel()
            .and_then(|t| t.parent())
            .and_then(|p| self.wm.by_surface(&p))
            .filter(|p| p.mapped)
            .map(|p| p.frame());
        let area = self.floating_area(&output);
        let others: Vec<Rect> = self
            .wm
            .on_workspace(ws)
            .filter(|o| o.id != id && o.fullscreen == Fullscreen::None)
            .map(|o| o.frame())
            .collect();
        // Placed by its whole box, its title bar included.
        let framed = Size::from((size.w, size.h + bar));
        let float = if fx.center {
            // A rule's `center`: the middle of the usable area, nothing else considered.
            clamp_floating(centered(framed, area), area)
        } else {
            let float = clamp_floating(centered(framed, parent_rect.unwrap_or(area)), area);
            cascade(float, &others, area, self.config.layout.gaps_out)
        };
        let float = without_bar(float, bar);
        let near = self.wm.focused.filter(|f| self.wm.get(*f).is_some_and(|m| m.workspace == ws));
        let cursor = self.seat.get_pointer().map(|p| p.current_location());
        let tiled_area = inset(self.work_area(&output), self.config.layout.gaps_out);
        let (initial_app_id, initial_title) = (app_id(window), title(window));
        if let Some(m) = self.wm.get_mut(id) {
            m.initial_app_id = initial_app_id;
            m.initial_title = initial_title;
            m.mapped = true;
            m.floating = !tiled;
            m.float_rect = Some(Rectangle::new(float.loc - og.loc, float.size));
        }
        if tiled && let Some(w) = self.wm.workspaces.get_mut(&ws) {
            w.layout.insert(id, tiled_area, near, cursor);
        }
        if float.size != size && !tiled
            && let Some(m) = self.wm.get_mut(id)
        {
            m.clamp_ask = Some((float.size, size));
        }
        self.list_window(id);
        self.wm.dirty_windows = true;
        self.wm.dirty_workspaces = true;
        // Sent elsewhere `silent`ly: it opens there without taking the user — or the focus.
        if !(fx.workspace.is_some() && fx.silent) {
            self.focus_window(Some(id));
        }
        self.arrange_workspace(ws);
        self.sync_space();
    }

    pub fn window_destroyed(&mut self, window: &Window) {
        let Some(m) = self.wm.by_window(window) else { return };
        let (id, ws) = (m.id, m.workspace);
        if let Some(w) = self.wm.workspaces.get_mut(&ws) {
            w.layout.remove(id);
        }
        let listed = self.wm.get_mut(id).and_then(|m| m.listed.take());
        self.unlist_window(listed);
        self.wm.windows.retain(|m| m.id != id);
        self.wm.dirty_windows = true;
        if self.wm.focused == Some(id) {
            self.wm.focused = None;
            // The keyboard goes to the window focused before it on the same workspace.
            let next = self.wm.last_focused_on(ws);
            self.focus_window(next);
        }
        self.arrange_workspace(ws);
        self.prune_workspaces();
        self.sync_space();
    }

    /// A commit of a mapped window: whether it has Hyalo's title bar, and a floating one's
    /// box follows the client's own size.
    pub fn window_committed(&mut self, window: &Window) {
        self.update_title_bar(window);
        let Some(m) = self.wm.by_window(window) else { return };
        if self.wm.grab.is_some_and(|g| g.id == m.id) {
            let id = m.id;
            self.grab_commit(id);
            return;
        }
        if !m.mapped || !m.floating || m.fullscreen != Fullscreen::None {
            return;
        }
        let (id, ws, bar) = (m.id, m.workspace, m.bar());
        let size = window.geometry().size;
        let Some(fr) = m.float_rect else { return };
        if fr.size == size {
            return;
        }
        let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { return };
        let og = self.space.output_geometry(&output).unwrap_or_default();
        let area = self.floating_area(&output);
        let global = Rectangle::new(fr.loc + og.loc, size);
        let clamped = clamp_floating_with_bar(global, area, bar);
        let ask = m.clamp_ask;
        let m = self.wm.get_mut(id).unwrap();
        m.float_rect = Some(Rectangle::new(clamped.loc - og.loc, size));
        // Larger than the usable area: asked to shrink once per size it grows to — a client
        // whose minimum does not fit refuses, and is left hanging off the bottom.
        if clamped.size != size && ask.is_none_or(|(_, seen)| seen != size) {
            m.clamp_ask = Some((clamped.size, size));
            m.float_rect = Some(Rectangle::new(clamped.loc - og.loc, clamped.size));
        }
        self.arrange_workspace(ws);
        self.sync_space();
    }

    // ── Laying out ────────────────────────────────────────────────────────────────────

    /// Gives every window of `ws` its box and tells it its size and state.
    pub fn arrange_workspace(&mut self, ws: i32) {
        let Some(w) = self.wm.workspaces.get(&ws) else { return };
        let Some(output) = self.output_named(&w.output) else { return };
        let og = self.space.output_geometry(&output).unwrap_or_default();
        let l: LayoutConfig = self.config.layout.clone();
        let work = self.work_area(&output);
        let tiled_area = inset(work, l.gaps_out);
        let boxes: HashMap<WindowId, Rect> = w.layout.arrange(tiled_area, l.gaps_in).into_iter().collect();
        let float_area = self.floating_area(&output);
        for m in self.wm.windows.iter_mut().filter(|m| m.workspace == ws && m.mapped) {
            let Some(t) = m.window.toplevel() else { continue };
            let tiled = boxes.get(&m.id).copied();
            // Hyalo's title bar takes the top of the box it is given; the client gets the rest.
            let bar = m.bar();
            let (rect, size): (Rect, Option<Size<i32, Logical>>) = match (m.fullscreen, tiled) {
                (Fullscreen::Fullscreen, _) => (og, Some(og.size)),
                (Fullscreen::Maximized, _) => {
                    let r = without_bar(float_area, bar);
                    (r, Some(r.size))
                }
                (Fullscreen::None, Some(b)) => {
                    let b = without_bar(inset(b, l.border), bar);
                    if m.pseudo {
                        // Its own size, centred in its tile and no larger than it.
                        let want = m.float_rect.map(|r| r.size).unwrap_or(b.size);
                        let s = Size::from((want.w.min(b.size.w), want.h.min(b.size.h)));
                        (centered(s, b), Some(s))
                    } else {
                        (b, Some(b.size))
                    }
                }
                (Fullscreen::None, None) => {
                    let fr = m.float_rect.unwrap_or_else(|| Rectangle::new((0, 0).into(), m.window.geometry().size));
                    (Rectangle::new(fr.loc + og.loc, fr.size), Some(fr.size))
                }
            };
            m.rect = rect;
            let is_tiled = tiled.is_some() && m.fullscreen == Fullscreen::None;
            t.with_pending_state(|s| {
                s.size = size.filter(|s| s.w > 0 && s.h > 0);
                s.bounds = Some(float_area.size);
                for st in TILED {
                    if is_tiled {
                        s.states.set(st);
                    } else {
                        s.states.unset(st);
                    }
                }
                match m.fullscreen {
                    Fullscreen::Fullscreen => {
                        s.states.set(xdg_toplevel::State::Fullscreen);
                        s.states.unset(xdg_toplevel::State::Maximized);
                        s.fullscreen_output = output.client_outputs(&t.wl_surface().client().unwrap()).next();
                    }
                    Fullscreen::Maximized => {
                        s.states.unset(xdg_toplevel::State::Fullscreen);
                        s.states.set(xdg_toplevel::State::Maximized);
                        s.fullscreen_output = None;
                    }
                    Fullscreen::None => {
                        s.states.unset(xdg_toplevel::State::Fullscreen);
                        s.states.unset(xdg_toplevel::State::Maximized);
                        s.fullscreen_output = None;
                    }
                }
            });
            if t.is_initial_configure_sent() {
                t.send_pending_configure();
            }
        }
    }

    pub fn arrange_all(&mut self) {
        let ids: Vec<i32> = self.wm.workspaces.keys().copied().collect();
        for ws in ids {
            self.arrange_workspace(ws);
        }
        self.sync_space();
    }

    /// The space made to match the model: what is visible, where, in what order, and which
    /// window is active.
    pub fn sync_space(&mut self) {
        let mut order: Vec<WindowId> = Vec::new();
        let outputs: Vec<String> = self.space.outputs().map(|o| o.name()).collect();
        for o in &outputs {
            let layer_ids = |ws: i32, order: &mut Vec<WindowId>| {
                let on: Vec<&Managed> = self.wm.on_workspace(ws).collect();
                // A fullscreen window hides the rest of its workspace.
                if let Some(fs) = on.iter().rev().find(|m| m.fullscreen == Fullscreen::Fullscreen) {
                    order.push(fs.id);
                    return;
                }
                let tiled = |m: &Managed| !m.floating && m.fullscreen == Fullscreen::None;
                order.extend(on.iter().filter(|m| tiled(m)).map(|m| m.id));
                order.extend(on.iter().filter(|m| !tiled(m)).map(|m| m.id));
            };
            if let Some(ws) = self.wm.active.get(o).copied() {
                layer_ids(ws, &mut order);
            }
            if let Some(ws) = self.wm.special_shown.get(o).copied() {
                layer_ids(ws, &mut order);
            }
        }
        let hidden: Vec<Window> = self
            .space
            .elements()
            .filter(|w| self.wm.by_window(w).is_none_or(|m| !order.contains(&m.id)))
            .cloned()
            .collect();
        for w in hidden {
            self.space.unmap_elem(&w);
        }
        let focused = self.wm.focused;
        for id in order {
            let Some(m) = self.wm.get(id) else { continue };
            let window = m.window.clone();
            // A space element's location is its GEOMETRY's origin; Smithay subtracts the
            // client's decoration offset itself where it draws and hit-tests.
            let loc = m.rect.loc;
            if self.wm.grab.is_none_or(|g| g.id != id) {
                self.space.map_element(window.clone(), loc, false);
            } else {
                self.space.raise_element(&window, false);
            }
            if window.set_activated(focused == Some(id))
                && let Some(t) = window.toplevel()
                && t.is_initial_configure_sent()
            {
                t.send_pending_configure();
            }
        }
        self.queue_redraw(None);
    }

    // ── Focus ─────────────────────────────────────────────────────────────────────────

    /// Gives a window the keyboard, showing its workspace first if it is hidden. `None` = no
    /// window has the focus (a click on the bare desktop). A window with a MODAL dialog open
    /// (xdg-dialog-v1) gives way to the dialog: every route to focus comes through here — a
    /// click, the keyboard, the IPC, the overview — so the parent cannot be worked in behind
    /// a dialog that is waiting for an answer.
    pub fn focus_window(&mut self, id: Option<WindowId>) {
        let serial = SERIAL_COUNTER.next_serial();
        let Some(id) = id else {
            self.wm.focused = None;
            self.set_keyboard_focus(None, serial);
            self.sync_space();
            return;
        };
        let id = self.modal_target(id);
        let Some(m) = self.wm.get(id) else { return };
        let ws = m.workspace;
        if !self.wm.is_visible(ws) {
            if self.wm.is_special(ws) {
                let output = self.wm.workspaces.get(&ws).map(|w| w.output.clone()).unwrap_or_default();
                self.wm.special_shown.insert(output, ws);
                self.wm.dirty_workspaces = true;
            } else {
                self.show_workspace(ws, false);
            }
        }
        // Another window of the workspace in fullscreen gives way, or this one would be
        // focused behind it.
        let others: Vec<WindowId> = self
            .wm
            .on_workspace(ws)
            .filter(|o| o.id != id && o.fullscreen == Fullscreen::Fullscreen)
            .map(|o| o.id)
            .collect();
        for o in others {
            if let Some(o) = self.wm.get_mut(o) {
                o.fullscreen = Fullscreen::None;
            }
            self.wm.dirty_windows = true;
        }
        self.wm.focus_counter += 1;
        let counter = self.wm.focus_counter;
        let pos = self.wm.windows.iter().position(|m| m.id == id).unwrap();
        let mut m = self.wm.windows.remove(pos);
        m.focus_serial = counter;
        let surface = m.window.toplevel().map(|t| t.wl_surface().clone());
        // To the top of the stack (tiled windows stay under floating ones: `sync_space`).
        self.wm.windows.push(m);
        self.wm.focused = Some(id);
        self.wm.focused_output = self.wm.workspaces.get(&ws).map(|w| w.output.clone());
        self.set_keyboard_focus(surface, serial);
        self.arrange_workspace(ws);
        self.sync_space();
    }

    /// The window that takes the focus meant for `id`: its open modal dialog, or that
    /// dialog's own, all the way down; `id` itself when it has none.
    fn modal_target(&self, id: WindowId) -> WindowId {
        let mut target = id;
        // Bounded: a client could make a cycle of parents.
        for _ in 0..8 {
            let Some(surface) = self.wm.get(target).and_then(|m| m.window.toplevel().map(|t| t.wl_surface().clone()))
            else {
                break;
            };
            let modal = self.wm.windows.iter().find(|m| {
                m.mapped
                    && m.window.toplevel().and_then(|t| t.parent()).as_ref() == Some(&surface)
                    && toplevel_data(&m.window, |d| d.dialog_hint) == Some(ToplevelDialogHint::Modal)
            });
            match modal {
                Some(m) => target = m.id,
                None => break,
            }
        }
        target
    }

    /// The keyboard back to the focused window, after a layer surface that had it went away.
    pub fn restore_keyboard_focus(&mut self) {
        // Locked: the keyboard belongs to the lock screen, never back to a window (lock.rs).
        if self.lock.is_locked() {
            self.focus_lock_surface();
            return;
        }
        let keyboard = self.seat.get_keyboard().unwrap();
        if keyboard.current_focus().is_some_and(|f| f.is_alive()) {
            return;
        }
        self.focus_window_keyboard();
    }

    /// The keyboard to the focused window, if there is one.
    pub fn focus_window_keyboard(&mut self) {
        let surface = self.wm.focused.and_then(|f| self.wm.get(f)).and_then(|m| m.window.wl_surface()).map(|s| s.into_owned());
        if surface.is_some() {
            self.set_keyboard_focus(surface, SERIAL_COUNTER.next_serial());
        }
    }

    // ── Workspaces ────────────────────────────────────────────────────────────────────

    /// Shows workspace `id` on the output it is on (created on the focused output if new) —
    /// or, when `here`, brings it to the focused output.
    pub fn show_workspace(&mut self, id: i32, here: bool) {
        let focused_out = self.focused_output().map(|o| o.name()).unwrap_or_default();
        self.ensure_workspace(id, &focused_out);
        let Some(w) = self.wm.workspaces.get(&id) else { return };
        let mut output = w.output.clone();
        if here && output != focused_out {
            output = focused_out.clone();
            self.wm.workspaces.get_mut(&id).unwrap().output = output.clone();
        }
        let current = self.wm.active.get(&output).copied();
        if current == Some(id) {
            self.wm.focused_output = Some(output);
            return;
        }
        if let Some(c) = current {
            self.wm.previous_workspace = Some(c);
        }
        self.wm.active.insert(output.clone(), id);
        self.wm.focused_output = Some(output.clone());
        // Pinned windows go with the output, whatever workspace it shows.
        let pinned: Vec<WindowId> = self
            .wm
            .windows
            .iter()
            .filter(|m| m.pinned && current == Some(m.workspace))
            .map(|m| m.id)
            .collect();
        for p in pinned {
            self.wm.get_mut(p).unwrap().workspace = id;
        }
        self.wm.dirty_workspaces = true;
        self.wm.dirty_windows = true;
        self.arrange_workspace(id);
        self.prune_workspaces();
        // The keyboard follows: the workspace's last focused window, or nothing.
        let next = self.wm.last_focused_on(id);
        if self.wm.focused != next {
            self.focus_window(next);
        } else {
            self.sync_space();
        }
    }

    /// Shows or hides a special workspace over the focused output.
    pub fn toggle_special(&mut self, name: &str) {
        let output = self.focused_output().map(|o| o.name()).unwrap_or_default();
        let id = self.ensure_special(name, &output);
        if self.wm.special_shown.get(&output) == Some(&id) {
            self.wm.special_shown.remove(&output);
            let active = self.active_workspace(&output);
            let next = self.wm.last_focused_on(active);
            self.wm.dirty_workspaces = true;
            self.prune_workspaces();
            self.focus_window(next);
            return;
        }
        // Shown on one output at a time: it comes here from wherever it was.
        self.wm.special_shown.retain(|_, w| *w != id);
        self.wm.special_shown.insert(output.clone(), id);
        self.wm.workspaces.get_mut(&id).unwrap().output = output;
        self.wm.dirty_workspaces = true;
        self.arrange_workspace(id);
        let next = self.wm.last_focused_on(id);
        match next {
            Some(n) => self.focus_window(Some(n)),
            None => self.sync_space(),
        }
    }

    /// Moves a window to another workspace; with `follow`, the view goes with it.
    pub fn move_to_workspace(&mut self, id: WindowId, target: i32, follow: bool) {
        let Some(m) = self.wm.get(id) else { return };
        let from = m.workspace;
        if from == target {
            return;
        }
        let focused_out = self.focused_output().map(|o| o.name()).unwrap_or_default();
        if target > 0 {
            self.ensure_workspace(target, &focused_out);
        }
        let to_output = self.wm.workspaces.get(&target).and_then(|w| self.output_named(&w.output));
        if let Some(w) = self.wm.workspaces.get_mut(&from) {
            w.layout.remove(id);
        }
        let window = self.wm.get(id).unwrap().window.clone();
        let floating_before = self.wm.get(id).unwrap().floating;
        // It takes the target's mode, as a window opened there would — except one that must
        // float (a dialog) or that was floated by hand on a tiling workspace.
        let floated_by_hand = self.workspace_mode(from) == WorkspaceMode::Tiling && floating_before;
        let tiled = self.workspace_mode(target) == WorkspaceMode::Tiling && !wants_floating(&window) && !floated_by_hand;
        if let Some(o) = &to_output {
            if tiled {
                let area = inset(self.work_area(o), self.config.layout.gaps_out);
                let near = self.wm.last_focused_on(target);
                if let Some(w) = self.wm.workspaces.get_mut(&target) {
                    w.layout.insert(id, area, near, None);
                }
            } else {
                // Its place relative to the output is kept, pulled inside a smaller one.
                let og = self.space.output_geometry(o).unwrap_or_default();
                let area = self.floating_area(o);
                let m = self.wm.get_mut(id).unwrap();
                let bar = m.bar();
                let fr = m.float_rect.unwrap_or(Rectangle::new(m.rect.loc - og.loc, m.rect.size));
                let fr = clamp_floating_with_bar(Rectangle::new(fr.loc + og.loc, fr.size), area, bar);
                m.float_rect = Some(Rectangle::new(fr.loc - og.loc, fr.size));
            }
        }
        let m = self.wm.get_mut(id).unwrap();
        m.workspace = target;
        m.floating = !tiled;
        m.pinned = false;
        self.wm.dirty_windows = true;
        self.wm.dirty_workspaces = true;
        self.arrange_workspace(from);
        self.arrange_workspace(target);
        if follow {
            if self.wm.is_special(target) {
                if let Some(name) = self.wm.workspaces.get(&target).map(|w| w.name.trim_start_matches("special:").to_string())
                    && !self.wm.is_visible(target)
                {
                    self.toggle_special(&name);
                }
            } else {
                self.show_workspace(target, false);
            }
            self.focus_window(Some(id));
        } else {
            if self.wm.focused == Some(id) {
                let next = self.wm.last_focused_on(from);
                self.focus_window(next);
            }
            self.prune_workspaces();
            self.sync_space();
        }
    }

    /// The numbered workspace `step` places from `from` among those that exist (`e+1`/`e-1`),
    /// round the end.
    pub fn relative_workspace(&self, from: i32, step: i32) -> i32 {
        let ids: Vec<i32> = self.wm.workspaces.keys().copied().filter(|i| *i > 0).collect();
        let Some(pos) = ids.iter().position(|i| *i == from) else { return from };
        let n = ids.len() as i32;
        ids[((pos as i32 + step).rem_euclid(n)) as usize]
    }

    /// The runtime mode of a workspace changed: its windows follow — all tiled, or all
    /// floating where they were.
    pub fn set_workspace_mode(&mut self, ws: i32, mode: Option<WorkspaceMode>) {
        let before = self.workspace_mode(ws);
        match mode {
            Some(m) => self.wm.mode_overrides.insert(ws, m),
            None => self.wm.mode_overrides.remove(&ws),
        };
        let after = self.workspace_mode(ws);
        // Only a CHANGE reorganizes: the shell re-states every workspace's mode when it
        // starts, and a window floated by hand on a tiling workspace must stay floating.
        if after != before {
            self.set_all_floating(ws, after == WorkspaceMode::Floating);
        }
        self.wm.dirty_workspaces = true;
    }

    /// Floats (or tiles) every window of a workspace that can be.
    pub fn set_all_floating(&mut self, ws: i32, floating: bool) {
        let ids: Vec<WindowId> = self
            .wm
            .on_workspace(ws)
            .filter(|m| m.floating != floating && !(!floating && wants_floating(&m.window)))
            .map(|m| m.id)
            .collect();
        for id in ids {
            self.set_floating(id, floating);
        }
        self.arrange_workspace(ws);
        self.sync_space();
    }

    pub fn set_floating(&mut self, id: WindowId, floating: bool) {
        let Some(m) = self.wm.get(id) else { return };
        if m.floating == floating {
            return;
        }
        let (ws, rect) = (m.workspace, m.rect);
        let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { return };
        let og = self.space.output_geometry(&output).unwrap_or_default();
        if floating {
            if let Some(w) = self.wm.workspaces.get_mut(&ws) {
                w.layout.remove(id);
            }
            let area = self.floating_area(&output);
            let m = self.wm.get_mut(id).unwrap();
            let bar = m.bar();
            // Back to its last floating box, else where it was tiled.
            let fr = m.float_rect.map(|r| Rectangle::new(r.loc + og.loc, r.size)).unwrap_or(rect);
            let fr = clamp_floating_with_bar(fr, area, bar);
            m.float_rect = Some(Rectangle::new(fr.loc - og.loc, fr.size));
            m.floating = true;
        } else {
            let area = inset(self.work_area(&output), self.config.layout.gaps_out);
            let near = self.wm.last_focused_on(ws).filter(|n| *n != id);
            let cursor = self.seat.get_pointer().map(|p| p.current_location());
            let m = self.wm.get_mut(id).unwrap();
            m.floating = false;
            m.pinned = false;
            if let Some(w) = self.wm.workspaces.get_mut(&ws) {
                w.layout.insert(id, area, near, cursor);
            }
        }
        self.wm.dirty_windows = true;
        self.arrange_workspace(ws);
        self.sync_space();
    }

    pub fn set_fullscreen(&mut self, id: WindowId, mode: Fullscreen) {
        let Some(m) = self.wm.get_mut(id) else { return };
        if m.fullscreen == mode {
            return;
        }
        m.fullscreen = mode;
        let ws = m.workspace;
        self.wm.dirty_windows = true;
        self.arrange_workspace(ws);
        self.sync_space();
    }

    // ── Outputs ───────────────────────────────────────────────────────────────────────

    /// Outputs came or went: each workspace goes home if it can, or to an output that is
    /// there; every output shows a workspace.
    pub fn outputs_changed(&mut self) {
        let present: Vec<String> = self.space.outputs().map(|o| o.name()).collect();
        self.wm.active.retain(|o, _| present.contains(o));
        self.wm.special_shown.retain(|o, _| present.contains(o));
        let Some(first) = present.first().cloned() else { return };
        let ids: Vec<i32> = self.wm.workspaces.keys().copied().collect();
        for id in ids {
            let w = &self.wm.workspaces[&id];
            let target = if present.contains(&w.home) {
                w.home.clone()
            } else if present.contains(&w.output) {
                w.output.clone()
            } else {
                first.clone()
            };
            if target != w.output {
                let back_home = target == w.home;
                self.wm.workspaces.get_mut(&id).unwrap().output = target.clone();
                self.wm.active.retain(|_, a| *a != id);
                // Home again: shown where it was shown before it left, if nothing better is.
                if back_home && !self.wm.workspaces[&id].is_special() && !self.wm.active.contains_key(&target) {
                    self.wm.active.insert(target.clone(), id);
                }
                self.wm.dirty_workspaces = true;
            }
        }
        for o in &present {
            self.active_workspace(o);
        }
        if self.wm.focused_output.as_ref().is_some_and(|o| !present.contains(o)) {
            self.wm.focused_output = None;
        }
        self.arrange_all();
    }

    /// The output under the pointer is the one the user is on, when no window says otherwise.
    pub fn pointer_on_output(&mut self, pos: Point<f64, Logical>) {
        let Some(name) = self.space.output_under(pos).next().map(|o| o.name()) else { return };
        if self.wm.focused_output.as_deref() != Some(&name) {
            self.wm.focused_output = Some(name);
            self.wm.dirty_workspaces = true;
        }
    }

    /// Every floating window of `ws` held inside the usable area again (#11) — after the
    /// area itself changed (a bar or a dock appeared), not after the user dragged one.
    pub fn reclamp_floating(&mut self, ws: i32) {
        let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { return };
        let og = self.space.output_geometry(&output).unwrap_or_default();
        let area = self.floating_area(&output);
        let mut moved = false;
        for m in self.wm.windows.iter_mut().filter(|m| m.workspace == ws && m.mapped && m.floating) {
            let Some(fr) = m.float_rect else { continue };
            let global = Rectangle::new(fr.loc + og.loc, fr.size);
            let inside = clamp_floating_with_bar(global, area, m.bar());
            // Moved only: a window larger than the area keeps its size until it asks again.
            let r = Rectangle::new(inside.loc, fr.size);
            if r.loc != global.loc {
                m.float_rect = Some(Rectangle::new(r.loc - og.loc, r.size));
                moved = true;
            }
        }
        if moved {
            self.wm.dirty_windows = true;
        }
    }

    /// The configured tiling layout changed: every workspace re-tiles its windows with it.
    pub fn change_tiling_layout(&mut self) {
        let name = self.config.layout.tiling.clone();
        let ids: Vec<i32> = self.wm.workspaces.keys().copied().collect();
        for ws in ids {
            let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { continue };
            let area = inset(self.work_area(&output), self.config.layout.gaps_out);
            let Some(mut fresh) = layout::new(&name) else { return };
            let w = self.wm.workspaces.get_mut(&ws).unwrap();
            for id in w.layout.windows() {
                fresh.insert(id, area, None, None);
            }
            w.layout = fresh;
        }
        self.arrange_all();
    }

    /// The window under a point among those shown, its title bar included.
    pub fn window_under(&self, pos: Point<f64, Logical>) -> Option<WindowId> {
        if let Some((id, _)) = self.chrome_under(pos) {
            return Some(id);
        }
        let (w, _) = self.space.element_under(pos)?;
        self.wm.by_window(w).map(|m| m.id)
    }

    // ── Hyalo's title bar ─────────────────────────────────────────────────────────────

    /// Whether a mapped window has Hyalo's title bar, after a commit: given, taken away — a
    /// client may switch its decorations while it runs — with the layout following.
    fn update_title_bar(&mut self, window: &Window) {
        let Some(m) = self.wm.by_window(window) else { return };
        if !m.mapped {
            return;
        }
        let (id, ws, had) = (m.id, m.workspace, m.has_title_bar);
        let now = m.title_bar && wants_title_bar(window, false);
        if !now {
            self.poke_stale_geometry(id);
        }
        if now == had {
            return;
        }
        self.wm.get_mut(id).unwrap().has_title_bar = now;
        self.wm.dirty_windows = true;
        self.reclamp_floating(ws);
        self.arrange_workspace(ws);
        self.sync_space();
    }

    /// A client that asked for server-side decorations but still declares the shadow margin of
    /// the frame it no longer draws: Chrome, when "Use system title bar and borders" is turned
    /// on while it runs, paints its whole surface opaque at once and keeps its old window
    /// geometry until a configure comes (measured, 2026-10-03: it overflowed its tile by 10 px
    /// on every side). An opaque region that reaches outside the geometry says so; one
    /// configure, once per geometry, makes it state the new one.
    fn poke_stale_geometry(&mut self, id: WindowId) {
        let Some(m) = self.wm.get(id) else { return };
        let Some(t) = m.window.toplevel().cloned() else { return };
        // Any client that speaks a decoration protocol: Chrome asked for client-side when it
        // started, and says nothing when the setting changes.
        if crate::shell::decoration::asked(t.wl_surface()).is_none() {
            return;
        }
        let geo = m.window.geometry();
        if m.poked_geometry == Some(geo) || !opaque_outside(t.wl_surface(), geo) {
            return;
        }
        self.wm.get_mut(id).unwrap().poked_geometry = Some(geo);
        tracing::debug!(id, ?geo, "a stale window geometry: a configure to restate it");
        crate::shell::decoration::note_dropped_frame(t.wl_surface());
        t.send_configure();
    }
}

const TILED: [xdg_toplevel::State; 4] = [
    xdg_toplevel::State::TiledLeft,
    xdg_toplevel::State::TiledRight,
    xdg_toplevel::State::TiledTop,
    xdg_toplevel::State::TiledBottom,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rectangle::new((x, y).into(), (w, h).into())
    }

    #[test]
    fn a_floating_window_stays_inside_with_its_top_edge_first() {
        let area = r(5, 45, 2550, 1290);
        // Fits: untouched.
        assert_eq!(clamp_floating(r(300, 300, 900, 700), area), r(300, 300, 900, 700));
        // Hanging off the right and the bottom: moved in.
        assert_eq!(clamp_floating(r(2000, 1000, 900, 700), area), r(1655, 635, 900, 700));
        // Larger than the area: shrunk to it, top-left at its corner.
        assert_eq!(clamp_floating(r(0, -101, 2560, 1440), area), r(5, 45, 2550, 1290));
        // Above the top: brought down.
        assert_eq!(clamp_floating(r(100, -50, 400, 300), area), r(100, 45, 400, 300));
    }

    #[test]
    fn a_title_bar_sits_on_top_and_never_leaves_by_the_top() {
        let area = r(5, 45, 2550, 1290);
        // The client's box and the window's whole box, one from the other.
        assert_eq!(with_bar(r(100, 200, 500, 300), 32), r(100, 168, 500, 332));
        assert_eq!(without_bar(r(100, 168, 500, 332), 32), r(100, 200, 500, 300));
        // A client at the top of the area: its bar would be above it, so it comes down.
        assert_eq!(clamp_floating_with_bar(r(100, 45, 500, 300), area, 32), r(100, 77, 500, 300));
        // A client as tall as the area: the bar fits, the client hangs off the bottom.
        assert_eq!(clamp_floating_with_bar(r(100, 45, 500, 1290), area, 32), r(100, 77, 500, 1258));
        // No bar: the old law.
        assert_eq!(clamp_floating_with_bar(r(100, -50, 400, 300), area, 0), clamp_floating(r(100, -50, 400, 300), area));
    }

    #[test]
    fn a_new_window_steps_off_one_it_would_cover_and_only_then() {
        let area = r(0, 0, 2000, 1000);
        let centred = r(700, 300, 600, 400);
        // Nothing under it, or something it only partly covers: it stays.
        assert_eq!(cascade(centred, &[], area, 4), centred);
        assert_eq!(cascade(centred, &[r(600, 300, 600, 400)], area, 4), centred);
        // A small dialog over a big parent covers nothing whole: it stays.
        assert_eq!(cascade(r(850, 400, 300, 200), &[centred], area, 4), r(850, 400, 300, 200));
        // The same terminal opened twice, then three times: down and right, 28 at a time.
        let second = cascade(centred, &[centred], area, 4);
        assert_eq!(second, r(728, 328, 600, 400));
        assert_eq!(cascade(centred, &[centred, second], area, 4), r(756, 356, 600, 400));
        // No room left: the original place.
        assert_eq!(cascade(r(1400, 600, 600, 400), &[r(1400, 600, 600, 400)], area, 4), r(1400, 600, 600, 400));
    }
}
