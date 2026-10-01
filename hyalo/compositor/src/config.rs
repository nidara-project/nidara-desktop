//! Hyalo's configuration: ONE file of ours, TOML.
//!
//! Three layers, read in order and merged table by table:
//!
//! 1. the defaults the package ships, `/usr/share/nidara/hyalo/hyalo.toml`;
//! 2. what Settings chose, `~/.config/nidara/hyalo-settings.toml` — written by the shell
//!    (core/MonitorConfig.ts), never by hand: the counterpart of `nidara-monitor.lua`;
//! 3. the user's own `~/.config/nidara/hyalo.toml`, last, so a hand edit wins — the same
//!    order as Hyprland's `nidara-*.lua` then `hyprland-user.lua`.
//!
//! A key a layer does not set keeps the value below it, so a new default reaches everybody
//! who has not overridden it.
//!
//! The file is watched (a cheap mtime poll) and a change re-applies only what changed. Live
//! changes go through IPC (`nidara-hyalo msg`), never by rewriting a file: the 09-12 freeze
//! came from Hyprland's config being rewritten twice in a second and reloaded on each write.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};

pub const SYSTEM_CONFIG: &str = "/usr/share/nidara/hyalo/hyalo.toml";

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub input: Input,
    /// Keyed by connector name (`DP-1`, `HDMI-A-1`, `eDP-1`).
    pub outputs: BTreeMap<String, OutputConfig>,
    /// Commands run once the compositor is up, in order, through `sh -c`.
    pub autostart: Vec<String>,
    pub cursor: CursorConfig,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Input {
    pub keyboard: Keyboard,
    pub pointer: Pointer,
    pub touchpad: Touchpad,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Keyboard {
    pub rules: String,
    pub model: String,
    pub layout: String,
    pub variant: String,
    pub options: String,
    /// Milliseconds before a held key repeats, and repeats per second.
    pub repeat_delay: i32,
    pub repeat_rate: i32,
}

impl Default for Keyboard {
    fn default() -> Self {
        Self {
            rules: String::new(),
            model: String::new(),
            layout: String::new(),
            variant: String::new(),
            options: String::new(),
            repeat_delay: 600,
            repeat_rate: 25,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Pointer {
    /// libinput's acceleration speed, -1..1.
    pub accel_speed: f64,
    pub natural_scroll: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Touchpad {
    pub accel_speed: f64,
    pub natural_scroll: bool,
    pub tap: bool,
    pub disable_while_typing: bool,
}

impl Default for Touchpad {
    fn default() -> Self {
        Self { accel_speed: 0.0, natural_scroll: true, tap: true, disable_while_typing: true }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CursorConfig {
    pub theme: String,
    pub size: u32,
}

impl Default for CursorConfig {
    fn default() -> Self {
        Self { theme: "default".into(), size: 24 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OutputConfig {
    pub enabled: bool,
    /// `WIDTHxHEIGHT` or `WIDTHxHEIGHT@HZ` (Hz may have decimals); empty = the preferred mode.
    pub mode: String,
    /// `1` and `1.0` alike: TOML tells them apart, a person does not.
    #[serde(deserialize_with = "number")]
    pub scale: f64,
    /// Logical pixels; `None` = to the right of the outputs already placed.
    pub position: Option<(i32, i32)>,
    /// normal, 90, 180, 270, flipped, flipped-90, flipped-180, flipped-270.
    pub transform: String,
    pub vrr: bool,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: String::new(),
            scale: 1.0,
            position: None,
            transform: "normal".into(),
            vrr: false,
        }
    }
}

fn number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N {
        I(i64),
        F(f64),
    }
    Ok(match N::deserialize(d)? {
        N::I(i) => i as f64,
        N::F(f) => f,
    })
}

impl OutputConfig {
    /// The mode asked for: (width, height, refresh in mHz if given).
    pub fn parsed_mode(&self) -> Option<(i32, i32, Option<i32>)> {
        let m = self.mode.trim();
        if m.is_empty() {
            return None;
        }
        let (size, hz) = match m.split_once('@') {
            Some((s, hz)) => (s, Some(hz)),
            None => (m, None),
        };
        let (w, h) = size.split_once('x')?;
        let refresh = match hz {
            Some(hz) => Some((hz.trim_end_matches("Hz").parse::<f64>().ok()? * 1000.0).round() as i32),
            None => None,
        };
        Some((w.parse().ok()?, h.parse().ok()?, refresh))
    }

    pub fn parsed_transform(&self) -> Option<smithay::utils::Transform> {
        use smithay::utils::Transform;
        Some(match self.transform.as_str() {
            "normal" | "" => Transform::Normal,
            "90" => Transform::_90,
            "180" => Transform::_180,
            "270" => Transform::_270,
            "flipped" => Transform::Flipped,
            "flipped-90" => Transform::Flipped90,
            "flipped-180" => Transform::Flipped180,
            "flipped-270" => Transform::Flipped270,
            _ => return None,
        })
    }
}

pub fn transform_name(t: smithay::utils::Transform) -> &'static str {
    use smithay::utils::Transform;
    match t {
        Transform::Normal => "normal",
        Transform::_90 => "90",
        Transform::_180 => "180",
        Transform::_270 => "270",
        Transform::Flipped => "flipped",
        Transform::Flipped90 => "flipped-90",
        Transform::Flipped180 => "flipped-180",
        Transform::Flipped270 => "flipped-270",
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{path}: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("{path}: {source}")]
    Parse { path: PathBuf, source: Box<toml::de::Error> },
    #[error("{0}")]
    Invalid(String),
}

impl Keyboard {
    /// This keyboard with the system's layout filled in where none is configured: what
    /// `localectl set-x11-keymap` wrote (the installer sets it), as GNOME and KDE read it.
    pub fn with_system_defaults(&self) -> Keyboard {
        let mut k = self.clone();
        if !k.layout.is_empty() {
            return k;
        }
        let Ok(text) = std::fs::read_to_string("/etc/X11/xorg.conf.d/00-keyboard.conf") else { return k };
        for line in text.lines() {
            let mut parts = line.split('"').skip(1).step_by(2);
            let (Some(key), Some(value)) = (parts.next(), parts.next()) else { continue };
            match key {
                "XkbLayout" => k.layout = value.into(),
                "XkbVariant" if k.variant.is_empty() => k.variant = value.into(),
                "XkbModel" if k.model.is_empty() => k.model = value.into(),
                "XkbOptions" if k.options.is_empty() => k.options = value.into(),
                _ => {}
            }
        }
        k
    }
}

/// The user's file: `$XDG_CONFIG_HOME/nidara/hyalo.toml`.
pub fn user_config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("nidara").join("hyalo.toml")
}

/// The file Settings writes: `$XDG_CONFIG_HOME/nidara/hyalo-settings.toml`.
pub fn settings_config_path() -> PathBuf {
    user_config_path().with_file_name("hyalo-settings.toml")
}

/// The layers in the order they apply. `HYALO_CONFIG` replaces them all (tests, CI).
pub fn layer_paths() -> Vec<PathBuf> {
    if let Some(p) = std::env::var_os("HYALO_CONFIG") {
        return vec![PathBuf::from(p)];
    }
    vec![PathBuf::from(SYSTEM_CONFIG), settings_config_path(), user_config_path()]
}

fn read_layer(path: &Path) -> Result<Option<toml::Table>, ConfigError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(ConfigError::Read { path: path.into(), source }),
    };
    toml::from_str::<toml::Table>(&text)
        .map(Some)
        .map_err(|source| ConfigError::Parse { path: path.into(), source: Box::new(source) })
}

/// `over` on top of `base`, table by table; anything else (values, arrays) is replaced.
fn merge(base: &mut toml::Table, over: toml::Table) {
    for (k, v) in over {
        match (base.get_mut(&k), v) {
            (Some(toml::Value::Table(b)), toml::Value::Table(o)) => merge(b, o),
            (_, v) => {
                base.insert(k, v);
            }
        }
    }
}

pub fn load_from(paths: &[PathBuf]) -> Result<Config, ConfigError> {
    let mut merged = toml::Table::new();
    for p in paths {
        if let Some(layer) = read_layer(p)? {
            merge(&mut merged, layer);
        }
    }
    let config: Config = toml::Value::Table(merged)
        .try_into()
        .map_err(|e: toml::de::Error| ConfigError::Invalid(e.to_string()))?;
    for (name, o) in &config.outputs {
        if !o.mode.is_empty() && o.parsed_mode().is_none() {
            return Err(ConfigError::Invalid(format!("outputs.{name}.mode: cannot read {:?}", o.mode)));
        }
        if o.parsed_transform().is_none() {
            return Err(ConfigError::Invalid(format!("outputs.{name}.transform: unknown {:?}", o.transform)));
        }
        if !(0.25..=4.0).contains(&o.scale) {
            return Err(ConfigError::Invalid(format!("outputs.{name}.scale: {} is outside 0.25..4", o.scale)));
        }
    }
    Ok(config)
}

pub fn load() -> Result<Config, ConfigError> {
    load_from(&layer_paths())
}

/// Each layer's modification time: the watcher compares these.
pub fn stamps() -> Vec<Option<SystemTime>> {
    layer_paths()
        .iter()
        .map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .collect()
}

/// Re-reads the configuration and applies what changed. A file that does not load leaves the
/// running configuration as it is.
pub fn reload(state: &mut crate::Hyalo) -> Result<(), String> {
    let new = match load() {
        Ok(c) => c,
        Err(err) => {
            let message = err.to_string();
            tracing::error!("configuration not reloaded: {message}");
            crate::ipc::server::broadcast(state, &crate::ipc::Event::ConfigError { message: message.clone() });
            return Err(message);
        }
    };
    let old = std::mem::replace(&mut state.config, new.clone());
    if old.input.keyboard != new.input.keyboard {
        let kb = &new.input.keyboard.with_system_defaults();
        let xkb = smithay::input::keyboard::XkbConfig {
            rules: &kb.rules,
            model: &kb.model,
            layout: &kb.layout,
            variant: &kb.variant,
            options: (!kb.options.is_empty()).then(|| kb.options.clone()),
        };
        if let Some(keyboard) = state.seat.get_keyboard() {
            if let Err(err) = keyboard.set_xkb_config(state, xkb) {
                tracing::warn!(?err, "keyboard layout refused");
            }
            keyboard.change_repeat_info(kb.repeat_rate, kb.repeat_delay);
        }
    }
    if old.input.pointer != new.input.pointer || old.input.touchpad != new.input.touchpad {
        state.backend.reconfigure_input_devices(&new.input);
    }
    if old.cursor != new.cursor {
        state.backend.reload_cursors(&new.cursor);
    }
    let names: std::collections::BTreeSet<String> =
        old.outputs.keys().chain(new.outputs.keys()).cloned().collect();
    for name in names {
        if old.outputs.get(&name) != new.outputs.get(&name) {
            let cfg = new.outputs.get(&name).cloned().unwrap_or_default();
            if let Err(err) = crate::outputs::apply(state, &name, &cfg) {
                tracing::warn!(%name, %err, "output setting not applied");
            }
        }
    }
    crate::outputs::arrange(state);
    crate::ipc::server::broadcast(state, &crate::ipc::Event::ConfigReloaded);
    crate::ipc::server::outputs_changed(state);
    tracing::info!("configuration reloaded");
    Ok(())
}

/// Polls the layers' modification times once a second and reloads on a change — cheap, and
/// immune to editors that replace the file rather than write into it.
pub fn watch(state: &mut crate::Hyalo) {
    use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
    let mut last = stamps();
    let interval = std::time::Duration::from_secs(1);
    let _ = state.loop_handle.insert_source(Timer::from_duration(interval), move |_, _, state| {
        let now = stamps();
        if now != last {
            last = now;
            let _ = reload(state);
        }
        TimeoutAction::ToDuration(interval)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, text).unwrap();
        p
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hyalo-config-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn user_layer_overrides_key_by_key() {
        let d = tmpdir("merge");
        let sys = write(&d, "sys.toml", "[input.keyboard]\nlayout = \"us\"\nrepeat_rate = 30\n[outputs.DP-1]\nscale = 1.5\n");
        let user = write(&d, "user.toml", "[input.keyboard]\nlayout = \"es\"\n[outputs.DP-1]\nmode = \"2560x1440@143.912\"\n");
        let c = load_from(&[sys, user]).unwrap();
        assert_eq!(c.input.keyboard.layout, "es");
        assert_eq!(c.input.keyboard.repeat_rate, 30, "a key the user did not set keeps the shipped value");
        let o = &c.outputs["DP-1"];
        assert_eq!(o.scale, 1.5);
        assert_eq!(o.parsed_mode(), Some((2560, 1440, Some(143912))));
    }

    #[test]
    fn three_layers_the_last_wins() {
        let d = tmpdir("three");
        let sys = write(&d, "sys.toml", "[outputs.DP-1]\nscale = 1\nvrr = true\n");
        let settings = write(&d, "settings.toml", "[outputs.DP-1]\nscale = 1.25\nmode = \"2560x1440@144\"\n");
        let user = write(&d, "user.toml", "[outputs.DP-1]\nscale = 1.5\n");
        let o = load_from(&[sys, settings, user]).unwrap().outputs["DP-1"].clone();
        assert_eq!(o.scale, 1.5, "the user's hand edit wins over Settings");
        assert_eq!(o.mode, "2560x1440@144", "Settings' value where the user set nothing");
        assert!(o.vrr, "the shipped value where neither did");
    }

    #[test]
    fn missing_files_are_defaults_and_bad_values_are_refused() {
        let d = tmpdir("bad");
        assert_eq!(load_from(&[d.join("nope.toml")]).unwrap(), Config::default());
        let bad = write(&d, "bad.toml", "[outputs.X]\nscale = 9.0\n");
        assert!(load_from(&[bad]).is_err());
        let typo = write(&d, "typo.toml", "[input.keybaord]\nlayout = \"es\"\n");
        assert!(load_from(&[typo]).is_err(), "an unknown key is an error, not silently ignored");
        let mode = write(&d, "mode.toml", "[outputs.X]\nmode = \"big\"\n");
        assert!(load_from(&[mode]).is_err());
    }
}


