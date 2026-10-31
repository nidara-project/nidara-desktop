//! One coherent observation of the session for the event stream (APPLICATIONS1-DOCK.md §2,
//! §5, §9 "Focus/WM stream", "Launch correlation", "Attention"; #959 H1).
//!
//! - **Epoch.** A random number drawn when this Hyalo starts. Window ids restart with Hyalo, so
//!   an id means a window only together with its epoch; a client that reconnects and finds
//!   another epoch knows every id it held is gone.
//! - **Serial.** Every event the stream sends carries the next serial, one counter for every
//!   subscriber, so a subscriber sees them contiguous: a gap can only be a dropped stream, and
//!   a dropped stream is closed (`server::broadcast`), never silently thinned.
//! - **Time.** Each event's `time_us` is CLOCK_MONOTONIC microseconds when it was sent, the
//!   clock Python's `time.monotonic()` reads. Usage is accounted from these, never wall time.
//! - **Barrier.** `event_stream` with `snapshot: true` answers, then at once sends a `snapshot`
//!   event holding the whole state as of its serial, before any other event can go out (the
//!   compositor is one thread): no race between reading the windows and starting the stream.
//!
//! **Launch correlation.** Whoever started an app with an activation token Hyalo made asks
//! `observe_launch` with it and gets an opaque launch number back; the stream then says what
//! became of that launch, by that number only — a new window used it, an existing window was
//! raised by it, it was refused, or it expired unused. The token itself is never sent, logged
//! or kept past ACTIVATION_TIMEOUT. A token used before it was asked about is remembered as
//! long as the token would have lived, so the order of "launch" and "ask" does not matter.
//! Holding the token is the only authority this needs: it is a secret, one use, 10 s.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::wm::WindowId;

/// How long Hyalo honours a token (activation.rs ACTIVATION_TIMEOUT): a launch nobody heard
/// back from within it has expired.
pub const LAUNCH_TIMEOUT: Duration = crate::activation::ACTIVATION_TIMEOUT;
/// Launches watched at once, and token uses remembered before they are asked about. Ten
/// seconds each: more would be a client asking for launches it did not make.
pub const MAX_LAUNCHES: usize = 64;

/// Without input this long, and with nothing holding idle off, the session is idle for usage
/// accounting (GNOME's presence default; APPLICATIONS1-DOCK.md §5). Independent of the
/// configured idle steps: a user who never dims still stops accruing usage.
pub const USAGE_IDLE: Duration = Duration::from_secs(300);

