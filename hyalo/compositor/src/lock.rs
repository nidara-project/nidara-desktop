//! ext-session-lock-v1: the lock screen (`nidara-lock`).
//!
//! **While the session is locked nothing of it is drawn or reachable**: an output shows its
//! lock surface over the wallpaper (the BACKGROUND layers) and nothing else, windows and the
//! shell's layers included — not covered, not drawn. The keyboard and the pointer reach the
//! lock surfaces only; of the bindings, only those marked `locked` run (volume, brightness),
//! plus the two built in (VT switch, Ctrl+Alt+Backspace).
//!
//! The lock surface is an ordinary surface to the rest of Hyalo, so it declares its glass
//! through `nidara-material-v1` like the shell's panels: the card's glass is Hyalo's,
//! refracting the real wallpaper. (On Hyprland the lock surface is drawn over an opaque
//! sheet, so `nidara-lock` painted its own copy of the wallpaper and imitated the glass on it.)
//!
//! **A new lock comes in over the desktop, not over the bare wallpaper.** From the request on,
//! the keyboard and the pointer reach the lock surfaces only; but an output goes on showing the
//! session until ITS lock surface has a buffer (at most HOLD_SESSION), and then cuts straight to
//! it. Cutting at the request showed the wallpaper alone for the frames the lock client needed
//! to draw its first one: a flash, lighter than the desktop and than the lock screen's own
//! veil (owner, 2026-10-02: "kitty lights up for an instant, then the lock screen appears"). A
//! RELOCK — a new client taking over the lock of one that died — holds nothing: the session
//! was hidden already and stays so.
//!
//! **"Locked" is said only when it is true.** The client is told the session is locked once
//! every output that shows frames has shown one of the locked ones — on the tty backend, at the
//! vblank that put it on screen — never when the request arrives.
//!
//! **A lock client that dies leaves the session locked.** Hyalo starts `nidara-lock` again
//! (a new client may lock a session whose locker is gone, as the protocol allows), at most
//! RELAUNCH_LIMIT times in RELAUNCH_WINDOW; past that, a key press tries once more. Until a
//! lock surface comes back the outputs show the wallpaper alone.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use smithay::{
    backend::renderer::utils::with_renderer_surface_state,
    desktop::{PopupManager, WindowSurfaceType, utils::under_from_surface_tree},
    output::Output,
    reexports::{
        calloop::{
            RegistrationToken,
            timer::{TimeoutAction, Timer},
        },
        wayland_protocols::ext::session_lock::v1::server::ext_session_lock_v1::ExtSessionLockV1,
        wayland_server::{
            Resource,
            protocol::{wl_output::WlOutput, wl_surface::WlSurface},
        },
    },
    utils::{Logical, Point, SERIAL_COUNTER, Serial},
    wayland::{
        compositor::{get_parent, get_role},
        session_lock::{LockSurface, SessionLockHandler, SessionLockManagerState, SessionLocker},
    },
};

use crate::state::Hyalo;

/// The lock client Hyalo starts again when the one holding the lock dies. `HYALO_LOCK_RELAUNCH`
/// replaces it (the lock check points it at its own probe client: scripts/ci/hyalo-lock-check.sh).
const RELAUNCH: &str = "nidara-lock";

pub fn lock_command() -> String {
    std::env::var("HYALO_LOCK_RELAUNCH").ok().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| RELAUNCH.into())
}
/// At most this many relaunches in RELAUNCH_WINDOW: a lock client that crashes on start must
/// not be restarted in a tight loop.
const RELAUNCH_LIMIT: usize = 3;
const RELAUNCH_WINDOW: Duration = Duration::from_secs(30);
/// How often a held lock checks that its client is still there.
const WATCH_EVERY: Duration = Duration::from_secs(1);
/// The longest a new lock keeps showing the session while its client draws its first frame;
/// past it, an output without a lock surface shows the wallpaper alone.
const HOLD_SESSION: Duration = Duration::from_secs(1);

/// The role Smithay gives a lock surface (not exported by it).
const LOCK_SURFACE_ROLE: &str = "ext_session_lock_surface_v1";

