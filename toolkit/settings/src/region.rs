// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings → Language & region on `AppWindow` (#1103 step 8b). Three settings, each in the
//! home that decides it:
//!
//! - The time zone is the computer's (Config1 `region.timezone`, timedated behind polkit).
//!   It is chosen by city: a search with its matches under it, "Madrid — Europe"; choosing
//!   one applies it, and the system asks for the password (owner, #1103 8b decisions).
//! - The language is the computer's too (`/etc/locale.conf`), through `pkexec nidara-language
//!   set`, which installs the input engine a language needs first (#703). A password prompt
//!   that opened as the selection moved would be a trap, so it keeps an Apply button.
//! - The regional format is this user's (Config1 `region.regionalFormat`), an ordinary row.
use crate::{Value, exports::Exports, session::Session};
use nk::{Ink, Node, Space, Type, TypeScale, Weight};
use std::process::Command;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};

pub const TIMEZONE: &str = "region.timezone";
pub const FORMAT: &str = "region.regionalFormat";
/// The Config1 keys this page writes; no other key is editable from it.
pub const KEYS: &[&str] = &[TIMEZONE, FORMAT];
/// How many matches are offered at once: a list to choose from, not one to scroll.
const MATCHES: usize = 8;
/// The areas a city is shown under. tzdata's other names (`US/Pacific`, `GB`, `Etc/GMT+3`)
/// are aliases of these cities, and a search that offered them would list one city twice.
const AREAS: &[&str] = &[
    "Africa",
    "America",
    "Antarctica",
    "Arctic",
    "Asia",
    "Atlantic",
    "Australia",
    "Europe",
    "Indian",
    "Pacific",
];

/// A zone as a person reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Place {
    pub zone: String,
    pub city: String,
    /// The area's i18n key; None for UTC.
    pub area: Option<String>,
}

/// "Europe/Madrid" → Madrid under Europe; "America/Argentina/Salta" → Salta under America;
/// UTC as itself. None for an alias.
pub fn place(zone: &str) -> Option<Place> {
    if zone == "UTC" {
        return Some(Place {
            zone: zone.into(),
            city: "UTC".into(),
            area: None,
        });
    }
    let (area, rest) = zone.split_once('/')?;
    if !AREAS.contains(&area) {
        return None;
    }
    let city = rest.rsplit('/').next()?.replace('_', " ");
    Some(Place {
        zone: zone.into(),
        city,
        area: Some(format!("settings.region.tz.area.{}", area.to_lowercase())),
    })
}

/// Lower case without accents: "méxico" finds Mexico City.
fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            '_' => ' ',
            c => c,
        })
        .collect()
}

/// The places whose city has a word starting with what is typed, the cities that start with
/// it first; at most `MATCHES`. Nothing for an empty query.
pub fn matches<'a>(query: &str, zones: impl IntoIterator<Item = &'a str>) -> Vec<Place> {
    let q = fold(query.trim());
    if q.is_empty() {
        return vec![];
    }
    let mut found: Vec<(bool, Place)> = zones
        .into_iter()
        .filter_map(place)
        .filter_map(|p| {
            let city = fold(&p.city);
            if city.starts_with(&q) {
                Some((true, p))
            } else if city.split([' ', '-']).any(|w| w.starts_with(&q)) {
                Some((false, p))
            } else {
                None
            }
        })
        .collect();
    found.sort_by(|(a, x), (b, y)| b.cmp(a).then_with(|| x.city.cmp(&y.city)));
    found.into_iter().take(MATCHES).map(|(_, p)| p).collect()
}

/// What a worker brings back.
enum Answer {
    /// The languages the system can switch to, and the one in force.
    Languages(Vec<String>, String),
    /// The language needs its input engine, and it is being installed.
    Installing,
    Applied(Outcome),
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    Done,
    /// The password prompt was dismissed: nothing failed, nothing changed.
    Cancelled,
    Failed,
}

#[derive(Default)]
pub struct Region {
    query: String,
    /// The languages and the one in force; None until read.
    languages: Option<(Vec<String>, String)>,
    /// The language picked and not applied yet.
    picked: Option<usize>,
    applying: bool,
    /// The language row's status, an i18n key: installing, or why it failed.
    status: Option<&'static str>,
    answers: Option<(Sender<Answer>, Receiver<Answer>)>,
}