/// USAGE_IDLE, or the test channel's shorter one (control.rs).
pub fn usage_idle_after() -> Duration {
    static AFTER: std::sync::LazyLock<Duration> = std::sync::LazyLock::new(|| {
        std::env::var("HYALO_TEST_USAGE_IDLE_MS")
            .ok()
            .filter(|_| crate::control::enabled())
            .and_then(|ms| ms.parse().ok())
            .map_or(USAGE_IDLE, Duration::from_millis)
    });
    *AFTER
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Outcome {
    /// A window that had not been shown yet came with the token. `honoured`: the token came
    /// from what the user did (a click on the dock), not from a background request.
    Window { window: WindowId, honoured: bool },
    /// A window already shown asked to come to the front with it, and did.
    Activated { window: WindowId },
    /// A window already shown asked with it and was refused: it was not from the user, or it
    /// came too late. That window now demands attention instead of taking the focus.
    Refused { window: WindowId },
    /// Nobody used it within LAUNCH_TIMEOUT.
    Expired,
}

// Every record lives until its TOKEN's deadline (made + ACTIVATION_TIMEOUT), never longer:
// asking about a token late, or using it late, does not extend it, and no secret or answer is
// kept past it.
struct Watch {
    launch: u64,
    token: String,
    deadline: Instant,
}

struct Used {
    token: String,
    deadline: Instant,
    outcome: Outcome,
}

/// A window not shown yet came with the token: answered when it is shown, if before the
/// deadline (`shown`).
struct Waiting {
    token: String,
    window: WindowId,
    honoured: bool,
    deadline: Instant,
}

/// The launches being watched, the uses not yet asked about, the windows waiting to be shown,
/// and the launches that expired but were not yet announced. Pure: the clock is passed in.
#[derive(Default)]
pub struct Launches {
    next: u64,
    watched: Vec<Watch>,
    used: Vec<Used>,
    waiting: Vec<Waiting>,
    expired: Vec<u64>,
}

impl Launches {
    /// Starts watching `token`'s launch. `deadline`: when the token Hyalo has stops being good;
    /// None when Hyalo does not have it. Returns the launch number, and its outcome if the
    /// token was already used.
    pub fn watch(&mut self, token: &str, deadline: Option<Instant>, now: Instant) -> Result<(u64, Option<Outcome>), &'static str> {
        self.prune(now);
        if let Some(i) = self.used.iter().position(|u| u.token == token) {
            let used = self.used.remove(i);
            return Ok((self.number(), Some(used.outcome)));
        }
        // Used by a window not shown yet: Hyalo no longer has the token, the waiting record does.
        let deadline = deadline.or_else(|| self.waiting.iter().find(|w| w.token == token).map(|w| w.deadline));
        let Some(deadline) = deadline.filter(|d| *d > now) else {
            return Err("not an activation token Hyalo has, or already used or expired");
        };
        if self.watched.iter().any(|w| w.token == token) {
            return Err("this launch is already watched");
        }
        if self.watched.len() >= MAX_LAUNCHES {
            return Err("too many launches watched at once");
        }
        let launch = self.number();
        self.watched.push(Watch { launch, token: token.to_owned(), deadline });
        Ok((launch, None))
    }

    /// `token` (good until `deadline`) was used with this outcome. Returns the launch watching
    /// it, if one is; else the use is remembered for a later `watch`, until the deadline.
    pub fn used(&mut self, token: &str, outcome: Outcome, deadline: Instant, now: Instant) -> Option<u64> {
        self.prune(now);
        if let Some(i) = self.watched.iter().position(|w| w.token == token) {
            return Some(self.watched.remove(i).launch);
        }
        if deadline > now {
            if self.used.len() >= MAX_LAUNCHES {
                self.used.remove(0);
            }
            self.used.push(Used { token: token.to_owned(), deadline, outcome });
        }
        None
    }

    /// A window not shown yet asked with `token`: its launch is answered when it is shown.
    pub fn wait_shown(&mut self, token: &str, window: WindowId, honoured: bool, deadline: Instant, now: Instant) {
        self.prune(now);
        if deadline <= now {
            return;
        }
        self.waiting.retain(|w| w.window != window);
        if self.waiting.len() >= MAX_LAUNCHES {
            self.waiting.remove(0);
        }
        self.waiting.push(Waiting { token: token.to_owned(), window, honoured, deadline });
    }

    /// `window` was shown: the launch it came with, if it came with one in time, and how.
    pub fn shown(&mut self, window: WindowId, now: Instant) -> Option<(Option<u64>, Outcome)> {
        self.prune(now);
        let i = self.waiting.iter().position(|w| w.window == window)?;
        let w = self.waiting.remove(i);
        let outcome = Outcome::Window { window, honoured: w.honoured };
        Some((self.used(&w.token, outcome, w.deadline, now), outcome))
    }

    /// The launches that expired unused since last asked, each exactly once.
    pub fn take_expired(&mut self, now: Instant) -> Vec<u64> {
        self.prune(now);
        std::mem::take(&mut self.expired)
    }

    /// The soonest deadline of a watched launch: when to look again.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.watched.iter().map(|w| w.deadline).min()
    }

    /// Forgets what is past its deadline; a watched launch moves to `expired`, to be announced.
    fn prune(&mut self, now: Instant) {
        let alive = |d: Instant| d > now;
        self.used.retain(|u| alive(u.deadline));
        self.waiting.retain(|w| alive(w.deadline));
        let expired = &mut self.expired;
        self.watched.retain(|w| {
            if !alive(w.deadline) {
                expired.push(w.launch);
            }
            alive(w.deadline)
        });
    }

    fn number(&mut self) -> u64 {
        self.next += 1;
        self.next
    }
}

