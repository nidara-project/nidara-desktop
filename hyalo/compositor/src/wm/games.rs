//! Which windows are games — what a rule's `match = { game = true }` asks (wm/rules.rs).
//!
//! Three signs, the ones the Hyprland session's game mode reads (`config/hypr/hyprland.lua`):
//! - the app id Steam gives a game it runs under XWayland, `steam_app_<id>`;
//! - a Steam app id in the environment of the window's process or of one of its parents
//!   (`SteamAppId`, `SteamGameId`, `STEAM_APP_ID`) — what a native Wayland game launched by
//!   Steam carries, whatever app id it chose;
//! - the surface saying its content is a game (wp-content-type-v1).
//!
//! The environment is read once, when the window is created, and kept (`Managed::steam_app`):
//! a rule is asked again on every rename, and a terminal renames itself constantly.
//!
//! What a game gets is the shipped rule's (config/hyalo/hyalo.toml, `[rules.games]`): its own
//! workspace, `gamespace`. The rest of game mode — the wallpaper, the power profile, the
//! notifications and the way back — is the shell's, on both compositors
//! (ui/shell/core/GameSession.ts).

use smithay::{
    reexports::wayland_protocols::wp::content_type::v1::server::wp_content_type_v1,
    wayland::{compositor::with_states, content_type::ContentTypeSurfaceCachedState},
};

use super::{Managed, app_id};

/// How many processes up the tree to look: Steam starts a game through a reaper and a
/// launcher or two (the Hyprland session looks as far).
const ANCESTORS: usize = 8;

/// The Steam app id in a process's environment (`/proc/PID/environ`: `KEY=value` entries
/// separated by NUL), if it has one. `0` is what Steam itself sets outside a game.
pub fn steam_id_in_environ(environ: &[u8]) -> Option<u32> {
    environ
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let entry = std::str::from_utf8(entry).ok()?;
            let (key, value) = entry.split_once('=')?;
            matches!(key, "SteamAppId" | "SteamGameId" | "STEAM_APP_ID").then(|| value.parse::<u32>().ok())?
        })
        .find(|id| *id != 0)
}

/// The parent's pid from `/proc/PID/stat`. The second field, the command name, is in
/// parentheses and may itself hold spaces and parentheses, so the fields are counted from
/// the LAST `)`.
pub fn parent_in_stat(stat: &str) -> Option<i32> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// The Steam app id of `pid` or one of its parents.
pub fn steam_app_of(pid: i32) -> Option<u32> {
    let mut p = pid;
    for _ in 0..ANCESTORS {
        if p <= 1 {
            break;
        }
        if let Some(id) = std::fs::read(format!("/proc/{p}/environ")).ok().and_then(|e| steam_id_in_environ(&e)) {
            return Some(id);
        }
        p = std::fs::read_to_string(format!("/proc/{p}/stat")).ok().and_then(|s| parent_in_stat(&s))?;
    }
    None
}

/// `steam_app_<digits>`, whole.
pub fn is_steam_app_id(app_id: &str) -> bool {
    app_id.strip_prefix("steam_app_").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether the surface says its content is a game.
fn says_game(m: &Managed) -> bool {
    let Some(t) = m.window.toplevel() else { return false };
    with_states(t.wl_surface(), |states| {
        *states.cached_state.get::<ContentTypeSurfaceCachedState>().current().content_type() == wp_content_type_v1::Type::Game
    })
}

pub fn is_game(m: &Managed) -> bool {
    m.steam_app.is_some() || is_steam_app_id(&app_id(&m.window)) || says_game(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_steam_id_is_read_out_of_the_environment() {
        assert_eq!(steam_id_in_environ(b"HOME=/home/a\0SteamAppId=440\0PATH=/usr/bin\0"), Some(440));
        assert_eq!(steam_id_in_environ(b"SteamGameId=1091500\0"), Some(1091500));
        assert_eq!(steam_id_in_environ(b"STEAM_APP_ID=70"), Some(70));
        // Steam's own processes carry 0; a value that is not a number is nobody's.
        assert_eq!(steam_id_in_environ(b"SteamAppId=0\0"), None);
        assert_eq!(steam_id_in_environ(b"SteamAppId=0\0SteamGameId=730\0"), Some(730));
        assert_eq!(steam_id_in_environ(b"SteamAppId=abc\0"), None);
        // A key that only ends like one is not one.
        assert_eq!(steam_id_in_environ(b"NOTSteamAppId=440\0"), None);
        assert_eq!(steam_id_in_environ(b""), None);
    }

    #[test]
    fn the_parent_is_counted_from_the_last_parenthesis() {
        assert_eq!(parent_in_stat("1234 (kitty) S 987 1234 1234 0"), Some(987));
        assert_eq!(parent_in_stat("1234 (a) (b c) S 55 1 1"), Some(55));
        assert_eq!(parent_in_stat("garbage"), None);
    }

    #[test]
    fn a_steam_app_id_is_the_prefix_and_digits_only() {
        assert!(is_steam_app_id("steam_app_440"));
        assert!(!is_steam_app_id("steam_app_"));
        assert!(!is_steam_app_id("steam_app_440x"));
        assert!(!is_steam_app_id("steam"));
        assert!(!is_steam_app_id("xsteam_app_440"));
    }
}