#[derive(Default)]
enum Mode {
    #[default]
    Unlocked,
    /// A client asked: nothing of the session can be reached, and the client hears `locked`
    /// once every output in `waiting` has shown a locked frame. Until `hold_until` (a new
    /// lock; never a relock) an output whose lock surface has no buffer yet still shows the
    /// session.
    Pending { locker: SessionLocker, waiting: Vec<Output>, hold_until: Option<Instant> },
    /// Confirmed. `lock` is the client's object: when it is gone the client is gone.
    Locked { lock: ExtSessionLockV1 },
}

pub struct LockState {
    manager: SessionLockManagerState,
    /// Shared with global filters, which see no `Hyalo`: hidden while locked (`locked_flag`).
    flag: Arc<AtomicBool>,
    mode: Mode,
    /// One lock surface per output, from the client that holds the lock.
    surfaces: Vec<(Output, LockSurface)>,
    /// Bumped at every lock request: a frame rendered with this generation is a locked frame
    /// of THIS lock, and only its vblank counts towards `locked`.
    generation: u64,
    relaunches: Vec<Instant>,
    watch: Option<RegistrationToken>,
}

/// The generation of the last frame rendered on an output (in its user data).
struct RenderedGeneration(std::sync::Mutex<u64>);

impl LockState {
    pub fn new(dh: &smithay::reexports::wayland_server::DisplayHandle) -> Self {
        Self {
            // A sandboxed client cannot lock the session (sandbox.rs).
            manager: SessionLockManagerState::new::<Hyalo, _>(dh, crate::sandbox::unrestricted),
            flag: Arc::new(AtomicBool::new(false)),
            mode: Mode::Unlocked,
            surfaces: Vec::new(),
            generation: 0,
            relaunches: Vec::new(),
            watch: None,
        }
    }

    /// For a global that a new client must not get while the session is locked: the virtual
    /// keyboard. Smithay's sends its keys straight to the keyboard focus, which is the lock
    /// screen's password field — and `wtype` connects anew for every run, so hiding the global
    /// is enough.
    pub fn locked_flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }

    /// Locked, or about to be: nothing of the session may be reached (nor captured).
    pub fn is_locked(&self) -> bool {
        !matches!(self.mode, Mode::Unlocked)
    }

    /// Does `output` show a locked frame (the lock surface over the wallpaper) rather than the
    /// session? Once locked, always; while a new lock waits for its client, once the lock
    /// surface there has a buffer, or once the hold is over.
    pub fn draws_locked(&self, output: &Output) -> bool {
        match &self.mode {
            Mode::Unlocked => false,
            Mode::Locked { .. } => true,
            Mode::Pending { hold_until: None, .. } => true,
            Mode::Pending { hold_until: Some(until), .. } => {
                Instant::now() >= *until
                    || self.surface_for(output).is_some_and(|s| {
                        with_renderer_surface_state(s, |state| state.buffer().is_some()).unwrap_or(false)
                    })
            }
        }
    }

    /// The lock surface on `output`, if its client made one.
    pub fn surface_for(&self, output: &Output) -> Option<&WlSurface> {
        self.surfaces.iter().find(|(o, s)| o == output && s.alive()).map(|(_, s)| s.wl_surface())
    }

    /// The frame being rendered on `output` is a locked one (render/mod.rs).
    pub fn note_rendered(&self, output: &Output) {
        if !self.draws_locked(output) {
            return;
        }
        let data = output.user_data();
        data.insert_if_missing_threadsafe(|| RenderedGeneration(std::sync::Mutex::new(0)));
        *data.get::<RenderedGeneration>().unwrap().0.lock().unwrap() = self.generation;
    }
}

impl Hyalo {
    /// Is `surface` a lock surface, or part of one (a subsurface, a popup of it)?
    pub fn belongs_to_lock(&self, surface: &WlSurface) -> bool {
        let mut root = surface.clone();
        while let Some(parent) = get_parent(&root) {
            root = parent;
        }
        if let Some(popup) = self.popups.find_popup(&root)
            && let Ok(top) = smithay::desktop::find_popup_root_surface(&popup)
        {
            root = top;
        }
        get_role(&root) == Some(LOCK_SURFACE_ROLE)
    }

    /// Every change of keyboard focus goes through here: while the session is locked, only a
    /// lock surface (or nothing) may have the keyboard, whatever asked for it — a click, a new
    /// window, xdg-activation, a focus grab, a popup.
    pub fn set_keyboard_focus(&mut self, surface: Option<WlSurface>, serial: Serial) {
        if self.lock.is_locked() && surface.as_ref().is_some_and(|s| !self.belongs_to_lock(s)) {
            tracing::debug!("keyboard focus refused: the session is locked");
            return;
        }
        let target = surface.map(|s| self.keyboard_target(s));
        let keyboard = self.seat.get_keyboard().unwrap();
        keyboard.set_focus(self, target, serial);
    }

