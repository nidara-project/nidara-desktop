// SPDX-License-Identifier: LGPL-3.0-or-later
//! User-triggered capture, with literal argv and one owned recorder across outputs.
use gio::prelude::*;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock, mpsc},
    time::{Duration, Instant},
};
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShotState {
    pub busy: bool,
    pub path: String,
    pub error: String,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub screenshot: ShotState,
    pub notice: Option<&'static str>,
    pub running: bool,
    pub starting: bool,
    pub path: String,
    pub error: String,
    pub revision: u64,
}
#[derive(Clone, Debug)]
pub enum Job {
    Screenshot {
        mode: &'static str,
        copy: bool,
        output: String,
    },
    Record {
        mode: &'static str,
        audio: bool,
        output: String,
    },
    Stop,
}
struct Service {
    jobs: mpsc::SyncSender<Job>,
    state: std::sync::Arc<Mutex<State>>,
}
static SERVICE: OnceLock<Service> = OnceLock::new();
fn service() -> &'static Service {
    SERVICE.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel(1);
        let state = std::sync::Arc::new(Mutex::new(State::default()));
        let shown = state.clone();
        let _ = std::thread::Builder::new()
            .name("cc-capture".into())
            .spawn(move || worker(rx, shown));
        Service { jobs: tx, state }
    })
}
pub fn state() -> State {
    service()
        .state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}
pub fn send(job: Job) -> Result<(), String> {
    let service = service();
    match job {
        Job::Screenshot { mode, copy, output } => {
            {
                let mut state = service.state.lock().unwrap_or_else(|p| p.into_inner());
                if state.screenshot.busy || state.starting {
                    return Err("capture is busy".into());
                }
                state.screenshot.busy = true;
                state.screenshot.error.clear();
                state.revision += 1;
            }
            let state = service.state.clone();
            let result = std::thread::Builder::new()
                .name("cc-screenshot".into())
                .spawn(move || {
                    std::thread::sleep(Duration::from_millis(600));
                    let result = screenshot(mode, copy, &output);
                    update(&state, |s| {
                        s.screenshot.busy = false;
                        match result {
                            Ok(path) => s.screenshot.path = path,
                            Err(error) => s.screenshot.error = error,
                        }
                    });
                });
            if let Err(error) = result {
                update(&service.state, |s| s.screenshot.busy = false);
                return Err(error.to_string());
            }
            Ok(())
        }
        Job::Record { .. } => {
            {
                let mut state = service.state.lock().unwrap_or_else(|p| p.into_inner());
                if state.running || state.starting || state.screenshot.busy {
                    return Err("capture is busy".into());
                }
                state.starting = true;
                state.error.clear();
                state.notice = None;
                state.revision += 1;
            }
            if service.jobs.try_send(job).is_err() {
                update(&service.state, |s| s.starting = false);
                return Err("capture is busy".into());
            }
            Ok(())
        }
        Job::Stop => service
            .jobs
            .try_send(Job::Stop)
            .map_err(|_| "capture is busy".into()),
    }
}

