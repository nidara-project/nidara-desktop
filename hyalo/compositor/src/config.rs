//! Hyalo's configuration: ONE file of ours, TOML.
//!
//! Three layers, read in order and merged table by table:
//!
//! 1. the defaults the package ships, `/usr/share/nidara/hyalo/hyalo.toml`;
//! 2. what Settings chose, `~/.config/nidara/hyalo-settings.toml` — written by Hyalo itself
//!    when the shell asks (the `settings` request, `apply_settings` below), never by hand: the
//!    counterpart of the `nidara-*.lua` files the shell writes for Hyprland;
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
    pub layout: LayoutConfig,
    pub workspaces: WorkspacesConfig,
    /// Key and pointer bindings: `"Super+Q" = "close-window"` (binds.rs).
    pub binds: BTreeMap<String, crate::binds::BindConfig>,
    /// Window rules by name, applied in name order (wm/rules.rs). By name rather than a list
    /// so a layer adds, overrides or switches off (`enabled = false`) one rule: the layers
    /// merge tables, and a list in the user's file would replace the shipped ones whole.
    pub rules: BTreeMap<String, RuleConfig>,
    /// What happens when nobody touches the computer (idle.rs). Settings → Power writes it.
    pub idle: IdleConfig,
    pub render: RenderConfig,
    /// How windows are drawn: their corners, and the blur behind a translucent one
    /// (render/window.rs). Settings → Appearance → Windows writes `backdrop.enabled`.
    pub windows: WindowsConfig,
    /// What Hyalo animates (wm/minimize.rs, wm/motion.rs). Settings → Accessibility → Reduce
    /// motion writes `enabled`.
    pub animations: AnimationsConfig,
    /// X11 apps (xwayland.rs).
    pub xwayland: XwaylandConfig,
}

/// X11 apps: Xwayland, with Hyalo as its window manager (xwayland.rs). Read when Hyalo starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct XwaylandConfig {
    /// Off, no X11 app runs: Steam and most games among them.
    pub enabled: bool,
}

impl Default for XwaylandConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// What Hyalo animates, and how long it takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AnimationsConfig {
    /// Off, nothing moves: a window opens, closes and is minimized at once (reduce motion).
    pub enabled: bool,
    /// A window shrinking into the dock, and back, in milliseconds. 400 = the Hyprland
    /// session's `windowsOut` (speed 4, in tenths of a second), on its `default` curve.
    pub minimize: u32,
    /// A window opening: it grows out of its own middle, ms. 700 = the Hyprland session's
    /// `windows` (speed 7, `myBezier`, which overshoots a little).
    pub open: u32,
    /// A window closing: it shrinks to 80 % of its size, ms. 400 = `windowsOut` (`default`).
    pub close: u32,
    /// How long a window takes to appear and to fade away as it opens and closes, ms. 400 =
    /// `fade` (speed 4, `easeOut`).
    pub fade: u32,
    /// Going to another workspace: the one shown slides out and the other in, sideways, ms.
    /// 600 = `workspaces` (speed 6, `default`, Hyprland's `slide`).
    pub workspace: u32,
}

impl Default for AnimationsConfig {
    fn default() -> Self {
        Self { enabled: true, minimize: 400, open: 700, close: 400, fade: 400, workspace: 600 }
    }
}

/// How frames reach the screen (backend/tty.rs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RenderConfig {
    /// A fullscreen window that covers the output, opaque, is put on the display's primary
    /// plane as it is, with no composition: less latency for a game. Off, every frame is
    /// composed — the switch for hardware that shows such a window wrong (Hyprland's
    /// `render:direct_scanout`). Overlay planes are never used, whatever this says.
    pub direct_scanout: bool,
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self { direct_scanout: true }
    }
}

/// How windows are drawn (render/window.rs). The defaults are what Hyprland drew for Nidara
/// (config/hypr/hyprland.lua: `rounding`, `rounding_power`, `decoration:blur`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WindowsConfig {
    /// Corner radius, logical pixels; 0 = square. A fullscreen window is never rounded.
    pub rounding: f64,
    /// The corner's curve: 2 is a circle, higher is a squircle (Hyprland's `rounding_power`).
    pub rounding_power: f64,
    pub backdrop: BackdropConfig,
    pub controls: ControlsConfig,
    pub title_bar: TitleBarConfig,
    pub border: BorderConfig,
    pub shadow: ShadowConfig,
}

