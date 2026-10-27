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
//! - **No lock from idle in a window** (`--winit`): its lock client is a `nidara-lock` like the
//!   live session's, and while it sat on a forgotten nested Hyalo the live session's launcher
//!   took it for its own and never drew the lock screen (2026-10-26). The screens still go dark,
//!   inside the window; Super+L still locks it by hand.

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
    dim: bool,
    screen_off: bool,
    lock: bool,
    suspend: bool,
}

impl Fired {
    fn restart_inhibited_stretch(&mut self) {
        self.dim = false;
        self.suspend = false;
    }
    fn input(&mut self) -> bool {
        std::mem::take(self).screen_off
    }
}

/// The suspend stretch has its own clock: changing source or timeout must never
/// apply an old stretch of inactivity to the new policy. `now` is injectable.
struct SleepClock {
    since: Instant,
    source: Option<bool>,
    timeout: u32,
}
impl SleepClock {
    fn new(now: Instant) -> Self {
        Self {
            since: now,
            source: None,
            timeout: 0,
        }
    }
    fn reset(&mut self, now: Instant) {
        self.since = now;
    }
    fn source(&mut self, source: Option<bool>, now: Instant) -> bool {
        if self.source == source {
            return false;
        }
        self.source = source;
        self.reset(now);
        true
    }
    fn timeout(&mut self, timeout: u32, now: Instant) -> bool {
        if self.timeout == timeout {
            return false;
        }
        self.timeout = timeout;
        self.reset(now);
        true
    }
    fn due(&self, now: Instant) -> bool {
        self.timeout > 0 && now.saturating_duration_since(self.since) >= Duration::from_secs(self.timeout as u64)
    }
}
fn may_suspend(session: bool, nested: bool) -> bool {
    session && !nested
}

pub struct IdleState {
    notifier: IdleNotifierState<Hyalo>,
    last_activity: Instant,
    sleep: SleepClock,
    pub dimmed: bool,
    fired: Fired,
    timer: Option<RegistrationToken>,
    /// Surfaces that asked through idle-inhibit; they count while shown.
    inhibitors: Vec<WlSurface>,
    /// Apps holding an `org.freedesktop.ScreenSaver` inhibition (logind.rs).
    pub dbus_inhibitors: usize,
    /// A real session: suspend may run.
    pub session: bool,
    /// A window inside another session (`--winit`): idle never locks it.
    pub nested: bool,
}

impl IdleState {
    pub fn new(
        dh: &smithay::reexports::wayland_server::DisplayHandle,
        loop_handle: smithay::reexports::calloop::LoopHandle<'static, Hyalo>,
    ) -> Self {
        IdleInhibitManagerState::new::<Hyalo>(dh);
        Self {
            notifier: IdleNotifierState::new(dh, loop_handle),
            last_activity: Instant::now(),
            sleep: SleepClock::new(Instant::now()),
            dimmed: false,
            fired: Fired::default(),
            timer: None,
            inhibitors: Vec::new(),
            dbus_inhibitors: 0,
            session: false,
            nested: false,
        }
    }
}

impl Hyalo {
    /// Input happened. Cheap: called for every motion.
    pub fn note_activity(&mut self) {
        let seat = self.seat.clone();
        self.idle.notifier.notify_activity(&seat);
        self.idle.last_activity = Instant::now();
        self.idle.sleep.reset(self.idle.last_activity);
        self.clear_idle_dim();
        if self.idle.fired.input() {
            tracing::info!("input: the screens come back on");
            let _ = crate::outputs::set_power(self, None, true);
            crate::ipc::server::outputs_changed(self);
        }
        // Every step had fired, so no timer was waiting: this stretch needs one again.
        if self.idle.timer.is_none() {
            self.idle_rearm();
        }
    }

