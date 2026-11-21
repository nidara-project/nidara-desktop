//! nidara-window-controls-v1 (#708 point 5): a window's controls — close, minimize, maximize —
//! are Hyalo's. The app keeps its own header and says where in it they go (`set_position`,
//! double-buffered on wl_surface.commit, so they move with the buffer that leaves room for
//! them); Hyalo draws them there over the app's pixels (render/controls.rs) and takes their
//! clicks (input.rs). The side and the buttons are the user's (`[windows.controls]`, which the
//! shell keeps equal to `org.gnome.desktop.wm.preferences button-layout` — the key the apps
//! that draw their own title bar read), sent to the app as `layout` with the box to reserve.
//!
//! - One capsule, the owner's choice: the shape of the back/forward pair in Settings' header,
//!   not three coloured circles.
//! - A button that does nothing for a window is NOT drawn (owner, 2026-10-04: hidden, not
//!   disabled — as GNOME and Windows, and as an app's own title bar, which cannot disable one):
//!   the capsule shrinks by a button. A window shows a button when the user chose it, the window
//!   asked for it (`set_buttons`; every button until it asks), a rule did not take it away
//!   (`controls`), and it can do it — no maximize for a window that cannot change size, no
//!   minimize for a dialog, which goes with its window (wm/minimize.rs). Close always.

use smithay::{
    reexports::wayland_server::{
        Client, DataInit, DisplayHandle, New, Resource, Weak, protocol::wl_surface::WlSurface,
    },
    utils::{Logical, Point, Rectangle, Size},
    wayland::{
        Dispatch2, GlobalDispatch2,
        compositor::{Cacheable, with_states},
        shell::xdg::SurfaceCachedState,
    },
};

use crate::{
    Hyalo,
    config::{ControlsConfig, ControlsSide},
    protocols::gen_window_controls::{
        nidara_window_controls_manager_v1::{self, NidaraWindowControlsManagerV1},
        nidara_window_controls_v1::{self, NidaraWindowControlsV1, Side},
    },
};

/// The buttons' height, and each one's diameter (#1128), logical px — the same over an app's
/// header and in Hyalo's title bar:
/// one size of controls in every window (owner, 2026-10-03; the window controls are the
/// system's, not the app's). As small as it can be (owner, 2026-10-23, #921): the controls are
/// the classic loose window buttons, not header buttons, so Hyalo's title bar stays thin. From 2026-10-04 to #921 it was 32, a header button's height.
pub const BUTTON_H: f64 = 24.0;

/// Each button is a glass circle of its own, `BUTTON_H` across, `GAP` from the next (#1128,
/// owner 2026-11-21): its hover and press tint the whole circle, so a close-only window's one
/// button turns red entirely. A button takes `PITCH` and the row `PITCH × n − GAP`: 24, 60, 96.
/// The gap is the air around a button in our apps, and puts the centres 36 apart, the bar's
/// icon rhythm. From #921 to #1128 the buttons were circles of 16 inside one capsule, 4 from
/// its ends and 8 apart (24, 48, 72). The shader takes these numbers from here
/// (render/controls.rs `set_geometry`).
pub const GAP: f64 = 12.0;
pub const PITCH: f64 = BUTTON_H + GAP;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Close,
    Minimize,
    Maximize,
}

impl Button {
    /// Its bit in the protocol's `button` bitfield.
    pub fn bit(self) -> u32 {
        match self {
            Self::Close => 1,
            Self::Minimize => 2,
            Self::Maximize => 4,
        }
    }

    /// The shader's glyph for it (render/controls.rs).
    pub fn glyph(self) -> f32 {
        match self {
            Self::Minimize => 0.0,
            Self::Maximize => 1.0,
            Self::Close => 2.0,
        }
    }
}

/// Every button, as the protocol's bitfield.
pub const ALL: u32 = 7;

/// The bits of `buttons`.
pub fn mask(buttons: &[Button]) -> u32 {
    buttons.iter().fold(0, |m, b| m | b.bit())
}

