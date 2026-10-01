//! Key and pointer bindings, from the `[binds]` table of the configuration:
//!
//! ```toml
//! [binds]
//! "Super+Q" = "close-window"
//! "Super+Shift+Right" = { action = "resize 30 0", repeat = true }
//! "Super_L" = { action = "spawn nidara-ipc toggleAppGrid", release = true }
//! "Super+MouseLeft" = "move-with-pointer"
//! "Super+WheelDown" = "workspace e+1"
//! ```
//!
//! Modifiers are `Super`, `Shift`, `Ctrl`, `Alt`; the key is an xkb keysym name (`Q`, `1`,
//! `Return`, `XF86AudioMute`…), or `MouseLeft`/`MouseRight`/`MouseMiddle`, `WheelUp`/
//! `WheelDown`. Keys match by their unshifted symbol in the first Latin layout, so `Super+1`
//! is the same key with Shift held and on a non-Latin layout. The command is any of
//! `wm/actions.rs`.
//!
//! - `repeat`: runs again while held, at the keyboard's repeat delay and rate;
//! - `release`: runs when the key is let go, and only if nothing else was pressed meanwhile
//!   (Super alone opens the app grid; Super+T does not);
//! - `locked`: also runs while the session is locked (volume, brightness).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use smithay::input::keyboard::{Keysym, ModifiersState, xkb};

