//! X11 applications: Xwayland, and Hyalo as its window manager (#683).
//!
//! Hyalo starts Xwayland itself and is its window manager through Smithay's `X11Wm` — not
//! xwayland-satellite in between. Both were measured against Steam and Proton games on
//! 2026-10-07 (#683): satellite lost an output's size change (Xwayland kept the old screen, a
//! running game fell out of fullscreen and off the screen), reported every X11 window as its
//! own process (so a native X11 game launched by Steam was not seen as a game), and gave
//! Xwayland twice the DPI on a 1.5 screen. Here an X11 window is a window like any other — the
//! same `Managed`, the same layout, rules, title bar, animations — with its pid, its size and
//! its output's scale read first hand.
//!
//! What X11 adds over xdg-shell:
//! - **Position.** An X client knows where it is, and opens its menus (override-redirect
//!   windows, never managed) from there: every move and resize is configured to it with its
//!   global position (`configure_x11`), or its menus open where it was.
//! - **Focus.** The X server routes keys to its own focus: the keyboard goes to the
//!   `X11Surface`, which sets that focus before entering its surface (focus.rs).
//! - **Scale.** Xwayland is given the largest output scale as its client scale: X clients
//!   draw at the outputs' real pixels (sharp at 1.5), and are told the matching DPI
//!   (XSETTINGS `Xft/DPI`) — `update_scale`.
//! - **Override-redirect windows** (menus, tooltips, drop-downs, a game's splash): placed by the
//!   client where it says, drawn over the windows and the shell's bar, never focused
//!   (`Wm::x11_overrides`, render/mod.rs, state.rs `surface_under`).

use std::os::unix::io::OwnedFd;

use smithay::{
    desktop::Window,
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Rectangle, Size},
    wayland::{
        compositor::CompositorHandler,
        selection::{
            SelectionTarget,
            data_device::{
                clear_data_device_selection, current_data_device_selection_userdata,
                request_data_device_client_selection, set_data_device_selection,
            },
            primary_selection::{
                clear_primary_selection, current_primary_selection_userdata, request_primary_client_selection,
                set_primary_selection,
            },
        },
        xwayland_shell::{XWaylandShellHandler, XWaylandShellState},
    },
    xwayland::{
        X11Surface, X11Wm, XWayland, XWaylandEvent, XwmHandler,
        xwm::{Reorder, ResizeEdge as X11ResizeEdge, WmWindowProperty, WmWindowType, XwmId},
    },
};

use crate::{
    Hyalo,
    focus::KeyboardFocus,
    wm::{Fullscreen, WindowId, grabs::{Kind, ResizeEdge}},
};

/// Xwayland, once started.
#[derive(Default)]
pub struct XState {
    pub wm: Option<X11Wm>,
    /// `:N`, set in `DISPLAY` for everything Hyalo starts.
    pub display: Option<u32>,
    /// The client scale Xwayland was last given (`update_x11_scale`).
    pub scale: f64,
    /// Xwayland's own Wayland connection.
    pub client: Option<smithay::reexports::wayland_server::Client>,
}

