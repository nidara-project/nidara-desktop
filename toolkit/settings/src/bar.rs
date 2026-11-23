// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings → Top bar on `AppWindow` (#1103 step 8e). What belongs to the bar itself, read
//! right to left as it stands from the screen's edge (`ui/shell/surfaces/settings/custom/
//! bar.ts`): the clock, whose Configure opens the Clock subpage; the Control Center, fixed;
//! the window title; the system menu and its icon. Below, the apps' tray icons, each with a
//! switch. Where each control appears (Wi-Fi, volume…) is the Controls page's (#1144,
//! owner 23-11), and there is no search item while the shell has no global search (#1109).
use crate::{Value, exports::Exports, session::Session};
use nk::{Align, Node, Type, TypeScale, Weight};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

/// The keys the Top bar page writes.
pub const KEYS: [&str; 3] = ["bar.appTitle", "bar.launcherIcon", "bar.trayHidden"];
/// The keys its Clock subpage writes.
pub const CLOCK_KEYS: [&str; 3] = [
    "region.dateFormat",
    "region.timeFormat",
    "region.showSeconds",
];
/// The Clock subpage: in the history like a page, shown under Top bar in the sidebar.
pub const CLOCK_PAGE: &str = "bar/clock";
pub const PAGE: &str = "bar";
/// The bar's built-in mark, a symbolic glyph of Settings' own (`Glyphs::add`).
pub const MARK: &str = "nidara-mark";
const MARK_VALUE: &str = "nidara";
/// The types the system menu's icon may be (`bar.launcherIcon`).
pub const ICON_IMAGES: &[&str] = &["image/svg+xml", "image/png", "image/jpeg", "image/webp"];
const ICON: f64 = 18.;
/// Pictures are decoded at twice their size, for a scale-2 output.
const PICTURE_PX: u32 = 36;

/// The mark's drawing, where the shell reads it (`toolkit/shell/src/paths.rs`).
pub fn mark_path() -> PathBuf {
    let installed =
        PathBuf::from("/usr/share/nidara/ui/shell/assets/nidara/assets/nidara-symbolic.svg");
    if installed.is_file() {
        installed
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../ui/shell/assets/nidara/assets/nidara-symbolic.svg")
    }
}