use crate::wm::actions::Action;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BindConfig {
    Command(String),
    Full(BindSpec),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindSpec {
    pub action: String,
    #[serde(default)]
    pub repeat: bool,
    #[serde(default)]
    pub release: bool,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub logo: bool,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}

impl From<&ModifiersState> for Mods {
    fn from(m: &ModifiersState) -> Self {
        Self { logo: m.logo, shift: m.shift, ctrl: m.ctrl, alt: m.alt }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Key(Keysym),
    Button(u32),
    WheelUp,
    WheelDown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub mods: Mods,
    pub trigger: Trigger,
    pub action: Action,
    pub repeat: bool,
    pub release: bool,
    pub locked: bool,
}

pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;

/// `"Super+Shift+Q"` → modifiers and trigger.
pub fn parse_keys(keys: &str) -> Result<(Mods, Trigger), String> {
    let parts: Vec<&str> = keys.split('+').map(str::trim).collect();
    let (key, mods) = parts.split_last().ok_or("empty binding")?;
    let mut m = Mods::default();
    for part in mods {
        match part.to_ascii_lowercase().as_str() {
            "super" | "mod4" | "logo" => m.logo = true,
            "shift" => m.shift = true,
            "ctrl" | "control" => m.ctrl = true,
            "alt" | "mod1" => m.alt = true,
            other => return Err(format!("{keys:?}: unknown modifier {other:?}")),
        }
    }
    let trigger = match key.to_ascii_lowercase().as_str() {
        "" => return Err(format!("{keys:?}: no key")),
        "mouseleft" => Trigger::Button(BTN_LEFT),
        "mouseright" => Trigger::Button(BTN_RIGHT),
        "mousemiddle" => Trigger::Button(BTN_MIDDLE),
        "wheelup" => Trigger::WheelUp,
        "wheeldown" => Trigger::WheelDown,
        _ => {
            let sym = xkb::keysym_from_name(key, xkb::KEYSYM_CASE_INSENSITIVE);
            if sym.raw() == xkb::keysyms::KEY_NoSymbol {
                return Err(format!("{keys:?}: no key called {key:?}"));
            }
            Trigger::Key(sym)
        }
    };
    Ok((m, trigger))
}

pub fn parse_binds(table: &BTreeMap<String, BindConfig>) -> Result<Vec<Binding>, String> {
    let mut out = Vec::new();
    for (keys, cfg) in table {
        let (mods, trigger) = parse_keys(keys)?;
        let (command, repeat, release, locked) = match cfg {
            BindConfig::Command(c) => (c.as_str(), false, false, false),
            BindConfig::Full(s) => (s.action.as_str(), s.repeat, s.release, s.locked),
        };
        let action: Action = command.parse().map_err(|e| format!("binds.{keys:?}: {e}"))?;
        let pointer_only = matches!(action, Action::MoveWithPointer | Action::ResizeWithPointer);
        if pointer_only != matches!(trigger, Trigger::Button(_)) {
            return Err(format!("binds.{keys:?}: move-/resize-with-pointer go on a mouse button, and only they do"));
        }
        if release && !matches!(trigger, Trigger::Key(_)) {
            return Err(format!("binds.{keys:?}: only a key can run on release"));
        }
        out.push(Binding { mods, trigger, action, repeat, release, locked });
    }
    Ok(out)
}

/// Letters compared without case: a binding says `Q`, the key's first level is `q`. (Latin
/// letters only, which is what the first Latin layout gives for a letter key.)
fn lower(sym: Keysym) -> u32 {
    let r = sym.raw();
    match r {
        0x41..=0x5a => r + 0x20,
        0xc0..=0xde if r != 0xd7 => r + 0x20,
        _ => r,
    }
}

/// The binding a key press runs. Release bindings are found with `release_binding`.
pub fn find_key(binds: &[Binding], mods: Mods, sym: Keysym) -> Option<&Binding> {
    binds
        .iter()
        .find(|b| !b.release && b.mods == mods && matches!(b.trigger, Trigger::Key(k) if lower(k) == lower(sym)))
}

/// A binding that runs when `sym` is let go — matched by the key alone, since the key is
/// usually a modifier and changes the modifier state itself.
pub fn release_binding(binds: &[Binding], sym: Keysym) -> Option<&Binding> {
    binds.iter().find(|b| b.release && matches!(b.trigger, Trigger::Key(k) if lower(k) == lower(sym)))
}

pub fn find_pointer(binds: &[Binding], mods: Mods, trigger: Trigger) -> Option<&Binding> {
    binds.iter().find(|b| b.mods == mods && b.trigger == trigger)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind(keys: &str, cfg: BindConfig) -> Result<Vec<Binding>, String> {
        parse_binds(&BTreeMap::from([(keys.to_string(), cfg)]))
    }

    fn cmd(s: &str) -> BindConfig {
        BindConfig::Command(s.into())
    }

    #[test]
    fn keys_and_buttons_read() {
        let (m, t) = parse_keys("Super+Shift+Q").unwrap();
        assert_eq!(m, Mods { logo: true, shift: true, ..Default::default() });
        assert!(matches!(t, Trigger::Key(k) if lower(k) == xkb::keysyms::KEY_q));
        assert_eq!(parse_keys("Super+MouseLeft").unwrap().1, Trigger::Button(BTN_LEFT));
        assert_eq!(parse_keys("Super+WheelDown").unwrap().1, Trigger::WheelDown);
        assert!(parse_keys("XF86AudioRaiseVolume").is_ok());
        assert!(parse_keys("Super+1").is_ok());
        assert!(parse_keys("Hyper+Q").is_err());
        assert!(parse_keys("Super+NotAKey").is_err());
    }

    #[test]
    fn a_binding_matches_its_key_whatever_the_case() {
        let b = bind("Super+Q", cmd("close-window")).unwrap();
        let mods = Mods { logo: true, ..Default::default() };
        assert!(find_key(&b, mods, Keysym::from(xkb::keysyms::KEY_q)).is_some());
        assert!(find_key(&b, Mods::default(), Keysym::from(xkb::keysyms::KEY_q)).is_none());
    }

    #[test]
    fn bindings_that_cannot_work_are_refused() {
        assert!(bind("Super+Q", cmd("move-with-pointer")).is_err());
        assert!(bind("Super+MouseLeft", cmd("close-window")).is_err());
        assert!(bind("Super+WheelUp", BindConfig::Full(BindSpec { action: "workspace e+1".into(), repeat: false, release: true, locked: false })).is_err());
        assert!(bind("Super+Q", cmd("close-everything")).is_err());
    }
}