/// The stream's coherence: epoch, serial, and the session boundaries it reports.
pub struct Observation {
    pub epoch: u64,
    serial: u64,
    /// This seat has the screens (logind/libseat); false while another VT has them.
    pub session_active: bool,
    /// Between logind's PrepareForSleep(true) and (false).
    pub sleeping: bool,
    pub launches: Launches,
}

impl Default for Observation {
    fn default() -> Self {
        Self { epoch: epoch(), serial: 0, session_active: true, sleeping: false, launches: Launches::default() }
    }
}

impl Observation {
    /// The serial the next event carries.
    pub fn next_serial(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }
    /// The serial of the last event sent: what a snapshot is "as of".
    pub fn serial(&self) -> u64 {
        self.serial
    }
}

/// Random, never zero: a client may use 0 for "none yet".
fn epoch() -> u64 {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    let random = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_ok();
    let n = if random {
        u64::from_ne_bytes(bytes)
    } else {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        (t.as_nanos() as u64) ^ (u64::from(std::process::id()) << 32)
    };
    // Within 2^53, so JavaScript reads it exactly too.
    (n & ((1 << 53) - 1)).max(1)
}

/// CLOCK_MONOTONIC microseconds for an `Instant` (Rust's Instant is CLOCK_MONOTONIC on
/// Linux), given the clock's reading now.
pub fn instant_us(now_us: u64, instant: Instant) -> u64 {
    now_us.saturating_sub(instant.elapsed().as_micros() as u64)
}

use smithay::reexports::calloop::timer::{TimeoutAction, Timer};

use super::{Event, Reply, Response, server::broadcast};
use crate::state::Hyalo;

impl Hyalo {
    /// CLOCK_MONOTONIC now, µs.
    pub fn now_us(&self) -> u64 {
        Duration::from(self.clock.now()).as_micros() as u64
    }

    /// `event` as the stream sends it: with its epoch, serial and time.
    pub fn stamped(&self, event: &Event, serial: u64) -> serde_json::Value {
        let mut value = serde_json::to_value(event).unwrap_or_default();
        if let Some(o) = value.as_object_mut() {
            o.insert("epoch".into(), self.ipc.observe.epoch.into());
            o.insert("serial".into(), serial.into());
            o.insert("time_us".into(), self.now_us().into());
        }
        value
    }

    pub fn snapshot_event(&mut self) -> Event {
        let (idle, idle_since_us) = self.usage_idle();
        Event::Snapshot {
            windows: self.window_infos(),
            workspaces: self.workspace_infos(),
            focus: self.wm.focused,
            locked: self.lock.is_locked(),
            idle,
            idle_since_us,
            session_active: self.ipc.observe.session_active,
            sleeping: self.ipc.observe.sleeping,
        }
    }

    pub fn observe_launch(&mut self, token: &str) -> Reply {
        let deadline = self
            .activation_state
            .tokens()
            .find(|(t, _)| t.as_str() == token)
            .map(|(_, d)| d.timestamp + LAUNCH_TIMEOUT);
        let watched = self.ipc.observe.launches.watch(token, deadline, Instant::now());
        self.announce_expired();
        match watched {
            Err(e) => Reply::Error(e.into()),
            Ok((launch, already)) => {
                if already.is_none()
                    && let Some(at) = self.ipc.observe.launches.next_deadline()
                {
                    // The answer if nobody uses it: a timer at the token's own deadline.
                    let _ = self.loop_handle.insert_source(Timer::from_deadline(at), |_, _, state| {
                        state.announce_expired();
                        TimeoutAction::Drop
                    });
                }
                Reply::Ok(Response::LaunchObserved { launch, already })
            }
        }
    }

    /// Every launch that expired unused and was not yet said to have: said now, once.
    fn announce_expired(&mut self) {
        for launch in self.ipc.observe.launches.take_expired(Instant::now()) {
            broadcast(self, &Event::LaunchOutcome { launch, outcome: Outcome::Expired });
        }
    }

