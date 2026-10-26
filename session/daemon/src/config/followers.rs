// SPDX-License-Identifier: GPL-3.0-or-later
//! Effects of the settings' homes, active only while we own Config1. GLib publishes a
//! complete latest snapshot; independent workers never block a Config1 call or each other.
//! A failed effect is retried with the latest value, never recorded as applied.
use super::{
    registry::{self, Store, Value},
    store::{Changes, Handle},
};
use gio::prelude::*;
use serde_json::{Value as Json, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::watch,
};

const INTERFACE: &str = "org.gnome.desktop.interface";
const NIGHT: &str = "org.nidara.night-light";
const RETRY: Duration = Duration::from_secs(2);
const DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Snapshot {
    gtk: Option<Gtk>,
    night: Option<Night>,
    wallpaper: Option<(String, String)>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Gtk {
    theme: String,
    dark: bool,
    icons: String,
    font: String,
    cursor: String,
    size: i32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Night {
    enabled: bool,
    temperature: i32,
    schedule: bool,
    from: String,
    to: String,
}
impl Snapshot {
    pub fn read(st: &Store) -> Self {
        let gtk = st
            .settings(INTERFACE)
            .filter(|_| {
                [
                    "gtk-theme",
                    "color-scheme",
                    "icon-theme",
                    "font-name",
                    "cursor-theme",
                    "cursor-size",
                ]
                .iter()
                .all(|k| st.has(INTERFACE, k))
            })
            .map(|s| Gtk {
                theme: s.string("gtk-theme").into(),
                dark: s.string("color-scheme") == "prefer-dark",
                icons: s.string("icon-theme").into(),
                font: s.string("font-name").into(),
                cursor: s.string("cursor-theme").into(),
                size: s.int("cursor-size").max(1),
            });
        let night = st
            .settings(NIGHT)
            .filter(|_| {
                [
                    "enabled",
                    "temperature",
                    "schedule-enabled",
                    "schedule-from",
                    "schedule-to",
                ]
                .iter()
                .all(|k| st.has(NIGHT, k))
            })
            .map(|s| Night {
                enabled: s.boolean("enabled"),
                temperature: s.int("temperature"),
                schedule: s.boolean("schedule-enabled"),
                from: s.string("schedule-from").into(),
                to: s.string("schedule-to").into(),
            });
        let text = |name| match registry::get(st, registry::find(name).unwrap()) {
            Value::Text(s) => s,
            _ => unreachable!(),
        };
        let path = text("wallpaper.current");
        let wallpaper = (!path.is_empty()).then(|| (path, text("wallpaper.transition")));
        Self {
            gtk,
            night,
            wallpaper,
        }
    }
}

/// Stable files keep unrelated settings and comments. A no-op does not touch the inode.
fn write_ini(path: &Path, entries: &[(&str, String)]) -> Result<(), String> {
    let kf = glib::KeyFile::new();
    if path.exists() {
        kf.load_from_file(path, glib::KeyFileFlags::KEEP_COMMENTS)
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let mut changed = false;
    for (key, value) in entries {
        if kf.string("Settings", key).ok().as_deref() != Some(value.as_str()) {
            kf.set_string("Settings", key, value);
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    let parent = path.parent().ok_or("settings.ini has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // GLib's replace operation writes aside and renames; readers never see half an INI.
    gio::File::for_path(path)
        .replace_contents(
            kf.to_data().as_bytes(),
            None,
            false,
            gio::FileCreateFlags::REPLACE_DESTINATION,
            gio::Cancellable::NONE,
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn gtk_ini(g: Gtk) -> Result<(), String> {
    let entries = [
        ("gtk-theme-name", g.theme),
        (
            "gtk-application-prefer-dark-theme",
            if g.dark { "1" } else { "0" }.into(),
        ),
        ("gtk-icon-theme-name", g.icons),
        ("gtk-font-name", g.font),
        ("gtk-cursor-theme-name", g.cursor),
        ("gtk-cursor-theme-size", g.size.to_string()),
    ];
    for toolkit in ["gtk-3.0", "gtk-4.0"] {
        write_ini(
            &glib::user_config_dir().join(toolkit).join("settings.ini"),
            &entries,
        )?;
    }
    Ok(())
}

fn socket() -> Option<PathBuf> {
    std::env::var_os("HYALO_SOCKET")
        .map(PathBuf::from)
        .or_else(|| {
            let display = std::env::var("WAYLAND_DISPLAY").ok()?;
            let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
            let display = Path::new(&display).file_name()?.to_str()?;
            Some(PathBuf::from(runtime).join(format!("nidara-hyalo.{display}.sock")))
        })
}
async fn request(path: &Path, value: Json) -> Result<(), String> {
    tokio::time::timeout(DEADLINE, async {
        let mut stream = UnixStream::connect(path).await.map_err(|e| e.to_string())?;
        stream
            .write_all(format!("{value}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        // A bounded response: never accumulate an unbounded line from a broken peer.
        use tokio::io::AsyncReadExt;
        BufReader::new(stream.take(64 * 1024))
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        let reply: Json = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if let Some(e) = reply.get("error") {
            return Err(e.to_string());
        }
        if reply.get("ok").is_none() {
            return Err("Hyalo reply has no ok".into());
        }
        Ok(())
    })
    .await
    .map_err(|_| "Hyalo request timed out".to_owned())?
}
async fn wallpaper((path, transition): (String, String)) -> Result<(), String> {
    // No shell: a path, including whitespace or metacharacters, stays a single argument.
    let mut command = tokio::process::Command::new("awww");
    command
        .args(["img", &path, "--transition-type", &transition])
        .kill_on_drop(true);
    let output = tokio::time::timeout(DEADLINE, command.output())
        .await
        .map_err(|_| "awww timed out".to_owned())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "awww {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// A lane owns only its last successful value. Rapid updates replace pending work, and
/// failed values stay pending. Idle workers sleep on changes (no polling of settings).
async fn lane<T, F, Fut>(
    name: &str,
    mut rx: watch::Receiver<Snapshot>,
    mut reset: watch::Receiver<u64>,
    project: fn(&Snapshot) -> Option<T>,
    apply: F,
) where
    T: Clone + PartialEq + Send,
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut applied = None;
    let mut last_error = None;
    loop {
        let desired = project(&rx.borrow_and_update());
        let mut failed = false;
        if desired != applied {
            if let Some(value) = desired.as_ref() {
                match apply(value.clone()).await {
                    Ok(()) => {
                        applied = desired;
                        last_error = None;
                    }
                    Err(e) => {
                        if last_error.as_ref() != Some(&e) {
                            eprintln!("[followers] {name}: {e}");
                        }
                        last_error = Some(e);
                        failed = true;
                    }
                }
            } else {
                applied = None;
            }
        }
        tokio::select! {
            r = rx.changed() => if r.is_err() { return; },
            r = reset.changed() => { if r.is_err() { return; } applied = None; },
            _ = tokio::time::sleep(RETRY), if failed => {},
        }
    }
}

fn minutes(time: &str) -> Option<i32> {
    if registry::valid_time(time).is_err() {
        return None;
    }
    let (h, m) = time.split_once(':')?;
    Some(h.parse::<i32>().ok()? * 60 + m.parse::<i32>().ok()?)
}
fn in_schedule(from: &str, to: &str, now: i32) -> Option<bool> {
    let (from, to) = (minutes(from)?, minutes(to)?);
    Some(if from > to {
        now >= from || now < to
    } else {
        now >= from && now < to
    })
}
async fn schedule(store: Handle, mut rx: watch::Receiver<Snapshot>) {
    let mut previous = None;
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        let n = rx.borrow_and_update().night.clone();
        let config = n
            .as_ref()
            .map(|n| (n.schedule, n.from.clone(), n.to.clone()));
        // Enabled/temperature changes are manual until the next clock check. Only schedule
        // configuration changes trigger an immediate check, like the desktop's existing rule.
        if config != previous {
            check_schedule(&store).await;
            previous = config;
        }
        tokio::select! {
            r = rx.changed() => if r.is_err() { return; },
            _ = tick.tick() => check_schedule(&store).await,
        }
    }
}
async fn check_schedule(store: &Handle) {
    // Read and decide on the GLib thread: a schedule disabled meanwhile cannot be applied
    // from an older snapshot. The resulting enabled change follows the ordinary home path.
    store
        .call(|st| {
            let Some(n) = Snapshot::read(st).night.filter(|n| n.schedule) else {
                return;
            };
            let Ok(now) = glib::DateTime::now_local() else {
                return;
            };
            let Some(enabled) = in_schedule(&n.from, &n.to, now.hour() * 60 + now.minute()) else {
                eprintln!(
                    "[followers] night-light: invalid schedule {}–{}",
                    n.from, n.to
                );
                return;
            };
            if n.enabled != enabled
                && let Err(e) = st.settings(NIGHT).unwrap().set_boolean("enabled", enabled)
            {
                eprintln!("[followers] night-light schedule: {e}");
            }
        })
        .await;
}

/// Reconnect after a compositor restart and restate runtime effects. Output hotplug also
/// reapplies the wallpaper for the new output. We do not react to our own config reloads.
async fn events(path: PathBuf, reset: watch::Sender<u64>) {
    loop {
        if let Ok(mut stream) = UnixStream::connect(&path).await
            && stream
                .write_all(b"{\"request\":\"event_stream\"}\n")
                .await
                .is_ok()
        {
            reset.send_modify(|n| *n += 1);
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if serde_json::from_str::<Json>(&line)
                    .ok()
                    .is_some_and(|v| v["event"] == "outputs_changed")
                {
                    reset.send_modify(|n| *n += 1);
                }
            }
        }
        tokio::time::sleep(RETRY).await;
    }
}

pub(super) fn start(store: Handle, changes: Arc<Changes>) {
    let rx = changes.followers.subscribe();
    // This sender is retained by the GTK worker even without Hyalo, so reset.changed()
    // remains pending instead of spinning on a closed channel.
    let (reset, reset_rx) = watch::channel(0);
    let keep = reset.clone();
    tokio::spawn(lane(
        "gtk-settings",
        rx.clone(),
        reset_rx.clone(),
        |s| s.gtk.clone(),
        move |g| {
            let _keep = keep.clone();
            async move {
                tokio::task::spawn_blocking(move || gtk_ini(g))
                    .await
                    .map_err(|e| e.to_string())?
            }
        },
    ));
    tokio::spawn(schedule(store, rx.clone()));
    if let Some(path) = socket() {
        let p = path.clone();
        tokio::spawn(lane(
            "cursor",
            rx.clone(),
            reset_rx.clone(),
            |s| s.gtk.as_ref().map(|g| (g.cursor.clone(), g.size)),
            move |(theme, size)| {
                let p = p.clone();
                async move {
                    request(&p, json!({"request":"settings", "patch":{"cursor":{"theme":theme,"size":size}}})).await
                }
            },
        ));
        let p = path.clone();
        tokio::spawn(lane(
            "night-light",
            rx.clone(),
            reset_rx.clone(),
            |s| {
                s.night.as_ref().map(|n| {
                    if n.enabled {
                        Some(n.temperature.clamp(2700, 6500))
                    } else {
                        None
                    }
                })
            },
            move |temperature| {
                let p = p.clone();
                async move {
                    request(
                        &p,
                        json!({"request":"night_light", "temperature":temperature}),
                    )
                    .await
                }
            },
        ));
        tokio::spawn(events(path, reset));
    }
    // Never run a live-session wallpaper client from a bus-only daemon/test.
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        tokio::spawn(lane(
            "wallpaper",
            rx,
            reset_rx,
            |s| s.wallpaper.clone(),
            wallpaper,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schedule_boundaries_overnight_and_equal() {
        for (from, to, now, expected) in [
            ("20:00", "07:00", 1200, true),
            ("20:00", "07:00", 419, true),
            ("20:00", "07:00", 420, false),
            ("20:00", "07:00", 1199, false),
            ("08:00", "17:00", 480, true),
            ("08:00", "17:00", 1020, false),
            ("08:00", "08:00", 480, false),
        ] {
            assert_eq!(in_schedule(from, to, now), Some(expected));
        }
        assert_eq!(in_schedule("8pm", "07:00", 0), None);
    }
}