fn update(state: &Mutex<State>, f: impl FnOnce(&mut State)) {
    let mut s = state.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut s);
    s.revision += 1;
}
struct Recorder {
    child: Child,
    file: PathBuf,
    stops: u8,
    notice: Option<&'static str>,
    error: std::thread::JoinHandle<String>,
}
fn worker(rx: mpsc::Receiver<Job>, state: std::sync::Arc<Mutex<State>>) {
    let mut recorder: Option<Recorder> = None;
    loop {
        let job = if recorder.is_some() {
            rx.recv_timeout(Duration::from_millis(100))
        } else {
            rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
        };
        match job {
            Ok(Job::Stop) => {
                if let Some(r) = &mut recorder {
                    r.stops += 1;
                    let result = if r.stops > 1 {
                        r.child.kill().map_err(|e| e.to_string())
                    } else {
                        checked(
                            command("kill").args(["-INT", &r.child.id().to_string()]),
                            Duration::from_secs(2),
                        )
                        .map(|_| ())
                    };
                    if let Err(error) = result {
                        update(&state, |s| s.error = error);
                    }
                }
            }
            Ok(job) => {
                if recorder.is_some() {
                    update(&state, |s| s.error = "recording already active".into());
                    continue;
                }
                update(&state, |s| {
                    s.starting = true;
                    s.error.clear();
                });
                // The bar commits its closed surface before the tools acquire frames.
                std::thread::sleep(Duration::from_millis(600));
                let result = match job {
                    Job::Screenshot { .. } => {
                        Err("screenshot must run on its own control lane".into())
                    }
                    Job::Record {
                        mode,
                        audio,
                        output,
                    } => start_recording(mode, audio, &output).map(|r| {
                        update(&state, |s| {
                            s.running = true;
                            s.notice = r.notice;
                            s.path = r.file.to_string_lossy().into();
                        });
                        recorder = Some(r);
                    }),
                    Job::Stop => Ok(()),
                };
                update(&state, |s| {
                    s.starting = false;
                    if let Err(error) = result {
                        s.error = error;
                    }
                });
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(mut r) = recorder {
                    let _ = r.child.kill();
                    let _ = r.child.wait();
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let done = recorder
            .as_mut()
            .and_then(|r| r.child.try_wait().transpose());
        if let Some(done) = done {
            let r = recorder.take().unwrap();
            let detail = r.error.join().unwrap_or_default();
            let okay = done.is_ok_and(|status| status.success() || r.stops > 0)
                && r.file.metadata().is_ok_and(|m| m.len() > 0);
            update(&state, |s| {
                s.running = false;
                if !okay {
                    s.error = if detail.is_empty() {
                        "recording failed".into()
                    } else {
                        detail
                    };
                }
            });
        }
    }
}
fn command(name: &str) -> Command {
    let mut c = Command::new(name);
    c.env_remove("GTK_THEME");
    c
}
/// Drain while waiting: helpers can never deadlock on a full pipe or wait forever.
fn checked(cmd: &mut Command, deadline: Duration) -> Result<String, String> {
    let clipboard = cmd.get_program() == "wl-copy";
    let mut child = cmd
        .stdout(if clipboard {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let reader = stdout.map(|stdout| {
        std::thread::spawn(move || {
            let mut bytes = vec![];
            let mut stdout = stdout;
            let mut buf = [0; 8192];
            while let Ok(n) = stdout.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if bytes.len() < 1 << 20 {
                    bytes.extend_from_slice(&buf[..n.min((1 << 20) - bytes.len())]);
                }
            }
            bytes
        })
    });
    let until = Instant::now() + deadline;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
            _ => {}
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            break Err("capture helper timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader
        .map(|r| r.join().unwrap_or_default())
        .unwrap_or_default();
    if status?.success() {
        Ok(String::from_utf8_lossy(&bytes).trim().into())
    } else {
        Err("capture helper failed or selection cancelled".into())
    }
}
fn select_region() -> Result<String, String> {
    let s = checked(command("slurp").arg("-d"), Duration::from_secs(120))?;
    validate_geometry(&s)?;
    Ok(s)
}
fn validate_geometry(s: &str) -> Result<(), String> {
    let Some((xy, wh)) = s.split_once(' ') else {
        return Err("invalid capture geometry".into());
    };
    let Some((x, y)) = xy.split_once(',') else {
        return Err("invalid capture geometry".into());
    };
    let Some((w, h)) = wh.split_once('x') else {
        return Err("invalid capture geometry".into());
    };
    if x.parse::<i32>().is_err()
        || y.parse::<i32>().is_err()
        || ![w, h]
            .iter()
            .all(|v| v.parse::<u32>().is_ok_and(|n| n > 0 && n <= 32768))
    {
        return Err("invalid capture geometry".into());
    }
    Ok(())
}
fn file(dir: &Path, prefix: &str, extension: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = glib::DateTime::now_local()
        .and_then(|d| d.format("%Y-%m-%d_%H-%M-%S_%f"))
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "{prefix}_{stamp}_{}.{}",
        std::process::id(),
        extension
    ));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    Ok(path)
}
fn user_dir(kind: glib::UserDirectory, fallback: &str) -> PathBuf {
    glib::user_special_dir(kind).unwrap_or_else(|| glib::home_dir().join(fallback))
}
fn screenshot(mode: &str, copy: bool, output: &str) -> Result<String, String> {
    let dir = if copy {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .ok_or("runtime directory unavailable")?
    } else {
        user_dir(glib::UserDirectory::Pictures, "Pictures")
    };
    let path = file(&dir, "Screenshot", "png")?;
    let work = || -> Result<(), String> {
        let mut cmd = command("grim");
        match mode {
            "area" => {
                cmd.args(["-g", &select_region()?]);
            }
            "window" => {
                let windows = crate::hyalo::request(serde_json::json!({"request":"windows"}))?;
                let w = windows["windows"]
                    .as_array()
                    .and_then(|ws| ws.iter().find(|w| w["focused"] == true))
                    .ok_or("no focused window")?;
                let number = |k: &str| w[k].as_i64().ok_or("missing window geometry");
                let geometry = format!(
                    "{},{} {}x{}",
                    number("x")?,
                    number("y")?,
                    number("width")?,
                    number("height")?
                );
                validate_geometry(&geometry)?;
                cmd.args(["-g", &geometry]);
            }
            "screen" => {
                cmd.args(["-o", output]);
            }
            _ => return Err("unknown screenshot mode".into()),
        }
        cmd.arg(&path);
        checked(&mut cmd, Duration::from_secs(15))?;
        if copy {
            checked(
                command("wl-copy")
                    .args(["--type", "image/png"])
                    .stdin(std::fs::File::open(&path).map_err(|e| e.to_string())?),
                Duration::from_secs(5),
            )?;
        }
        Ok(())
    };
    let result = work();
    if copy || result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result?;
    Ok(if copy {
        String::new()
    } else {
        path.to_string_lossy().into()
    })
}
fn settings() -> Option<gio::Settings> {
    gio::SettingsSchemaSource::default()?
        .lookup("org.nidara.recording", true)
        .map(|_| gio::Settings::new("org.nidara.recording"))
}
fn audio_device(wanted: &str) -> Result<String, String> {
    let name = match wanted {
        "@system" => format!(
            "{}.monitor",
            checked(
                command("pactl").arg("get-default-sink"),
                Duration::from_secs(5)
            )?
        ),
        "@mic" => checked(
            command("pactl").arg("get-default-source"),
            Duration::from_secs(5),
        )?,
        other => other.into(),
    };
    let sources = checked(
        command("pactl").args(["-f", "json", "list", "sources"]),
        Duration::from_secs(5),
    )?;
    let sources: serde_json::Value = serde_json::from_str(&sources).map_err(|e| e.to_string())?;
    if sources
        .as_array()
        .is_some_and(|a| a.iter().any(|s| s["name"] == name))
    {
        Ok(name)
    } else if !["@system", "@mic"].contains(&wanted) {
        audio_device("@system")
    } else {
        Err("selected recording audio source unavailable".into())
    }
}
fn start_recording(mode: &str, audio: bool, output: &str) -> Result<Recorder, String> {
    let s = settings();
    let string = |key: &str, default: &str| {
        s.as_ref()
            .map(|s| s.string(key).to_string())
            .unwrap_or_else(|| default.into())
    };
    let format = string("format", "mp4");
    if !["mp4", "mkv", "webm"].contains(&format.as_str()) {
        return Err("invalid recording format".into());
    }
    let quality = string("quality", "balanced");
    let save = string("save-dir", "");
    let dir = if save.is_empty() {
        user_dir(glib::UserDirectory::Videos, "Videos")
    } else {
        PathBuf::from(save)
    };
    let path = file(&dir, "Recording", &format)?;
    let result = || -> Result<Recorder, String> {
        let mut cmd = command("setpriv");
        cmd.args(["--pdeathsig", "INT", "wf-recorder", "--overwrite"]);
        // Only the freshly create_new-reserved file is passed; no existing user file.
        cmd.stdin(Stdio::null());
        match mode {
            "region" => {
                cmd.args(["-g", &select_region()?]);
            }
            "screen" => {
                cmd.args(["-o", output]);
            }
            _ => return Err("invalid recording mode".into()),
        }
        let audio_device = if audio {
            audio_device(&string("audio-source", "@system")).ok()
        } else {
            None
        };
        if let Some(device) = &audio_device {
            cmd.arg(format!("--audio={device}"));
        }
        let notice = if audio && audio_device.is_none() {
            Some("widget.screenrecord.no-audio")
        } else {
            None
        };
        let fps = s.as_ref().map_or(0, |s| s.int("framerate"));
        if fps > 0 {
            cmd.args(["-r", &fps.min(240).to_string()]);
        }
        let hardware = s
            .as_ref()
            .and_then(|s| s.user_value("hardware").and_then(|v| v.get::<bool>()))
            .unwrap_or_else(|| Path::new("/dev/dri/renderD128").exists())
            && format != "webm"
            && Path::new("/dev/dri/renderD128").exists();
        cmd.args(record_args(&format, &quality, hardware));
        cmd.arg("-f")
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut stderr = child.stderr.take().unwrap();
        let error = std::thread::spawn(move || {
            let mut text = vec![];
            let mut buf = [0; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if text.len() < 8192 {
                    text.extend_from_slice(&buf[..n.min(8192 - text.len())]);
                }
            }
            String::from_utf8_lossy(&text).into()
        });
        Ok(Recorder {
            child,
            file: path.clone(),
            stops: 0,
            notice,
            error,
        })
    };
    let result = result();
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result
}
fn record_args(format: &str, quality: &str, hardware: bool) -> Vec<String> {
    let index = match quality {
        "low" => 0,
        "high" => 2,
        _ => 1,
    };
    let args: Vec<String> = if format == "webm" {
        vec![
            "-c".into(),
            "libvpx-vp9".into(),
            "-p".into(),
            format!("crf={}", [40, 32, 24][index]),
            "-p".into(),
            "b=0".into(),
        ]
    } else if hardware {
        vec![
            "-c".into(),
            "h264_vaapi".into(),
            "-d".into(),
            "/dev/dri/renderD128".into(),
            "-p".into(),
            format!("qp={}", [34, 26, 20][index]),
        ]
    } else {
        vec![
            "-c".into(),
            "libx264".into(),
            "-p".into(),
            format!("crf={}", [30, 23, 18][index]),
            "-p".into(),
            "preset=veryfast".into(),
        ]
    };
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recording_preferences_keep_the_ts_codec_and_quality_contract() {
        assert!(
            record_args("webm", "high", true)
                .windows(2)
                .any(|p| p == ["-c", "libvpx-vp9"])
        );
        assert!(record_args("webm", "high", true).iter().any(|p| p == "b=0"));
        assert!(
            record_args("mp4", "balanced", false)
                .iter()
                .any(|p| p == "crf=23")
        );
        assert!(record_args("mkv", "low", true).iter().any(|p| p == "qp=34"));
        assert!(
            !record_args("webm", "balanced", true)
                .iter()
                .any(|p| p == "/dev/dri/renderD128")
        );
    }
    #[test]
    fn only_complete_bounded_capture_geometry_is_used() {
        for s in ["0,0 1920x1080", "-1920,-10 1280x720"] {
            assert!(validate_geometry(s).is_ok());
        }
        for s in [
            "",
            "0,0 0x100",
            "0,0 99999x99",
            "0,0 100x100 extra",
            "$(bad),0 100x100",
            "0,0 -1x100",
        ] {
            assert!(validate_geometry(s).is_err(), "{s}");
        }
    }
    #[test]
    fn a_helper_that_never_finishes_is_killed_and_reaped() {
        let start = Instant::now();
        let result = checked(command("sleep").arg("10"), Duration::from_millis(50));
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