/// The buttons a window shows, left to right: close last on the right, first on the left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Buttons {
    slots: [Button; 3],
    len: usize,
}

impl Buttons {
    pub fn as_slice(&self) -> &[Button] {
        &self.slots[..self.len]
    }

    /// The row's width, logical px: one `PITCH` per button, less the last gap.
    pub fn width(&self) -> f64 {
        PITCH * self.len as f64 - GAP
    }

    /// The shader's glyph per slot (render/controls.rs), and how many slots.
    pub fn glyphs(&self) -> ([f32; 3], f32) {
        let mut g = [0.0; 3];
        for (i, b) in self.as_slice().iter().enumerate() {
            g[i] = b.glyph();
        }
        (g, self.len as f32)
    }

    fn size(&self) -> Size<f64, Logical> {
        Size::from((self.width(), BUTTON_H))
    }
}

/// Whether the window cannot change size (its minimum = its maximum): nothing to maximize.
fn fixed_size(surface: &WlSurface) -> bool {
    with_states(surface, |states| {
        let mut cached = states.cached_state.get::<SurfaceCachedState>();
        let s = cached.current();
        s.max_size.w > 0 && s.max_size.h > 0 && s.min_size == s.max_size
    })
}

/// Whether the window is a dialog of another (xdg_toplevel.set_parent): it is minimized with
/// that one, never by itself.
fn is_dialog(surface: &WlSurface) -> bool {
    with_states(surface, |states| {
        states
            .data_map
            .get::<smithay::wayland::shell::xdg::XdgToplevelSurfaceData>()
            .is_some_and(|d| d.lock().unwrap().parent.is_some())
    })
}