/// A tray icon Settings may list, from `bar.trayHidden`'s `ui.items`.
#[derive(Clone, Debug, PartialEq)]
pub struct TrayApp {
    pub id: String,
    pub title: String,
    /// A theme name, or a file.
    pub icon: String,
}
pub fn tray_apps(session: &Session) -> Vec<TrayApp> {
    let Some(entry) = session
        .store()
        .and_then(|s| s.key("bar.trayHidden"))
        .filter(|k| k.available)
    else {
        return vec![];
    };
    entry.entry["ui"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| {
            let id = i["value"].as_str()?.to_owned();
            Some(TrayApp {
                title: i["title"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .unwrap_or(&id)
                    .to_owned(),
                icon: i["icon"].as_str().unwrap_or_default().to_owned(),
                id,
            })
        })
        .collect()
}
/// The custom system-menu icon, when one is set.
fn custom_icon(shown: Option<&Value>) -> Option<&str> {
    shown
        .and_then(Value::as_text)
        .filter(|v| *v != MARK_VALUE && v.starts_with('/'))
}

/// The page's pictures: the system menu's custom icon and tray icons given as files,
/// decoded once per file. Settings hands them to the window before it draws the page.
#[derive(Default)]
pub struct Pictures {
    decoded: HashMap<String, Option<Arc<nk_render::Raster>>>,
}
impl Pictures {
    fn id(path: &str) -> String {
        format!("bar/picture/{path}")
    }
    /// Every picture the page shows now, by the id its node names.
    pub fn current(&mut self, session: &Session) -> HashMap<String, Arc<nk_render::Raster>> {
        let mut paths: Vec<String> = tray_apps(session)
            .into_iter()
            .map(|a| a.icon)
            .filter(|i| i.starts_with('/'))
            .collect();
        paths.extend(custom_icon(session.shown("bar.launcherIcon")).map(str::to_owned));
        let mut out = HashMap::new();
        for path in paths {
            let raster = self
                .decoded
                .entry(path.clone())
                .or_insert_with(|| {
                    nk_icons::read_app_icon(std::path::Path::new(&path), PICTURE_PX)
                        .and_then(|(w, h, rgba)| {
                            nk_render::Raster::from_rgba(w as u16, h as u16, rgba).ok()
                        })
                        .map(Arc::new)
                })
                .clone();
            if let Some(r) = raster {
                out.insert(Self::id(&path), r);
            }
        }
        out
    }
    /// The file changed under the same path (a new icon saved over the old).
    pub fn forget(&mut self, path: &str) {
        self.decoded.remove(path);
    }
}

/// What a press on the page asks of the window or of Config1.
#[derive(Debug, PartialEq)]
pub enum Effect {
    Apply(&'static str, Value),
    /// Open the file chooser for the system menu's icon.
    ChooseIcon,
    None,
}
/// A page action (`bar:…`) and its value.
pub fn act(action: &str, value: Option<nk::Value>, session: &Session) -> Effect {
    match (action, value) {
        ("appTitle", _) => Effect::Apply(
            "bar.appTitle",
            Value::Bool(
                !session
                    .shown("bar.appTitle")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            ),
        ),
        ("icon:change", _) => Effect::ChooseIcon,
        ("icon:default", _) => Effect::Apply("bar.launcherIcon", Value::Text(MARK_VALUE.into())),
        (tray, _) if tray.starts_with("tray:") => {
            let id = &tray["tray:".len()..];
            let offered = tray_apps(session);
            if !offered.iter().any(|a| a.id == id) {
                return Effect::None;
            }
            let mut hidden: Vec<String> = session
                .shown("bar.trayHidden")
                .and_then(Value::as_list)
                .map(<[String]>::to_vec)
                .unwrap_or_default();
            if let Some(at) = hidden.iter().position(|h| h == id) {
                hidden.remove(at);
            } else {
                hidden.push(id.to_owned());
            }
            // In the order Config1 offers them: the value it answers.
            let hidden = offered
                .into_iter()
                .map(|a| a.id)
                .filter(|a| hidden.contains(a))
                .collect();
            Effect::Apply("bar.trayHidden", Value::List(hidden))
        }
        _ => Effect::None,
    }
}

/// What a page row needs to draw itself.
pub struct Rows<'a> {
    pub types: &'a TypeScale,
    pub session: &'a Session,
    pub exports: &'a Exports,
    /// The value shown: a held one, else the session's.
    pub shown: &'a dyn Fn(&str) -> Option<Value>,
    pub error: &'a dyn Fn(&str) -> Option<String>,
}
impl Rows<'_> {
    fn t(&self, key: &str) -> Result<String, String> {
        self.exports.text(key).map(str::to_owned)
    }
    fn available(&self, key: &str) -> bool {
        self.session
            .store()
            .and_then(|s| s.key(key))
            .is_some_and(|k| k.available)
    }
    fn writable(&self, key: &str) -> bool {
        self.session.available()
            && self
                .session
                .store()
                .and_then(|s| s.key(key))
                .is_some_and(|k| k.available && k.writable())
    }
    fn row(&self, id: &str, title: &str, lead: Node, end: Option<Node>, key: Option<&str>) -> Node {
        let mut row = nk::ListRow::new(
            format!("bar/row/{id}"),
            title,
            self.types.style(Type::Body, Weight::Regular),
        )
        .leading(lead);
        if let Some(end) = end {
            row = row.trailing(end);
        }
        if let Some(line) = key.and_then(|k| (self.error)(k)) {
            row = row.subtitle(line, self.types.style(Type::Small, Weight::Regular));
        }
        row.into()
    }
    fn glyph(&self, id: &str, name: &str) -> Node {
        nk::Image::new(format!("bar/icon/{id}"), name, ICON).into()
    }
    fn button(&self, id: &str, label: String, action: &str, on: bool) -> Node {
        nk::Button::new(
            format!("bar/button/{id}"),
            label,
            action,
            self.types.style(Type::Body, Weight::Regular),
        )
        .enabled(on)
        .into()
    }

    /// The bar's own items, right to left.
    pub fn items(&self) -> Result<Vec<Node>, String> {
        let mut rows = vec![];
        let clock = self.t("settings.bar.item.clock")?;
        rows.push(self.row(
            "clock",
            &clock,
            self.glyph("clock", "nd-preferences-system-time"),
            Some(self.button(
                "clock",
                self.t("settings.widgets.configure")?,
                &format!("page:{CLOCK_PAGE}"),
                CLOCK_KEYS.iter().any(|k| self.available(k)),
            )),
            None,
        ));
        rows.push(self.row(
            "control-center",
            &self.t("settings.bar.item.control-center")?,
            self.glyph("control-center", "nd-control-center"),
            None,
            None,
        ));
        if self.available("bar.appTitle") {
            let title = self.t("settings.bar.app-title")?;
            let on = (self.shown)("bar.appTitle")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            rows.push(
                self.row(
                    "app-title",
                    &title,
                    self.glyph("app-title", "nd-window-floating"),
                    Some(
                        nk::Switch::new("key/bar.appTitle", &title, "bar:appTitle", on)
                            .enabled(self.writable("bar.appTitle"))
                            .description(self.t("settings.bar.app-title.desc")?)
                            .into(),
                    ),
                    Some("bar.appTitle"),
                ),
            );
        }
        if self.available("bar.launcherIcon") {
            let shown = (self.shown)("bar.launcherIcon");
            let custom = custom_icon(shown.as_ref());
            let lead = match custom {
                Some(path) => nk::Image::new("bar/icon/system-menu", Pictures::id(path), ICON)
                    .picture()
                    .into(),
                None => self.glyph("system-menu", MARK),
            };
            let on = self.writable("bar.launcherIcon");
            let ends = nk::Row::new(
                "bar/system-menu/buttons",
                vec![
                    self.button(
                        "icon-change",
                        self.t("settings.bar.change-icon")?,
                        "bar:icon:change",
                        on,
                    ),
                    self.button(
                        "icon-default",
                        self.t("settings.bar.icon-preset")?,
                        "bar:icon:default",
                        on && custom.is_some(),
                    ),
                ],
            )
            .gap(nk::Space::S2)
            .align(Align::Center);
            rows.push(self.row(
                "system-menu",
                &self.t("settings.bar.item.system-menu")?,
                lead,
                Some(ends.into()),
                Some("bar.launcherIcon"),
            ));
        }
        Ok(rows)
    }

    /// The apps' tray icons, a switch each; none when no app has shown one.
    pub fn apps(&self) -> Result<Vec<Node>, String> {
        let hidden = (self.shown)("bar.trayHidden")
            .and_then(|v| v.as_list().map(<[String]>::to_vec))
            .unwrap_or_default();
        let on = self.writable("bar.trayHidden");
        tray_apps(self.session)
            .into_iter()
            .map(|a| {
                let lead: Node = if a.icon.starts_with('/') {
                    nk::Image::new(
                        format!("bar/icon/tray/{}", a.id),
                        Pictures::id(&a.icon),
                        ICON,
                    )
                    .picture()
                    .into()
                } else {
                    nk::Image::new(format!("bar/icon/tray/{}", a.id), &a.icon, ICON)
                        .app_theme("nd-window-floating")
                        .into()
                };
                Ok(self.row(
                    &format!("tray/{}", a.id),
                    &a.title,
                    lead,
                    Some(
                        nk::Switch::new(
                            format!("bar/tray/{}", a.id),
                            &a.title,
                            format!("bar:tray:{}", a.id),
                            !hidden.contains(&a.id),
                        )
                        .enabled(on)
                        .into(),
                    ),
                    Some("bar.trayHidden"),
                ))
            })
            .collect()
    }
}

