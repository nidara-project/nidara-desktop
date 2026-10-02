//! When nobody touches the computer: the screen goes dark, the session locks, the computer
//! sleeps — `[idle]` in the config, written by Settings → Power. Hyalo does it itself (owner,
//! 2026-10-02): no hypridle, no other process that has to be alive for the session to lock.
//!
//! - **Activity** is any input: a device, the control FIFO, the virtual pointer (`note_activity`
//!   from input.rs). It only moves a timestamp: one timer wakes at the next step's deadline,
//!   checks the time that really passed, and is armed again — not re-armed at every motion.
//! - **Inhibitors** hold everything off while they count: an `idle-inhibit` surface (a video
//!   playing) while it is SHOWN, and the apps that asked over `org.freedesktop.ScreenSaver`
//!   (logind.rs). While the session is locked none counts: nobody is watching.
//! - The steps are independent, each fires once per idle stretch. The screen comes back on at
//!   the first input; the lock stays.
//! - Other programs can still ask how long the user has been away: `ext-idle-notify-v1`, fed
//!   by the same activity and the same inhibitors.
//! - **Suspend only in a real session** (`--session`): a development Hyalo in a window must
//!   never put the machine it runs on to sleep.

use std::time::{Duration, Instant};

use smithay::{
    reexports::{
        calloop::{
            RegistrationToken,
            timer::{TimeoutAction, Timer},
        },
        wayland_server::{Resource, protocol::wl_surface::WlSurface},
    },
    wayland::{
        compositor::get_parent,
        idle_inhibit::{IdleInhibitHandler, IdleInhibitManagerState},
        idle_notify::{IdleNotifierHandler, IdleNotifierState},
    },
};

use crate::state::Hyalo;

#[derive(Default, Clone, Copy)]
struct Fired {
    screen_off: bool,
    lock: bool,
    suspend: bool,
}

pub struct IdleState {
    notifier: IdleNotifierState<Hyalo>,
    last_activity: Instant,
    fired: Fired,
    timer: Option<RegistrationToken>,
    /// Surfaces that asked through idle-inhibit; they count while shown.
    inhibitors: Vec<WlSurface>,
    /// Apps holding an `org.freedesktop.ScreenSaver` inhibition (logind.rs).
    pub dbus_inhibitors: usize,
    /// A real session: suspend may run.
    pub session: bool,
}

impl IdleState {
    pub fn new(dh: &smithay::reexports::wayland_server::DisplayHandle, loop_handle: smithay::reexports::calloop::LoopHandle<'static, Hyalo>) -> Self {
        IdleInhibitManagerState::new::<Hyalo>(dh);
        Self {
            notifier: IdleNotifierState::new(dh, loop_handle),
            last_activity: Instant::now(),
            fired: Fired::default(),
            timer: None,
            inhibitors: Vec::new(),
            dbus_inhibitors: 0,
            session: false,
        }
    }
}

impl Hyalo {
    /// Input happened. Cheap: called for every motion.
    pub fn note_activity(&mut self) {
        let seat = self.seat.clone();
        self.idle.notifier.notify_activity(&seat);
        self.idle.last_activity = Instant::now();
        let fired = std::mem::take(&mut self.idle.fired);
        if fired.screen_off {
            tracing::info!("input: the screens come back on");
            let _ = crate::outputs::set_power(self, None, true);
            crate::ipc::server::outputs_changed(self);
        }
        // Every step had fired, so no timer was waiting: this stretch needs one again.
        if self.idle.timer.is_none() {
            self.idle_rearm();
        }
    }

    /// Does anything hold the idle steps off right now?
    fn idle_inhibited(&mut self) -> bool {
        if self.lock.is_locked() {
            return false;
        }
        self.idle.inhibitors.retain(|s| s.is_alive());
        let shown = self.idle.inhibitors.iter().any(|s| self.surface_is_shown(s));
        shown || self.idle.dbus_inhibitors > 0
    }