/// The buttons the window with this main surface shows: those the user chose (`cfg`), it asked
/// for (`set_buttons`) and a rule left it (`rule`, the bits of its `controls`), that it can do.
pub fn shown(surface: &WlSurface, rule: Option<u32>, cfg: &ControlsConfig) -> Buttons {
    let asked = with_states(surface, |states| {
        if !states.cached_state.has::<ControlsState>() {
            return None;
        }
        states.cached_state.get::<ControlsState>().current().buttons
    });
    let want = mask(&cfg.buttons) & asked.unwrap_or(ALL) & rule.unwrap_or(ALL);
    let order = match cfg.side {
        ControlsSide::Right => [Button::Minimize, Button::Maximize, Button::Close],
        ControlsSide::Left => [Button::Close, Button::Minimize, Button::Maximize],
    };
    let mut out = Buttons { slots: [Button::Close; 3], len: 0 };
    for b in order {
        let show = match b {
            Button::Close => true,
            Button::Minimize => want & b.bit() != 0 && !is_dialog(surface),
            Button::Maximize => want & b.bit() != 0 && !fixed_size(surface),
        };
        if show {
            out.slots[out.len] = b;
            out.len += 1;
        }
    }
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ControlsState {
    /// The reserved box's top-left corner, surface-local logical px; none = no controls.
    pub position: Option<Point<f64, Logical>>,
    /// The buttons the window asked for (`set_buttons`), the protocol's bits; none = every one.
    pub buttons: Option<u32>,
    /// The app's header under the controls is light: draw them with dark ink (`set_ink`).
    pub dark_ink: bool,
}

impl Cacheable for ControlsState {
    fn commit(&mut self, _dh: &DisplayHandle) -> Self {
        *self
    }
    fn merge_into(self, into: &mut Self, _dh: &DisplayHandle) {
        *into = self;
    }
}

/// Where the app placed its controls box, surface-local logical px, if it did.
pub fn placed(surface: &WlSurface) -> Option<Point<f64, Logical>> {
    with_states(surface, |states| {
        if !states.cached_state.has::<ControlsState>() {
            return None;
        }
        states.cached_state.get::<ControlsState>().current().position
    })
}

/// Whether the app asked for its controls in dark ink (`set_ink`: its header is light).
pub fn dark_ink(surface: &WlSurface) -> bool {
    with_states(surface, |states| {
        states.cached_state.has::<ControlsState>() && states.cached_state.get::<ControlsState>().current().dark_ink
    })
}

/// The buttons' air above and below them in Hyalo's own title bar (render/title_bar.rs),
/// logical px: the bar is their height and twice this (`wm::TITLE_BAR_H`): 24 + 4 + 4 = 32
/// (owner, 2026-10-23, #921: keeps the bar thin).
pub const BAR_MARGIN: f64 = 4.0;
const _: () = assert!(crate::wm::TITLE_BAR_H as f64 == BUTTON_H + 2.0 * BAR_MARGIN);
/// Their distance from the window's side in that bar: the same as in a kit window
/// (`capsule.windowInset`). Until #1128 it was `BAR_MARGIN`, which pressed the buttons into
/// the window's rounded corner (owner, 2026-11-21).
pub const BAR_SIDE: f64 = 12.0;

/// Where a window's controls are, surface-local logical px, and its buttons: in Hyalo's title
/// bar when it has one (above the surface, so `y` is negative), else where the app placed them.
pub fn managed_rect(m: &crate::wm::Managed, cfg: &ControlsConfig) -> Option<(Rectangle<f64, Logical>, Buttons)> {
    let surface = crate::wm::surface_of(&m.window)?;
    let buttons = shown(&surface, m.controls, cfg);
    let visible = m.visible_size().to_f64();
    if visible.w < buttons.width() || visible.h + (m.bar() as f64) < BUTTON_H { return None; }
    let bar = m.bar() as f64;
    if bar > 0.0 {
        let geo = m.window.geometry().to_f64();
        let w = buttons.width();
        let x = match cfg.side {
            ControlsSide::Right => geo.loc.x + visible.w - BAR_SIDE - w,
            ControlsSide::Left => geo.loc.x + BAR_SIDE,
        };
        let x = x.clamp(geo.loc.x, geo.loc.x + visible.w - w);
        let y = geo.loc.y - bar + (bar - BUTTON_H) / 2.0;
        return Some((Rectangle::new((x, y).into(), (w, BUTTON_H).into()), buttons));
    }
    let mut at = placed(&surface)?;
    let geo = m.window.geometry().to_f64();
    // Keep the capsule in the visible header when GTK allocated its minimum width
    // beyond the tile. Preserve its requested gap from the chosen side.
    let gap = (geo.loc.x + geo.size.w - at.x - buttons.width()).max(0.0);
    if cfg.side == ControlsSide::Right { at.x = geo.loc.x + visible.w - gap - buttons.width(); }
    at.x = at.x.clamp(geo.loc.x, geo.loc.x + visible.w - buttons.width());
    if at.y < geo.loc.y || at.y + BUTTON_H > geo.loc.y + visible.h { return None; }
    Some((Rectangle::new(at, buttons.size()), buttons))
}

/// The button at `local` in controls at `r` showing `buttons` (both surface-local logical px).
pub fn button_at(r: Rectangle<f64, Logical>, local: Point<f64, Logical>, buttons: &Buttons) -> Option<Button> {
    if !r.contains(local) || buttons.len == 0 {
        return None;
    }
    // Each button is its own circle: the gap between two belongs to neither (in a title bar it
    // is the bar, which moves the window; over an app's header, the app's).
    let r_ = BUTTON_H / 2.0;
    let i = (((local.x - r.loc.x) / PITCH).floor().max(0.0) as usize).min(buttons.len - 1);
    let centre = (r.loc.x + r_ + i as f64 * PITCH, r.loc.y + r_);
    let (dx, dy) = (local.x - centre.0, local.y - centre.1);
    (dx * dx + dy * dy <= r_ * r_).then(|| buttons.as_slice()[i])
}

fn side_of(side: ControlsSide) -> Side {
    match side {
        ControlsSide::Right => Side::Right,
        ControlsSide::Left => Side::Left,
    }
}

/// Tells the app the box to reserve, if it changed since it was last told: the side, or how
/// many buttons it shows.
fn tell(state: &Hyalo, res: &NidaraWindowControlsV1) {
    let Some(data) = res.data::<ControlsData>() else { return };
    let Ok(surface) = data.surface.upgrade() else { return };
    let cfg = &state.config.windows.controls;
    let rule = state.wm.by_surface(&surface).and_then(|m| m.controls);
    let buttons = shown(&surface, rule, cfg);
    let now = (cfg.side, buttons.len);
    let mut told = data.told.lock().unwrap();
    if *told != Some(now) {
        *told = Some(now);
        res.layout(side_of(cfg.side), buttons.width(), BUTTON_H);
    }
}

/// After the user's side or buttons, or a window's rules, changed: every app whose box changed
/// lays it out again.
pub fn send_layouts(state: &mut Hyalo) {
    state.window_controls.retain(|r| r.is_alive());
    for r in &state.window_controls {
        tell(state, r);
    }
}

/// After `surface` committed: what it asked for, or whether it can change size, may have
/// changed its buttons.
pub fn on_commit(state: &Hyalo, surface: &WlSurface) {
    for r in &state.window_controls {
        if r.data::<ControlsData>().is_some_and(|d| d.surface.upgrade().is_ok_and(|s| &s == surface)) {
            tell(state, r);
        }
    }
}

pub struct ControlsGlobal;
pub struct ControlsData {
    surface: Weak<WlSurface>,
    /// The side and the number of buttons the app was last told.
    told: std::sync::Mutex<Option<(ControlsSide, usize)>>,
}

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, NidaraWindowControlsManagerV1, _>(1, ControlsGlobal);
}

