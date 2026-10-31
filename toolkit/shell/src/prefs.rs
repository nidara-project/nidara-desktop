// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's ordinary preferences (DOCK.md §3): GSettings `org.nidara.dock` read on a GLib
//! thread of its own, following its change signals. Writes go through Config1 (the dock
//! menu, the Settings page), never here; `pinned`/`layout` are never read here (the layout
//! is Applications1's). Reduce transparency is `org.nidara.appearance`'s, read the same way.
use crate::geometry::Position;
use gio::prelude::*;

pub const SCHEMA: &str = "org.nidara.dock";
pub const APPEARANCE: &str = "org.nidara.appearance";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Prefs {
    pub position: Position,
    /// The preferred size; the fit factor may draw it smaller, never stores it.
    pub icon_size: u32,
    pub indicators: bool,
    pub magnification: bool,
    /// The largest an icon grows under the pointer, before the bounds cap it.
    pub max_icon_size: u32,
    pub auto_hide: bool,
    pub hide_delay_ms: u32,
    /// The glass becomes solid (the tokens' reduce-transparency variant).
    pub reduce_transparency: bool,
}
impl Default for Prefs {
    fn default() -> Self {
        Self {
            position: Position::Bottom,
            icon_size: 64,
            indicators: true,
            magnification: true,
            max_icon_size: 128,
            auto_hide: false,
            hide_delay_ms: 500,
            reduce_transparency: false,
        }
    }
}

/// What GSettings holds, before the schema's bounds are applied.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub position: String,
    pub icon_size: i32,
    pub indicators: bool,
    pub magnification: bool,
    pub max_icon_size: i32,
    pub auto_hide: bool,
    pub hide_delay: i32,
    pub reduce_transparency: bool,
}

/// The schema's own bounds; an out-of-range stored value is read at its nearest bound.
pub fn read(s: &Stored) -> Prefs {
    Prefs {
        position: Position::parse(&s.position).unwrap_or(Position::Bottom),
        icon_size: s.icon_size.clamp(32, 96) as u32,
        indicators: s.indicators,
        magnification: s.magnification,
        max_icon_size: s.max_icon_size.clamp(64, 128) as u32,
        auto_hide: s.auto_hide,
        hide_delay_ms: s.hide_delay.clamp(0, 2000) as u32,
        reduce_transparency: s.reduce_transparency,
    }
}

fn settings(schema: &str, key: &str) -> Option<gio::Settings> {
    let found = gio::SettingsSchemaSource::default()
        .and_then(|s| s.lookup(schema, true))
        .filter(|s| s.has_key(key));
    if found.is_none() {
        eprintln!("nidara-shell: no {schema} schema with {key}; using its default");
    }
    found.map(|_| gio::Settings::new(schema))
}

/// Runs forever on its own thread. A missing schema leaves its defaults, said once.
pub fn watch(emit: impl Fn(Prefs) + 'static) {
    let ctx = glib::MainContext::new();
    let _guard = ctx.acquire();
    let _ = ctx.with_thread_default(|| {
        let dock = settings(SCHEMA, "position");
        let appearance = settings(APPEARANCE, "reduce-transparency");
        let get = {
            let (dock, appearance) = (dock.clone(), appearance.clone());
            move || {
                let d = Prefs::default();
                let int = |key, default: u32| dock.as_ref().map_or(default as i32, |s| s.int(key));
                let flag = |key, default| dock.as_ref().map_or(default, |s| s.boolean(key));
                read(&Stored {
                    position: dock
                        .as_ref()
                        .map_or(String::from("bottom"), |s| s.string("position").into()),
                    icon_size: int("icon-size", d.icon_size),
                    indicators: flag("show-indicators", d.indicators),
                    magnification: flag("magnification", d.magnification),
                    max_icon_size: int("max-icon-size", d.max_icon_size),
                    auto_hide: flag("auto-hide", d.auto_hide),
                    hide_delay: int("hide-delay", d.hide_delay_ms),
                    reduce_transparency: appearance
                        .as_ref()
                        .is_some_and(|s| s.boolean("reduce-transparency")),
                })
            }
        };
        let emit = std::rc::Rc::new(emit);
        let get = std::rc::Rc::new(get);
        emit(get());
        let watched = [
            (
                dock,
                &[
                    "position",
                    "icon-size",
                    "show-indicators",
                    "magnification",
                    "max-icon-size",
                    "auto-hide",
                    "hide-delay",
                ][..],
            ),
            (appearance, &["reduce-transparency"][..]),
        ];
        for (s, keys) in watched.iter() {
            if let Some(s) = s {
                let (emit, get, keys) = (emit.clone(), get.clone(), keys.to_vec());
                s.connect_changed(None, move |_, key| {
                    if keys.contains(&key) {
                        emit(get());
                    }
                });
            }
        }
        glib::MainLoop::new(Some(&ctx), false).run();
        drop(watched);
    });
}

/// One Config1 Apply of a dock key. Its answer is the committed value, which the
/// GSettings watcher above then reports: the menu never shows a value Config1 did not take.
pub fn apply(
    conn: &zbus::blocking::Connection,
    key: &str,
    value: &crate::menu::PrefValue,
) -> Result<(), String> {
    use zbus::zvariant::Value;
    let value = match value {
        crate::menu::PrefValue::Bool(b) => Value::from(*b),
        crate::menu::PrefValue::Text(t) => Value::from(*t),
        crate::menu::PrefValue::Number(n) => Value::from(*n),
    };
    conn.call_method(
        Some("org.nidara.Config"),
        "/org/nidara/Config",
        Some("org.nidara.Config1"),
        "Apply",
        &(key, value),
    )
    .map(|_| ())
    .map_err(|e| format!("Config1 Apply {key}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stored(position: &str, icon_size: i32) -> Stored {
        Stored {
            position: position.into(),
            icon_size,
            indicators: true,
            magnification: true,
            max_icon_size: 128,
            auto_hide: false,
            hide_delay: 500,
            reduce_transparency: true,
        }
    }
    #[test]
    fn stored_values_are_read_inside_the_schema_bounds() {
        assert_eq!(
            read(&stored("left", 64)),
            Prefs {
                position: Position::Left,
                reduce_transparency: true,
                ..Prefs::default()
            }
        );
        assert_eq!(read(&stored("top", 200)).position, Position::Bottom);
        assert_eq!(read(&stored("right", 200)).icon_size, 96);
        assert_eq!(read(&stored("bottom", 8)).icon_size, 32);
        let mut s = stored("bottom", 64);
        (s.max_icon_size, s.hide_delay) = (300, -5);
        assert_eq!((read(&s).max_icon_size, read(&s).hide_delay_ms), (128, 0));
    }
}