// ── The Clock subpage's preview ──────────────────────────────────────────────────────────

/// How the clock reads now, from the session's three keys.
pub fn region(session: &Session) -> nk_platform::clock::Region {
    let text = |k: &str| session.shown(k).and_then(Value::as_text).map(str::to_owned);
    let defaults = nk_platform::clock::Region::default();
    nk_platform::clock::Region {
        twelve_hour: text("region.timeFormat").as_deref() == Some("12h"),
        seconds: session
            .shown("region.showSeconds")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.seconds),
        date: text("region.dateFormat").unwrap_or(defaults.date),
    }
}

/// `strftime` in this process's LC_TIME, which is the session's (set once from the
/// environment, as a GLib program's is).
fn strftime(tm: &libc::tm, pattern: &str) -> String {
    static LOCALE: std::sync::Once = std::sync::Once::new();
    LOCALE.call_once(|| unsafe {
        libc::setlocale(libc::LC_TIME, c"".as_ptr());
    });
    let Ok(pattern) = std::ffi::CString::new(pattern) else {
        return String::new();
    };
    let mut buf = [0u8; 256];
    let n = unsafe { libc::strftime(buf.as_mut_ptr().cast(), buf.len(), pattern.as_ptr(), tm) };
    String::from_utf8_lossy(&buf[..n]).into_owned()
}
fn local(at: libc::time_t) -> libc::tm {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&at, &mut tm) };
    tm
}
/// The bar's clock text at `at` (seconds since the epoch), as the bar writes it.
pub fn preview(r: &nk_platform::clock::Region, at: i64) -> String {
    use nk_platform::clock::{Moment, clock, order_of, time_pattern};
    let tm = local(at as libc::time_t);
    let mut sample: libc::tm = unsafe { std::mem::zeroed() };
    (sample.tm_year, sample.tm_mon, sample.tm_mday) = (101, 1, 3);
    let order = order_of(&strftime(&sample, "%x"));
    let f = |p: &str| strftime(&tm, p);
    let moment = Moment {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        time: f(time_pattern(r)),
        weekday_short: f("%a"),
        weekday_long: f("%A"),
        month_short: f("%b"),
        month_long: f("%B"),
    };
    clock(r, &moment, order)
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// The Clock subpage's head: the bar's clock as it will read, ticking, and what it is.
pub fn preview_rows(text: &str, types: &TypeScale, e: &Exports) -> Result<Node, String> {
    Ok(nk::Group::new(
        "bar/clock/preview",
        nk::Column::new(
            "bar/clock/preview/rows",
            vec![
                nk::Label::new(
                    "bar/clock/preview/text",
                    text,
                    types.style(Type::Title3, Weight::Medium),
                )
                .into(),
                nk::Label::new(
                    "bar/clock/preview/caption",
                    e.text("settings.region.preview")?,
                    types.style(Type::Small, Weight::Regular),
                )
                .ink(nk::Ink::Dim)
                .into(),
            ],
        )
        .gap(nk::Space::S1)
        .align(Align::Center)
        .padding(nk::Padding::all(nk::Space::S3)),
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preview_is_the_bars_clock() {
        // 2026-11-02 18:05:09 UTC, read in UTC so the test does not depend on the host.
        unsafe { std::env::set_var("TZ", "UTC") };
        unsafe extern "C" {
            fn tzset();
        }
        unsafe { tzset() };
        let at = 1_793_642_709;
        let r = |date: &str, twelve: bool, seconds: bool| nk_platform::clock::Region {
            twelve_hour: twelve,
            seconds,
            date: date.into(),
        };
        assert_eq!(preview(&r("none", false, false), at), "18:05");
        assert_eq!(preview(&r("none", false, true), at), "18:05:09");
        assert_eq!(preview(&r("iso", false, false), at), "2026-11-02  18:05");
        assert!(preview(&r("none", true, false), at).starts_with("06:05"));
    }
}
