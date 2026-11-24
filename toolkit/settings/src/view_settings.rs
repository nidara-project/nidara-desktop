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
use nk::{Activated, AppWindow, BACK, FORWARD, Ink, Node, Padding, Space, Type, Weight};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

/// A page with a module of its own here rather than rows from the manifest.
fn own(page: &Page) -> bool {
    page.builder.as_deref() == Some("about")
        || page.id == "region"
        || page.id == "appearance"
        || page.id == crate::bar::PAGE
        || page.id == crate::display::view::ID
}
/// A subpage of a page (Top bar → Clock): shown like a page, under its parent's entry.
fn parent_of(id: &str) -> Option<&'static str> {
    (id == crate::bar::CLOCK_PAGE).then_some(crate::bar::PAGE)
}
/// Whether the history may hold `id`: a page this window draws, or a subpage of one.
fn shown_here(id: &str, e: &Exports, session: &Session) -> bool {
    let id = parent_of(id).unwrap_or(id);
    e.page(id).is_some_and(|p| listed(p, session))
}
/// Whether this window draws `page`: its own module, or every row of it ordinary.
pub fn listed(page: &Page, session: &Session) -> bool {
    own(page) || ordinary(page, session)
}
/// All-or-nothing, recursively: a mixed page cannot silently lose a custom item.
pub fn ordinary(page: &Page, session: &Session) -> bool {
    fn supported(candidate: &Item, s: &Session) -> bool {
        match candidate {
            Item::Key { key, .. } => s.store().and_then(|s| s.key(key)).is_some_and(|k| {
                matches!(
                    k.entry["ui"]["control"].as_str(),
                    Some("toggle" | "segmented" | "preset" | "slider" | "dropdown" | "listbox")
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
    pub about: crate::about::About,
    pub region: crate::region::Region,
    pub display: crate::display::view::Display,
    /// A font row pressed: its key and current choice, for the window to open the dialog.
    font_request: Option<(String, nk::FontChoice)>,
    /// Top bar's pictures, decoded once per file.
    pub bar_pictures: crate::bar::Pictures,
    /// "Change icon" pressed: the window opens the file chooser.
    icon_request: bool,
    /// The Clock subpage's preview as last drawn.
    clock_text: String,
}
impl Model {
    /// The font row pressed since last asked: its key and its current choice.
    pub fn take_font_request(&mut self) -> Option<(String, nk::FontChoice)> {
        self.font_request.take()
    }
    /// The font dialog's answer for `key`: written when it is a different font.
    pub fn font_chosen(
        &mut self,
        key: &str,
        choice: &nk::FontChoice,
        editor: &mut dyn Editor,
        e: &Exports,
    ) -> Result<(), String> {
        if !crate::appearance::KEYS.contains(&key) || !self.editable(key, editor.session(), e) {
            return Ok(());
        }
        let value = crate::appearance::font_value(choice)?;
        let now = editor.session().shown(key).and_then(Value::as_text);
        let same = now.and_then(|n| nk_platform::font_description::Description::parse(n).ok())
            == nk_platform::font_description::Description::parse(&value).ok();
        if !same {
            self.send(key, Value::Text(value), editor, e)?;
        }
        Ok(())
    }
    /// "Change icon" pressed since last asked.
    pub fn take_icon_request(&mut self) -> bool {
        std::mem::take(&mut self.icon_request)
    }
    /// The file chosen for the system menu's icon.
    pub fn icon_chosen(
        &mut self,
        path: &std::path::Path,
        editor: &mut dyn Editor,
        e: &Exports,
    ) -> Result<(), String> {
        let key = "bar.launcherIcon";
        if !self.editable(key, editor.session(), e) {
            return Ok(());
        }
        let path = path.to_string_lossy().into_owned();
        self.bar_pictures.forget(&path);
        self.send(key, Value::Text(path), editor, e)
    }
    /// On the Clock subpage, whether its preview reads differently now.
    pub fn tick(&mut self, session: &Session) -> bool {
        if self.selected() != Some(crate::bar::CLOCK_PAGE) {
            return false;
        }
        let text = crate::bar::preview(&crate::bar::region(session), crate::bar::now());
        let changed = text != self.clock_text;
        self.clock_text = text;
        changed
    }
    pub fn display_action(&mut self, action: &Activated, held: bool, host: &AppWindow) -> bool {
        if self.selected() != Some(crate::display::view::ID) {
            return false;
        }
        let (size, inset) = crate::display::view::diagram_metrics(host);
        self.display.activate(action, held, size, inset)
    }

    pub fn take_display_focus(&mut self) -> Option<&'static str> {
        self.display
            .take_revert_focus()
            .then_some(crate::display::view::REVERT_GROUP)
    }

    pub fn selected(&self) -> Option<&str> {
        self.history.get(self.at).map(String::as_str)
    }
    pub fn reconcile(&mut self, exports: &Exports, session: &Session) {
        let eligible = |id: &str| shown_here(id, exports, session);
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
                .find(|p| listed(p, session))
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
            // A page's worker has yet to answer: look again soon.
            .min(if self.about.waiting() || self.region.waiting() {
                200
            } else {
                u32::MAX
            })
            // The Clock subpage's preview ticks with the clock.
            .min(if self.selected() == Some(crate::bar::CLOCK_PAGE) {
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.subsec_millis());
                1000 - ms
            } else {
                u32::MAX
            })
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
            if shown_here(page, e, editor.session()) && self.selected() != Some(page) {
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
            if let Some(nk::Value::Bool(open)) = a.value {
                self.open.insert(key.into(), open);
            }
            return Ok(false);
        }
        if let Some(action) = a.action.strip_prefix("appearance:") {
            let session = editor.session();
            let effect = match (action, a.value) {
                ("accent", Some(nk::Value::Index(i))) => session
                    .store()
                    .and_then(|s| s.key("appearance.accent"))
                    .and_then(|k| k.entry["values"][i].as_str().map(str::to_owned))
                    .map(|v| ("appearance.accent".to_owned(), Value::Text(v))),
                (time, Some(nk::Value::Text(t))) if time.starts_with("time:") => {
                    let key = &time["time:".len()..];
                    crate::appearance::KEYS
                        .contains(&key)
                        .then(|| (key.to_owned(), Value::Text(t)))
                }
                (font, _) if font.starts_with("font:") => {
                    let key = &font["font:".len()..];
                    if crate::appearance::KEYS.contains(&key) && self.editable(key, session, e) {
                        let raw = session
                            .shown(key)
                            .and_then(Value::as_text)
                            .unwrap_or_default();
                        let choice = crate::appearance::font_choice(raw)
                            .unwrap_or_else(|| nk::FontChoice::new(raw, nk::FontSize::Points(11.)));
                        self.font_request = Some((key.to_owned(), choice));
                    }
                    None
                }
                _ => None,
            };
            if let Some((key, value)) = effect
                && self.editable(&key, editor.session(), e)
            {
                self.send(&key, value, editor, e)?;
            }
            return Ok(false);
        }
        if let Some(action) = a.action.strip_prefix("bar:") {
            match crate::bar::act(action, a.value, editor.session()) {
                crate::bar::Effect::Apply(key, value)
                    if self.editable(key, editor.session(), e) =>
                {
                    self.send(key, value, editor, e)?
                }
                crate::bar::Effect::ChooseIcon
                    if self.editable("bar.launcherIcon", editor.session(), e) =>
                {
                    self.icon_request = true
                }
                _ => {}
            }
            return Ok(false);
        }
        if let Some(action) = a.action.strip_prefix("region:") {
            if let crate::region::Effect::Apply(key, value) =
                self.region.act(action, a.value, editor.session())
                && self.editable(key, editor.session(), e)
            {
                self.send(key, value, editor, e)?;
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
            "segmented" | "preset" | "dropdown" | "listbox" => {
                let mut choices = choices(&key, entry, kind, editor.session().shown(&key))?;
                let index = match a.value {
                    Some(nk::Value::Index(i)) => i,
                    _ => return Ok(false),
                };
                if index >= choices.len() {
                    return Ok(false);
                }
                choices.remove(index).1
            }
            "slider" => {
                let Some(n) = a.value.as_ref().and_then(nk::Value::number) else {
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
            && (self.selected() == Some(crate::bar::CLOCK_PAGE)
                && crate::bar::CLOCK_KEYS.contains(&key)
                || self.selected().and_then(|id| e.page(id)).is_some_and(|p| {
                    // A page module writes the keys it names, and no other.
                    (p.id == "region" && crate::region::KEYS.contains(&key))
                        || (p.id == crate::bar::PAGE && crate::bar::KEYS.contains(&key))
                        || (p.id == "appearance" && crate::appearance::KEYS.contains(&key))
                        || p.groups.iter().enumerate().any(|(i, g)| {
                            // Appearance leaves its wallpaper out (#1146): not drawn, not written.
                            !(p.id == "appearance"
                                && g.i18n.as_deref() == Some(crate::appearance::WALLPAPER_GROUP))
                                && allowed(&g.items, key, s, &self.open, &format!("{}/{i}", p.id))
                        })
                }))
    }
    pub fn page(
        &self,
        host: &AppWindow,
        session: &Session,
        e: &Exports,
    ) -> Result<nk::Page, String> {
        let types = &host.look().types;
        let body = || types.style(Type::Body, Weight::Regular);
        let small = || types.style(Type::Small, Weight::Regular);
        let sidebar = e
            .pages
            .iter()
            .filter(|p| listed(p, session))
            .map(|p| {
                Ok::<_, String>(
                    nk::SidebarEntry::new(
                        format!("page/{}", p.id),
                        e.text(&p.label)?.to_owned(),
                        p.icon
                            .as_deref()
                            .unwrap_or("nd-settings")
                            .trim_end_matches("-symbolic"),
                        format!("page:{}", p.id),
                        body(),
                        host.look().frame.icon,
                    )
                    .selected(
                        self.selected().map(|id| parent_of(id).unwrap_or(id))
                            == Some(p.id.as_str()),
                    ),
                )
            })
            .collect::<Result<Vec<_>, String>>()?;
        let page = self.selected().and_then(|id| e.page(id));
        let sub = self.selected().filter(|id| parent_of(id).is_some());
        let mut content: Vec<Node> = Vec::new();
        if let Some(status) = &self.status {
            content.push(nk::Label::new("settings-status", status, body()).into());
        }
        let group = |content: &mut Vec<Node>, id: &str, title: &str, rows: Vec<Node>| {
            content.push(
                nk::Label::new(
                    format!("{id}/title"),
                    title,
                    types.style(Type::Body, Weight::Medium),
                )
                .into(),
            );
            content.push(
                nk::Group::new(
                    format!("{id}/group"),
                    nk::Column::new(format!("{id}/rows"), rows),
                )
                .into(),
            );
        };
        if page.is_some_and(|p| p.id == crate::display::view::ID) {
            content.extend(self.display.rows(host, e)?);
        } else if sub == Some(crate::bar::CLOCK_PAGE) {
            let r = crate::bar::region(session);
            content.push(crate::bar::preview_rows(
                &crate::bar::preview(&r, crate::bar::now()),
                types,
                e,
            )?);
            let key = |k: &str| Item::Key {
                key: k.into(),
                visible_when: None,
                sensitive_when: None,
            };
            for (id, title, keys) in [
                (
                    "bar/clock/date",
                    "settings.region.date.group",
                    &["region.dateFormat"][..],
                ),
                (
                    "bar/clock/time",
                    "settings.region.time.group",
                    &["region.timeFormat", "region.showSeconds"][..],
                ),
            ] {
                let items: Vec<Item> = keys.iter().map(|k| key(k)).collect();
                let rows = self.items(&items, id, host, session, e)?;
                if !rows.is_empty() {
                    group(&mut content, id, e.text(title)?, rows);
                }
            }
        } else if page.is_some_and(|p| p.id == crate::bar::PAGE) {
            let shown = |key: &str| {
                self.held
                    .get(key)
                    .map(|h| h.value.clone())
                    .or_else(|| session.shown(key).cloned())
            };
            let error = |key: &str| self.errors.get(key).cloned();
            let rows = crate::bar::Rows {
                types,
                session,
                exports: e,
                shown: &shown,
                error: &error,
            };
            group(
                &mut content,
                "bar/items",
                e.text("settings.bar.group.items")?,
                rows.items()?,
            );
            let apps = rows.apps()?;
            if !apps.is_empty() {
                group(
                    &mut content,
                    "bar/apps",
                    e.text("settings.bar.group.apps")?,
                    apps,
                );
            }
        } else if let Some(p) = page.filter(|p| p.id == "region") {
            content.extend(self.region.timezone(e, types, session)?);
            let format = Item::Key {
                key: crate::region::FORMAT.into(),
                visible_when: None,
                sensitive_when: None,
            };
            let mut rows = vec![self.region.language(e, types)?];
            rows.extend(self.items(
                std::slice::from_ref(&format),
                &format!("{}/format", p.id),
                host,
                session,
                e,
            )?);
            content.push(
                nk::Label::new(
                    "region/locale/title",
                    e.text("settings.region.locale.group")?,
                    types.style(Type::Body, Weight::Medium),
                )
                .into(),
            );
            content.push(
                nk::Group::new(
                    "region/locale/group",
                    nk::Column::new("region/locale/rows", rows),
                )
                .into(),
            );
        } else if let Some(p) = page.filter(|p| p.id == "appearance") {
            for (i, g) in p.groups.iter().enumerate() {
                if g.i18n.as_deref() == Some(crate::appearance::WALLPAPER_GROUP) {
                    continue;
                }
                let id = format!("{}/{i}", p.id);
                let mut rows = vec![];
                for (n, item) in g.items.iter().enumerate() {
                    if item.visible_when().is_some_and(|w| !w.holds(session)) {
                        continue;
                    }
                    let shown = |key: &str| {
                        self.held
                            .get(key)
                            .map(|h| h.value.clone())
                            .or_else(|| session.shown(key).cloned())
                    };
                    let error = |key: &str| self.errors.get(key).cloned();
                    let row = crate::appearance::Row {
                        id: format!("{id}/{n}"),
                        types,
                        session,
                        exports: e,
                        shown: &shown,
                        error: &error,
                    };
                    match item {
                        Item::Custom { name, i18n, .. } if name == "accentPicker" => {
                            rows.extend(row.accent(item, i18n.as_deref().unwrap_or_default())?)
                        }
                        Item::Custom { name, i18n, .. } => rows.extend(row.font(
                            item,
                            name,
                            i18n.as_deref().unwrap_or_default(),
                        )?),
                        Item::Decoration { name, .. } if name == "nightScheduleTimes" => {
                            rows.extend(row.schedule(item)?)
                        }
                        Item::Decoration { name, .. } => {
                            return Err(format!("appearance: no decoration {name}"));
                        }
                        _ => rows.extend(self.items(
                            std::slice::from_ref(item),
                            &format!("{id}/{n}"),
                            host,
                            session,
                            e,
                        )?),
                    }
                }
                if rows.is_empty() {
                    continue;
                }
                if let Some(label) = g.i18n.as_ref().filter(|label| !label.is_empty()) {
                    content.push(
                        nk::Label::new(
                            format!("{id}/title"),
                            e.text(label)?,
                            types.style(Type::Body, Weight::Medium),
                        )
                        .into(),
                    );
                }
                content.push(
                    nk::Group::new(
                        format!("{id}/group"),
                        nk::Column::new(format!("{id}/rows"), rows),
                    )
                    .into(),
                );
            }
        } else if page.is_some_and(own) {
            content.extend(self.about.content(e, types)?);
        } else if let Some(p) = page {
            for (i, g) in p.groups.iter().enumerate() {
                let id = format!("{}/{i}", p.id);
                if let Some(label) = g.i18n.as_ref().filter(|label| !label.is_empty()) {
                    content.push(
                        nk::Label::new(
                            format!("{id}/title"),
                            e.text(label)?,
                            types.style(Type::Body, Weight::Medium),
                        )
                        .into(),
                    );
                }
                content.push(
                    nk::Group::new(
                        format!("{id}/group"),
                        nk::Column::new(
                            format!("{id}/rows"),
                            self.items(&g.items, &id, host, session, e)?,
                        ),
                    )
                    .into(),
                );
                if let Some(footer) = g
                    .footer
                    .as_ref()
                    .filter(|_| g.footer_when.as_ref().is_none_or(|p| p.holds(session)))
                {
                    content.push(
                        nk::Label::new(format!("{id}/footer"), e.text(footer)?, small())
                            .ink(Ink::Dim)
                            .into(),
                    );
                }
            }
        } else {
            content.push(
                nk::Label::new(
                    "loading",
                    e.text(if session.store().is_none() {
                        "settings.native.loading"
                    } else {
                        "settings.native.unavailable"
                    })?,
                    body(),
                )
                .into(),
            );
        }
        Ok(nk::Page {
            sidebar: nk::SidebarList::new("settings-sidebar")
                .entries(sidebar)
                .into(),
            content: nk::Column::new("settings-content", content)
                .gap(Space::S3)
                .padding(Padding::all(Space::S3))
                .into(),
            title: if sub == Some(crate::bar::CLOCK_PAGE) {
                Some(e.text("settings.bar.item.clock")?)
            } else {
                page.map(|p| e.text(&p.label)).transpose()?
            }
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
                    nk::Expander::new(
                        id.clone(),
                        e.text(i18n)?.to_owned(),
                        format!("disclosure:{id}"),
                        self.open.get(&id).copied().unwrap_or(true),
                    )
                    .child(nk::Column::new(
                        format!("{id}/items"),
                        self.items(items, &id, host, s, e)?,
                    ))
                    .into(),
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
                    if kind == "listbox" {
                        let choices = choices(key, &entry.entry, kind, shown)?;
                        let selected = choices.iter().position(|(_, v)| Some(v) == shown);
                        let options = choices
                            .into_iter()
                            .enumerate()
                            .map(|(i, (label, _))| {
                                let option = nk::ListBoxOption::new(label);
                                match ui["options"][i]["icon"].as_str() {
                                    Some(icon) => option.icon(icon),
                                    None => option,
                                }
                            })
                            .collect();
                        nodes.push(
                            nk::ListBox::new(
                                name,
                                title,
                                action,
                                options,
                                types.style(Type::Body, Weight::Regular),
                            )
                            .selected(selected)
                            .enabled(!disabled)
                            .into(),
                        );
                        if let Some(subtitle) = subtitle {
                            nodes.push(
                                nk::Label::new(
                                    format!("{id}/subtitle"),
                                    subtitle,
                                    types.style(Type::Small, Weight::Regular),
                                )
                                .ink(Ink::Dim)
                                .into(),
                            );
                        }
                        continue;
                    }
                    // What a reader says after the control's name: its row's second line.
                    let said = subtitle.unwrap_or_default();
                    let control: Node = match kind {
                        "toggle" => nk::Switch::new(
                            name,
                            title,
                            action,
                            shown.and_then(Value::as_bool).unwrap_or(false),
                        )
                        .enabled(!disabled)
                        .description(said)
                        .into(),
                        "segmented" | "preset" | "dropdown" => {
                            let choices = choices(key, &entry.entry, kind, shown)?;
                            let chosen = choices
                                .iter()
                                .position(|(_, v)| Some(v) == shown)
                                .unwrap_or(0);
                            let options = choices.into_iter().map(|(label, _)| label).collect();
                            if kind == "dropdown" {
                                nk::DropDown::new(name, title, action, options, chosen)
                                    .enabled(!disabled)
                                    .description(said)
                                    .into()
                            } else {
                                nk::Segmented::new(name, title, action, options, chosen)
                                    .enabled(!disabled)
                                    .into()
                            }
                        }
                        "slider" => {
                            let spec = row_values::slider(key, &entry.entry)?;
                            let mut slider = nk::SliderRange::new(
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
                            let end = nk::SliderEnd::new(
                                name,
                                title,
                                action,
                                slider,
                                types.style(Type::Small, Weight::Regular),
                            )
                            .enabled(!disabled);
                            match icons {
                                Some(icons) => end.icons(icons).into(),
                                None => end.into(),
                            }
                        }
                        _ => return Err(format!("{key}: unsupported ordinary row")),
                    };
                    let mut row =
                        nk::ListRow::new(id, title, types.style(Type::Body, Weight::Regular))
                            .trailing(control)
                            .enabled(!disabled);
                    if let Some(subtitle) = subtitle {
                        row = row.subtitle(subtitle, types.style(Type::Small, Weight::Regular));
                    }
                    nodes.push(row.into());
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
    let current = shown.map(Value::predicate_text).unwrap_or_default();
    let mut options: Vec<(String, Value)> = if kind == "dropdown" {
        row_values::dropdown_options(entry, &current)?
            .into_iter()
            .map(|(value, label)| (label, Value::Text(value)))
            .collect()
    } else {
        row_values::choice_options(key, entry, kind)?
    };
    // A number key's options are written as text in the schema: compare and apply numbers.
    if entry["type"] == "number" {
        for (_, v) in &mut options {
            if let Value::Text(t) = v
                && let Ok(n) = t.parse::<f64>()
            {
                *v = Value::Number(n);
            }
        }
    }

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