    /// While locked: the lock surface under `pos`, if any.
    pub fn lock_surface_under(&self, pos: Point<f64, Logical>) -> Option<(WlSurface, Point<f64, Logical>)> {
        let output = self.space.output_under(pos).next()?;
        let loc = self.space.output_geometry(output)?.loc;
        let surface = self.lock.surface_for(output)?;
        for (popup, offset) in PopupManager::popups_for_surface(surface) {
            let at = loc + offset - popup.geometry().loc;
            if let Some(hit) = under_from_surface_tree(popup.wl_surface(), pos, at, WindowSurfaceType::ALL) {
                return Some((hit.0, hit.1.to_f64()));
            }
        }
        under_from_surface_tree(surface, pos, loc, WindowSurfaceType::ALL).map(|(s, p)| (s, p.to_f64()))
    }

    /// While locked: the keyboard to the lock surface of the output the pointer is on (or the
    /// first one there is), unless a lock surface has it already.
    pub fn focus_lock_surface(&mut self) {
        let keyboard = self.seat.get_keyboard().unwrap();
        if keyboard.current_focus().and_then(|f| f.surface()).is_some_and(|f| f.is_alive() && self.belongs_to_lock(&f)) {
            return;
        }
        let pointer = self.seat.get_pointer().unwrap().current_location();
        let here = self.space.output_under(pointer).next().and_then(|o| self.lock.surface_for(o)).cloned();
        let any = || self.lock.surfaces.iter().find(|(_, s)| s.alive()).map(|(_, s)| s.wl_surface().clone());
        if let Some(surface) = here.or_else(any) {
            self.set_keyboard_focus(Some(surface), SERIAL_COUNTER.next_serial());
        }
    }

    /// A locked frame of this lock is on screen on `output` (the tty backend's vblank, the
    /// winit backend's submit). Once every output it waits for has one, the client is told.
    pub fn lock_frame_shown(&mut self, output: &Output) {
        let Mode::Pending { waiting, .. } = &mut self.lock.mode else { return };
        let generation = self.lock.generation;
        let shown = output
            .user_data()
            .get::<RenderedGeneration>()
            .is_some_and(|g| *g.0.lock().unwrap() == generation);
        if shown {
            waiting.retain(|o| o != output);
        }
        if waiting.is_empty() {
            self.confirm_lock();
        }
    }

    fn confirm_lock(&mut self) {
        let Mode::Pending { locker, .. } = std::mem::take(&mut self.lock.mode) else { return };
        let lock = locker.ext_session_lock().clone();
        locker.lock();
        tracing::info!("session locked");
        self.lock.mode = Mode::Locked { lock };
        self.ipc_broadcast_lock(true);
        self.lock_confirmed_for_sleep();
    }

    /// While locked, once a second: a lock whose client is gone gets a new one.
    fn watch_lock(&mut self) {
        let dead = match &self.lock.mode {
            Mode::Locked { lock } => !lock.is_alive(),
            Mode::Pending { locker, .. } => !locker.ext_session_lock().is_alive(),
            Mode::Unlocked => return,
        };
        if dead {
            self.relaunch_lock(false);
        }
    }

    /// Starts the lock client again. `asked`: from a key press after the automatic attempts
    /// ran out, which is always allowed one more.
    pub fn relaunch_lock(&mut self, asked: bool) {
        let now = Instant::now();
        self.lock.relaunches.retain(|t| now.duration_since(*t) < RELAUNCH_WINDOW);
        if !asked && self.lock.relaunches.len() >= RELAUNCH_LIMIT {
            return;
        }
        if self.lock.relaunches.last().is_some_and(|t| now.duration_since(*t) < Duration::from_secs(2)) {
            return; // the last one may still be starting
        }
        let cmd = lock_command();
        tracing::warn!(%cmd, "the lock client is gone; the session stays locked and it starts again");
        self.lock.relaunches.push(now);
        crate::spawn(&cmd);
    }

