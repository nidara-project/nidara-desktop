// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the app paints with: the Settings portal, and only it (PHASE1.md D4 [A8], #534).
//! `Config1` is for editing; a colour never comes from it, nor from a file.
//!
//! Four values pick one of the exported token sets — `org.freedesktop.appearance`
//! `accent-color`/`color-scheme` and `org.nidara.appearance`
//! `reduce-transparency`/`window-background` — plus `reduced-motion`, honoured on its own
//! (D5), and the interface font with the text scale (`org.gnome.desktop.interface`
//! `font-name`/`text-scaling-factor`): run-time inputs of layout, never exported [A8].
//! Subscribed to `SettingChanged` before `ReadAll`; on any change the whole namespace is
//! read again, so a change and the read that already holds it can arrive in either order.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedValue, Value as Variant};

pub const NAMESPACES: [&str; 3] = [
    "org.freedesktop.appearance",
    "org.nidara.appearance",
    "org.gnome.desktop.interface",
];

#[derive(Clone, Debug, PartialEq)]
pub struct Appearance {
    /// sRGB, 0–1, as the portal says it.
    pub accent: [f64; 3],
    pub dark: bool,
    pub reduce_transparency: bool,
    /// `opaque`, `tinted` or `translucent` (D6).
    pub window_background: String,
    pub reduced_motion: bool,
    /// A Pango description, `Family [Style] Size` in points.
    pub font: String,
    /// The text scale (`text-scaling-factor`), > 0.
    pub text_scale: f64,
}

/// `ReadAll`'s answer.
pub type Namespaces = HashMap<String, HashMap<String, OwnedValue>>;

impl Appearance {
    /// From `ReadAll`'s answer. A value missing or of another kind is an error: an unknown
    /// combination is shown as one, never painted as a silent blue/dark (D4).
    pub fn from_portal(all: &Namespaces) -> Result<Self, String> {
        let get = |ns: &str, key: &str| -> Result<&OwnedValue, String> {
            all.get(ns)
                .and_then(|m| m.get(key))
                .ok_or_else(|| format!("the portal has no {ns} {key}"))
        };
        let text = |ns: &str, key: &str| -> Result<String, String> {
            match &**get(ns, key)? {
                Variant::Str(s) => Ok(s.as_str().to_owned()),
                v => Err(format!("{key} of another kind: {v:?}")),
            }
        };
        let accent = match &**get(NAMESPACES[0], "accent-color")? {
            Variant::Structure(s) => match s.fields() {
                [Variant::F64(r), Variant::F64(g), Variant::F64(b)] => [*r, *g, *b],
                f => return Err(format!("accent-color of another shape: {f:?}")),
            },
            v => return Err(format!("accent-color of another shape: {v:?}")),
        };
        let dark = match u32::try_from(get(NAMESPACES[0], "color-scheme")?) {
            Ok(1) => true,
            Ok(2) => false,
            v => return Err(format!("color-scheme {v:?}: neither dark nor light")),
        };
        let reduced_motion = u32::try_from(get(NAMESPACES[0], "reduced-motion")?)
            .map_err(|e| format!("reduced-motion: {e}"))?
            == 1;
        let reduce_transparency = bool::try_from(get(NAMESPACES[1], "reduce-transparency")?)
            .map_err(|e| format!("reduce-transparency: {e}"))?;
        let text_scale = f64::try_from(get(NAMESPACES[2], "text-scaling-factor")?)
            .map_err(|e| format!("text-scaling-factor: {e}"))?;
        if !(text_scale.is_finite() && text_scale > 0.) {
            return Err(format!("text-scaling-factor {text_scale}"));
        }
        Ok(Self {
            accent,
            dark,
            reduce_transparency,
            window_background: text(NAMESPACES[1], "window-background")?,
            reduced_motion,
            font: text(NAMESPACES[2], "font-name")?,
            text_scale,
        })
    }
}

pub struct Portal {
    connection: Connection,
    changed: Receiver<()>,
}