impl Default for WindowsConfig {
    fn default() -> Self {
        Self {
            rounding: 24.0,
            rounding_power: 3.2,
            backdrop: BackdropConfig::default(),
            controls: ControlsConfig::default(),
            title_bar: TitleBarConfig::default(),
            border: BorderConfig::default(),
            shadow: ShadowConfig::default(),
        }
    }
}

/// The line around every window (render/decor.rs), outside its box and following its corners:
/// Hyprland's for Nidara (config/hypr/hyprland.lua `col.active_border`/`inactive_border`). Its
/// room is `[layout] border`, which tiles leave between them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BorderConfig {
    /// Logical px; 0 = none.
    pub width: f64,
    /// The focused window's: a gradient from the first colour to the second, at `angle`
    /// degrees (0 left to right, 90 top to bottom). `#rrggbb` or `#rrggbbaa`.
    pub active: [String; 2],
    pub angle: f64,
    /// Every other window's.
    pub inactive: String,
}

impl Default for BorderConfig {
    fn default() -> Self {
        Self { width: 1.0, active: ["#ffffff4d".into(), "#ffffff1a".into()], angle: 45.0, inactive: "#59595933".into() }
    }
}

/// The shadow under every window (render/decor.rs): what lifts a window off the one beneath —
/// and what an app that draws its own frame lost when Hyalo cut that frame to its box.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShadowConfig {
    pub enabled: bool,
    /// How it fades: (1 − t)^power over its range — Hyprland's `render_power`.
    pub power: f64,
    /// The focused window's, deeper; every other window's.
    pub active: ShadowLook,
    pub inactive: ShadowLook,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShadowLook {
    /// How far it reaches past the window's edge, logical px.
    pub range: f64,
    /// How far it falls below the window, logical px.
    pub offset: f64,
    /// `#rrggbbaa`: its colour where it is strongest, at the window's edge.
    pub color: String,
}

impl Default for ShadowLook {
    fn default() -> Self {
        Self { range: 20.0, offset: 4.0, color: "#00000059".into() }
    }
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            power: 2.0,
            active: ShadowLook::default(),
            inactive: ShadowLook { range: 12.0, offset: 2.0, color: "#00000033".into() },
        }
    }
}

/// `#rrggbb` or `#rrggbbaa` as premultiplied RGBA, 0..1; None when it is neither.
pub fn parse_color(s: &str) -> Option<[f32; 4]> {
    let h = s.strip_prefix('#')?;
    if !matches!(h.len(), 6 | 8) || !h.is_ascii() {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|b| b as f32 / 255.0);
    let a = if h.len() == 8 { byte(6)? } else { 1.0 };
    Some([byte(0)? * a, byte(2)? * a, byte(4)? * a, a])
}

/// The title bar Hyalo draws for an app that leaves its decorations to the compositor (kitty,
/// Qt apps, Chrome with "Use system title bar and borders"): render/title_bar.rs, #708 point 5.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TitleBarConfig {
    /// The title's font family: the desktop's interface font, which the shell keeps here in
    /// step with Settings → Appearance (the size is the shell chrome's fixed 13 px).
    pub font: String,
}

impl Default for TitleBarConfig {
    fn default() -> Self {
        Self { font: "Inter".into() }
    }
}

/// The window controls Hyalo draws over an app's header (protocols/window_controls.rs, #708
/// point 5): which side of the window they go on, and which buttons. Settings → Appearance →
/// Windows writes `org.gnome.desktop.wm.preferences button-layout`, and the shell keeps these
/// equal to it (core/AppearanceSync.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ControlsConfig {
    pub side: ControlsSide,
    /// The buttons the user wants; close is always shown. A window shows fewer when it cannot
    /// do one (window_controls.rs `shown`).
    pub buttons: Vec<crate::protocols::window_controls::Button>,
}

