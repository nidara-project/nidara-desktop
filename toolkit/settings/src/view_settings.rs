// SPDX-License-Identifier: LGPL-3.0-or-later
//! The ordinary manifest pages on AppWindow. No old Tree or builder is mounted here.
use crate::{
    Value,
    client::Editor,
    exports::Exports,
    manifest::{Item, Page},
    row_values,
    session::{ApplyError, Notice, Session},
};
use nk_view::{
    Activated, AppWindow, BACK, Dropdown, FORWARD, Ink, Node, Padding, Segmented, SettingRow,
    SidebarEntry, Slider, SliderEnd, Space, Type, Weight,
};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

/// All-or-nothing, recursively: a mixed page cannot silently lose a custom item.
pub fn ordinary(page: &Page, session: &Session) -> bool {
    fn supported(candidate: &Item, s: &Session) -> bool {
        match candidate {
            Item::Key { key, .. } => s.store().and_then(|s| s.key(key)).is_some_and(|k| {
                matches!(
                    k.entry["ui"]["control"].as_str(),
                    Some("toggle" | "segmented" | "preset" | "slider" | "dropdown")
                )
            }),
            Item::Disclosure { items, .. } => items.iter().all(|i| supported(i, s)),
            _ => false,
        }
    }
    page.kind != "browser"
        && page.builder.is_none()
        && page.header.is_none()
        && !page.groups.is_empty()
        && page
            .groups
            .iter()
            .all(|g| g.custom.is_none() && g.items.iter().all(|i| supported(i, session)))
}
struct Held {
    value: Value,
    at: Instant,
    release: bool,
}
#[derive(Default)]
pub struct Model {
    history: Vec<String>,
    at: usize,
    open: BTreeMap<String, bool>,
    errors: BTreeMap<String, String>,
    held: BTreeMap<String, Held>,
    status: Option<String>,
}
impl Model {
    pub fn selected(&self) -> Option<&str> {
        self.history.get(self.at).map(String::as_str)
    }
    pub fn reconcile(&mut self, exports: &Exports, session: &Session) {
        let eligible = |id: &str| exports.page(id).is_some_and(|p| ordinary(p, session));
        if self.selected().is_some_and(eligible) {
            self.at = self
                .history
                .iter()
                .take(self.at)
                .filter(|id| eligible(id))
                .count();
            self.history.retain(|id| eligible(id));
        } else {
            self.history = exports
                .pages
                .iter()
                .find(|p| ordinary(p, session))
                .map(|p| vec![p.id.clone()])
                .unwrap_or_default();
            self.at = 0;
            self.held.clear();
        }
    }
    pub fn notices(&mut self, notices: &[Notice], exports: &Exports) -> Result<(), String> {
        for notice in notices {
            match notice {
                Notice::Ready => {
                    self.held.clear();
                    self.errors.clear();
                    self.status = None;
                }
                Notice::Unavailable => {
                    self.held.clear();
                    self.status = Some(exports.text("settings.native.unavailable")?.to_owned());
                }
                Notice::Changed(keys) => {
                    for key in keys {
                        self.errors.remove(key);
                    }
                }
                Notice::Failed { key, .. } => {
                    self.held.remove(key);
                }
                Notice::Error(message) => {
                    self.held.clear();
                    self.status = Some(message.clone());
                }
            }
        }
        // Session emits Failed followed by Changed to restore the canonical value.
        // Apply failures last so that same-batch Changed cannot erase their message.
        for notice in notices {
            if let Notice::Failed { key, error } = notice {
                self.errors.insert(key.clone(), failure(error, exports)?);
            }
        }
        Ok(())
    }
    pub fn poll_interval_ms(&self, now: Instant, host: u32) -> u32 {
        self.held
            .values()
            .filter(|h| !h.release)
            .map(|h| {
                h.at.saturating_duration_since(now)
                    .as_millis()
                    .min(u128::from(u32::MAX)) as u32
            })
            .fold(host, u32::min)
    }
    fn send(
        &mut self,
        key: &str,
        value: Value,
        editor: &mut dyn Editor,
        e: &Exports,
    ) -> Result<(), String> {
        self.errors.remove(key);
        if let Err(error) = editor.apply(key, value) {
            self.errors.insert(key.into(), failure(&error, e)?);
        }
        Ok(())
    }
    pub fn flush(
        &mut self,
        editor: &mut dyn Editor,
        e: &Exports,
        now: Instant,
    ) -> Result<bool, String> {
        let ready: Vec<_> = self
            .held
            .iter()
            .filter(|(_, h)| !h.release && h.at <= now)
            .map(|(key, _)| key.clone())
            .collect();
        let changed = !ready.is_empty();
        for key in ready {
            let held = self.held.remove(&key).unwrap();
            if self.editable(&key, editor.session(), e) {
                self.send(&key, held.value, editor, e)?;
            }
        }
        Ok(changed)
    }
    /// Pointer press/release is host input, never inferred from timing or a value change.
    pub fn activate(
        &mut self,
        a: Activated,
        pointer_down: bool,
        editor: &mut dyn Editor,
        e: &Exports,
        now: Instant,
    ) -> Result<bool, String> {
        if let Some(page) = a.action.strip_prefix("page:") {
            if e.page(page).is_some_and(|p| ordinary(p, editor.session()))
                && self.selected() != Some(page)
            {
                self.history.truncate(self.at + 1);
                self.history.push(page.into());
                self.at = self.history.len() - 1;
                self.held.clear();
                return Ok(true);
            }
            return Ok(false);
        }
        match a.action.as_str() {
            BACK if self.at > 0 => {
                self.at -= 1;
                self.held.clear();
                return Ok(true);
            }
            FORWARD if self.at + 1 < self.history.len() => {
                self.at += 1;
                self.held.clear();
                return Ok(true);
            }
            _ => {}
        }
        if let Some(key) = a.action.strip_prefix("disclosure:") {
            if let Some(nk_view::Value::Bool(open)) = a.value {
                self.open.insert(key.into(), open);
            }
            return Ok(false);
        }
        let Some(action) = a.action.strip_prefix("set:") else {
            return Ok(false);
        };
        // Segments append :index; keys themselves are matched against the current page,
        // not split on ':' or interpreted as arbitrary Config1 keys.
        let Some(store) = editor.session().store() else {
            return Ok(false);
        };
        let key = store
            .keys()
            .map(|(k, _)| k)
            .find(|k| action == *k || action.strip_prefix(*k).is_some_and(|s| s.starts_with(':')))
            .map(str::to_owned);
        let Some(key) = key.filter(|k| self.editable(k, editor.session(), e)) else {
            return Ok(false);
        };
        let entry = &store.key(&key).unwrap().entry;
        let kind = entry["ui"]["control"].as_str().unwrap_or_default();
        let value = match kind {
            "toggle" => Value::Bool(
                !editor
                    .session()
                    .shown(&key)
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
            "segmented" | "preset" | "dropdown" => {
                let mut choices = choices(&key, entry, kind, editor.session().shown(&key))?;
                let index = match a.value {
                    Some(nk_view::Value::Index(i)) => i,
                    _ => return Ok(false),
                };
                if index >= choices.len() {
                    return Ok(false);
                }
                choices.remove(index).1
            }
            "slider" => {
                let Some(n) = a.value.as_ref().and_then(nk_view::Value::number) else {
                    return Ok(false);
                };
                let spec = row_values::slider(&key, entry)?;
                let release = spec.commit_on_release && pointer_down;
                let delay = if spec.commit_on_release {
                    Duration::ZERO
                } else {
                    spec.debounce
                };
                self.held.insert(
                    key,
                    Held {
                        value: Value::Number(n / f64::from(spec.factor)),
                        at: now + delay,
                        release,
                    },
                );
                return self.flush(editor, e, now).map(|_| false);
            }
            _ => return Ok(false),
        };
        self.send(&key, value, editor, e)?;
        Ok(false)
    }
    fn editable(&self, key: &str, s: &Session, e: &Exports) -> bool {
        fn allowed(
            items: &[Item],
            key: &str,
            s: &Session,
            open: &BTreeMap<String, bool>,
            prefix: &str,
        ) -> bool {
            items.iter().enumerate().any(|(i, item)| match item {
                Item::Key {
                    key: k,
                    visible_when,
                    sensitive_when,
                } => {
                    k == key
                        && visible_when.as_ref().is_none_or(|p| p.holds(s))
                        && sensitive_when.as_ref().is_none_or(|p| p.holds(s))
                }
                Item::Disclosure { items, .. } => {
                    let id = format!("{prefix}/{i}");
                    open.get(&id).copied().unwrap_or(true) && allowed(items, key, s, open, &id)
                }
                _ => false,
            })
        }
        s.available()
            && s.store()
                .and_then(|s| s.key(key))
                .is_some_and(|k| k.available && k.writable())
            && self.selected().and_then(|id| e.page(id)).is_some_and(|p| {
                p.groups
                    .iter()
                    .enumerate()
                    .any(|(i, g)| allowed(&g.items, key, s, &self.open, &format!("{}/{i}", p.id)))
            })
    }
    pub fn page(
        &self,
        host: &AppWindow,
        session: &Session,
        e: &Exports,
    ) -> Result<nk_view::Page, String> {
        let types = &host.look().types;
        let body = || types.style(Type::Body, Weight::Regular);
        let small = || types.style(Type::Small, Weight::Regular);
        let sidebar = e
            .pages
            .iter()
            .filter(|p| ordinary(p, session))
            .map(|p| {
                Ok(Node::sidebar_entry(
                    format!("page/{}", p.id),
                    SidebarEntry {
                        title: e.text(&p.label)?.to_owned(),
                        glyph: p
                            .icon
                            .as_deref()
                            .unwrap_or("nd-settings")
                            .trim_end_matches("-symbolic")
                            .into(),
                        action: format!("page:{}", p.id),
                        selected: self.selected() == Some(p.id.as_str()),
                        style: body(),
                    },
                    host.look().frame.icon,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let page = self.selected().and_then(|id| e.page(id));
        let mut content = Vec::new();
        if let Some(status) = &self.status {
            content.push(Node::text("settings-status", status, body()));
        }
        if let Some(p) = page {
            for (i, g) in p.groups.iter().enumerate() {
                let id = format!("{}/{i}", p.id);
                if let Some(label) = g.i18n.as_ref().filter(|label| !label.is_empty()) {
                    content.push(Node::text(
                        format!("{id}/title"),
                        e.text(label)?,
                        types.style(Type::Body, Weight::Medium),
                    ));
                }
                content.push(Node::group(
                    format!("{id}/group"),
                    Node::column(
                        format!("{id}/rows"),
                        self.items(&g.items, &id, host, session, e)?,
                    ),
                ));
                if let Some(footer) = g
                    .footer
                    .as_ref()
                    .filter(|_| g.footer_when.as_ref().is_none_or(|p| p.holds(session)))
                {
                    content.push(
                        Node::text(format!("{id}/footer"), e.text(footer)?, small()).ink(Ink::Dim),
                    );
                }
            }
        } else {
            content.push(Node::text(
                "loading",
                e.text(if session.store().is_none() {
                    "settings.native.loading"
                } else {
                    "settings.native.unavailable"
                })?,
                body(),
            ));
        }
        Ok(nk_view::Page {
            sidebar: Node::column("settings-sidebar", sidebar),
            content: Node::column("settings-content", content)
                .gap(Space::S3)
                .padding(Padding::all(Space::S3)),
            title: page
                .map(|p| e.text(&p.label))
                .transpose()?
                .unwrap_or(e.text("settings.native.application")?)
                .to_owned(),
            can_back: self.at > 0,
            can_forward: self.at + 1 < self.history.len(),
        })
    }
    fn items(
        &self,
        items: &[Item],
        prefix: &str,
        host: &AppWindow,
        s: &Session,
        e: &Exports,
    ) -> Result<Vec<Node>, String> {
        let mut nodes = Vec::new();
        let types = &host.look().types;
        for (i, item) in items.iter().enumerate() {
            let id = format!("{prefix}/{i}");
            match item {
                Item::Disclosure { i18n, items } => nodes.push(
                    nk_view::components::Disclosure {
                        label: e.text(i18n)?.to_owned(),
                        expanded: self.open.get(&id).copied().unwrap_or(true),
                    }
                    .node(
                        id.clone(),
                        format!("disclosure:{id}"),
                        Node::column(format!("{id}/items"), self.items(items, &id, host, s, e)?),
                    ),
                ),
                Item::Key {
                    key,
                    visible_when,
                    sensitive_when,
                } => {
                    let Some(entry) = s.store().and_then(|s| s.key(key)) else {
                        continue;
                    };
                    if !entry.available || visible_when.as_ref().is_some_and(|p| !p.holds(s)) {
                        continue;
                    }
                    let disabled = !s.available()
                        || !entry.writable()
                        || sensitive_when.as_ref().is_some_and(|p| !p.holds(s));
                    let ui = &entry.entry["ui"];
                    let title = ui["title"]
                        .as_str()
                        .ok_or_else(|| format!("{key}: no title"))?;
                    let subtitle = self
                        .errors
                        .get(key)
                        .map(String::as_str)
                        .or(ui["subtitle"].as_str());
                    let shown = self
                        .held
                        .get(key)
                        .map(|h| &h.value)
                        .or_else(|| s.shown(key));
                    let name = format!("key/{key}");
                    let action = format!("set:{key}");
                    let kind = ui["control"].as_str().unwrap_or_default();
                    let control = match kind {
                        "toggle" => Node::switch_control(
                            name,
                            title,
                            action,
                            shown.and_then(Value::as_bool).unwrap_or(false),
                        )
                        .enabled(!disabled),
                        "segmented" | "preset" | "dropdown" => {
                            let choices = choices(key, &entry.entry, kind, shown)?;
                            let chosen = choices
                                .iter()
                                .position(|(_, v)| Some(v) == shown)
                                .unwrap_or(0);
                            let options = choices.into_iter().map(|(label, _)| label).collect();
                            if kind == "dropdown" {
                                Node::dropdown(
                                    name,
                                    Dropdown {
                                        name: title.into(),
                                        options,
                                        chosen,
                                        action,
                                        disabled,
                                    },
                                )
                            } else {
                                Node::segmented(
                                    name,
                                    Segmented {
                                        name: title.into(),
                                        options,
                                        chosen,
                                        action,
                                        disabled,
                                    },
                                )
                            }
                        }
                        "slider" => {
                            let spec = row_values::slider(key, &entry.entry)?;
                            let mut slider = Slider::new(
                                spec.min.into(),
                                spec.max.into(),
                                spec.step.into(),
                                shown.and_then(Value::as_number).unwrap_or(0.)
                                    * f64::from(spec.factor),
                            );
                            slider.decimals = spec.decimals;
                            slider.unit = spec.unit;
                            let icons = ui["slider"]["icons"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .map(|i| {
                                            i.as_str()
                                                .map(|i| i.trim_end_matches("-symbolic").to_owned())
                                                .ok_or_else(|| format!("{key}: invalid icon"))
                                        })
                                        .collect::<Result<Vec<_>, _>>()
                                })
                                .transpose()?
                                .map(|a| {
                                    a.try_into()
                                        .map_err(|_| format!("{key}: expected two icons"))
                                })
                                .transpose()?;
                            Node::slider_end(
                                name,
                                SliderEnd {
                                    name: title.into(),
                                    action,
                                    slider,
                                    value_style: types.style(Type::Small, Weight::Regular),
                                    icons,
                                    disabled,
                                },
                            )
                        }
                        _ => return Err(format!("{key}: unsupported ordinary row")),
                    };
                    let control = if let Some(subtitle) = subtitle {
                        control.description(subtitle)
                    } else {
                        control
                    };
                    nodes.push(Node::setting_row(
                        id,
                        SettingRow {
                            title: title.into(),
                            subtitle: subtitle.map(str::to_owned),
                            title_style: types.style(Type::Body, Weight::Regular),
                            subtitle_style: types.style(Type::Small, Weight::Regular),
                            trailing: Some(control),
                            disabled,
                            ..Default::default()
                        },
                    ));
                }
                _ => return Err("custom item reached ordinary page".into()),
            }
        }
        Ok(nodes)
    }
}
fn choices(
    key: &str,
    entry: &serde_json::Value,
    kind: &str,
    shown: Option<&Value>,
) -> Result<Vec<(String, Value)>, String> {
    let mut options = if kind == "dropdown" {
        row_values::dropdown_options(entry, shown.and_then(Value::as_text).unwrap_or_default())?
            .into_iter()
            .map(|(value, label)| (label, Value::Text(value)))
            .collect()
    } else {
        row_values::choice_options(key, entry, kind)?
    };

    if let Some(value) = shown
        && !options.iter().any(|(_, v)| v == value)
    {
        options.push((value.predicate_text(), value.clone()));
    }
    Ok(options)
}
fn failure(error: &ApplyError, e: &Exports) -> Result<String, String> {
    match error {
        ApplyError::Invalid(s) | ApplyError::Denied(s) | ApplyError::Failed(s) => Ok(s.clone()),
        ApplyError::NoReply | ApplyError::Unavailable => {
            e.text("settings.native.unavailable").map(str::to_owned)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_failed_reply_keeps_its_error_while_restoring_the_canonical_value() {
        let root = std::env::var_os("NK_SETTINGS_DATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../build/settings-data")
            });
        let exports = Exports::load(&root).unwrap();
        let (mut session, _) = Session::start();
        session.handle(crate::session::Raw::Snapshot(Ok((7,1,serde_json::json!({"schemaVersion":1,"keys":{"switch":{"type":"boolean","value":false,"available":true,"writable":true}}}).to_string()))));
        session.apply("switch", Value::Bool(true)).unwrap();
        let (notices, _) = session.handle(crate::session::Raw::Reply {
            key: "switch".into(),
            epoch: 7,
            result: Err(ApplyError::Invalid("refused".into())),
        });
        let mut model = Model::default();
        model.notices(&notices, &exports).unwrap();
        assert_eq!(session.shown("switch"), Some(&Value::Bool(false)));
        assert_eq!(
            model.errors.get("switch").map(String::as_str),
            Some("refused")
        );
        model
            .notices(&[Notice::Changed(vec!["switch".into()])], &exports)
            .unwrap();
        assert!(!model.errors.contains_key("switch"));
    }
}
