// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings → Language & region on `AppWindow` (#1103 step 8b). Three settings, each in the
//! home that decides it:
//!
//! - The time zone is the computer's (Config1 `region.timezone`, timedated behind polkit).
//!   It is chosen by city: a search with its matches under it, "Madrid — Europe"; choosing
//!   one applies it, and the system asks for the password (owner, #1103 8b decisions).
//! - Language and regional format are ordinary Config1 rows. A language that needs a
//!   missing input engine goes through the package install before it is applied (#703).
use crate::{Value, exports::Exports, session::Session};
use nk::{Ink, Node, Type, TypeScale, Weight};
use std::process::Command;
use std::sync::mpsc::{Receiver, TryRecvError, channel};

pub const TIMEZONE: &str = "region.timezone";
pub const FORMAT: &str = "region.regionalFormat";
pub const LANGUAGE: &str = "region.language";
/// The Config1 keys this page writes; no other key is editable from it.
pub const KEYS: &[&str] = &[TIMEZONE, FORMAT, LANGUAGE];
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

enum Answer {
    Installing,
    Prepared(Outcome),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    Done,
    Cancelled,
    Failed,
}

struct LanguageRequest {
    epoch: u64,
    previous: Value,
    language: String,
    answers: Receiver<Answer>,
}

#[derive(Default)]
pub struct Region {
    query: String,
    pending: Option<LanguageRequest>,
    /// The language row's status, an i18n key.
    status: Option<&'static str>,
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
    pub fn choose_language(&mut self, language: String, session: &Session) {
        let (Some(store), Some(previous)) = (session.store(), session.shown(LANGUAGE)) else {
            return;
        };
        if self.waiting()
            || session.pending(LANGUAGE)
            || previous.as_text() == Some(language.as_str())
        {
            return;
        }

        let (send, answers) = channel();
        let requested = language.clone();
        self.status = None;
        match std::thread::Builder::new()
            .name("region-language".into())
            .spawn(move || {
                let outcome = prepare_language(&requested, || {
                    let _ = send.send(Answer::Installing);
                });
                let _ = send.send(Answer::Prepared(outcome));
            }) {
            Ok(_) => {
                self.pending = Some(LanguageRequest {
                    epoch: store.epoch,
                    previous: previous.clone(),
                    language,
                    answers,
                })
            }
            Err(error) => {
                eprintln!("[region] could not start language change: {error}");
                self.status = Some("settings.region.locale.lang.failed");
            }
        }
    }

    /// Returns whether to repaint and a language whose engine is ready.
    pub fn poll(&mut self, session: &Session) -> (bool, Option<Value>) {
        let mut changed = false;
        while let Some(request) = &self.pending {
            let outcome = match request.answers.try_recv() {
                Ok(Answer::Installing) => {
                    self.status = Some("settings.region.locale.lang.installing");
                    changed = true;
                    continue;
                }
                Ok(Answer::Prepared(outcome)) => outcome,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => Outcome::Failed,
            };
            let request = self.pending.take().expect("pending language request");
            self.status =
                (outcome == Outcome::Failed).then_some("settings.region.locale.lang.failed");
            let apply = outcome == Outcome::Done
                && session.available()
                && session
                    .store()
                    .is_some_and(|store| store.epoch == request.epoch)
                && session.shown(LANGUAGE) == Some(&request.previous);
            return (true, apply.then_some(Value::Text(request.language)));
        }
        (changed, None)
    }

    pub fn waiting(&self) -> bool {
        self.pending.is_some()
    }

    pub fn language_status(&self) -> Option<&'static str> {
        self.status
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
            _ => Effect::None,
        }
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

/// Installs only a missing input engine. The caller can persist the language after Done.
fn prepare_language(lang: &str, installing: impl FnOnce()) -> Outcome {
    let Some(engine) = run("nidara-language", &["engine", lang]) else {
        return Outcome::Failed;
    };
    let engine = engine.trim();
    if engine.is_empty() || run("pacman", &["-Qq", engine]).is_some() {
        return Outcome::Done;
    }

    installing();
    match Command::new("pkexec")
        .args(["nidara-language", "ensure-engine", lang])
        .status()
    {
        Ok(s) if s.success() => Outcome::Done,
        Ok(s) if s.code() == Some(126) => Outcome::Cancelled,
        Ok(s) => {
            eprintln!("[region] nidara-language ensure-engine {lang}: {s}");
            Outcome::Failed
        }
        Err(err) => {
            eprintln!("[region] nidara-language ensure-engine {lang}: {err}");
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
    fn commits_only_after_the_engine_is_ready_for_the_same_config_session() {
        use crate::session::Raw;

        let session = |epoch| {
            let (mut session, _) = Session::start();
            let schema = serde_json::json!({"schemaVersion": 1, "keys": {
                (LANGUAGE): {"type": "enum", "value": "en_US.UTF-8", "available": true, "writable": true}
            }});
            session.handle(Raw::Snapshot(Ok((epoch, 1, schema.to_string()))));
            session
        };
        let session_a = session(9);
        let session_b = session(10);
        let previous = Value::Text("en_US.UTF-8".into());
        let pick = |region: &mut Region| {
            let (send, answers) = channel();
            region.pending = Some(LanguageRequest {
                epoch: 9,
                previous: previous.clone(),
                language: "zh_CN.UTF-8".into(),
                answers,
            });
            send
        };
        let mut region = Region::default();
        let send = pick(&mut region);
        send.send(Answer::Installing).unwrap();
        assert_eq!(region.poll(&session_a), (true, None));
        assert!(region.waiting());

        send.send(Answer::Prepared(Outcome::Cancelled)).unwrap();
        assert_eq!(region.poll(&session_a), (true, None));
        assert!(region.language_status().is_none());

        pick(&mut region)
            .send(Answer::Prepared(Outcome::Failed))
            .unwrap();
        assert_eq!(region.poll(&session_a), (true, None));
        assert_eq!(
            region.language_status(),
            Some("settings.region.locale.lang.failed")
        );

        pick(&mut region)
            .send(Answer::Prepared(Outcome::Done))
            .unwrap();
        assert_eq!(region.poll(&session_b), (true, None));

        pick(&mut region)
            .send(Answer::Prepared(Outcome::Done))
            .unwrap();
        assert_eq!(
            region.poll(&session_a),
            (true, Some(Value::Text("zh_CN.UTF-8".into())))
        );
    }
}
