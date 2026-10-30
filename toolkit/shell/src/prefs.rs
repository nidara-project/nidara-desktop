// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's ordinary preferences, read-only (DOCK.md §3): GSettings `org.nidara.dock`
//! on a GLib thread of its own, following its change signals. Config1 becomes the writer
//! in D2; `pinned`/`layout` are never read here (the layout is Applications1's).
use crate::geometry::Position;
use gio::prelude::*;

pub const SCHEMA: &str = "org.nidara.dock";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Prefs {
    pub position: Position,
    /// The preferred size; the fit factor may draw it smaller, never stores it.
    pub icon_size: u32,
    pub indicators: bool,
}
impl Default for Prefs {
    fn default() -> Self {
        Self {
            position: Position::Bottom,
            icon_size: 64,
            indicators: true,
        }
    }
}

/// The schema's own bounds; an out-of-range stored value is read at its nearest bound.
pub fn read(position: &str, icon_size: i32, indicators: bool) -> Prefs {
    Prefs {
        position: Position::parse(position).unwrap_or(Position::Bottom),
        icon_size: icon_size.clamp(32, 96) as u32,
        indicators,
    }
}

/// Runs forever on its own thread. Without the schema the defaults stand, said once.
pub fn watch(emit: impl Fn(Prefs) + 'static) {
    let ctx = glib::MainContext::new();
    let _guard = ctx.acquire();
    let _ = ctx.with_thread_default(|| {
        let installed = gio::SettingsSchemaSource::default()
            .and_then(|s| s.lookup(SCHEMA, true))
            .is_some();
        if !installed {
            eprintln!("nidara-shell: no {SCHEMA} schema; using the default dock preferences");
            emit(Prefs::default());
            return;
        }
        let settings = gio::Settings::new(SCHEMA);
        let get = |s: &gio::Settings| {
            read(
                &s.string("position"),
                s.int("icon-size"),
                s.boolean("show-indicators"),
            )
        };
        emit(get(&settings));
        settings.connect_changed(None, move |s, key| {
            if matches!(key, "position" | "icon-size" | "show-indicators") {
                emit(get(s));
            }
        });
        glib::MainLoop::new(Some(&ctx), false).run();
        drop(settings);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_values_are_read_inside_the_schema_bounds() {
        assert_eq!(
            read("left", 64, true),
            Prefs {
                position: Position::Left,
                icon_size: 64,
                indicators: true
            }
        );
        assert_eq!(read("top", 200, false).position, Position::Bottom);
        assert_eq!(read("right", 200, false).icon_size, 96);
        assert_eq!(read("bottom", 8, false).icon_size, 32);
    }
}