/// Starts Xwayland and, once it is up, the window manager. `DISPLAY` is known (and set for every
/// child, the autostart's `uwsm finalize` included) as soon as the sockets are bound, before
/// Xwayland has started: an X client started meanwhile waits on the socket.
pub fn start(state: &mut Hyalo) {
    if !state.config.xwayland.enabled {
        tracing::info!("Xwayland is off (xwayland.enabled = false)");
        return;
    }
    let spawned = XWayland::spawn(
        &state.display_handle,
        None,
        std::iter::empty::<(String, String)>(),
        std::iter::empty::<String>(),
        true,
        std::process::Stdio::null(),
        std::process::Stdio::null(),
        |_| (),
    );
    let (xwayland, client) = match spawned {
        Ok(x) => x,
        Err(err) => {
            tracing::error!(%err, "Xwayland did not start: X11 apps will not run");
            return;
        }
    };
    let display = xwayland.display_number();
    state.x11.display = Some(display);
    state.x11.client = Some(client.clone());
    unsafe {
        std::env::set_var("DISPLAY", format!(":{display}"));
    }
    let inserted = state.loop_handle.insert_source(xwayland, move |event, _, state| match event {
        XWaylandEvent::Ready { x11_socket, display_number } => {
            state.x11.scale = 0.0;
            let scale = state.xwayland_scale();
            state.client_compositor_state(&client).set_client_scale(scale);
            state.resend_outputs();
            match X11Wm::start_wm(state.loop_handle.clone(), &state.display_handle, x11_socket, client.clone()) {
                Ok(wm) => {
                    state.x11.wm = Some(wm);
                    state.x11.scale = scale;
                    state.update_x11_resources();
                    state.set_x11_cursor();
                    tracing::info!(display = display_number, scale, "Xwayland ready");
                }
                Err(err) => tracing::error!(%err, "the X11 window manager did not start"),
            }
        }
        XWaylandEvent::Error => tracing::error!("Xwayland exited while starting"),
    });
    if let Err(err) = inserted {
        tracing::error!(%err, "Xwayland's event source");
    }
}

impl Hyalo {
    /// The scale Xwayland's clients draw at: the largest output's, so an X11 window is sharp
    /// on every screen (scaled down on a smaller one, never up).
    fn xwayland_scale(&self) -> f64 {
        self.space.outputs().map(|o| o.current_scale().fractional_scale()).fold(1.0, f64::max)
    }

    /// An output's scale changed, or one came or went: Xwayland is given the new largest one.
    /// Its windows are then configured again, their sizes now counted in the new pixels.
    pub fn update_x11_scale(&mut self) {
        let (Some(_), Some(client)) = (self.x11.wm.as_ref(), self.x11.client.clone()) else { return };
        let scale = self.xwayland_scale();
        if (scale - self.x11.scale).abs() < 1e-6 {
            return;
        }
        self.client_compositor_state(&client).set_client_scale(scale);
        self.resend_outputs();
        self.x11.scale = scale;
        self.update_x11_resources();
        self.set_x11_cursor();
        tracing::info!(scale, "Xwayland's scale");
        self.arrange_all();
        self.queue_redraw(None);
    }

    /// Every output described again to the clients whose scale changed: Smithay sends each
    /// `wl_output` and `xdg_output` in the client's own pixels, and only when something changes.
    /// Without it Xwayland kept the screen it was told before its scale changed — 853×533 for a
    /// 1280×800 output at 1.5, then 1920×1200 once back at 1 (measured nested, 2026-10-07).
    fn resend_outputs(&self) {
        for o in self.space.outputs() {
            o.change_current_state(None, None, None, None);
        }
    }

    /// What X11 toolkits read of the desktop, at the scale Xwayland draws at: the DPI their text
    /// is sized from (96 per unit of scale) and the cursor theme. GTK 3 reads XSETTINGS (`Xft/DPI`,
    /// `Gtk/CursorThemeName`); Qt, Wine, Xft, Xcursor and most others the resource database on
    /// the root window (what `xrdb` writes), which nobody fills on Xwayland but us.
    pub fn update_x11_resources(&mut self) {
        let scale = self.x11.scale.max(1.0);
        let dpi = 96.0 * scale;
        let theme = self.config.cursor.theme.clone();
        let size = (self.config.cursor.size as f64 * scale).round() as i32;
        let Some(wm) = self.x11.wm.as_mut() else { return };
        use smithay::xwayland::xwm::settings::Value;
        let settings = [
            ("Xft/DPI".to_string(), Value::Integer((dpi * 1024.0).round() as i32)),
            ("Gtk/CursorThemeName".to_string(), Value::String(theme.clone())),
            ("Gtk/CursorThemeSize".to_string(), Value::Integer(size)),
        ];
        if let Err(err) = wm.set_xsettings(settings.into_iter()) {
            tracing::warn!(?err, "XSETTINGS not set");
        }
        let Some(display) = self.x11.display else { return };
        let resources = vec![
            ("Xft.dpi".to_string(), format!("{}", dpi.round() as u32)),
            ("Xcursor.theme".to_string(), theme),
            ("Xcursor.size".to_string(), size.to_string()),
        ];
        // A connection of its own, off the main loop: Xwayland may be waiting on Hyalo in a
        // Wayland roundtrip when the request arrives, and Hyalo must not wait on it.
        std::thread::spawn(move || match set_resources(display, &resources) {
            Ok(()) => tracing::debug!(?resources, "X resources"),
            Err(err) => tracing::warn!(%err, "X resources not set"),
        });
    }