impl Default for ControlsConfig {
    fn default() -> Self {
        use crate::protocols::window_controls::Button;
        Self { side: ControlsSide::default(), buttons: vec![Button::Minimize, Button::Maximize, Button::Close] }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ControlsSide {
    /// The Linux and Windows convention: close last, at the window's right.
    #[default]
    Right,
    /// Close first, at the window's left.
    Left,
}

/// The blur behind every translucent window: the WINDOW material (#708 point 1), apart from the
/// shell's refractive glass — blur and Hyprland's finishing, no refraction, no tint of its own
/// (a window's own translucent background is its tint). A rule turns it off for one app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BackdropConfig {
    pub enabled: bool,
    /// The kawase blur, as `GLASS_BLUR`'s numbers: each pass's offset (logical px) and passes.
    pub size: f64,
    pub passes: u32,
    /// Hyprland's `decoration:blur` finishing, its numbers and its formulas: contrast before
    /// the blur, vibrancy in each down-sample, noise and brightness after.
    pub contrast: f64,
    pub brightness: f64,
    pub vibrancy: f64,
    pub vibrancy_darkness: f64,
    pub noise: f64,
}

impl Default for BackdropConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            size: 2.0,
            passes: 2,
            contrast: 1.2,
            brightness: 1.0,
            vibrancy: 0.4,
            vibrancy_darkness: 0.1,
            noise: 0.01,
        }
    }
}

/// Seconds without input before each step; 0 = never. The steps are independent: with the
/// screen off at 300 and the lock at 600, the screen goes dark at five minutes and the session
/// locks at ten. The defaults are the ones Settings showed on Hyprland with no hypridle.conf.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdleConfig {
    pub screen_off: u32,
    pub lock: u32,
    pub suspend: u32,
}

impl Default for IdleConfig {
    fn default() -> Self {
        Self { screen_off: 300, lock: 600, suspend: 0 }
    }
}

/// One window rule: what it matches and what it does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RuleConfig {
    pub enabled: bool,
    #[serde(rename = "match")]
    pub matching: RuleMatch,
    /// Float (true) or tile (false), whatever the workspace's mode.
    pub float: Option<bool>,
    /// Centred in the usable area — not over its parent, not stepped off another window.
    pub center: bool,
    /// `"3"`, `"special:NAME"` or `"name:NAME"` (a named workspace, `gamespace`).
    pub workspace: Option<String>,
    /// With `workspace`: the window goes there without taking the user with it.
    pub silent: bool,
    /// `false`: square corners (Hyprland's `rounding = 0`).
    pub rounding: Option<bool>,
    /// `false`: no blur behind it, translucent or not.
    pub backdrop: Option<bool>,
    /// `false`: no title bar from Hyalo, for an app that asks for one (render/title_bar.rs).
    pub title_bar: Option<bool>,
    /// The only buttons its controls may show (`["close"]`); close is always kept
    /// (protocols/window_controls.rs).
    pub controls: Option<Vec<crate::protocols::window_controls::Button>>,
    /// `false`: it opens and closes at once, no animation (Hyprland's `no_anim`).
    pub animate: Option<bool>,
}

impl Default for RuleConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            matching: RuleMatch::default(),
            float: None,
            center: false,
            workspace: None,
            silent: false,
            rounding: None,
            backdrop: None,
            title_bar: None,
            controls: None,
            animate: None,
        }
    }
}

/// Regular expressions, each searched in its field (anchor with `^…$` for the whole string).
/// Every one given must match.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RuleMatch {
    pub app_id: Option<String>,
    pub title: Option<String>,
    /// What the window was called when it was first shown.
    pub initial_app_id: Option<String>,
    pub initial_title: Option<String>,
    /// A game (wm/games.rs: Steam's app id or environment, or a surface whose content is a
    /// game) — or, `false`, anything that is not.
    pub game: Option<bool>,
}

/// How windows are laid out. The defaults are the Hyprland session's (`config/hypr/
/// hyprland.lua`), so the bar's ends line up with the windows the same way in both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LayoutConfig {
    /// The tiling layout of every workspace (`wm/layout/`): `dwindle`.
    pub tiling: String,
    /// Between a window and its neighbour, each (so twice this between two windows).
    pub gaps_in: i32,
    /// Between the windows and the usable area's edge — the bar's margin.
    pub gaps_out: i32,
    /// Kept around every window for its border.
    pub border: i32,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self { tiling: "dwindle".into(), gaps_in: 2, gaps_out: 4, border: 1 }
    }
}

/// Floating or tiling, per workspace (#513 on Hyprland). Settings writes `modes`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspacesConfig {
    pub default_mode: crate::wm::WorkspaceMode,
    /// By workspace number: `modes = { "3" = "tiling" }`.
    pub modes: BTreeMap<String, crate::wm::WorkspaceMode>,
}

impl Default for WorkspacesConfig {
    fn default() -> Self {
        Self { default_mode: crate::wm::WorkspaceMode::Floating, modes: BTreeMap::new() }
    }
}