impl GlobalDispatch2<NidaraWindowControlsManagerV1, Hyalo> for ControlsGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<NidaraWindowControlsManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, ControlsGlobal);
    }

    /// Not for a sandboxed client (sandbox.rs), like the glass: our apps' protocol.
    fn can_view(&self, client: &Client) -> bool {
        crate::sandbox::unrestricted(client)
    }
}

impl Dispatch2<NidaraWindowControlsManagerV1, Hyalo> for ControlsGlobal {
    fn request(
        &self,
        state: &mut Hyalo,
        _client: &Client,
        _resource: &NidaraWindowControlsManagerV1,
        request: nidara_window_controls_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        if let nidara_window_controls_manager_v1::Request::GetWindowControls { id, surface } = request {
            let res = data_init.init(id, ControlsData { surface: surface.downgrade(), told: Default::default() });
            tell(state, &res);
            state.window_controls.retain(|r| r.is_alive());
            state.window_controls.push(res);
        }
    }
}

impl ControlsData {
    fn pending(&self, f: impl FnOnce(&mut ControlsState)) {
        if let Ok(surface) = self.surface.upgrade() {
            with_states(&surface, |states| f(states.cached_state.get::<ControlsState>().pending()));
        }
    }
}

impl Dispatch2<NidaraWindowControlsV1, Hyalo> for ControlsData {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        _resource: &NidaraWindowControlsV1,
        request: nidara_window_controls_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use nidara_window_controls_v1::Request;
        match request {
            Request::SetPosition { x, y } => self.pending(|c| c.position = Some(Point::from((x, y)))),
            Request::UnsetPosition | Request::Destroy => self.pending(|c| c.position = None),
            // Close is always kept; an unknown bit is ignored.
            Request::SetButtons { buttons } => {
                let bits = match buttons {
                    smithay::reexports::wayland_server::WEnum::Value(b) => b.bits(),
                    smithay::reexports::wayland_server::WEnum::Unknown(u) => u,
                };
                self.pending(|c| c.buttons = Some(bits & ALL))
            }
            // An unknown value is light, the default.
            Request::SetInk { ink } => {
                let dark = matches!(ink, smithay::reexports::wayland_server::WEnum::Value(nidara_window_controls_v1::Ink::Dark));
                self.pending(|c| c.dark_ink = dark)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_mirror_matches_default_component_export() {
        let token: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../toolkit/tokens/capsule.json"
        )).unwrap();
        // Separate circles (#1128): the button is the height, with no capsule round it.
        for (key, value) in [("height", BUTTON_H), ("button", BUTTON_H), ("edge", 0.0), ("gap", GAP)] {
            assert_eq!(token["default"][key].as_f64(), Some(value), "capsule {key} mirror drift");
        }
        use crate::render::controls::*;
        for (key, value) in [("size", GLYPH_SIZE), ("stroke", GLYPH_STROKE),
            ("minimizeHalf", GLYPH_MINIMIZE_HALF), ("maximizeHalf", GLYPH_MAXIMIZE_HALF),
            ("maximizeRadius", GLYPH_MAXIMIZE_RADIUS), ("closeHalf", GLYPH_CLOSE_HALF)] {
            assert_eq!(token["default"]["glyph"][key].as_f64(), Some(value), "glyph {key} mirror drift");
        }
        assert_eq!(PITCH, BUTTON_H + GAP);
    }

