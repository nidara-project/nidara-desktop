// SPDX-License-Identifier: LGPL-3.0-or-later
//! The manifest, typed: the pages, their groups and their items, as
//! `scripts/export-settings-data.mjs` writes them from `ui/settings/manifest.ts` (PHASE1.md
//! D2, D4). The page is the manifest; this file reads it and decides nothing about drawing.
//!
//! A shape this build does not know is an error, not something skipped: an allowlisted page
//! drawn without one of its items is the parity failure gate 1 exists to catch.

use crate::session::Session;
use serde_json::Value as Json;

#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub id: String,
    pub kind: String,
    /// An i18n key.
    pub label: String,
    pub subtitle: Option<String>,
    pub icon: Option<String>,
    /// A subpage's page.
    pub parent: Option<String>,
    /// The sidebar starts a new block at this page.
    pub group_start: bool,
    /// Empty for a page drawn by a builder of its own (`builder`): not a manifest page.
    pub groups: Vec<Group>,
    pub builder: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    /// The header, an i18n key.
    pub i18n: Option<String>,
    pub items: Vec<Item>,
    /// A group drawn whole by a named builder (`custom` at group level).
    pub custom: Option<String>,
    /// An i18n key, shown under the group while `footer_when` holds (always, without one).
    pub footer: Option<String>,
    pub footer_when: Option<Predicate>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// A registry key drawn by the control its schema names (`ui.control`).
    Key {
        key: String,
        visible_when: Option<Predicate>,
        sensitive_when: Option<Predicate>,
    },
    /// A control drawn by a named builder, labelled by `i18n`, editing `key` when it has one.
    Custom {
        name: String,
        i18n: Option<String>,
        key: Option<String>,
        visible_when: Option<Predicate>,
    },
    /// Something drawn that is not a control (the wallpaper preview, the schedule times row's
    /// frame) by a named builder.
    Decoration {
        name: String,
        visible_when: Option<Predicate>,
    },
}

impl Item {
    pub fn visible_when(&self) -> Option<&Predicate> {
        match self {
            Self::Key { visible_when, .. }
            | Self::Custom { visible_when, .. }
            | Self::Decoration { visible_when, .. } => visible_when.as_ref(),
        }
    }

    pub fn sensitive_when(&self) -> Option<&Predicate> {
        match self {
            Self::Key { sensitive_when, .. } => sensitive_when.as_ref(),
            _ => None,
        }
    }

    /// The registry key this item shows, if any.
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::Key { key, .. } => Some(key),
            Self::Custom { key, .. } => key.as_deref(),
            Self::Decoration { .. } => None,
        }
    }
}

/// `{key, in: [...]}`: holds while the key's value, as JavaScript's `String()` writes it, is
/// one of the texts.
#[derive(Clone, Debug, PartialEq)]
pub struct Predicate {
    pub key: String,
    pub any_of: Vec<String>,
}

impl Predicate {
    /// Against what the controls show (a value asked and not yet answered counts: a row
    /// that depends on a switch follows the switch as it is flipped). A key with no value
    /// does not hold.
    pub fn holds(&self, session: &Session) -> bool {
        session
            .shown(&self.key)
            .is_some_and(|v| self.any_of.contains(&v.predicate_text()))
    }

    fn parse(v: &Json, at: &str) -> Result<Self, String> {
        let key = text(&v["key"], at)?;
        let any_of = v["in"]
            .as_array()
            .ok_or_else(|| format!("{at}: predicate without `in`"))?
            .iter()
            .map(|t| text(t, at))
            .collect::<Result<_, _>>()?;
        known(v, &["key", "in"], at)?;
        Ok(Self { key, any_of })
    }
}

pub fn parse(manifest: &Json) -> Result<Vec<Page>, String> {
    manifest
        .as_array()
        .ok_or("manifest is not a list of pages")?
        .iter()
        .map(page)
        .collect()
}

fn page(v: &Json) -> Result<Page, String> {
    let id = text(&v["id"], "page")?;
    let at = format!("page {id}");
    known(
        v,
        &[
            "id",
            "kind",
            "label",
            "subtitle",
            "icon",
            "parent",
            "groupStart",
            "groups",
            "builder",
            "reason",
        ],
        &at,
    )?;
    let groups = match v.get("groups") {
        Some(g) => g
            .as_array()
            .ok_or_else(|| format!("{at}: groups is not a list"))?
            .iter()
            .enumerate()
            .map(|(i, g)| group(g, &format!("{at} group {i}")))
            .collect::<Result<_, _>>()?,
        None => Vec::new(),
    };
    Ok(Page {
        kind: text(&v["kind"], &at)?,
        label: text(&v["label"], &at)?,
        subtitle: optional(&v["subtitle"], &at)?,
        icon: optional(&v["icon"], &at)?,
        parent: optional(&v["parent"], &at)?,
        group_start: v["groupStart"].as_bool().unwrap_or(false),
        builder: optional(&v["builder"], &at)?,
        groups,
        id,
    })
}

fn group(v: &Json, at: &str) -> Result<Group, String> {
    known(
        v,
        &[
            "i18n",
            "items",
            "custom",
            "footer",
            "footerWhen",
            "note",
            "reaches",
        ],
        at,
    )?;
    let items = match v.get("items") {
        Some(items) => items
            .as_array()
            .ok_or_else(|| format!("{at}: items is not a list"))?
            .iter()
            .enumerate()
            .map(|(i, it)| item(it, &format!("{at} item {i}")))
            .collect::<Result<_, _>>()?,
        None => Vec::new(),
    };
    Ok(Group {
        i18n: optional(&v["i18n"], at)?,
        custom: optional(&v["custom"], at)?,
        footer: optional(&v["footer"], at)?,
        footer_when: predicate(&v["footerWhen"], at)?,
        items,
    })
}