    /// The arrow over the X root window: what a client that sets no cursor of its own shows.
    pub fn set_x11_cursor(&mut self) {
        let scale = self.x11.scale.max(1.0);
        let cursors = crate::cursor::Cursors::load(&self.config.cursor.theme, self.config.cursor.size);
        let Some(image) = cursors.arrow(scale) else { return };
        let Some(wm) = self.x11.wm.as_mut() else { return };
        if let Err(err) = wm.set_cursor(
            &image.pixels_rgba,
            Size::from((image.width as u16, image.height as u16)),
            smithay::utils::Point::from((image.xhot as u16, image.yhot as u16)),
        ) {
            tracing::warn!(?err, "X11 cursor not set");
        }
    }

    /// The managed window an X11 surface is.
    pub fn x11_managed(&self, x: &X11Surface) -> Option<WindowId> {
        self.wm.windows.iter().find(|m| m.window.x11_surface() == Some(x)).map(|m| m.id)
    }

    /// Tells an X11 window where its box is and how large: its global position (X clients place
    /// their menus from it), at the size it was given. `rect` is the box Hyalo lays out — what
    /// it shows; the X window is larger by the shadow a client-side frame declares
    /// (`_GTK_FRAME_EXTENTS`). Sent only when that changed.
    pub fn configure_x11(&self, x: &X11Surface, rect: Rectangle<i32, Logical>) {
        if x.is_override_redirect() || rect.size.w <= 0 || rect.size.h <= 0 {
            return;
        }
        let e = x.frame_extents();
        let rect = Rectangle::new(
            (rect.loc.x - e.left, rect.loc.y - e.top).into(),
            (rect.size.w + e.left + e.right, rect.size.h + e.top + e.bottom).into(),
        );
        if x.last_configure() == rect && x.pending_configure().is_none() {
            return;
        }
        if let Err(err) = x.configure(rect) {
            tracing::debug!(?err, "X11 configure");
        }
    }

    /// Before an X11 window is shown: what the rules will make of it, and a first size — its
    /// tile's, when it will be tiled — so its first frame is already right.
    fn x11_initial_configure(&mut self, window: &Window) {
        let Some(x) = window.x11_surface().cloned() else { return };
        let Some(id) = self.x11_managed(&x) else { return };
        let (ws, tiled_rect) = self.initial_placement(id, window);
        let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else {
            let _ = x.configure(None);
            return;
        };
        let area = self.floating_area_of(&output);
        let rect = match tiled_rect {
            Some(r) => r,
            None => {
                let want = (x.last_configure() - x.frame_extents()).size;
                let size = Size::from((want.w.clamp(1, area.size.w.max(1)), want.h.clamp(1, area.size.h.max(1))));
                crate::wm::centered(size, area)
            }
        };
        self.configure_x11(&x, rect);
    }
}

impl XWaylandShellHandler for Hyalo {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }

    fn surface_associated(&mut self, _xwm: XwmId, _surface: WlSurface, window: X11Surface) {
        // Its frames arrive from now on; one may have been committed already, before the window
        // knew its surface — shown with the next one.
        if window.is_override_redirect() {
            self.queue_redraw(None);
        }
    }
}

impl XwmHandler for Hyalo {
    fn xwm_state(&mut self, _xwm: XwmId) -> &mut X11Wm {
        self.x11.wm.as_mut().expect("the X11 window manager")
    }

    fn new_window(&mut self, _xwm: XwmId, _window: X11Surface) {}
    fn new_override_redirect_window(&mut self, _xwm: XwmId, _window: X11Surface) {}