    /// An activation token, good until `deadline`, was used (activation.rs).
    pub fn launch_used(&mut self, token: &str, outcome: Outcome, deadline: Instant) {
        let launch = self.ipc.observe.launches.used(token, outcome, deadline, Instant::now());
        self.announce_expired();
        if let Some(launch) = launch {
            broadcast(self, &Event::LaunchOutcome { launch, outcome });
        }
    }

    /// A window not shown yet asked with a token: only the launch bookkeeping keeps it, and
    /// only until the token's deadline (activation.rs).
    pub fn launch_waits_for(&mut self, token: &str, window: WindowId, honoured: bool, deadline: Instant) {
        self.ipc.observe.launches.wait_shown(token, window, honoured, deadline, Instant::now());
        self.announce_expired();
    }

    /// Window `id` was just shown: the launch whose token it came with is answered.
    pub fn window_shown_with_token(&mut self, id: WindowId, window: &smithay::desktop::Window) {
        let shown = self.ipc.observe.launches.shown(id, Instant::now());
        self.announce_expired();
        if let Some((launch, outcome)) = shown {
            if let Some(launch) = launch {
                broadcast(self, &Event::LaunchOutcome { launch, outcome });
            }
        } else if let Some((token, honoured, deadline)) = self.take_x11_startup(window) {
            self.launch_used(&token, Outcome::Window { window: id, honoured }, deadline);
        }
        if let Some(x) = window.x11_surface()
            && x.hints().is_some_and(|h| h.urgent)
            && self.wm.focused != Some(id)
        {
            self.set_attention(id, None, Some(true));
        }
    }

    /// The keyboard goes to `id`: every change of who has it is said at once, with its own
    /// time (`focus_transition`), however many a dispatch makes — usage is split at each. The
    /// coalesced `focus_changed` still follows the round's window list.
    pub fn set_focused(&mut self, id: Option<WindowId>) {
        if self.wm.focused == id {
            return;
        }
        self.wm.focused = id;
        let app_id = id.and_then(|id| self.wm.get(id)).map(|m| crate::wm::app_id(&m.window));
        broadcast(self, &Event::FocusTransition { id, app_id });
    }

    /// Sets either source of a window's attention (`None` leaves it); the stream hears of an
    /// edge only.
    pub fn set_attention(&mut self, id: WindowId, activation: Option<bool>, x11: Option<bool>) {
        let Some(m) = self.wm.get_mut(id) else { return };
        let before = m.demands_attention();
        if let Some(a) = activation {
            m.attention = a;
        }
        if let Some(x) = x11 {
            m.x11_urgent = x;
        }
        let demands = m.demands_attention();
        if before != demands {
            self.wm.dirty_windows = true;
            broadcast(self, &Event::AttentionChanged { id, demands });
        }
    }

    pub fn session_active_changed(&mut self, active: bool) {
        if std::mem::replace(&mut self.ipc.observe.session_active, active) != active {
            broadcast(self, &Event::SessionActiveChanged { active });
        }
    }