    /// Is the lock held by a client that is gone (so a key press may bring it back)?
    pub fn lock_client_gone(&self) -> bool {
        match &self.lock.mode {
            Mode::Locked { lock } => !lock.is_alive(),
            _ => false,
        }
    }
}

impl SessionLockHandler for Hyalo {
    fn lock_state(&mut self) -> &mut SessionLockManagerState {
        &mut self.lock.manager
    }

    fn lock(&mut self, confirmation: SessionLocker) {
        let held_by_live_client = match &self.lock.mode {
            Mode::Locked { lock } => lock.is_alive(),
            Mode::Pending { locker, .. } => locker.ext_session_lock().is_alive(),
            Mode::Unlocked => false,
        };
        if held_by_live_client {
            // Dropping the locker tells this client it failed: the session is locked already.
            tracing::info!("a second lock request refused: the session is locked by a live client");
            return;
        }
        let relock = self.lock.is_locked();
        self.lock.surfaces.clear();
        self.lock.generation += 1;
        let waiting: Vec<Output> =
            self.space.outputs().filter(|o| self.backend.output_shows_frames(o)).cloned().collect();
        tracing::info!(relock, outputs = waiting.len(), "locking the session");
        let hold_until = (!relock).then(|| Instant::now() + HOLD_SESSION);
        self.lock.mode = Mode::Pending { locker: confirmation, waiting, hold_until };
        self.lock.flag.store(true, Ordering::Release);

        if !relock {
            // Whatever held the input lets go of it: a drag, a menu's grab, a panel's grab.
            let serial = SERIAL_COUNTER.next_serial();
            let pointer = self.seat.get_pointer().unwrap();
            pointer.unset_grab(self, serial, smithay::backend::input::InputTime::now());
            let keyboard = self.seat.get_keyboard().unwrap();
            keyboard.unset_grab(self);
            self.end_focus_grab(true);
            self.set_keyboard_focus(None, serial);
            let token = self.loop_handle.insert_source(Timer::from_duration(WATCH_EVERY), |_, _, state| {
                if !state.lock.is_locked() {
                    state.lock.watch = None;
                    return TimeoutAction::Drop;
                }
                state.watch_lock();
                TimeoutAction::ToDuration(WATCH_EVERY)
            });
            self.lock.watch = token.ok();
            // The hold's end must draw a frame even if nothing else asks for one: a lock client
            // that never draws still gets the session hidden, and `locked` said.
            let _ = self.loop_handle.insert_source(Timer::from_duration(HOLD_SESSION), |_, _, state| {
                state.queue_redraw(None);
                TimeoutAction::Drop
            });
        }
        if matches!(&self.lock.mode, Mode::Pending { waiting, .. } if waiting.is_empty()) {
            // No output shows frames (all off, or another VT is active): nothing to wait for.
            self.confirm_lock();
        }
        self.queue_redraw(None);
    }

    fn unlock(&mut self) {
        tracing::info!("session unlocked");
        self.lock.mode = Mode::Unlocked;
        self.lock.flag.store(false, Ordering::Release);
        self.lock.surfaces.clear();
        self.lock.relaunches.clear();
        if let Some(token) = self.lock.watch.take() {
            self.loop_handle.remove(token);
        }
        // The keyboard back to the window that had it.
        self.set_keyboard_focus(None, SERIAL_COUNTER.next_serial());
        self.restore_keyboard_focus();
        self.ipc_broadcast_lock(false);
        self.queue_redraw(None);
    }

    fn new_surface(&mut self, surface: LockSurface, wl_output: WlOutput) {
        let Some(output) = Output::from_resource(&wl_output) else { return };
        // Only the client that holds (or is taking) the lock: a racing locker's surfaces are not
        // shown, and Smithay stops calling for them once its locker is dropped.
        let ours = match &self.lock.mode {
            Mode::Pending { locker, .. } => locker.ext_session_lock() == surface.ext_session_lock(),
            Mode::Locked { lock } => lock == surface.ext_session_lock(),
            Mode::Unlocked => false,
        };
        if !ours {
            return;
        }
        if let Some(geo) = self.space.output_geometry(&output) {
            surface.with_pending_state(|s| s.size = Some((geo.size.w as u32, geo.size.h as u32).into()));
        }
        self.lock.surfaces.retain(|(o, _)| o != &output);
        self.lock.surfaces.push((output.clone(), surface));
        self.focus_lock_surface();
        self.queue_redraw(Some(&output));
    }
}