    fn clear_idle_dim(&mut self) {
        if std::mem::take(&mut self.idle.dimmed) {
            self.queue_redraw(None);
        }
    }
    pub fn idle_power_source(&mut self, on_battery: Option<bool>) {
        if self.idle.sleep.source(on_battery, Instant::now()) {
            self.idle.fired.suspend = false;
            self.idle_rearm();
            crate::ipc::server::broadcast(self, &crate::ipc::Event::PowerStateChanged);
        }
    }
    pub fn idle_config_changed(&mut self) {
        self.idle.sleep.reset(Instant::now());
        self.idle.fired.suspend = false;
        self.idle.fired.dim = false;
        self.clear_idle_dim();
        self.idle_rearm();
    }
    pub fn power_info(&mut self) -> serde_json::Value {
        let inhibitors = self.idle_inhibitors_info();
        let external = self.space.outputs().any(|o| {
            let name = o.name();
            !["eDP", "LVDS", "DSI"].iter().any(|prefix| name.starts_with(prefix))
        });
        let binding = serde_json::to_value(self.config.binds.get("XF86PowerOff")).unwrap_or_default();
        let command = binding
            .as_str()
            .or_else(|| binding["action"].as_str())
            .unwrap_or_default();
        let ready = command == "spawn nidara-power-key"
            && binding["locked"].as_bool() == Some(true)
            && binding["dont_inhibit"].as_bool() == Some(true)
            && !binding["repeat"].as_bool().unwrap_or(false)
            && !binding["release"].as_bool().unwrap_or(false)
            && std::env::var_os("PATH").is_some_and(|paths| {
                std::env::split_paths(&paths).any(|dir| {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::metadata(dir.join("nidara-power-key"))
                        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                })
            });
        serde_json::json!({
            "session": self.idle.session,
            "nested": self.idle.nested,
            "locked": self.lock.is_locked(),
            "power_key_forwarding": ready,
            "docked_known": self.idle.session&&!self.idle.nested,
            "docked": external,
            "idle": self.config.idle,
            "dimmed": self.idle.dimmed,
            "on_battery": self.idle.sleep.source,
            "inhibitors": inhibitors,
        })
    }
    pub fn idle_inhibitors_info(&mut self) -> Vec<serde_json::Value> {
        self.idle.inhibitors.retain(|s| s.is_alive());
        let mut out=self.idle.inhibitors.iter().map(|surface| {
            let root=self.window_for_surface(surface);
            let app=root.as_ref().map(crate::wm::app_id).unwrap_or_default();
            serde_json::json!({
                "id": format!("wayland:{:?}:{}",surface.client().map(|c|c.id()),surface.id().protocol_id()),
                "source": "wayland-idle",
                "who": app,
                "reason": "Wayland idle-inhibit",
                "app_id": app,
                "pid": 0,
                "uid": 0,
                "identity_known": false,
                "effective": !self.lock.is_locked()&&self.surface_is_shown(surface),
            })
        }).collect::<Vec<_>>();
        if let Some(login) = &self.login {
            for item in &login.inhibitors {
                let mut item = item.clone();
                item["effective"] = serde_json::json!(!self.lock.is_locked());
                out.push(item);
            }
        }
        out
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
        if inhibited {
            self.clear_idle_dim();
        }
        crate::ipc::server::broadcast(self, &crate::ipc::Event::IdleInhibitorsChanged);
        self.idle.notifier.set_is_inhibited(inhibited);
        if !inhibited {
            // The time spent inhibited was not idle time: the stretch starts now.
            self.idle.last_activity = Instant::now();
            self.idle.sleep.reset(self.idle.last_activity);
            self.idle.fired.restart_inhibited_stretch();
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
        let suspend = suspend_seconds(&cfg, self.idle.sleep.source);
        if self.idle.sleep.timeout(suspend, Instant::now()) {
            self.idle.fired.suspend = false;
        }
        let dim = dim_seconds(&cfg);
        let next = [
            (dim, self.idle.fired.dim, self.idle.last_activity),
            (cfg.screen_off, fired.screen_off, self.idle.last_activity),
            (cfg.lock, fired.lock, self.idle.last_activity),
            (suspend, self.idle.fired.suspend, self.idle.sleep.since),
        ]
        .into_iter()
        .filter(|(seconds, fired, _)| *seconds > 0 && !*fired)
        .map(|(seconds, _, start)| start + Duration::from_secs(seconds as u64))
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
            self.idle.sleep.reset(self.idle.last_activity);
            self.idle.fired.restart_inhibited_stretch();
            self.idle_rearm();
            return;
        }
        let idle = self.idle.last_activity.elapsed();
        let cfg = self.config.idle.clone();
        let due = |t: u32| t > 0 && idle >= Duration::from_secs(t as u64);
        if due(dim_seconds(&cfg)) && !self.idle.fired.dim {
            self.idle.fired.dim = true;
            self.idle.dimmed = true;
            self.queue_redraw(None);
        }
        if due(cfg.screen_off) && !self.idle.fired.screen_off {
            self.idle.fired.screen_off = true;
            tracing::info!(secs = cfg.screen_off, "idle: the screens go dark");
            let _ = crate::outputs::set_power(self, None, false);
            crate::ipc::server::outputs_changed(self);
        }
        if due(cfg.lock) && !self.idle.fired.lock {
            self.idle.fired.lock = true;
            if self.idle.nested {
                tracing::info!("idle: lock skipped, this Hyalo is a window (--winit)");
            } else if !self.lock.is_locked() {
                tracing::info!(secs = cfg.lock, "idle: locking");
                self.lock_session();
            }
        }
        if self.idle.sleep.due(Instant::now()) && !self.idle.fired.suspend {
            self.idle.fired.suspend = true;
            if may_suspend(self.idle.session, self.idle.nested) {
                tracing::info!(secs = self.idle.sleep.timeout, "idle: suspending");
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

fn suspend_seconds(config: &crate::config::IdleConfig, on_battery: Option<bool>) -> u32 {
    match on_battery {
        Some(true) => config.suspend_battery,
        Some(false) => config.suspend_ac,
        None => 0,
    }
}
fn dim_seconds(config: &crate::config::IdleConfig) -> u32 {
    if config.screen_off <= config.dim_before_off || config.dim_before_off == 0 {
        0
    } else {
        config.screen_off.saturating_sub(config.dim_before_off).max(1)
    }
}
#[cfg(test)]
mod power_tests {
    use super::*;
    #[test]
    fn inhibition_after_screen_off_keeps_the_next_input_wake_pending() {
        let mut fired = Fired {
            screen_off: true,
            ..Default::default()
        };
        // Off at 300s, ScreenSaver inhibition starts, the lock timer then fires.
        fired.restart_inhibited_stretch();
        assert!(fired.screen_off);
        // Releasing inhibition also must not erase physical DPMS state.
        fired.restart_inhibited_stretch();
        assert!(fired.input());
        assert!(!fired.input());
    }
    #[test]
    fn source_timeout_input_and_inhibition_start_a_new_sleep_stretch() {
        let start = Instant::now();
        let later = start + Duration::from_secs(1000);
        let mut clock = SleepClock::new(start);
        assert!(clock.source(Some(true), start));
        assert!(clock.timeout(60, start));
        assert!(clock.due(start + Duration::from_secs(60)));
        assert!(clock.source(Some(false), later));
        assert!(!clock.due(later));
        assert!(clock.timeout(5, later));
        assert!(!clock.due(later + Duration::from_secs(4)));
        assert!(clock.due(later + Duration::from_secs(5)));
        clock.reset(later + Duration::from_secs(5));
        assert!(!clock.due(later + Duration::from_secs(6)));
        clock.source(None, later);
        clock.timeout(0, later);
        assert!(!clock.due(later + Duration::from_secs(9999)));
        assert!(may_suspend(true, false));
        assert!(!may_suspend(false, false));
        assert!(!may_suspend(true, true));
    }
    #[test]
    fn dim_and_source_deadlines_have_no_zero_or_unknown_sleep() {
        let mut cfg = crate::config::IdleConfig {
            suspend_battery: 60,
            suspend_ac: 600,
            ..Default::default()
        };
        assert_eq!(suspend_seconds(&cfg, None), 0);
        assert_eq!(suspend_seconds(&cfg, Some(true)), 60);
        assert_eq!(suspend_seconds(&cfg, Some(false)), 600);
        assert_eq!(dim_seconds(&cfg), 290);
        cfg.screen_off = 1;
        assert_eq!(dim_seconds(&cfg), 0);
        cfg.screen_off = 5;
        assert_eq!(dim_seconds(&cfg), 0);
    }
}