    pub fn sleep_changed(&mut self, sleeping: bool) {
        if std::mem::replace(&mut self.ipc.observe.sleeping, sleeping) != sleeping {
            broadcast(self, &Event::SleepChanged { sleeping });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = LAUNCH_TIMEOUT;

    #[test]
    fn a_launch_is_answered_whether_it_is_asked_about_before_or_after_its_use() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        let d = Some(t0 + T);
        // Asked first, used after.
        let (a, now) = l.watch("tok-a", d, t0).unwrap();
        assert_eq!(now, None);
        assert_eq!(l.used("tok-a", Outcome::Activated { window: 7 }, t0 + T, t0), Some(a));
        // Used first, asked after: the answer comes with the number.
        assert_eq!(l.used("tok-b", Outcome::Activated { window: 8 }, t0 + T, t0), None);
        let (b, now) = l.watch("tok-b", None, t0).unwrap();
        assert_ne!(a, b);
        assert_eq!(now, Some(Outcome::Activated { window: 8 }));
        // Once answered, the token is forgotten: asking again is refused, not answered twice.
        assert!(l.watch("tok-b", None, t0).is_err());
        assert!(l.watch("tok-a", None, t0).is_err());
    }

    #[test]
    fn a_window_not_shown_yet_answers_when_shown_and_never_after_the_deadline() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        // Asked before the window used it, and after: both get the window when it is shown.
        let (a, _) = l.watch("tok-a", Some(t0 + T), t0).unwrap();
        l.wait_shown("tok-a", 1, true, t0 + T, t0);
        l.wait_shown("tok-b", 2, false, t0 + T, t0);
        let (b, now) = l.watch("tok-b", None, t0).unwrap();
        assert_eq!(now, None, "not answered before the window is shown");
        assert_eq!(l.shown(1, t0), Some((Some(a), Outcome::Window { window: 1, honoured: true })));
        assert_eq!(l.shown(2, t0), Some((Some(b), Outcome::Window { window: 2, honoured: false })));
        assert_eq!(l.shown(2, t0), None, "once");
        // A window that is never shown: its token is gone at the deadline and the launch expires.
        let (c, _) = l.watch("tok-c", Some(t0 + T), t0).unwrap();
        l.wait_shown("tok-c", 3, true, t0 + T, t0);
        assert_eq!(l.take_expired(t0 + T), vec![c]);
        assert_eq!(l.shown(3, t0 + T), None, "shown too late: no launch is claimed");
        assert!(l.waiting.is_empty() && l.watched.is_empty());
    }

    #[test]
    fn the_deadline_is_the_tokens_however_late_it_is_asked_about_or_used() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        // A token made at t0, asked about at 9 s: it expires at 10 s, not at 19 s.
        let (a, _) = l.watch("tok", Some(t0 + T), t0 + Duration::from_secs(9)).unwrap();
        assert_eq!(l.next_deadline(), Some(t0 + T));
        assert_eq!(l.take_expired(t0 + T), vec![a]);
        // A use past the deadline (refused, kept for attention) is not observable.
        assert_eq!(l.used("old", Outcome::Refused { window: 1 }, t0 + T, t0 + T * 2), None);
        assert!(l.watch("old", None, t0 + T * 2).is_err());
        // A token that is past its deadline already cannot be watched.
        assert!(l.watch("stale", Some(t0 + T), t0 + T).is_err());
    }

    #[test]
    fn an_expiry_is_announced_once_even_when_another_call_finds_it_first() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        let (a, _) = l.watch("a", Some(t0 + T), t0).unwrap();
        // Another launch is asked about, and another token used, after A's deadline but before
        // its timer runs: A is still announced, once.
        l.watch("b", Some(t0 + T * 2), t0 + T).unwrap();
        l.used("c", Outcome::Activated { window: 1 }, t0 + T * 2, t0 + T);
        assert_eq!(l.take_expired(t0 + T), vec![a]);
        assert!(l.take_expired(t0 + T).is_empty());
    }

    #[test]
    fn foreign_and_too_many_tokens_are_refused() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        assert!(l.watch("made-up", None, t0).is_err(), "a token Hyalo does not have");
        l.watch("tok", Some(t0 + T), t0).unwrap();
        assert!(l.watch("tok", Some(t0 + T), t0).is_err(), "watched twice");
        for n in 1..MAX_LAUNCHES {
            l.watch(&format!("t{n}"), Some(t0 + T), t0).unwrap();
        }
        assert!(l.watch("one-more", Some(t0 + T), t0).is_err());
    }

    #[test]
    fn serials_are_contiguous_and_the_epoch_is_never_zero() {
        let mut o = Observation::default();
        assert_ne!(o.epoch, 0);
        assert_eq!(o.serial(), 0);
        assert_eq!(o.next_serial(), 1);
        assert_eq!(o.next_serial(), 2);
        assert_eq!(o.serial(), 2);
    }
}