impl WorkspacesConfig {
    pub fn mode_of(&self, ws: i32) -> crate::wm::WorkspaceMode {
        self.modes.get(&ws.to_string()).copied().unwrap_or(self.default_mode)
    }
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
    /// Num Lock on when the keyboard is set up (Hyprland's `numlock_by_default`).
    pub numlock: bool,
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
            numlock: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Pointer {
    /// libinput's acceleration speed, -1..1.
    #[serde(deserialize_with = "number")]
    pub accel_speed: f64,
    /// `adaptive` or `flat` (libinput's acceleration profiles).
    pub accel_profile: String,
    pub natural_scroll: bool,
}

impl Default for Pointer {
    fn default() -> Self {
        Self { accel_speed: 0.0, accel_profile: "adaptive".into(), natural_scroll: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Touchpad {
    #[serde(deserialize_with = "number")]
    pub accel_speed: f64,
    pub accel_profile: String,
    pub natural_scroll: bool,
    pub tap: bool,
    pub disable_while_typing: bool,
}

impl Default for Touchpad {
    fn default() -> Self {
        Self {
            accel_speed: 0.0,
            accel_profile: "adaptive".into(),
            natural_scroll: true,
            tap: true,
            disable_while_typing: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CursorConfig {
    pub theme: String,
    pub size: u32,
    /// The pointer is in a screen recording that asks for it (wlr-screencopy's
    /// `overlay_cursor` — wf-recorder always does): Settings → the recording widget's "Show the
    /// pointer" writes it (protocols/screencopy.rs).
    pub recorded: bool,
}

impl Default for CursorConfig {
    fn default() -> Self {
        Self { theme: "default".into(), size: 24, recorded: true }
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
    pub vrr: Vrr,
}

/// Variable refresh rate on an output: `false`, `true`, or `"games"` — on only while a game is
/// fullscreen on it (niri's on-demand VRR, Hyprland's `misc:vrr = 3`). A bool as before, so the
/// layers already written keep their meaning. `"games"` is decided every frame in the tty
/// backend (`backend/tty.rs` → `vrr_for_games`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Vrr {
    #[default]
    Off,
    On,
    Games,
}

impl Serialize for Vrr {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Vrr::Off => s.serialize_bool(false),
            Vrr::On => s.serialize_bool(true),
            Vrr::Games => s.serialize_str("games"),
        }
    }
}

impl<'de> Deserialize<'de> for Vrr {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum V {
            B(bool),
            S(String),
        }
        match V::deserialize(d)? {
            V::B(b) => Ok(if b { Vrr::On } else { Vrr::Off }),
            V::S(s) if s == "games" => Ok(Vrr::Games),
            V::S(s) => Err(serde::de::Error::custom(format!("vrr is false, true or \"games\", not {s:?}"))),
        }
    }
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: String::new(),
            scale: 1.0,
            position: None,
            transform: "normal".into(),
            vrr: Vrr::Off,
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

/// The file Settings' choices go to: `$XDG_CONFIG_HOME/nidara/hyalo-settings.toml`, or
/// `HYALO_SETTINGS`.
pub fn settings_config_path() -> PathBuf {
    match std::env::var_os("HYALO_SETTINGS") {
        Some(p) => PathBuf::from(p),
        None => user_config_path().with_file_name("hyalo-settings.toml"),
    }
}

/// The layers in the order they apply. `HYALO_CONFIG` replaces them all (tests, CI), and then
/// there is a settings layer only if `HYALO_SETTINGS` names one: a test must not write the
/// real `~/.config`.
pub fn layer_paths() -> Vec<PathBuf> {
    if let Some(p) = std::env::var_os("HYALO_CONFIG") {
        let mut v = vec![PathBuf::from(p)];
        v.extend(std::env::var_os("HYALO_SETTINGS").map(PathBuf::from));
        return v;
    }
    vec![PathBuf::from(SYSTEM_CONFIG), settings_config_path(), user_config_path()]
}

/// The settings layer of this session, if it has one (`layer_paths`).
fn settings_layer() -> Option<PathBuf> {
    let path = settings_config_path();
    layer_paths().contains(&path).then_some(path)
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
    let mut layers = Vec::new();
    for p in paths {
        layers.extend(read_layer(p)?);
    }
    from_layers(layers)
}

/// The configuration the layers make, bottom first, checked.
fn from_layers(layers: Vec<toml::Table>) -> Result<Config, ConfigError> {
    let mut merged = toml::Table::new();
    for layer in layers {
        merge(&mut merged, layer);
    }
    let config: Config = toml::Value::Table(merged)
        .try_into()
        .map_err(|e: toml::de::Error| ConfigError::Invalid(e.to_string()))?;
    if crate::wm::layout::new(&config.layout.tiling).is_none() {
        return Err(ConfigError::Invalid(format!(
            "layout.tiling: unknown {:?} (one of {})",
            config.layout.tiling,
            crate::wm::layout::NAMES.join(", ")
        )));
    }
    for (k, v) in [("gaps_in", config.layout.gaps_in), ("gaps_out", config.layout.gaps_out), ("border", config.layout.border)] {
        if !(0..=200).contains(&v) {
            return Err(ConfigError::Invalid(format!("layout.{k}: {v} is outside 0..200")));
        }
    }
    for (name, profile, speed) in [
        ("pointer", &config.input.pointer.accel_profile, config.input.pointer.accel_speed),
        ("touchpad", &config.input.touchpad.accel_profile, config.input.touchpad.accel_speed),
    ] {
        if !matches!(profile.as_str(), "adaptive" | "flat") {
            return Err(ConfigError::Invalid(format!("input.{name}.accel_profile: {profile:?} is not adaptive or flat")));
        }
        if !(-1.0..=1.0).contains(&speed) {
            return Err(ConfigError::Invalid(format!("input.{name}.accel_speed: {speed} is outside -1..1")));
        }
    }
    if let Some(k) = config.workspaces.modes.keys().find(|k| k.parse::<i32>().map_or(true, |n| n < 1)) {
        return Err(ConfigError::Invalid(format!("workspaces.modes: {k:?} is not a workspace number")));
    }
    crate::binds::parse_binds(&config.binds).map_err(ConfigError::Invalid)?;
    crate::wm::rules::compile(&config.rules).map_err(ConfigError::Invalid)?;
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
    // Before reading: a write landing between the stamp and the read is read again next poll.
    state.config_stamps = stamps();
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
            // A new keymap starts with Num Lock off; turning the option OFF leaves the key
            // as the user has it.
            if kb.numlock {
                set_numlock(&keyboard);
            }
        }
    }
    if old.input.pointer != new.input.pointer || old.input.touchpad != new.input.touchpad {
        state.backend.reconfigure_input_devices(&new.input);
    }
    if old.cursor != new.cursor {
        state.backend.reload_cursors(&new.cursor);
        // X11 apps draw their own cursors from the theme in their resources (xwayland.rs).
        state.update_x11_resources();
        state.set_x11_cursor();
    }
    if old.binds != new.binds {
        // Validated by `load`, so this cannot fail here.
        state.binds = crate::binds::parse_binds(&new.binds).unwrap_or_default();
    }
    if old.rules != new.rules {
        // Validated by `load`. Applies to windows opened from now on, and to a window whose
        // app id or title changes: a rule never re-arranges what is already open.
        state.rules = crate::wm::rules::compile(&new.rules).unwrap_or_default();
    }
    if old.idle != new.idle {
        state.idle_rearm();
    }
    if old.windows.controls != new.windows.controls {
        crate::protocols::window_controls::send_layouts(state);
    }
    if old.layout.tiling != new.layout.tiling {
        state.change_tiling_layout();
    }
    if old.workspaces != new.workspaces {
        // Each workspace whose mode changed (and was not set at runtime) takes the new one.
        let ids: Vec<i32> = state.wm.workspaces.keys().copied().filter(|i| *i > 0).collect();
        for ws in ids {
            if !state.wm.mode_overrides.contains_key(&ws) && old.workspaces.mode_of(ws) != new.workspaces.mode_of(ws) {
                let floating = new.workspaces.mode_of(ws) == crate::wm::WorkspaceMode::Floating;
                state.set_all_floating(ws, floating);
            }
        }
        state.wm.dirty_workspaces = true;
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
    state.arrange_all();
    crate::ipc::server::broadcast(state, &crate::ipc::Event::ConfigReloaded);
    crate::ipc::server::outputs_changed(state);
    tracing::info!("configuration reloaded");
    Ok(())
}

/// Polls the layers' modification times once a second and reloads on a change — cheap, and
/// immune to editors that replace the file rather than write into it.
pub fn watch(state: &mut crate::Hyalo) {
    use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
    let interval = std::time::Duration::from_secs(1);
    let _ = state.loop_handle.insert_source(Timer::from_duration(interval), move |_, _, state| {
        if stamps() != state.config_stamps {
            let _ = reload(state);
        }
        TimeoutAction::ToDuration(interval)
    });
}

pub fn set_numlock(keyboard: &smithay::input::keyboard::KeyboardHandle<crate::Hyalo>) {
    let mut mods = keyboard.modifier_state();
    mods.num_lock = true;
    keyboard.set_modifier_state(mods);
}

/// What Settings chose, applied: `patch` (JSON, the shape of the config) is merged into the
/// settings layer, the whole stack is checked, the file is written and the configuration
/// reloaded — once. A `null` removes a key, so the layer below shows through again. Returns
/// whether anything changed: re-stating what the layer already says writes nothing and
/// reloads nothing, so a shell that re-sends its settings on every `config_reloaded` cannot
/// loop.
///
/// Hyalo is the one writer of this file. Before, the shell wrote it whole from each module's
/// state, and two modules writing one file would have dropped each other's tables.
pub fn apply_settings(state: &mut crate::Hyalo, patch: serde_json::Value) -> Result<bool, String> {
    let serde_json::Value::Object(patch) = patch else {
        return Err("settings: the patch must be an object".into());
    };
    let Some(path) = settings_layer() else {
        return Err("settings: this session has no settings layer (HYALO_CONFIG without HYALO_SETTINGS)".into());
    };
    let current = read_layer(&path).map_err(|e| e.to_string())?.unwrap_or_default();
    let mut patched = current.clone();
    merge_patch(&mut patched, patch)?;
    if patched == current {
        return Ok(false);
    }
    let mut layers = Vec::new();
    for p in layer_paths() {
        if p == path {
            layers.push(patched.clone());
        } else {
            layers.extend(read_layer(&p).map_err(|e| e.to_string())?);
        }
    }
    from_layers(layers).map_err(|e| format!("settings refused: {e}"))?;
    let body = toml::to_string(&patched).map_err(|e| e.to_string())?;
    write_atomically(&path, &format!("{SETTINGS_HEADER}\n{body}")).map_err(|e| format!("{}: {e}", path.display()))?;
    reload(state)?;
    Ok(true)
}

const SETTINGS_HEADER: &str = "\
# Written by Hyalo for Nidara Settings — do not edit: it is rewritten on every change.
# Your own settings go in hyalo.toml next to it, which is read after this file and wins.
";

fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("toml.tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// JSON merge patch (RFC 7396) onto a TOML table; tables a removal leaves empty go too.
fn merge_patch(base: &mut toml::Table, patch: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    use serde_json::Value as J;
    for (k, v) in patch {
        match v {
            J::Null => {
                base.remove(&k);
            }
            J::Object(o) => {
                let mut t = match base.remove(&k) {
                    Some(toml::Value::Table(t)) => t,
                    _ => toml::Table::new(),
                };
                merge_patch(&mut t, o)?;
                if !t.is_empty() {
                    base.insert(k, toml::Value::Table(t));
                }
            }
            v => {
                base.insert(k.clone(), json_to_toml(v).map_err(|e| format!("settings: {k}: {e}"))?);
            }
        }
    }
    Ok(())
}

fn json_to_toml(v: serde_json::Value) -> Result<toml::Value, String> {
    use serde_json::Value as J;
    Ok(match v {
        J::Null => return Err("null inside a value".into()),
        J::Bool(b) => toml::Value::Boolean(b),
        J::Number(n) => match n.as_i64() {
            Some(i) => toml::Value::Integer(i),
            None => toml::Value::Float(n.as_f64().ok_or("not a number")?),
        },
        J::String(s) => toml::Value::String(s),
        J::Array(a) => toml::Value::Array(a.into_iter().map(json_to_toml).collect::<Result<_, _>>()?),
        J::Object(o) => {
            let mut t = toml::Table::new();
            for (k, v) in o {
                t.insert(k, json_to_toml(v)?);
            }
            toml::Value::Table(t)
        }
    })
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
        assert_eq!(o.vrr, Vrr::On, "the shipped value where neither did");
    }

    #[test]
    fn vrr_is_a_bool_or_games() {
        let d = tmpdir("vrr");
        let f = write(&d, "a.toml", "[outputs.A]\nvrr = false\n[outputs.B]\nvrr = true\n[outputs.C]\nvrr = \"games\"\n");
        let c = load_from(&[f]).unwrap();
        assert_eq!((c.outputs["A"].vrr, c.outputs["B"].vrr, c.outputs["C"].vrr), (Vrr::Off, Vrr::On, Vrr::Games));
        let bad = write(&d, "b.toml", "[outputs.A]\nvrr = \"always\"\n");
        assert!(load_from(&[bad]).is_err(), "a word that is not games is refused, not read as off");
        let json = serde_json::to_string(&[Vrr::Off, Vrr::On, Vrr::Games]).unwrap();
        assert_eq!(json, r#"[false,true,"games"]"#, "written back as it is read");
    }

    #[test]
    fn the_shipped_file_loads_with_every_binding() {
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/hyalo/hyalo.toml");
        let c = load_from(&[shipped]).expect("config/hyalo/hyalo.toml must load");
        let binds = crate::binds::parse_binds(&c.binds).unwrap();
        assert!(binds.len() >= 54, "the Hyprland session's bindings are all there");
        assert_eq!(c.workspaces.default_mode, crate::wm::WorkspaceMode::Floating);
        let rules = crate::wm::rules::compile(&c.rules).unwrap();
        assert!(rules.iter().any(|r| r.name == "about"), "the shipped rules load");
        // The Hyprland session's animations, and its `no_anim` for games and app-id-less windows.
        assert_eq!(c.animations, AnimationsConfig::default());
        for name in ["games", "no-app-id"] {
            assert!(rules.iter().any(|r| r.name == name && r.effects.animate == Some(false)), "{name} opens at once");
        }
    }

    #[test]
    fn layout_and_workspace_modes_are_checked() {
        let d = tmpdir("layout");
        let ok = write(&d, "ok.toml", "[layout]\ngaps_in = 0\n[workspaces.modes]\n3 = \"tiling\"\n");
        let c = load_from(&[ok]).unwrap();
        assert_eq!(c.workspaces.mode_of(3), crate::wm::WorkspaceMode::Tiling);
        assert_eq!(c.workspaces.mode_of(4), crate::wm::WorkspaceMode::Floating);
        assert!(load_from(&[write(&d, "l.toml", "[layout]\ntiling = \"spiral\"\n")]).is_err());
        assert!(load_from(&[write(&d, "m.toml", "[workspaces.modes]\nzero = \"tiling\"\n")]).is_err());
        assert!(load_from(&[write(&d, "b.toml", "[binds]\n\"Super+Q\" = \"explode\"\n")]).is_err());
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

    #[test]
    fn a_settings_patch_merges_removes_and_keeps_types() {
        let mut layer: toml::Table = toml::from_str(
            "[outputs.DP-1]\nscale = 1.25\n[workspaces.modes]\n3 = \"tiling\"\n4 = \"floating\"\n",
        )
        .unwrap();
        let patch = serde_json::json!({
            "input": { "pointer": { "accel_speed": 0, "accel_profile": "flat" }, "keyboard": { "numlock": true } },
            "workspaces": { "modes": { "3": null, "4": null } },
            "outputs": { "DP-1": { "scale": 1 } },
        });
        let serde_json::Value::Object(patch) = patch else { unreachable!() };
        merge_patch(&mut layer, patch).unwrap();
        assert!(layer.get("workspaces").is_none(), "a table emptied by removals goes");
        let c = from_layers(vec![layer]).expect("integers where floats are expected still load");
        assert_eq!(c.input.pointer.accel_speed, 0.0);
        assert_eq!(c.input.pointer.accel_profile, "flat");
        assert!(c.input.keyboard.numlock);
        assert_eq!(c.outputs["DP-1"].scale, 1.0);
        assert_eq!(c.workspaces.mode_of(3), crate::wm::WorkspaceMode::Floating);
    }

    #[test]
    fn input_values_are_checked() {
        let bad = |t: &str| from_layers(vec![toml::from_str(t).unwrap()]).is_err();
        assert!(bad("[input.pointer]\naccel_profile = \"custom\"\n"));
        assert!(bad("[input.touchpad]\naccel_speed = 2.0\n"));
        assert!(!bad("[input.touchpad]\naccel_speed = -1\naccel_profile = \"flat\"\n"));
    }
}