    fn map_window_request(&mut self, _xwm: XwmId, x: X11Surface) {
        if let Err(err) = x.set_mapped(true) {
            tracing::warn!(?err, "X11 window not mapped");
            return;
        }
        if self.x11_managed(&x).is_some() {
            return;
        }
        crate::wm::remember_steam_class(&x);
        let window = Window::new_x11_window(x);
        self.window_created(window.clone());
        self.x11_initial_configure(&window);
    }

    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, x: X11Surface) {
        tracing::debug!(window = x.window_id(), geo = ?x.last_configure(), class = %x.class(), kind = ?x.window_type(), "X11 override-redirect mapped");
        self.wm.x11_overrides.retain(|o| o != &x);
        self.wm.x11_overrides.push(x);
        self.queue_redraw(None);
    }

    fn unmapped_window(&mut self, _xwm: XwmId, x: X11Surface) {
        self.x11_gone(&x);
        if !x.is_override_redirect() {
            let _ = x.set_mapped(false);
        }
    }

    fn destroyed_window(&mut self, _xwm: XwmId, x: X11Surface) {
        self.x11_gone(&x);
    }

    fn configure_request(
        &mut self,
        _xwm: XwmId,
        x: X11Surface,
        req_x: Option<i32>,
        req_y: Option<i32>,
        w: Option<u32>,
        h: Option<u32>,
        _reorder: Option<Reorder>,
    ) {
        let Some(id) = self.x11_managed(&x) else {
            // Not shown yet: whatever it asks — it is placed when it maps.
            let mut geo = x.last_configure();
            if let Some(v) = req_x {
                geo.loc.x = v;
            }
            if let Some(v) = req_y {
                geo.loc.y = v;
            }
            if let Some(v) = w {
                geo.size.w = v as i32;
            }
            if let Some(v) = h {
                geo.size.h = v as i32;
            }
            let _ = x.configure(geo);
            return;
        };
        let m = self.wm.get(id).unwrap();
        // A floating window may choose its size (a game switching resolution in a window, a
        // dialog growing); never its place, which is the user's. A tiled or fullscreen one is
        // told its box again.
        if m.mapped && m.floating && m.fullscreen == Fullscreen::None && (w.is_some() || h.is_some()) {
            let ws = m.workspace;
            let current = m.float_rect.unwrap_or(m.rect);
            let size = Size::from((w.map_or(current.size.w, |v| v as i32), h.map_or(current.size.h, |v| v as i32)));
            self.wm.get_mut(id).unwrap().float_rect = Some(Rectangle::new(current.loc, size));
            self.reclamp_floating(ws);
            self.arrange_workspace(ws);
            self.sync_space();
            return;
        }
        if m.mapped {
            let rect = m.rect;
            // Told again even if unchanged: it asked, and waits for an answer.
            let _ = x.configure(None);
            self.configure_x11(&x, rect);
        } else {
            let _ = x.configure(None);
        }
    }

    fn configure_notify(&mut self, _xwm: XwmId, x: X11Surface, _geometry: Rectangle<i32, Logical>, _above: Option<u32>) {
        // An override-redirect window moved itself (a menu following its button): drawn there.
        if x.is_override_redirect() {
            self.queue_redraw(None);
        }
    }

    fn property_notify(&mut self, _xwm: XwmId, x: X11Surface, property: WmWindowProperty) {
        let Some(id) = self.x11_managed(&x) else { return };
        match property {
            WmWindowProperty::Title => self.window_title_changed(id),
            WmWindowProperty::Class => self.window_app_id_changed(id),
            WmWindowProperty::MotifHints => {
                let window = self.wm.get(id).unwrap().window.clone();
                self.window_committed(&window);
            }
            _ => {}
        }
    }

    fn maximize_request(&mut self, _xwm: XwmId, x: X11Surface) {
        match self.x11_managed(&x).and_then(|id| self.wm.get(id)).map(|m| (m.id, m.mapped, m.fullscreen)) {
            Some((id, true, Fullscreen::None)) => self.set_fullscreen(id, Fullscreen::Maximized),
            _ => {
                let _ = x.set_maximized(true);
            }
        }
    }

    fn unmaximize_request(&mut self, _xwm: XwmId, x: X11Surface) {
        match self.x11_managed(&x).and_then(|id| self.wm.get(id)).map(|m| (m.id, m.fullscreen)) {
            Some((id, Fullscreen::Maximized)) => self.set_fullscreen(id, Fullscreen::None),
            _ => {
                let _ = x.set_maximized(false);
            }
        }
    }

    fn fullscreen_request(&mut self, _xwm: XwmId, x: X11Surface) {
        // A game asking for the whole screen: granted, on the output its workspace is on. Asked
        // before it is shown, it is shown fullscreen (`window_mapped` reads the state).
        match self.x11_managed(&x).and_then(|id| self.wm.get(id)).map(|m| (m.id, m.mapped)) {
            Some((id, true)) => self.set_fullscreen(id, Fullscreen::Fullscreen),
            _ => {
                let _ = x.set_fullscreen(true);
            }
        }
    }

    fn unfullscreen_request(&mut self, _xwm: XwmId, x: X11Surface) {
        match self.x11_managed(&x) {
            Some(id) => self.set_fullscreen(id, Fullscreen::None),
            None => {
                let _ = x.set_fullscreen(false);
            }
        }
    }

    fn minimize_request(&mut self, _xwm: XwmId, x: X11Surface) {
        if let Some(id) = self.x11_managed(&x).filter(|id| self.wm.get(*id).is_some_and(|m| m.mapped))
            && let Err(err) = self.minimize(id)
        {
            tracing::debug!(%err, "X11 minimize request");
        }
    }

    fn unminimize_request(&mut self, _xwm: XwmId, x: X11Surface) {
        if let Some(id) = self.x11_managed(&x) {
            self.focus_window(Some(id));
        }
    }

    fn resize_request(&mut self, _xwm: XwmId, x: X11Surface, button: u32, edges: X11ResizeEdge) {
        let Some(id) = self.x11_managed(&x) else { return };
        let Some(start_data) = self.seat.get_pointer().and_then(|p| p.grab_start_data()) else { return };
        let edges = match edges {
            X11ResizeEdge::Top => ResizeEdge::TOP,
            X11ResizeEdge::Bottom => ResizeEdge::BOTTOM,
            X11ResizeEdge::Left => ResizeEdge::LEFT,
            X11ResizeEdge::Right => ResizeEdge::RIGHT,
            X11ResizeEdge::TopLeft => ResizeEdge::TOP | ResizeEdge::LEFT,
            X11ResizeEdge::TopRight => ResizeEdge::TOP | ResizeEdge::RIGHT,
            X11ResizeEdge::BottomLeft => ResizeEdge::BOTTOM | ResizeEdge::LEFT,
            X11ResizeEdge::BottomRight => ResizeEdge::BOTTOM | ResizeEdge::RIGHT,
        };
        self.start_window_grab(id, Kind::Resize(edges), start_data, button);
    }

    fn move_request(&mut self, _xwm: XwmId, x: X11Surface, button: u32) {
        let Some(id) = self.x11_managed(&x) else { return };
        let Some(start_data) = self.seat.get_pointer().and_then(|p| p.grab_start_data()) else { return };
        self.start_window_grab(id, Kind::Move, start_data, button);
    }

    fn allow_selection_access(&mut self, xwm: XwmId, _selection: SelectionTarget) -> bool {
        // Only while one of its windows has the keyboard, as a Wayland client's offer.
        matches!(
            self.seat.get_keyboard().and_then(|k| k.current_focus()),
            Some(KeyboardFocus::X11(x)) if x.xwm_id() == Some(xwm)
        )
    }

    fn send_selection(&mut self, _xwm: XwmId, selection: SelectionTarget, mime_type: String, fd: OwnedFd) {
        let result = match selection {
            SelectionTarget::Clipboard => request_data_device_client_selection(&self.seat, mime_type, fd).map_err(|e| e.to_string()),
            SelectionTarget::Primary => request_primary_client_selection(&self.seat, mime_type, fd).map_err(|e| e.to_string()),
        };
        if let Err(err) = result {
            tracing::debug!(%err, ?selection, "the Wayland selection for an X11 client");
        }
    }

    fn new_selection(&mut self, _xwm: XwmId, selection: SelectionTarget, mime_types: Vec<String>) {
        match selection {
            SelectionTarget::Clipboard => set_data_device_selection(&self.display_handle, &self.seat, mime_types, ()),
            SelectionTarget::Primary => set_primary_selection(&self.display_handle, &self.seat, mime_types, ()),
        }
    }

    fn cleared_selection(&mut self, _xwm: XwmId, selection: SelectionTarget) {
        match selection {
            SelectionTarget::Clipboard => {
                if current_data_device_selection_userdata(&self.seat).is_some() {
                    clear_data_device_selection(&self.display_handle, &self.seat);
                }
            }
            SelectionTarget::Primary => {
                if current_primary_selection_userdata(&self.seat).is_some() {
                    clear_primary_selection(&self.display_handle, &self.seat);
                }
            }
        }
    }

    fn disconnected(&mut self, _xwm: XwmId) {
        tracing::warn!("Xwayland went away: X11 apps will not run until Hyalo restarts");
        self.x11.wm = None;
        self.wm.x11_overrides.clear();
        let gone: Vec<Window> = self.wm.windows.iter().filter(|m| m.window.x11_surface().is_some()).map(|m| m.window.clone()).collect();
        for w in gone {
            self.window_destroyed(&w);
        }
    }
}