/// What the page asks the window to do.
pub enum Effect {
    None,
    /// Rebuild: the page changed.
    Redraw,
    /// Write a Config1 key.
    Apply(&'static str, Value),
}

impl Region {
    fn sender(&mut self) -> Sender<Answer> {
        self.answers.get_or_insert_with(channel).0.clone()
    }

    /// The page is shown: read the languages (they change only by an Apply, or by hand).
    pub fn visit(&mut self) {
        if self.languages.is_some() {
            return;
        }
        let tx = self.sender();
        let _ = std::thread::Builder::new()
            .name("region-languages".into())
            .spawn(move || {
                let _ = tx.send(read_languages());
            });
    }

    /// Takes what the workers brought; true when the page changed.
    pub fn poll(&mut self) -> bool {
        let Some((_, rx)) = &self.answers else {
            return false;
        };
        let mut changed = false;
        loop {
            match rx.try_recv() {
                Ok(Answer::Languages(list, current)) => {
                    self.languages = Some((list, current));
                    self.picked = None;
                }
                Ok(Answer::Installing) => {
                    self.status = Some("settings.region.locale.lang.installing");
                }
                Ok(Answer::Applied(outcome)) => {
                    self.applying = false;
                    self.status = (outcome == Outcome::Failed)
                        .then_some("settings.region.locale.lang.failed");
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return changed,
            }
            changed = true;
        }
    }

    /// Whether a worker has yet to answer (the window looks again soon).
    pub fn waiting(&self) -> bool {
        self.applying || self.answers.is_some() && self.languages.is_none()
    }

    /// An action of this page (`region:…`).
    pub fn act(&mut self, action: &str, value: Option<nk::Value>, session: &Session) -> Effect {
        match (action, value) {
            ("tz-edit", Some(nk::Value::Text(text))) => {
                self.query = text;
                Effect::Redraw
            }
            ("tz-choose", Some(nk::Value::Index(i))) => {
                let Some(place) = matches(&self.query, zones(session)).into_iter().nth(i) else {
                    return Effect::None;
                };
                self.query.clear();
                Effect::Apply(TIMEZONE, Value::Text(place.zone))
            }
            ("lang-pick", Some(nk::Value::Index(i))) => {
                self.picked = Some(i);
                self.status = None;
                Effect::Redraw
            }
            ("lang-apply", _) => {
                let Some(lang) = self.picked_language().filter(|_| !self.applying) else {
                    return Effect::None;
                };
                self.applying = true;
                self.status = None;
                let tx = self.sender();
                let _ = std::thread::Builder::new()
                    .name("region-language".into())
                    .spawn(move || {
                        let outcome = apply_language(&lang, || {
                            let _ = tx.send(Answer::Installing);
                        });
                        let _ = tx.send(Answer::Applied(outcome));
                        if outcome == Outcome::Done {
                            let _ = tx.send(read_languages());
                        }
                    });
                Effect::Redraw
            }
            _ => Effect::None,
        }
    }

    /// The language picked, when it is not the one in force.
    fn picked_language(&self) -> Option<String> {
        let (list, current) = self.languages.as_ref()?;
        list.get(self.picked?).filter(|l| *l != current).cloned()
    }

    /// The time zone's group: the zone in force, the city search and its matches.
    pub fn timezone(
        &self,
        e: &Exports,
        types: &TypeScale,
        session: &Session,
    ) -> Result<Vec<Node>, String> {
        let body = || types.style(Type::Body, Weight::Regular);
        let small = || types.style(Type::Small, Weight::Regular);
        let shown = session
            .shown(TIMEZONE)
            .and_then(Value::as_text)
            .unwrap_or_default();
        let active = match place(shown) {
            Some(p) => self.label(e, &p)?,
            None => shown.to_owned(),
        };
        let mut nodes = vec![
            nk::Label::new(
                "region/tz/title",
                e.text("settings.region.tz.group")?,
                types.style(Type::Body, Weight::Medium),
            )
            .into(),
            nk::Group::new(
                "region/tz/group",
                nk::Column::new(
                    "region/tz/rows",
                    vec![
                        nk::ListRow::new(
                            "region/tz/active",
                            e.text("settings.region.tz.active")?,
                            body(),
                        )
                        .subtitle(e.text("settings.region.tz.active.desc")?, small())
                        .trailing(
                            nk::Label::new("region/tz/active/value", active, body())
                                .ink(Ink::Secondary),
                        )
                        .into(),
                    ],
                ),
            )
            .into(),
        ];
        let writable = session.available()
            && session
                .store()
                .and_then(|s| s.key(TIMEZONE))
                .is_some_and(|k| k.available && k.writable());
        nodes.push(
            nk::SearchEntry::new(
                "region/tz/search",
                e.text("settings.region.tz.change")?,
                "region:tz-edit",
                self.query.clone(),
                e.text("settings.region.tz.clear")?,
            )
            .placeholder(e.text("settings.region.tz.search")?)
            .suggestions("region/tz/matches")
            .enabled(writable)
            .into(),
        );
        let found = matches(&self.query, zones(session));
        if !found.is_empty() {
            let options = found
                .iter()
                .map(|p| {
                    let option = nk::ListBoxOption::new(p.city.clone());
                    Ok(match &p.area {
                        Some(area) => option.subtitle(e.text(area)?),
                        None => option,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            nodes.push(
                nk::Group::new(
                    "region/tz/matches/group",
                    nk::ListBox::new(
                        "region/tz/matches",
                        e.text("settings.region.tz.matches")?,
                        "region:tz-choose",
                        options,
                        body(),
                    )
                    .subtitle_style(small())
                    .enabled(writable),
                )
                .into(),
            );
        } else if !self.query.trim().is_empty() {
            nodes.push(
                nk::Label::new(
                    "region/tz/none",
                    e.text("settings.region.tz.none")?,
                    small(),
                )
                .ink(Ink::Dim)
                .into(),
            );
        }
        nodes.push(
            nk::Label::new(
                "region/tz/footer",
                e.text("settings.region.tz.search.desc")?,
                small(),
            )
            .ink(Ink::Dim)
            .into(),
        );
        Ok(nodes)
    }

    /// The language row: the languages, and Apply for the one picked.
    pub fn language(&self, e: &Exports, types: &TypeScale) -> Result<Node, String> {
        let body = || types.style(Type::Body, Weight::Regular);
        let small = || types.style(Type::Small, Weight::Regular);
        let title = e.text("settings.region.locale.lang")?;
        let subtitle = e.text(self.status.unwrap_or("settings.region.locale.lang.desc"))?;
        let mut row = nk::ListRow::new("region/lang", title, body()).subtitle(subtitle, small());
        if let Some((list, current)) = &self.languages {
            let chosen = self
                .picked
                .or_else(|| list.iter().position(|l| l == current))
                .unwrap_or(0);
            row = row.trailing(
                nk::Row::new(
                    "region/lang/controls",
                    vec![
                        nk::DropDown::new(
                            "region/lang/list",
                            title,
                            "region:lang-pick",
                            list.clone(),
                            chosen,
                        )
                        .enabled(!self.applying)
                        .description(subtitle)
                        .into(),
                        nk::Button::new(
                            "region/lang/apply",
                            e.text("settings.region.tz.apply")?,
                            "region:lang-apply",
                            body(),
                        )
                        .appearance(nk::ButtonAppearance::Default)
                        .enabled(!self.applying && self.picked_language().is_some())
                        .into(),
                    ],
                )
                .gap(Space::S2)
                .align(nk::Align::Center),
            );
        }
        Ok(row.into())
    }

    /// "Madrid — Europe", the area in the session's language.
    fn label(&self, e: &Exports, p: &Place) -> Result<String, String> {
        Ok(match &p.area {
            Some(area) => format!("{} — {}", p.city, e.text(area)?),
            None => p.city.clone(),
        })
    }
}

/// The zones Config1 accepts, its catalogue.
fn zones(session: &Session) -> impl Iterator<Item = &str> {
    session
        .store()
        .and_then(|s| s.key(TIMEZONE))
        .and_then(|k| k.entry["catalogue"].as_array())
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `localectl`'s generated locales without the C/POSIX family (no language), and LANG; a
/// LANG not in the list is added, so the row shows the truth rather than a neighbour.
fn read_languages() -> Answer {
    let (mut list, current) = parse_languages(
        &run("localectl", &["list-locales"]).unwrap_or_default(),
        &run("localectl", &["status"]).unwrap_or_default(),
    );
    if !current.is_empty() && !list.contains(&current) {
        list.push(current.clone());
    }
    Answer::Languages(list, current)
}
fn parse_languages(listed: &str, status: &str) -> (Vec<String>, String) {
    let list = listed
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty()
                && !["C", "POSIX"]
                    .iter()
                    .any(|c| *l == *c || l.starts_with(&format!("{c}.")))
        })
        .map(str::to_owned)
        .collect();
    let current = status
        .lines()
        .find_map(|l| l.trim().strip_prefix("System Locale:"))
        .and_then(|v| v.trim().strip_prefix("LANG="))
        .map(|v| v.split_whitespace().next().unwrap_or_default().to_owned())
        .unwrap_or_default();
    (list, current)
}

/// Sets the language, its input engine first when it needs one it lacks (#703): one password
/// prompt for both, and no language change if the engine cannot be installed.
fn apply_language(lang: &str, installing: impl FnOnce()) -> Outcome {
    let engine = run("nidara-language", &["engine", lang])
        .map(|p| p.trim().to_owned())
        .unwrap_or_default();
    if !engine.is_empty() && run("pacman", &["-Qq", &engine]).is_none() {
        installing();
    }
    match Command::new("pkexec")
        .args(["nidara-language", "set", lang])
        .status()
    {
        Ok(s) if s.success() => Outcome::Done,
        Ok(s) if s.code() == Some(126) => Outcome::Cancelled,
        Ok(s) => {
            eprintln!("[region] nidara-language set {lang}: {s}");
            Outcome::Failed
        }
        Err(err) => {
            eprintln!("[region] nidara-language set {lang}: {err}");
            Outcome::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zone_is_a_city_under_its_area() {
        assert_eq!(
            place("America/Argentina/Salta").unwrap(),
            Place {
                zone: "America/Argentina/Salta".into(),
                city: "Salta".into(),
                area: Some("settings.region.tz.area.america".into()),
            }
        );
        assert_eq!(place("America/Mexico_City").unwrap().city, "Mexico City");
        assert_eq!(place("UTC").unwrap().area, None);
        assert_eq!(place("US/Pacific"), None, "an alias is not a city");
        assert_eq!(place("Etc/GMT+3"), None);
    }

    #[test]
    fn the_city_search_finds_word_starts_and_ignores_accents() {
        let zones = [
            "Europe/Madrid",
            "America/Managua",
            "America/Mexico_City",
            "America/Argentina/Buenos_Aires",
            "US/Pacific",
            "Asia/Ho_Chi_Minh",
        ];
        let cities =
            |q: &str| -> Vec<String> { matches(q, zones).into_iter().map(|p| p.city).collect() };
        assert_eq!(cities("ma"), ["Madrid", "Managua"]);
        assert_eq!(cities("méxico"), ["Mexico City"]);
        assert_eq!(cities("aires"), ["Buenos Aires"]);
        assert_eq!(cities("city"), ["Mexico City"]);
        assert_eq!(
            cities("pacific"),
            Vec::<String>::new(),
            "aliases are not offered"
        );
        assert_eq!(cities("  "), Vec::<String>::new());
    }

    #[test]
    fn cities_that_start_with_the_query_come_first() {
        let zones = ["America/Mexico_City", "Asia/Manila", "America/Monterrey"];
        let cities: Vec<String> = matches("m", zones).into_iter().map(|p| p.city).collect();
        assert_eq!(cities, ["Manila", "Mexico City", "Monterrey"]);
        let cities: Vec<String> = matches("ci", zones).into_iter().map(|p| p.city).collect();
        assert_eq!(cities, ["Mexico City"]);
    }

    #[test]
    fn languages_drop_c_and_posix_and_lang_is_read() {
        let (list, current) = parse_languages(
            "C.UTF-8\nen_US.UTF-8\nes_ES.UTF-8\nPOSIX\n",
            "   System Locale: LANG=es_ES.UTF-8\n       VC Keymap: es\n",
        );
        assert_eq!(list, ["en_US.UTF-8", "es_ES.UTF-8"]);
        assert_eq!(current, "es_ES.UTF-8");
        assert_eq!(parse_languages("", "").1, "");
    }
}