    /// Is `surface` part of a window or layer surface on screen?
    fn surface_is_shown(&self, surface: &WlSurface) -> bool {
        let mut root = surface.clone();
        while let Some(parent) = get_parent(&root) {
            root = parent;
        }
        if let Some(window) = self.window_for_surface(&root) {
            return self.space.elements().any(|w| w == &window);
        }
        self.space.outputs().any(|o| {
            smithay::desktop::layer_map_for_output(o).layers().any(|l| l.wl_surface() == &root)
        })
    }

    /// The idle state changed in a way the ext-idle-notify clients must hear.
    pub fn idle_inhibition_changed(&mut self) {
        let inhibited = self.idle_inhibited();
        self.idle.notifier.set_is_inhibited(inhibited);
        if !inhibited {
            // The time spent inhibited was not idle time: the stretch starts now.
            self.idle.last_activity = Instant::now();
            self.idle_rearm();
        }
    }

    /// Arms the timer for the next step that has not fired (the config changed, a stretch began).
    pub fn idle_rearm(&mut self) {
        if let Some(token) = self.idle.timer.take() {
            self.loop_handle.remove(token);
        }
        let cfg = self.config.idle.clone();
        let fired = self.idle.fired;
        let next = [(cfg.screen_off, fired.screen_off), (cfg.lock, fired.lock), (cfg.suspend, fired.suspend)]
            .into_iter()
            .filter(|(t, f)| *t > 0 && !f)
            .map(|(t, _)| self.idle.last_activity + Duration::from_secs(t as u64))
            .min();
        let Some(deadline) = next else { return };
        let token = self.loop_handle.insert_source(Timer::from_deadline(deadline), |_, _, state| {
            state.idle.timer = None;
            state.idle_check();
            TimeoutAction::Drop
        });
        self.idle.timer = token.ok();
    }

    fn idle_check(&mut self) {
        if self.idle_inhibited() {
            self.idle.last_activity = Instant::now();
            self.idle_rearm();
            return;
        }
        let idle = self.idle.last_activity.elapsed();
        let cfg = self.config.idle.clone();
        let due = |t: u32| t > 0 && idle >= Duration::from_secs(t as u64);
        if due(cfg.screen_off) && !self.idle.fired.screen_off {
            self.idle.fired.screen_off = true;
            tracing::info!(secs = cfg.screen_off, "idle: the screens go dark");
            let _ = crate::outputs::set_power(self, None, false);
            crate::ipc::server::outputs_changed(self);
        }
        if due(cfg.lock) && !self.idle.fired.lock {
            self.idle.fired.lock = true;
            if !self.lock.is_locked() {
                tracing::info!(secs = cfg.lock, "idle: locking");
                crate::spawn(&crate::lock::lock_command());
            }
        }
        if due(cfg.suspend) && !self.idle.fired.suspend {
            self.idle.fired.suspend = true;
            if self.idle.session {
                tracing::info!(secs = cfg.suspend, "idle: suspending");
                crate::spawn("systemctl suspend");
            } else {
                tracing::info!("idle: suspend skipped, this is not a session (--session)");
            }
        }
        self.idle_rearm();
    }

    /// For the IPC: seconds since the last input, and whether something holds idle off.
    pub fn idle_info(&mut self) -> (u64, bool) {
        (self.idle.last_activity.elapsed().as_secs(), self.idle_inhibited())
    }
}

impl IdleNotifierHandler for Hyalo {
    fn idle_notifier_state(&mut self) -> &mut IdleNotifierState<Self> {
        &mut self.idle.notifier
    }
}

impl IdleInhibitHandler for Hyalo {
    fn inhibit(&mut self, surface: WlSurface) {
        self.idle.inhibitors.push(surface);
        self.idle_inhibition_changed();
    }

    fn uninhibit(&mut self, surface: WlSurface) {
        self.idle.inhibitors.retain(|s| s != &surface);
        self.idle_inhibition_changed();
    }
}
