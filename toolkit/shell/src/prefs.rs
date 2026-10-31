// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's ordinary preferences, read-only (DOCK.md §3): GSettings `org.nidara.dock`
//! on a GLib thread of its own, following its change signals. Config1 becomes the writer
//! in D2; `pinned`/`layout` are never read here (the layout is Applications1's). Reduce
//! transparency is `org.nidara.appearance`'s, read the same way.
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
    /// The glass becomes solid (the tokens' reduce-transparency variant).
    pub reduce_transparency: bool,
}
impl Default for Prefs {
    fn default() -> Self {
        Self {
            position: Position::Bottom,
            icon_size: 64,
            indicators: true,
            reduce_transparency: false,
        }
    }
}

/// The schema's own bounds; an out-of-range stored value is read at its nearest bound.
pub fn read(position: &str, icon_size: i32, indicators: bool, reduce_transparency: bool) -> Prefs {
    Prefs {
        position: Position::parse(position).unwrap_or(Position::Bottom),
        icon_size: icon_size.clamp(32, 96) as u32,
        indicators,
        reduce_transparency,
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
                read(
                    &dock
                        .as_ref()
                        .map_or(String::from("bottom"), |s| s.string("position").into()),
                    dock.as_ref()
                        .map_or(d.icon_size as i32, |s| s.int("icon-size")),
                    dock.as_ref()
                        .map_or(d.indicators, |s| s.boolean("show-indicators")),
                    appearance
                        .as_ref()
                        .is_some_and(|s| s.boolean("reduce-transparency")),
                )
            }
        };
        let emit = std::rc::Rc::new(emit);
        let get = std::rc::Rc::new(get);
        emit(get());
        let watched = [
            (dock, &["position", "icon-size", "show-indicators"][..]),
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_values_are_read_inside_the_schema_bounds() {
        assert_eq!(
            read("left", 64, true, true),
            Prefs {
                position: Position::Left,
                icon_size: 64,
                indicators: true,
                reduce_transparency: true,
            }
        );
        assert_eq!(read("top", 200, false, false).position, Position::Bottom);
        assert_eq!(read("right", 200, false, false).icon_size, 96);
        assert_eq!(read("bottom", 8, false, false).icon_size, 32);
    }
}