impl Hyalo {
    /// An X11 window unmapped or destroyed: gone from the desktop (an X client that maps it
    /// again is a new window to us, as on every X window manager).
    fn x11_gone(&mut self, x: &X11Surface) {
        if x.is_override_redirect() {
            let before = self.wm.x11_overrides.len();
            self.wm.x11_overrides.retain(|o| o != x);
            if self.wm.x11_overrides.len() != before {
                self.queue_redraw(None);
            }
            return;
        }
        if let Some(window) = self.x11_managed(x).and_then(|id| self.wm.get(id)).map(|m| m.window.clone()) {
            self.window_destroyed(&window);
        }
    }
}

/// `resources` set in the root window's resource database, the rest of it kept. The change is
/// checked before the connection closes: only flushed, it was lost (measured, 2026-10-07).
fn set_resources(display: u32, resources: &[(String, String)]) -> Result<(), Box<dyn std::error::Error>> {
    use smithay::reexports::x11rb::{
        self,
        connection::Connection,
        protocol::xproto::{AtomEnum, ConnectionExt, PropMode},
        wrapper::ConnectionExt as _,
    };
    let (conn, screen) = x11rb::connect(Some(&format!(":{display}")))?;
    let root = conn.setup().roots[screen].root;
    let current = conn
        .get_property(false, root, AtomEnum::RESOURCE_MANAGER, AtomEnum::STRING, 0, u32::MAX / 4)?
        .reply()?;
    let ours = |l: &str| resources.iter().any(|(k, _)| l.split(':').next().map(str::trim) == Some(k.as_str()));
    let mut db: Vec<String> = String::from_utf8_lossy(&current.value)
        .lines()
        .filter(|l| !l.is_empty() && !ours(l))
        .map(str::to_owned)
        .collect();
    db.extend(resources.iter().map(|(k, v)| format!("{k}:\t{v}")));
    let text = db.join("\n") + "\n";
    conn.change_property8(PropMode::REPLACE, root, AtomEnum::RESOURCE_MANAGER, AtomEnum::STRING, text.as_bytes())?
        .check()?;
    tracing::debug!(root, screen, %text, "resource database");
    Ok(())
}

/// Whether an X11 window floats wherever it opens, as a dialog does: it belongs to another, or
/// is not a normal window, or cannot be resized.
pub fn wants_floating(x: &X11Surface) -> bool {
    if x.is_transient_for().is_some() || x.is_modal() {
        return true;
    }
    if x.window_type().is_some_and(|t| !matches!(t, WmWindowType::Normal)) {
        return true;
    }
    matches!((x.min_size(), x.max_size()), (Some(min), Some(max)) if min.w > 0 && min == max)
}