fn item(v: &Json, at: &str) -> Result<Item, String> {
    if let Some(key) = v.as_str() {
        return Ok(Item::Key {
            key: key.to_owned(),
            visible_when: None,
            sensitive_when: None,
        });
    }
    // `note` is the manifest's documentation for people; it is exported and never drawn.
    if let Some(name) = v.get("custom") {
        known(v, &["custom", "i18n", "key", "visibleWhen", "note"], at)?;
        return Ok(Item::Custom {
            name: text(name, at)?,
            i18n: optional(&v["i18n"], at)?,
            key: optional(&v["key"], at)?,
            visible_when: predicate(&v["visibleWhen"], at)?,
        });
    }
    if let Some(name) = v.get("decoration") {
        known(v, &["decoration", "visibleWhen", "note"], at)?;
        return Ok(Item::Decoration {
            name: text(name, at)?,
            visible_when: predicate(&v["visibleWhen"], at)?,
        });
    }
    if let Some(key) = v.get("key") {
        known(v, &["key", "visibleWhen", "sensitiveWhen", "note"], at)?;
        return Ok(Item::Key {
            key: text(key, at)?,
            visible_when: predicate(&v["visibleWhen"], at)?,
            sensitive_when: predicate(&v["sensitiveWhen"], at)?,
        });
    }
    Err(format!("{at}: an item of no known shape: {v}"))
}

fn predicate(v: &Json, at: &str) -> Result<Option<Predicate>, String> {
    if v.is_null() {
        return Ok(None);
    }
    Predicate::parse(v, at).map(Some)
}

fn text(v: &Json, at: &str) -> Result<String, String> {
    v.as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{at}: expected a string, found {v}"))
}

fn optional(v: &Json, at: &str) -> Result<Option<String>, String> {
    if v.is_null() {
        return Ok(None);
    }
    text(v, at).map(Some)
}

fn known(v: &Json, fields: &[&str], at: &str) -> Result<(), String> {
    let Some(object) = v.as_object() else {
        return Err(format!("{at}: expected an object, found {v}"));
    };
    match object.keys().find(|k| !fields.contains(&k.as_str())) {
        Some(k) => Err(format!("{at}: a field this build does not read: `{k}`")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Raw;
    use serde_json::json;

    #[test]
    fn reads_the_appearance_shapes() {
        let pages = parse(&json!([{
            "id": "appearance", "kind": "preference", "label": "settings.appearance.title",
            "icon": "nd-preferences-desktop-theme", "groupStart": true,
            "groups": [
                {"i18n": "g.base", "items": ["appearance.darkMode"]},
                {"i18n": "g.windows", "footer": "g.windows.footer",
                 "footerWhen": {"key": "appearance.darkMode", "in": ["true"]},
                 "items": [
                    {"key": "appearance.windowBackground", "note": "people only",
                     "sensitiveWhen": {"key": "accessibility.reduceTransparency", "in": ["false"]}},
                    {"custom": "accentPicker", "i18n": "a", "key": "appearance.accent"},
                    {"decoration": "nightScheduleTimes",
                     "visibleWhen": {"key": "nightlight.scheduleEnabled", "in": ["true"]}},
                 ]},
            ],
        }]))
        .unwrap();
        let g = &pages[0].groups[1];
        assert_eq!(g.footer_when.as_ref().unwrap().any_of, ["true"]);
        assert_eq!(
            g.items[0].sensitive_when().unwrap().key,
            "accessibility.reduceTransparency"
        );
        assert_eq!(g.items[1].key(), Some("appearance.accent"));
        assert!(
            matches!(&g.items[2], Item::Decoration { name, .. } if name == "nightScheduleTimes")
        );
    }

    #[test]
    fn an_unknown_shape_is_an_error() {
        let page = |item: Json| {
            json!([{"id": "p", "kind": "preference", "label": "l",
                                        "groups": [{"items": [item]}]}])
        };
        assert!(parse(&page(json!({"key": "k", "hiddenWhen": {}}))).is_err());
        assert!(parse(&page(json!({"slider": "k"}))).is_err());
        assert!(parse(&page(json!({"key": "k", "visibleWhen": {"key": "x"}}))).is_err());
    }

    #[test]
    fn a_predicate_follows_what_the_controls_show() {
        let (mut s, _) = Session::start();
        let schema = json!({"schemaVersion": 1, "keys": {
            "nightlight.scheduleEnabled": {"type": "boolean", "value": false, "writable": true},
            "nightlight.temperature": {"type": "number", "value": 4500, "writable": true},
        }});
        s.handle(Raw::Snapshot(Ok((1, 0, schema.to_string()))));
        let on = Predicate {
            key: "nightlight.scheduleEnabled".into(),
            any_of: vec!["true".into()],
        };
        assert!(!on.holds(&s));
        s.apply("nightlight.scheduleEnabled", crate::Value::Bool(true))
            .unwrap();
        assert!(
            on.holds(&s),
            "the predicate waited for the service's answer"
        );
        let k = Predicate {
            key: "nightlight.temperature".into(),
            any_of: vec!["4500".into()],
        };
        assert!(k.holds(&s));
        let missing = Predicate {
            key: "no.such".into(),
            any_of: vec!["".into()],
        };
        assert!(!missing.holds(&s));
    }
}