impl Portal {
    /// Subscribes on `connection`; read with [`Portal::read`], and again whenever
    /// [`Portal::changed`] says so.
    pub fn watch(connection: &Connection) -> Result<Self, String> {
        let signals = proxy(connection)?
            .receive_signal("SettingChanged")
            .map_err(|e| format!("portal SettingChanged: {e}"))?;
        let (tx, changed) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("portal-changed".into())
            .spawn(move || {
                for message in signals {
                    let ours = message
                        .body()
                        .deserialize::<(String, String, OwnedValue)>()
                        .is_ok_and(|(ns, _, _)| NAMESPACES.contains(&ns.as_str()));
                    if ours {
                        // One pending re-read covers any number of changes.
                        let _ = tx.try_send(());
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection: connection.clone(),
            changed,
        })
    }

    pub fn read(&self) -> Result<Appearance, String> {
        let all: Namespaces = proxy(&self.connection)?
            .call("ReadAll", &(NAMESPACES.to_vec(),))
            .map_err(|e| format!("portal ReadAll: {e}"))?;
        Appearance::from_portal(&all)
    }

    /// Whether something changed since the last call (then `read` again).
    pub fn changed(&self) -> bool {
        self.changed.try_recv().is_ok()
    }
}

fn proxy(connection: &Connection) -> Result<Proxy<'static>, String> {
    Proxy::new(
        connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Settings",
    )
    .map_err(|e| format!("portal proxy: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::StructureBuilder;

    fn owned(v: Variant<'_>) -> OwnedValue {
        OwnedValue::try_from(v).unwrap()
    }

    fn portal(scheme: u32) -> Namespaces {
        let accent = StructureBuilder::new()
            .add_field(0.0f64)
            .add_field(0.533f64)
            .add_field(1.0f64)
            .build()
            .unwrap();
        let entries = |pairs: Vec<(&str, Variant<'static>)>| {
            pairs
                .into_iter()
                .map(|(k, v)| (k.to_owned(), owned(v)))
                .collect::<HashMap<_, _>>()
        };
        HashMap::from([
            (
                NAMESPACES[0].to_owned(),
                entries(vec![
                    ("accent-color", Variant::from(accent)),
                    ("color-scheme", Variant::from(scheme)),
                    ("reduced-motion", Variant::from(0u32)),
                ]),
            ),
            (
                NAMESPACES[1].to_owned(),
                entries(vec![
                    ("reduce-transparency", Variant::from(false)),
                    ("window-background", Variant::from("tinted")),
                ]),
            ),
            (
                NAMESPACES[2].to_owned(),
                entries(vec![
                    ("font-name", Variant::from("Inter Variable 11")),
                    ("text-scaling-factor", Variant::from(1.25f64)),
                ]),
            ),
        ])
    }

    #[test]
    fn reads_the_values() {
        let a = Appearance::from_portal(&portal(1)).unwrap();
        assert_eq!(a.accent, [0.0, 0.533, 1.0]);
        assert!(a.dark && !a.reduce_transparency && !a.reduced_motion);
        assert_eq!(a.window_background, "tinted");
        assert_eq!((a.font.as_str(), a.text_scale), ("Inter Variable 11", 1.25));
        assert!(!Appearance::from_portal(&portal(2)).unwrap().dark);
    }

    #[test]
    fn no_preference_is_an_error_not_a_default() {
        assert!(Appearance::from_portal(&portal(0)).is_err());
        for (ns, key) in [
            (NAMESPACES[1], "window-background"),
            (NAMESPACES[2], "font-name"),
        ] {
            let mut p = portal(1);
            p.get_mut(ns).unwrap().remove(key);
            assert!(Appearance::from_portal(&p).is_err(), "{key} missing passed");
        }
        let mut p = portal(1);
        p.get_mut(NAMESPACES[2])
            .unwrap()
            .insert("text-scaling-factor".into(), owned(Variant::from(0.0f64)));
        assert!(Appearance::from_portal(&p).is_err());
    }
}