    fn of(list: &[Button]) -> Buttons {
        let mut out = Buttons { slots: [Button::Close; 3], len: 0 };
        for b in list {
            out.slots[out.len] = *b;
            out.len += 1;
        }
        out
    }

    #[test]
    fn a_button_is_its_own_circle() {
        // Two buttons (24 + 12 + 24 = 60), in the title bar above the surface.
        let two = of(&[Button::Maximize, Button::Close]);
        let r = Rectangle::new((340.0, -32.0).into(), (two.width(), BUTTON_H).into());
        let at = |x: f64| button_at(r, Point::from((x, -20.0)), &two);
        assert_eq!(two.width(), 60.0);
        assert_eq!(at(340.5), Some(Button::Maximize));
        assert_eq!(at(363.5), Some(Button::Maximize));
        assert_eq!(at(370.0), None, "the gap is neither button's");
        assert_eq!(at(376.5), Some(Button::Close));
        assert_eq!(at(399.5), Some(Button::Close));
        assert_eq!(at(401.0), None);
        assert_eq!(button_at(r, Point::from((350.0, 0.0)), &two), None, "below it: the app");
        // The circle, not its square: the corner of the slot is not the button.
        assert_eq!(button_at(r, Point::from((341.0, -31.0)), &two), None);
        // Close alone: one circle, 24 × 24, all of it the button.
        let one = of(&[Button::Close]);
        assert_eq!(one.width(), 24.0);
        let r = Rectangle::new((364.0, -32.0).into(), (one.width(), BUTTON_H).into());
        assert_eq!(button_at(r, Point::from((364.5, -20.0)), &one), Some(Button::Close));
        assert_eq!(button_at(r, Point::from((387.5, -20.0)), &one), Some(Button::Close));
        // Three (#1128): 96 × 24, circles of 24, 12 apart, centres 36 apart.
        let three = of(&[Button::Minimize, Button::Maximize, Button::Close]);
        assert_eq!(three.width(), 96.0);
        assert_eq!(BUTTON_H, 24.0);
        let r = Rectangle::new((0.0, 0.0).into(), (three.width(), BUTTON_H).into());
        let at = |x: f64| button_at(r, Point::from((x, 12.0)), &three);
        assert_eq!(at(0.5), Some(Button::Minimize));
        assert_eq!(at(23.5), Some(Button::Minimize));
        assert_eq!(at(30.0), None);
        assert_eq!(at(36.5), Some(Button::Maximize));
        assert_eq!(at(59.5), Some(Button::Maximize));
        assert_eq!(at(66.0), None);
        assert_eq!(at(72.5), Some(Button::Close));
        assert_eq!(at(95.5), Some(Button::Close));
        for i in 0..3 {
            assert_eq!(BUTTON_H / 2.0 + i as f64 * PITCH, 12.0 + 36.0 * i as f64);
        }
    }

    #[test]
    fn the_bits_are_the_protocols() {
        assert_eq!(mask(&[Button::Close, Button::Minimize, Button::Maximize]), ALL);
        assert_eq!(mask(&[Button::Maximize]), 4);
    }
}
