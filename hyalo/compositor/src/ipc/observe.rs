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

struct Watch {
    launch: u64,
    token: String,
    at: Instant,
}

struct Used {
    token: String,
    at: Instant,
    outcome: Outcome,
}

/// The launches being watched and the uses not yet asked about. Pure: the clock is passed in.
#[derive(Default)]
pub struct Launches {
    next: u64,
    watched: Vec<Watch>,
    used: Vec<Used>,
}

impl Launches {
    /// Starts watching `token`'s launch. `known`: Hyalo made it and it has not been used or
    /// expired. Returns the launch number, and its outcome if the token was already used.
    pub fn watch(&mut self, token: &str, known: bool, now: Instant) -> Result<(u64, Option<Outcome>), &'static str> {
        self.expire(now);
        if let Some(i) = self.used.iter().position(|u| u.token == token) {
            let used = self.used.remove(i);
            return Ok((self.number(), Some(used.outcome)));
        }
        if !known {
            return Err("not an activation token Hyalo has, or already used or expired");
        }
        if self.watched.iter().any(|w| w.token == token) {
            return Err("this launch is already watched");
        }
        if self.watched.len() >= MAX_LAUNCHES {
            return Err("too many launches watched at once");
        }
        let launch = self.number();
        self.watched.push(Watch { launch, token: token.to_owned(), at: now });
        Ok((launch, None))
    }

    /// `token` was used with this outcome. Returns the launch watching it, if one is; else the
    /// use is remembered for a later `watch`.
    pub fn used(&mut self, token: &str, outcome: Outcome, now: Instant) -> Option<u64> {
        self.expire(now);
        if let Some(i) = self.watched.iter().position(|w| w.token == token) {
            return Some(self.watched.remove(i).launch);
        }
        if self.used.len() >= MAX_LAUNCHES {
            self.used.remove(0);
        }
        self.used.push(Used { token: token.to_owned(), at: now, outcome });
        None
    }

    /// The launches whose token's time ran out unused; forgets uses nobody asked about in time.
    pub fn expire(&mut self, now: Instant) -> Vec<u64> {
        let old = |at: Instant| now.saturating_duration_since(at) >= LAUNCH_TIMEOUT;
        self.used.retain(|u| !old(u.at));
        let mut gone = Vec::new();
        self.watched.retain(|w| {
            let keep = !old(w.at);
            if !keep {
                gone.push(w.launch);
            }
            keep
        });
        gone
    }

    pub fn is_empty(&self) -> bool {
        self.watched.is_empty()
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
        let known = self
            .activation_state
            .tokens()
            .any(|(t, d)| t.as_str() == token && d.timestamp.elapsed() < LAUNCH_TIMEOUT);
        match self.ipc.observe.launches.watch(token, known, Instant::now()) {
            Err(e) => Reply::Error(e.into()),
            Ok((launch, already)) => {
                if already.is_none() {
                    // The answer if nobody uses it: one timer per watched launch, bounded.
                    let _ = self.loop_handle.insert_source(Timer::from_duration(LAUNCH_TIMEOUT), |_, _, state| {
                        state.expire_launches();
                        TimeoutAction::Drop
                    });
                }
                Reply::Ok(Response::LaunchObserved { launch, already })
            }
        }
    }

    fn expire_launches(&mut self) {
        for launch in self.ipc.observe.launches.expire(Instant::now()) {
            broadcast(self, &Event::LaunchOutcome { launch, outcome: Outcome::Expired });
        }
    }

    /// An activation token was used (activation.rs, `window_shown_with_token`).
    pub fn launch_used(&mut self, token: &str, outcome: Outcome) {
        if let Some(launch) = self.ipc.observe.launches.used(token, outcome, Instant::now()) {
            broadcast(self, &Event::LaunchOutcome { launch, outcome });
        }
    }

    /// Window `id` was just shown: the launch whose token it came with is answered.
    pub fn window_shown_with_token(&mut self, id: WindowId, window: &smithay::desktop::Window) {
        let shown_with = self.wm.get_mut(id).and_then(|m| m.shown_with.take());
        if let Some((token, honoured)) = shown_with.or_else(|| self.take_x11_startup(window)) {
            self.launch_used(&token, Outcome::Window { window: id, honoured });
        }
        if let Some(x) = window.x11_surface()
            && x.hints().is_some_and(|h| h.urgent)
            && self.wm.focused != Some(id)
        {
            self.set_attention(id, None, Some(true));
        }
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

    #[test]
    fn a_launch_is_answered_whether_it_is_asked_about_before_or_after_its_use() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        // Asked first, used after.
        let (a, now) = l.watch("tok-a", true, t0).unwrap();
        assert_eq!(now, None);
        assert_eq!(l.used("tok-a", Outcome::Window { window: 7, honoured: true }, t0), Some(a));
        // Used first, asked after: the answer comes with the number.
        assert_eq!(l.used("tok-b", Outcome::Activated { window: 8 }, t0), None);
        let (b, now) = l.watch("tok-b", false, t0).unwrap();
        assert_ne!(a, b);
        assert_eq!(now, Some(Outcome::Activated { window: 8 }));
        // Once answered, the token is forgotten: asking again is refused, not answered twice.
        assert!(l.watch("tok-b", false, t0).is_err());
        assert!(l.watch("tok-a", false, t0).is_err());
    }

    #[test]
    fn foreign_stale_and_too_many_tokens_are_refused_and_unused_ones_expire() {
        let mut l = Launches::default();
        let t0 = Instant::now();
        assert!(l.watch("made-up", false, t0).is_err(), "a token Hyalo does not have");
        let (a, _) = l.watch("tok", true, t0).unwrap();
        assert!(l.watch("tok", true, t0).is_err(), "watched twice");
        assert!(l.expire(t0 + LAUNCH_TIMEOUT / 2).is_empty());
        assert_eq!(l.expire(t0 + LAUNCH_TIMEOUT), vec![a]);
        assert!(l.is_empty());
        // A use nobody asked about in time is not kept either.
        l.used("late", Outcome::Activated { window: 1 }, t0);
        assert!(l.watch("late", false, t0 + LAUNCH_TIMEOUT).is_err());
        for n in 0..MAX_LAUNCHES {
            l.watch(&format!("t{n}"), true, t0).unwrap();
        }
        assert!(l.watch("one-more", true, t0).is_err());
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
