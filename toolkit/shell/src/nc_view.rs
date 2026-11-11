// SPDX-License-Identifier: LGPL-3.0-or-later
//! The notification centre on nk-view (VIEW.md, #1048). Separate glass cards, one per
//! notification or group, as the TS centre had them
//! (`ui/shell/surfaces/control-center/NotificationCenter.tsx`); the calendar is a card above
//! them. This module only builds the view from the history and says what an activation means;
//! layout, hover, press, focus, scrolling, swipes, reveals and the regions are the kit's. The
//! month shown and the bulk dismissal are `nc.rs`'s.
use crate::{
    nc,
    notification_card::{self, Artwork},
    notifications::Banner,
    popup::Look,
};
use nk_render::{Canvas, ImageFit};
use nk_text::{Rect, TextStyle};
use nk_view::{
    Activated, Align, Corner, Frame, Ink, Key, KeyInput, Node, Padding, Radius, ScrollBy, Space,
    Ticked, Tokens, ViewState, Wash,
};
use nk_wayland::{Group, MaterialRect, Pane, Shadow, Tone};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

/// Region ids of the pilot's controls start here, clear of the bar's and the CC's.
const REGIONS: u32 = 60_000;
/// The scroll bar's lane, right of the cards.
const LANE: Space = Space::S3;
/// The app icon and the thumbnail beside the text, as the TS card had them.
const ART: f64 = 44.;
/// A collapsed group's ghost layers under its card (`makeGroupStack`): the card's least
/// height, how far the nearest ghost peeks, and how much more each deeper one does.
const GHOST_H: f64 = 76.;
const PEEK: f64 = 14.;
const STEP: f64 = 10.;

/// A clear's cascade: the cards leave one after another this far apart (TS's `cascadeOut`).
const CASCADE: Duration = Duration::from_millis(45);

/// A card's corner, the CC's 4×1 (owner, 2026-11-10): `lg` of the radius scale, which a test
/// holds equal to `cc::wide_radius`.
const CARD: Radius = Radius::Lg;
/// An open card shows its picture across its whole width when the source is at least this
/// wide; a smaller one (a chat avatar is 64 to 160 px) would only be blurred by it, and
/// keeps its thumbnail. The height follows the picture, between the two bounds. As TS had it.
const HERO_SOURCE: u32 = 240;
const HERO_HEIGHT: (f64, f64) = (72., 200.);
const HERO_CORNER: Radius = Radius::Md;

/// The kit's tokens for the shell's skin (always dark) in this appearance.
pub fn tokens(
    e: &nk_settings::exports::Exports,
    appearance: &nk_settings::portal::Appearance,
) -> Result<Tokens, String> {
    let skin = nk_settings::portal::Appearance {
        dark: true,
        ..appearance.clone()
    };
    let set = e.tokens(&skin)?;
    let colors = serde_json::json!({ "tokens": set.colors });
    Ok(Tokens {
        spacing: nk_view::Spacing::from_static(&e.statics)?,
        radii: nk_view::Radii::from_static(&e.statics)?,
        motion: nk_view::Motion::from_static(&e.statics)?,
        look: nk_view::Look::from_colors(&colors)?,
        washes: nk_view::Washes::from_glass(&e.glass, true, skin.reduce_transparency)?,
        scrollbar: nk_view::scrollbar_from(&set.components["scrollbar"], &colors)?,
        slider: nk_view::slider_from(&set.components["range"])?,
    })
}

/// What an activation in the centre asks the bar for.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    /// A card's body, close or action: the bar's own card path.
    Card(u64, u64, notification_card::Target),
    /// The calendar's months, or a bulk dismissal: today's `nc::Target`s.
    Nc(nc::Target),
    /// Only the view changed (a group or a card opened or closed).
    Rebuild,
    /// Something started to move (a clear's cascade): the bar ticks and draws.
    Motion,
}

pub struct View {
    pub state: ViewState,
    tokens: Option<Tokens>,
    groups_open: HashSet<String>,
    items_open: HashSet<u64>,
    history: Arc<Vec<Banner>>,
    /// The view's rect on the bar's surface, and the list's viewport within it.
    pub bounds: [f64; 4],
    pub list: [f64; 4],
    /// The minute the ages were written for.
    pub minute: u64,
    /// What the last painted frame declared: `material` reads it after `paint`.
    last: Frame,
    /// The appearance the tokens were read for.
    appearance: Option<nk_settings::portal::Appearance>,
    /// Each row's height when it was last laid out, by its key; a card never laid out is
    /// guessed at the last card's.
    heights: HashMap<String, f64>,
    card_guess: f64,
    /// The list's window the view was built for.
    built: (f64, f64),
    /// Which control each semantic id published is.
    ids: HashMap<u64, Key>,
    /// A clear whose cards are still leaving: carried out when the last is gone, or at once
    /// if the centre closes first.
    clearing: Option<nc::Target>,
    /// Groups folding away, until their rows have rolled up.
    folding: HashMap<String, Instant>,
    /// Why the last bulk dismissal failed, shown under the list.
    error: String,
    /// The cards' width, which an open card's picture spans less its padding.
    width: f64,
    /// Each picture's pixel size, read from its header once.
    sizes: std::cell::RefCell<HashMap<String, Option<(u32, u32)>>>,
}

impl Default for View {
    fn default() -> Self {
        Self {
            state: ViewState::new(REGIONS),
            tokens: None,
            groups_open: HashSet::new(),
            items_open: HashSet::new(),
            history: Arc::default(),
            bounds: [0.; 4],
            list: [0.; 4],
            minute: 0,
            last: Frame::default(),
            appearance: None,
            heights: HashMap::new(),
            card_guess: 96.,
            built: (0., 0.),
            ids: HashMap::new(),
            clearing: None,
            folding: HashMap::new(),
            error: String::new(),
            width: 0.,
            sizes: Default::default(),
        }
    }
}

/// Strips markup and decodes the entities a sender may put in a summary or a body, and folds
/// it to one line, as the TS card's `sanitize` did: tags first, `&amp;` last.
pub fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let mut decoded = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(i) = rest.find('&') {
        decoded.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            decoded.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "amp" => Some('&'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .filter(|&c| c > 0)
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                decoded.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                decoded.push('&');
                rest = &rest[1..];
            }
        }
    }
    decoded.push_str(rest);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The history as the centre lists it: groups newest first, each newest first, transient
/// notifications left out (B3.2).
pub fn groups(history: &[Banner]) -> Vec<(String, Vec<&Banner>)> {
    let mut by: HashMap<String, Vec<&Banner>> = HashMap::new();
    for b in history.iter().filter(|b| !b.notice.transient()) {
        by.entry(nc::group(b)).or_default().push(b);
    }
    let newest = |b: &Banner| (b.notice.time, b.notice.revision, b.instance);
    let mut out: Vec<_> = by.into_iter().collect();
    for (_, list) in &mut out {
        list.sort_by_key(|b| std::cmp::Reverse(newest(b)));
    }
    out.sort_by_key(|(_, list)| std::cmp::Reverse(newest(list[0])));
    out
}

/// The interface strings the centre shows, in the session's language.
pub struct Strings {
    pub empty: String,
    pub clear_all: String,
}
impl Strings {
    pub fn of(look: &Look) -> Self {
        let t = |k: &str, fallback: &str| {
            look.exports
                .text(k)
                .map(str::to_string)
                .unwrap_or_else(|_| fallback.into())
        };
        Self {
            empty: t("nc.empty", "No notifications"),
            clear_all: t("nc.clear-all", "Clear notifications"),
        }
    }
}

/// Everything the view is built from.
pub struct Model<'a> {
    pub history: &'a [Banner],
    pub year: i32,
    pub month: i32,
    /// Today, when it is in the month shown.
    pub today: Option<i32>,
    pub now: u64,
    pub text: &'a TextStyle,
    pub strings: &'a Strings,
    pub weekdays: &'a [String],
    pub month_name: &'a str,
    /// Why the last bulk dismissal failed; empty when it did not.
    pub error: &'a str,
}

fn style(base: &TextStyle, size: f32, weight: f32) -> TextStyle {
    TextStyle {
        size,
        weight,
        line_height: 1.35,
        ..base.clone()
    }
}

fn ghosts(count: usize) -> usize {
    match count {
        0 | 1 => 0,
        2 => 1,
        _ => 2,
    }
}

impl View {
    /// The centre's view: the calendar card, then the list, which scrolls.
    pub fn view(&self, m: &Model<'_>) -> Node {
        let mut list = vec![];
        let groups = groups(m.history);
        if groups.is_empty() {
            list.push(
                Node::row(
                    "empty/row",
                    vec![Node::pane(
                        "empty",
                        Corner::Pill,
                        Node::row(
                            "empty/pad",
                            vec![
                                Node::text(
                                    "empty/text",
                                    &m.strings.empty,
                                    style(m.text, 13., 400.),
                                )
                                .ink(Ink::Secondary),
                            ],
                        )
                        .padding(Padding::symmetric(Space::S2, Space::S8)),
                    )],
                )
                .justify(nk_view::Justify::Center),
            );
        }
        // Only the rows near what shows are built (B3.2, VIEW.md §8): a viewport above and
        // below it; every other row is a placeholder at the height it was laid out at.
        let (offset, viewport) = self.window();
        let (lo, hi) = (offset - viewport, offset + 2. * viewport);
        let px = |s: Space| self.tokens.as_ref().map_or(16., |t| t.spacing.px(s));
        let height = |key: &str, guess: f64| self.heights.get(key).copied().unwrap_or(guess);
        let mut y = 0.;
        // Whether a row at `y`, `h` tall, is near enough to what shows to be built.
        let near = |y: f64, h: f64| y + h >= lo && y <= hi;
        // A group's open rows from `y`, each built if near, else a placeholder; and where
        // they end.
        let rows = |list_of: &[&Banner], mut y: f64| -> (Vec<Node>, f64) {
            let mut out = vec![];
            for (n, b) in list_of.iter().enumerate() {
                let pane = format!("n{}/pane", b.instance);
                let h = height(&pane, self.card_guess);
                out.push(if near(y, h) {
                    self.card(b, m, None)
                } else {
                    Node::placeholder(pane, h)
                });
                // The last card's gap is the list's, to the next row.
                y += h + px(if n + 1 == list_of.len() {
                    Space::S4
                } else {
                    Space::S3
                });
            }
            (out, y)
        };
        for (key, list_of) in &groups {
            if list_of.len() < 2 {
                let pane = format!("n{}/pane", list_of[0].instance);
                let h = height(&pane, self.card_guess);
                list.push(if near(y, h) {
                    self.card(list_of[0], m, None)
                } else {
                    Node::placeholder(pane, h)
                });
                y += h + px(Space::S4);
                continue;
            }
            // A group is its front (the header open, the stacked card folded) over its rows,
            // which unroll beneath it as TS's revealer did. Folding, the rows stay built
            // until they have rolled up.
            let open = self.groups_open.contains(key);
            let folding = !open && self.folding.contains_key(key);
            let front = if open {
                let header = format!("g:{key}/header");
                let h = height(&header, 40.);
                let node = if near(y, h) {
                    self.group_header(key, list_of, m)
                } else {
                    Node::placeholder(header, h)
                };
                y += h + px(Space::S3);
                node
            } else {
                let strip = PEEK + (ghosts(list_of.len()) - 1) as f64 * STEP;
                let pane = format!("f{}/pane", list_of[0].instance);
                let h = height(&pane, self.card_guess) + strip;
                let node = if near(y, h) {
                    Node::column(
                        format!("g:{key}/stack"),
                        vec![
                            self.card(list_of[0], m, Some((key, list_of.len()))),
                            Node::placeholder(format!("g:{key}/ghosts"), strip),
                        ],
                    )
                } else {
                    Node::placeholder(format!("g:{key}/stack"), h)
                };
                y += h + px(Space::S4);
                node
            };
            let built = if open || folding {
                let (built, end) = rows(list_of, y);
                if open {
                    y = end;
                }
                built
            } else {
                vec![]
            };
            list.push(Node::column(
                format!("g:{key}"),
                vec![
                    front,
                    Node::reveal(
                        format!("g:{key}/rows"),
                        open,
                        Node::column(format!("g:{key}/list"), built)
                            .gap(Space::S3)
                            .padding(Padding {
                                top: Some(Space::S3),
                                ..Padding::default()
                            }),
                    ),
                ],
            ));
        }
        if !m.error.is_empty() {
            list.push(
                Node::row(
                    "error/row",
                    vec![
                        Node::text("error", m.error, style(m.text, 12., 400.))
                            .lines(2)
                            .ink(Ink::Secondary),
                    ],
                )
                .justify(nk_view::Justify::Center),
            );
        }
        if !groups.is_empty() {
            list.push(
                Node::row(
                    "clear/row",
                    vec![Node::pane(
                        "clear",
                        Corner::Pill,
                        Node::control(
                            "clear-all",
                            &m.strings.clear_all,
                            "clear-all",
                            Node::row(
                                "clear/pad",
                                vec![Node::text(
                                    "clear/text",
                                    &m.strings.clear_all,
                                    style(m.text, 13., 400.),
                                )],
                            )
                            .padding(Padding::symmetric(Space::S2, Space::S8)),
                        ),
                    )],
                )
                .justify(nk_view::Justify::Center),
            );
        }
        Node::column(
            "nc",
            vec![
                Node::row("calendar/row", vec![self.calendar(m).grow()]).padding(Padding {
                    right: Some(LANE),
                    ..Padding::default()
                }),
                Node::scroll(
                    "list",
                    Node::column("list/items", list)
                        .gap(Space::S4)
                        .padding(Padding {
                            right: Some(LANE),
                            bottom: Some(Space::S1),
                            ..Padding::default()
                        }),
                ),
            ],
        )
        .gap(Space::S4)
    }

    fn calendar(&self, m: &Model<'_>) -> Node {
        let body = style(m.text, 13., 400.);
        let nav = |key: &str, name: &str, icon: &str| {
            Node::control(
                format!("cal/{key}"),
                name,
                key,
                Node::row(
                    format!("cal/{key}/pad"),
                    vec![Node::icon(format!("cal/{key}/icon"), icon, 16.)],
                )
                .padding(Padding::all(Space::S1)),
            )
        };
        let header = Node::row(
            "cal/header",
            vec![
                Node::text("cal/month", m.month_name, style(m.text, 15., 700.)).grow(),
                nav("previous", "Previous month", "nd-pan-start"),
                Node::control(
                    "cal/today",
                    "Today",
                    "today",
                    Node::row(
                        "cal/today/pad",
                        vec![Node::text("cal/today/text", "Today", body.clone())],
                    )
                    .padding(Padding::symmetric(Space::S1, Space::S2)),
                ),
                nav("next", "Next month", "nd-pan-end"),
            ],
        )
        .gap(Space::S1)
        .align(Align::Center);
        // A cell is a square the width of a day number, the number centred over it; the
        // seven share the row's room, so the columns are equal whatever the digits.
        let cell = |key: String, label: String, ink: Ink| {
            Node::overlay(
                format!("{key}/cell"),
                Node::icon(format!("{key}/square"), "", 28.),
            )
            .layer(
                Align::Center,
                Align::Center,
                Padding::default(),
                Node::text(key, label, body.clone()).ink(ink),
            )
            .grow()
        };
        let mut rows = vec![
            header,
            Node::row(
                "cal/weekdays",
                m.weekdays
                    .iter()
                    .enumerate()
                    .map(|(i, d)| cell(format!("cal/wd{i}"), d.clone(), Ink::Dim))
                    .collect(),
            ),
        ];
        let days = nc::calendar(m.year, m.month);
        for week in 0..6 {
            let mut cells = vec![];
            for col in 0..7 {
                let at = week * 7 + col;
                let day = days.iter().find(|(_, c)| *c == at).map(|(d, _)| *d);
                let key = format!("cal/d{at}");
                cells.push(match day {
                    Some(d) if m.today == Some(d) => Node::control(
                        format!("{key}/today"),
                        format!("Today, {d}"),
                        "",
                        cell(key, d.to_string(), Ink::Primary),
                    )
                    .enabled(false)
                    .marked(true)
                    .grow(),
                    Some(d) => cell(key, d.to_string(), Ink::Primary),
                    // A day outside the month is room, not an empty text a reader would visit.
                    None => Node::icon(format!("{key}/square"), "", 28.).grow(),
                });
            }
            rows.push(Node::row(format!("cal/w{week}"), cells));
        }
        Node::pane(
            "calendar",
            Corner::Token(Radius::Xl),
            Node::column("cal/col", rows)
                .gap(Space::S1)
                .padding(Padding::all(Space::S4)),
        )
    }

    fn group_header(&self, key: &str, list: &[&Banner], m: &Model<'_>) -> Node {
        let name = list[0].notice.app_name.clone();
        let pane = format!("g:{key}/header");
        Node::pane(
            pane.clone(),
            Corner::Token(Radius::Md),
            Node::control(
                format!("g:{key}/toggle"),
                format!("{name}, {} notifications, collapse", list.len()),
                format!("group:{key}"),
                Node::row(
                    format!("g:{key}/row"),
                    vec![
                        Node::text(format!("g:{key}/name"), name, style(m.text, 13., 700.))
                            .lines(1)
                            .grow(),
                        Node::text(
                            format!("g:{key}/count"),
                            list.len().to_string(),
                            style(m.text, 11., 600.),
                        )
                        .ink(Ink::Secondary),
                        Node::control(
                            format!("g:{key}/clear"),
                            format!("Clear {}", list[0].notice.app_name),
                            format!("clear-group:{key}"),
                            Node::row(
                                format!("g:{key}/clear/pad"),
                                vec![Node::icon(
                                    format!("g:{key}/clear/icon"),
                                    "nd-window-close",
                                    13.,
                                )],
                            )
                            .padding(Padding::all(Space::S1)),
                        )
                        .wash(Wash::Destructive)
                        .revealed_with(pane),
                    ],
                )
                .gap(Space::S2)
                .align(Align::Center)
                .padding(Padding::symmetric(Space::S2, Space::S3)),
            )
            .corner(Corner::Token(Radius::Md))
            .swipe(format!("clear-group:{key}")),
        )
    }

    /// One card. `group`: the collapsed group it fronts and how many it holds; its close and
    /// its swipe clear the group, and a tap opens it. A front's keys start with `f`, a row's
    /// with `n`, so a folding group's rows and its front are never one node.
    /// How tall a card's picture is across the card when it is open: None when it has none
    /// that is big enough.
    fn hero(&self, b: &Banner) -> Option<f64> {
        let path = thumbnail(b)?;
        let (w, h) = *self
            .sizes
            .borrow_mut()
            .entry(path)
            .or_insert_with_key(|path| image::image_dimensions(path).ok())
            .as_ref()?;
        let pad = self.tokens.as_ref()?.spacing.px(Space::S3);
        let across = self.width - 2. * pad;
        (w >= HERO_SOURCE && across > 0.).then(|| {
            (across * f64::from(h) / f64::from(w))
                .round()
                .clamp(HERO_HEIGHT.0, HERO_HEIGHT.1)
        })
    }

    fn card(&self, b: &Banner, m: &Model<'_>, group: Option<(&String, usize)>) -> Node {
        let lead = if group.is_some() { 'f' } else { 'n' };
        let k = |s: &str| format!("{lead}{}/{s}", b.instance);
        let pane = k("pane");
        let (i, c) = (b.instance, b.content);
        let summary = plain(&b.notice.summary);
        let body = plain(&b.notice.body);
        let title = if summary.is_empty() {
            b.notice.app_name.clone()
        } else {
            summary
        };
        let actions: Vec<_> = b
            .notice
            .actions
            .iter()
            .filter(|a| a.id != "default" && !a.label.is_empty())
            .collect();
        // What a reader hears after the title: the age, the body and any error, which are
        // inside the card's control and so are not labels of their own.
        let said = [nc::age(b.notice.time, m.now), body.clone(), b.error.clone()]
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        let expanded = group.is_none() && self.items_open.contains(&i);
        let hero = group.is_none().then(|| self.hero(b)).flatten();
        let expandable =
            group.is_none() && (!actions.is_empty() || body.chars().count() > 70 || hero.is_some());
        // Open, a big picture spans the card under its text, with the actions under it.
        let hero = hero.filter(|_| expanded);
        let close_action = match group {
            Some((key, _)) => format!("clear-group:{key}"),
            None => format!("close:{i}:{c}"),
        };
        let age = Node::text(
            k("age"),
            nc::age(b.notice.time, m.now),
            style(m.text, 11., 400.),
        )
        .ink(Ink::Dim);
        // The chevron shows on hover in the age's place, as TS swapped them, so the title
        // line never moves.
        let age = if expandable {
            Node::overlay(k("when"), age.hidden_with(pane.clone())).layer(
                Align::Center,
                Align::Center,
                Padding::default(),
                Node::control(
                    k("more"),
                    if expanded { "Show less" } else { "Show more" },
                    format!("item:{i}"),
                    Node::icon(
                        k("more/icon"),
                        if expanded { "nd-pan-up" } else { "nd-pan-down" },
                        13.,
                    ),
                )
                .revealed_with(pane.clone()),
            )
        } else {
            age
        };
        let mut head = vec![
            Node::text(k("title"), title.clone(), style(m.text, 13., 700.))
                .lines(1)
                .grow(),
            age,
        ];
        if let Some((_, count)) = group {
            head.push(
                Node::text(k("count"), count.to_string(), style(m.text, 11., 600.))
                    .ink(Ink::Secondary),
            );
        }
        let mut text = vec![
            Node::row(k("head"), head)
                .gap(Space::S2)
                .align(Align::Center),
        ];
        if !body.is_empty() {
            text.push(
                // Two lines however short, so every card of its kind is one height (TS).
                Node::text(k("body"), body, style(m.text, 12., 400.))
                    .lines(if expanded { 4 } else { 2 })
                    .reserve(if expanded { 0 } else { 2 })
                    .ink(Ink::Secondary),
            );
        }
        let mut actions = (expanded && !actions.is_empty()).then(|| {
            Node::row(
                k("actions"),
                actions
                    .iter()
                    .map(|a| {
                        Node::control(
                            format!("n{i}/act/{}", a.id),
                            a.label.clone(),
                            format!("act:{i}:{c}:{}", a.id),
                            Node::row(
                                format!("n{i}/act/{}/pad", a.id),
                                vec![
                                    Node::text(
                                        format!("n{i}/act/{}/text", a.id),
                                        a.label.clone(),
                                        style(m.text, 12., 400.),
                                    )
                                    .lines(1),
                                ],
                            )
                            .padding(Padding::symmetric(Space::S1, Space::S3)),
                        )
                    })
                    .collect(),
            )
            .gap(Space::S2)
        });
        if hero.is_none()
            && let Some(row) = actions.take()
        {
            text.push(row);
        }
        if !b.error.is_empty() {
            text.push(Node::text(k("error"), b.error.clone(), style(m.text, 12., 400.)).lines(2));
        }
        let mut row = vec![
            Node::icon(k("app"), "", ART),
            Node::column(k("text"), text).gap(Space::S1).grow(),
        ];
        if hero.is_none() && thumbnail(b).is_some() {
            row.push(Node::icon(k("thumb"), "", ART));
        }
        let mut body = vec![Node::row(k("row"), row).gap(Space::S3).align(Align::Center)];
        if let Some(h) = hero {
            body.push(Node::placeholder(k("hero"), h));
        }
        body.extend(actions);
        let open = match group {
            Some((key, _)) => format!("group:{key}"),
            None => format!("open:{i}:{c}"),
        };
        let content = Node::control(
            k("card"),
            match group {
                Some((_, n)) => format!("{title}, {n} notifications, expand"),
                None => title,
            },
            open,
            Node::column(k("body-col"), body)
                .gap(Space::S3)
                .padding(Padding::all(Space::S3)),
        )
        .description(said)
        .wash(Wash::None)
        .corner(Corner::Token(CARD))
        .swipe(close_action.clone());
        let close = Node::control(
            k("close"),
            match group {
                Some(_) => format!("Clear {}", b.notice.app_name),
                None => "Close notification".into(),
            },
            close_action,
            Node::row(
                k("close/pad"),
                vec![Node::icon(k("close/icon"), "nd-window-close", 13.)],
            )
            .padding(Padding::all(Space::S1)),
        )
        .wash(Wash::Destructive)
        .revealed_with(pane.clone());
        Node::pane(
            pane,
            Corner::Token(CARD),
            Node::overlay(k("over"), content).layer(
                Align::Start,
                Align::Start,
                Padding {
                    top: Some(Space::S1),
                    left: Some(Space::S1),
                    ..Padding::default()
                },
                close,
            ),
        )
    }

    /// Rebuilds the view from the history and the month shown, and lays it out. `cards`:
    /// where the cards lie (the list's scroll bar takes a lane right of them, up to `right`).
    #[allow(clippy::too_many_arguments)]
    pub fn refresh(
        &mut self,
        look: &mut Look,
        history: Arc<Vec<Banner>>,
        error: &str,
        month: (i32, i32),
        cards: [f64; 4],
        right: f64,
        scale: f64,
    ) {
        if self.appearance.as_ref() != Some(&look.appearance) {
            self.appearance = Some(look.appearance.clone());
            self.tokens = tokens(&look.exports, &look.appearance)
                .map_err(|e| eprintln!("nidara-shell: the NC view has no tokens: {e}"))
                .ok();
            self.state
                .set_reduced_motion(look.appearance.reduced_motion);
        }
        let style = look.styles.text.clone();
        let strings = Strings::of(look);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.error = error.into();
        self.lay(
            &mut look.text,
            &style,
            &strings,
            history,
            month,
            cards,
            right,
            scale,
            now,
        );
    }

    /// `refresh` once the look is read; `now` in seconds since the epoch.
    #[allow(clippy::too_many_arguments)]
    fn lay(
        &mut self,
        text: &mut dyn nk_text::TextBackend,
        style: &TextStyle,
        strings: &Strings,
        history: Arc<Vec<Banner>>,
        (year, month): (i32, i32),
        cards: [f64; 4],
        right: f64,
        scale: f64,
        now: u64,
    ) {
        let Some(tokens) = self.tokens.clone() else {
            return;
        };
        let live: HashSet<u64> = history.iter().map(|b| b.instance).collect();
        self.items_open.retain(|i| live.contains(i));
        let at = Instant::now();
        self.folding.retain(|_, until| *until > at);
        self.history = history;
        self.minute = now / 60;
        let today = glib::DateTime::now_local()
            .ok()
            .filter(|d| d.year() == year && d.month() == month)
            .map(|d| d.day_of_month());
        let month_name = glib::DateTime::from_local(year, month, 1, 0, 0, 0.)
            .ok()
            .and_then(|d| d.format("%B %Y").ok())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let lane = tokens.spacing.px(LANE);
        let bounds = [
            cards[0],
            cards[1],
            (cards[2] + lane).min(right - cards[0]).max(cards[2]),
            cards[3],
        ];
        self.bounds = bounds;
        self.width = cards[2];
        let weekdays = nc::weekday_labels();
        let history = self.history.clone();
        let view = self.view(&Model {
            history: &history,
            year,
            month,
            today,
            now,
            text: style,
            strings,
            weekdays: &weekdays,
            month_name: &month_name,
            error: &self.error,
        });
        self.state
            .layout_in(&view, bounds, scale, &tokens, text, Instant::now());
        self.list = self.state.rect(&Key::from("list")).unwrap_or([0.; 4]);
        self.built = self.window();
        for p in self.state.placed() {
            let k = &p.key.0;
            if matches!(p.what, nk_view::What::Pane(_))
                && (k.starts_with('n') || k.starts_with('f') || k.starts_with("g:"))
            {
                self.heights.insert(k.clone(), p.rect[3]);
                if k.starts_with('n') {
                    self.card_guess = p.rect[3];
                }
            }
        }
        self.heights.retain(|k, _| {
            k.starts_with("g:")
                || k[1..]
                    .split('/')
                    .next()
                    .and_then(|i| i.parse::<u64>().ok())
                    .is_some_and(|i| live.contains(&i))
        });
    }

    /// The list's offset and viewport height; before the first layout, its top and the
    /// whole view's height.
    fn window(&self) -> (f64, f64) {
        self.state
            .window(&Key::from("list"))
            .unwrap_or((0., self.bounds[3]))
    }

    /// Whether the list scrolled far enough from the window the view was built for that
    /// rows it left as placeholders may show: the surface rebuilds.
    pub fn stale(&self) -> bool {
        let (offset, viewport) = self.window();
        (offset - self.built.0).abs() > viewport / 2. || viewport != self.built.1
    }

    /// A frame of motion; Some when anything changed.
    pub fn tick(&mut self, text: &mut dyn nk_text::TextBackend) -> Option<Ticked> {
        let tokens = self.tokens.as_ref()?;
        self.state
            .animating()
            .then(|| self.state.tick(tokens, text, Instant::now()))
    }

    pub fn animating(&self) -> bool {
        self.state.animating()
    }

    pub fn contains(&self, p: (f64, f64)) -> bool {
        notification_card::inside(self.bounds, p)
    }

    pub fn key(&mut self, k: KeyInput) -> Option<Activated> {
        self.state.key(k)
    }

    pub fn scroll(&mut self, by: ScrollBy) -> bool {
        self.state.scroll(by)
    }

    /// What an activation means. Opening and closing a group or a card is the view's own.
    pub fn activated(&mut self, a: &Activated) -> Option<Act> {
        let s = a.action.as_str();
        let card = |rest: &str| -> Option<(u64, u64)> {
            let mut it = rest.splitn(2, ':');
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        };
        if let Some(key) = s.strip_prefix("group:") {
            if self.groups_open.remove(key) {
                // Its rows stay built while they roll up.
                let base = self
                    .tokens
                    .as_ref()
                    .map_or(Duration::ZERO, |t| t.motion.base);
                self.folding.insert(key.into(), Instant::now() + base);
            } else {
                self.groups_open.insert(key.into());
            }
            return Some(Act::Rebuild);
        }
        if let Some(key) = s.strip_prefix("clear-group:") {
            // The group's cards still showing leave one after another, then it is cleared.
            let cards: Vec<Key> = groups_of(&self.history)
                .into_iter()
                .find(|(k, _)| k == key)
                .map(|(_, list)| {
                    std::iter::once(Key::from(format!("g:{key}/toggle")))
                        .chain(list.iter().flat_map(|b| {
                            ['f', 'n'].map(|lead| Key::from(format!("{lead}{}/card", b.instance)))
                        }))
                        .collect()
                })
                .unwrap_or_default();
            return self.clear(&cards, nc::Target::ClearGroup(key.into()));
        }
        if s == "clear-all" {
            let cards: Vec<Key> = self
                .state
                .placed()
                .iter()
                .filter(|p| {
                    let k = &p.key.0;
                    k.ends_with("/card") && (k.starts_with('n') || k.starts_with('f'))
                        || k.starts_with("g:") && k.ends_with("/toggle")
                })
                .map(|p| p.key.clone())
                .collect();
            return self.clear(&cards, nc::Target::ClearAll);
        }
        if let Some(rest) = s.strip_prefix("cleared:") {
            let target = self.clearing.take()?;
            if let nc::Target::ClearGroup(key) = &target {
                self.groups_open.remove(key);
            }
            return (rest == "now").then_some(Act::Nc(target));
        }
        if let Some(i) = s.strip_prefix("item:").and_then(|i| i.parse().ok()) {
            if !self.items_open.remove(&i) {
                self.items_open.insert(i);
            }
            return Some(Act::Rebuild);
        }
        if let Some((i, c)) = s.strip_prefix("open:").and_then(card) {
            return Some(Act::Card(i, c, notification_card::Target::Body));
        }
        if let Some((i, c)) = s.strip_prefix("close:").and_then(card) {
            return Some(Act::Card(i, c, notification_card::Target::Close));
        }
        if let Some(rest) = s.strip_prefix("act:") {
            let mut it = rest.splitn(3, ':');
            let (i, c, id) = (it.next()?, it.next()?, it.next()?);
            return Some(Act::Card(
                i.parse().ok()?,
                c.parse().ok()?,
                notification_card::Target::Action(id.into()),
            ));
        }
        Some(Act::Nc(match s {
            "previous" => nc::Target::Previous,
            "next" => nc::Target::Next,
            "today" => nc::Target::Today,
            _ => return None,
        }))
    }

    /// Starts a clear: `cards` leave one after another, and the clear is carried out when
    /// the last is gone (`cleared:now` from the kit), or at once when none shows. A clear
    /// already under way is let finish.
    fn clear(&mut self, cards: &[Key], target: nc::Target) -> Option<Act> {
        if self.clearing.is_some() {
            return None;
        }
        self.clearing = Some(target);
        match self
            .state
            .cascade(cards, CASCADE, "cleared:now", Instant::now())
        {
            Some(done) => self.activated(&done),
            None => Some(Act::Motion),
        }
    }

    /// Closed: groups and cards fold back, and nothing is held. A clear still under way is
    /// returned, to be carried out now, as TS settled it when the centre closed.
    pub fn close(&mut self) -> Option<nc::Target> {
        self.groups_open.clear();
        self.items_open.clear();
        self.folding.clear();
        self.state.pointer_leave();
        self.clearing.take()
    }

    /// The panes and regions for Hyalo, from the frame `paint` declared: a collapsed group's
    /// ghost layers first, under its card, then the cards; each ghost cut to its band and to
    /// the list.
    pub fn glass(&self, tone: Tone, shadow: Shadow) -> (Vec<Group>, Vec<nk_wayland::StateRegion>) {
        let Some(tokens) = self.tokens.as_ref() else {
            return (vec![], vec![]);
        };
        let frame = &self.last;
        let radius = tokens.radii.px(CARD);
        let mut groups = vec![];
        for (key, list) in groups_of(&self.history) {
            if list.len() < 2 || self.groups_open.contains(&key) {
                continue;
            }
            let pane_key = Key::from(format!("f{}/pane", list[0].instance));
            let Some(fp) = frame.panes.iter().find(|p| p.key == pane_key) else {
                continue;
            };
            let r = [fp.pane.x, fp.pane.y, fp.pane.width, fp.pane.height];
            let bottom = r[1] + r[3];
            for i in (0..ghosts(list.len())).rev() {
                let inset = radius - 2. + i as f64 * 16.;
                let low = bottom + PEEK + i as f64 * STEP;
                let top = if i == 0 {
                    bottom
                } else {
                    bottom + PEEK + (i - 1) as f64 * STEP - 2.
                };
                let Some(band) = intersect([r[0], top, r[2], low - top], self.list) else {
                    continue;
                };
                groups.push(Group {
                    clip: Some(MaterialRect {
                        x: band[0],
                        y: band[1],
                        width: band[2],
                        height: band[3],
                    }),
                    opacity: fp.opacity * (1. - i as f64 * 0.12),
                    tone,
                    shadow,
                    shapes: vec![Pane {
                        x: r[0] + inset,
                        y: low - GHOST_H,
                        width: r[2] - inset * 2.,
                        height: GHOST_H,
                        radius,
                        exponent: 2.,
                        pointer: None,
                    }],
                });
            }
        }
        groups.extend(frame.groups(tone, shadow));
        (groups, frame.states.clone())
    }

    /// The content: the kit's paint, then each card's artwork in its slot.
    /// Declares this frame's panes and regions (`glass` reads them), and paints without the
    /// material protocol the washes too (D5).
    pub fn paint(
        &mut self,
        c: &mut Canvas,
        icons: &mut dyn FnMut(&str, f64) -> Option<Arc<nk_icons::Icon>>,
        art: &Artwork<'_>,
        material: bool,
    ) -> Result<(), String> {
        let Some(tokens) = self.tokens.as_ref() else {
            return Ok(());
        };
        self.last = self.state.frame(tokens, Instant::now());
        self.state
            .paint(c, tokens, icons, (!material).then_some(&self.last))?;
        for (p, slot, b, visible) in self.artwork() {
            let side = match slot {
                "hero" => art.pixels(p.rect[2].ceil() as u32),
                _ => art.pixels(64),
            };
            let asset = if slot == "app" {
                notification_card::app_asset(art, b)
            } else {
                thumbnail(b)
                    .and_then(|path| notification_card::asset_image(art.namespace, b, &path, side))
            };
            let Some(asset) = asset else {
                continue;
            };
            // The picture fades and slides with its card, as its text does.
            let fading = p.alpha < 1.;
            if fading {
                c.push_opacity(p.alpha);
            }
            c.clip(rect(visible));
            let (corner, fit) = match slot {
                "app" => (0., ImageFit::Contain),
                "thumb" => (ART * crate::geometry::ICON_CORNER, ImageFit::Contain),
                _ => (tokens.radii.px(HERO_CORNER), ImageFit::Cover),
            };
            if corner > 0. {
                c.clip_rounded_rect(rect(p.rect), corner);
            }
            c.image(&asset.raster, rect(p.rect), fit);
            if corner > 0. {
                c.pop_clip();
            }
            c.pop_clip();
            if fading {
                c.pop_opacity();
            }
        }
        Ok(())
    }

    /// Each card's artwork this frame: its slot (`app`, `thumb` or `hero`), its notice and
    /// what of it shows. Everything that shows is drawn, at its card's opacity, so a card
    /// leaving or unrolling takes its pictures with it.
    fn artwork(&self) -> Vec<(&nk_view::Placed, &str, &Banner, nk_view::Rect)> {
        self.state
            .placed()
            .iter()
            .filter_map(|p| {
                let (instance, slot) = p.key.0.strip_prefix(['n', 'f'])?.split_once('/')?;
                if !matches!(slot, "app" | "thumb" | "hero") || p.alpha <= 0. {
                    return None;
                }
                let visible = p.visible()?;
                let i = instance.parse::<u64>().ok()?;
                let b = self.history.iter().find(|b| b.instance == i)?;
                Some((p, slot, b, visible))
            })
            .collect()
    }

    /// The semantics, under a panel named for the centre; its ids start at `first_id`.
    pub fn semantics(&mut self, first_id: u64) -> nk_a11y::Tree {
        let mut root = nk_a11y::Node::new(nc::PANEL, nk_a11y::Role::Panel, "Notification Center");
        root.description = self.error.clone();
        root.bounds = nk_a11y::Bounds {
            x: self.bounds[0],
            y: self.bounds[1],
            width: self.bounds[2],
            height: self.bounds[3],
        };
        let tree = self.state.semantics(root, first_id);
        self.ids = self.state.semantic_keys();
        tree
    }

    /// Whether a semantic id is one of the centre's controls.
    pub fn knows(&self, id: u64) -> bool {
        self.ids.contains_key(&id)
    }

    /// A reader's request on one of the centre's controls: None when the id is not the
    /// centre's; else what an activation asks for, if anything.
    pub fn request(&mut self, id: u64, activate: bool) -> Option<Option<Activated>> {
        let key = self.ids.get(&id)?.clone();
        Some(self.state.request(&key, activate))
    }

    /// The first pane the last frame declared: the material's base when the bar's own
    /// capsules are hidden.
    pub fn first_pane(&self) -> Option<Pane> {
        self.last.panes.first().map(|p| p.pane)
    }
}

fn groups_of(history: &[Banner]) -> Vec<(String, Vec<Banner>)> {
    groups(history)
        .into_iter()
        .map(|(k, l)| (k, l.into_iter().cloned().collect()))
        .collect()
}

/// The picture a notice carries beside its text, when there is one to show: a local file
/// that exists, as TS's `heroImagePath` had it. An icon name (Pamac sends
/// `system-software-install-symbolic`) is not a picture, and a sender's temporary file may be
/// gone (Edge's `/tmp/…scoped_dir…`); either way the card keeps no room for it.
fn thumbnail(b: &Banner) -> Option<String> {
    let image = match b.notice.hint("image-path") {
        "" => b.notice.hint("image_path"),
        image => image,
    };
    let path = match image.strip_prefix("file://") {
        Some(_) => glib::filename_from_uri(image).ok()?.0,
        None => std::path::PathBuf::from(image),
    };
    (path.is_absolute() && path.is_file()).then(|| path.to_string_lossy().into_owned())
}

fn intersect(a: [f64; 4], b: [f64; 4]) -> Option<[f64; 4]> {
    let x = a[0].max(b[0]);
    let y = a[1].max(b[1]);
    let r = (a[0] + a[2]).min(b[0] + b[2]);
    let d = (a[1] + a[3]).min(b[1] + b[3]);
    (r > x && d > y).then_some([x, y, r - x, d - y])
}

fn rect(r: [f64; 4]) -> Rect {
    Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}

/// The exported tokens in the dark skin, for tests; None (skipped) without an export.
#[cfg(test)]
pub(crate) fn exported_tokens() -> Option<Tokens> {
    let root = std::env::var_os("NK_SETTINGS_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    if !root.join("version").exists() {
        assert!(
            std::env::var_os("NK_REQUIRE_EXPORT").is_none(),
            "NK_REQUIRE_EXPORT set and no build/settings-data"
        );
        eprintln!("skipped: no build/settings-data");
        return None;
    }
    let e = nk_settings::exports::Exports::load(&root).unwrap();
    let set = e.colors["sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["dark"] == true && s["reduceTransparency"] == false)
        .unwrap();
    let hex = e.colors["accents"][set["accent"].as_str().unwrap()]
        .as_str()
        .unwrap();
    let c = nk_view::parse_color(hex).unwrap().components;
    let appearance = nk_settings::portal::Appearance {
        accent: [c[0] as f64, c[1] as f64, c[2] as f64],
        dark: true,
        reduce_transparency: false,
        window_background: set["windowBackground"].as_str().unwrap().into(),
        reduced_motion: false,
        font: "Sans 11".into(),
        text_scale: 1.,
    };
    Some(tokens(&e, &appearance).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nk_view::What;

    fn banner(instance: u64, app: &str, time: u64, extra: serde_json::Value) -> Banner {
        let mut notice = serde_json::json!({"id": instance, "app_name": app,
            "summary": format!("Summary {instance}"), "body": "Body", "time": time,
            "hints": {"desktop-entry": app}});
        if let (Some(n), Some(e)) = (notice.as_object_mut(), extra.as_object()) {
            n.extend(e.clone());
        }
        Banner {
            notice: crate::notifications::Notice::parse(&notice.to_string()).unwrap(),
            instance,
            content: 1,
            output: "a".into(),
            deadline: None,
            hovered: false,
            error: String::new(),
        }
    }

    /// The exported tokens, as the Settings tests read them; None (skipped) without an
    /// export unless CI requires one.
    fn exported() -> Option<Tokens> {
        exported_tokens()
    }
    fn laid(history: Vec<Banner>, setup: impl FnOnce(&mut View)) -> Option<View> {
        let mut p = View {
            tokens: Some(exported()?),
            ..View::default()
        };
        setup(&mut p);
        let mut text =
            nk_text::ParleyBackend::new(Arc::new(nk_text::FontSet::discover_required().unwrap()))
                .unwrap();
        let strings = Strings {
            empty: "No notifications".into(),
            clear_all: "Clear notifications".into(),
        };
        p.lay(
            &mut text,
            &TextStyle::default(),
            &strings,
            Arc::new(history),
            (2026, 11),
            [900., 60., notification_card::WIDTH, 900.],
            1300.,
            1.,
            2_000_000_000,
        );
        Some(p)
    }

    fn panes(p: &View) -> Vec<String> {
        p.state
            .placed()
            .iter()
            .filter(|q| matches!(q.what, What::Pane(_)))
            .map(|q| q.key.0.clone())
            .collect()
    }

    #[test]
    fn plain_strips_tags_before_decoding_entities() {
        assert_eq!(plain("<b>Hi</b> &amp;lt;x&gt;"), "Hi &lt;x>");
        assert_eq!(plain("a\n  b &#x41;&#66; & c"), "a b AB & c");
        assert_eq!(plain("&bogus; &#0;"), "&bogus; &#0;");
    }

    #[test]
    fn groups_are_newest_first_and_leave_transient_notices_out() {
        let history = vec![
            banner(1, "mail", 10, serde_json::json!({})),
            banner(2, "chat", 30, serde_json::json!({})),
            banner(3, "mail", 20, serde_json::json!({})),
            banner(
                4,
                "mail",
                40,
                serde_json::json!({"hints": {"transient": true}}),
            ),
        ];
        let g = groups(&history);
        let order: Vec<_> = g
            .iter()
            .map(|(k, l)| (k.as_str(), l.iter().map(|b| b.instance).collect::<Vec<_>>()))
            .collect();
        assert_eq!(order, [("chat", vec![2]), ("mail", vec![3, 1])]);
    }

    #[test]
    fn each_notification_or_group_is_its_own_card_and_the_calendar_another() {
        let history = vec![
            banner(1, "mail", 10, serde_json::json!({})),
            banner(2, "chat", 30, serde_json::json!({})),
            banner(3, "mail", 20, serde_json::json!({})),
        ];
        let Some(p) = laid(history.clone(), |_| {}) else {
            return;
        };
        // One pane per card, never one around them all: the calendar, chat's card, mail's
        // front card (its older one hidden in the stack), the clear pill.
        assert_eq!(panes(&p), ["calendar", "n2/pane", "f3/pane", "clear"]);
        let card = p.state.rect(&Key::from("n2/pane")).unwrap();
        assert_eq!((card[0], card[2]), (900., notification_card::WIDTH));
        let a = p.state.rect(&Key::from("n2/pane")).unwrap();
        let b = p.state.rect(&Key::from("f3/pane")).unwrap();
        assert!(b[1] >= a[1] + a[3] + 16., "a gap between the cards");
        // Opened, the group shows its header and both cards.
        let Some(mut p) = laid(history, |p| {
            p.groups_open.insert("mail".into());
        }) else {
            return;
        };
        assert_eq!(
            panes(&p),
            [
                "calendar",
                "n2/pane",
                "g:mail/header",
                "n3/pane",
                "n1/pane",
                "clear"
            ]
        );
        // The header's control folds it again.
        let a = Activated {
            key: Key::from("g:mail/toggle"),
            action: "group:mail".into(),
        };
        assert_eq!(p.activated(&a), Some(Act::Rebuild));
        assert!(!p.groups_open.contains("mail"));
    }

    #[test]
    fn a_collapsed_group_lays_its_ghosts_under_its_card_cut_to_their_band() {
        let history: Vec<_> = (1..=3)
            .map(|i| banner(i, "mail", i * 10, serde_json::json!({})))
            .collect();
        let Some(mut p) = laid(history.clone(), |_| {}) else {
            return;
        };
        let mut canvas = Canvas::new(1400, 1000, 1.);
        let art = Artwork {
            theme: "",
            catalogue: &HashMap::new(),
            namespace: "test",
            scale: 1.,
        };
        p.paint(&mut canvas, &mut |_, _| None, &art, true).unwrap();
        let tone = Tone {
            saturation: 1.,
            ceiling: 1.,
            lift: 0.,
            gain: 1.,
            wash: [0.; 4],
            ambient: 0.,
            ambient_lift: 0.,
            ambient_gain: 0.,
        };
        let shadow = Shadow {
            opacity_small: 0.,
            opacity_large: 0.,
            blur_small: 0.,
            blur_large: 0.,
            offset: 0.,
        };
        let (groups, _) = p.glass(tone, shadow);
        let card = p.state.rect(&Key::from("f3/pane")).unwrap();
        let bottom = card[1] + card[3];
        // Two ghosts (three in the group), deepest first, then the panes in their groups.
        let ghosts: Vec<_> = groups
            .iter()
            .take_while(|g| g.shapes.len() == 1 && g.shapes[0].y + g.shapes[0].height > bottom)
            .collect();
        assert_eq!(ghosts.len(), 2);
        let clip = |g: &Group| g.clip.unwrap();
        assert!(clip(ghosts[1]).y == bottom && clip(ghosts[1]).height == PEEK);
        assert!(clip(ghosts[0]).y < bottom + PEEK);
        assert!(ghosts[0].shapes[0].width < ghosts[1].shapes[0].width);
        assert!(ghosts[0].opacity < ghosts[1].opacity);
        // The list leaves room for them: the clear pill starts below the deepest.
        let pill = p.state.rect(&Key::from("clear")).unwrap();
        assert!(pill[1] >= bottom + PEEK + STEP);
        // Cards and their ghosts take the CC's 4×1 corner.
        let corner = crate::cc::wide_radius();
        let front = groups
            .iter()
            .flat_map(|g| &g.shapes)
            .find(|s| s.x == card[0] && s.y == card[1] && s.width == card[2])
            .expect("the front card's pane");
        assert_eq!(front.radius, corner);
        assert!(ghosts.iter().all(|g| g.shapes[0].radius == corner));
        // A group of two has one ghost; a lone card none.
        let Some(mut p) = laid(history[..2].to_vec(), |_| {}) else {
            return;
        };
        p.paint(&mut canvas, &mut |_, _| None, &art, true).unwrap();
        let n = p.glass(tone, shadow).0.len() - p.last.groups(tone, shadow).len();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_long_open_group_builds_only_the_rows_near_the_window() {
        let history: Vec<_> = (1..=300)
            .map(|i| banner(i, "mail", i, serde_json::json!({})))
            .collect();
        let open = |p: &mut View| {
            p.groups_open.insert("mail".into());
        };
        let Some(mut p) = laid(history.clone(), open) else {
            return;
        };
        let built = |p: &View| -> Vec<u64> {
            p.state
                .placed()
                .iter()
                .filter(|q| matches!(q.what, What::Pane(_)))
                .filter_map(|q| {
                    q.key
                        .0
                        .strip_prefix('n')?
                        .strip_suffix("/pane")?
                        .parse()
                        .ok()
                })
                .collect()
        };
        let first = built(&p);
        assert!(first.contains(&300), "the newest is built");
        assert!(first.len() < 40, "{} cards built of 300", first.len());
        // Placeholders keep the list its whole height: it scrolls as far as 300 cards go.
        let laid_out = |p: &mut View| {
            let mut text = nk_text::ParleyBackend::new(Arc::new(
                nk_text::FontSet::discover_required().unwrap(),
            ))
            .unwrap();
            let strings = Strings {
                empty: String::new(),
                clear_all: "Clear notifications".into(),
            };
            p.lay(
                &mut text,
                &TextStyle::default(),
                &strings,
                Arc::new(history.clone()),
                (2026, 11),
                [900., 60., notification_card::WIDTH, 900.],
                1300.,
                1.,
                2_000_000_000,
            );
            text
        };
        let mut text = laid_out(&mut p);
        for _ in 0..20 {
            p.key(KeyInput::PageDown);
        }
        p.tick(&mut text);
        assert!(p.stale(), "scrolled past what was built");
        assert!(p.window().0 > 10_000., "{:?}", p.window());
        laid_out(&mut p);
        assert!(!p.stale());
        let later = built(&p);
        assert!(!later.contains(&300) && !later.is_empty(), "{later:?}");
        assert!(later.len() < 40);
    }

    #[test]
    fn activations_name_the_card_and_the_action_whole() {
        let mut p = View::default();
        let a = |action: &str| Activated {
            key: Key::from("k"),
            action: action.into(),
        };
        use notification_card::Target as T;
        assert_eq!(p.activated(&a("open:7:2")), Some(Act::Card(7, 2, T::Body)));
        assert_eq!(
            p.activated(&a("close:7:2")),
            Some(Act::Card(7, 2, T::Close))
        );
        assert_eq!(
            p.activated(&a("act:7:2:reply:now")),
            Some(Act::Card(7, 2, T::Action("reply:now".into())))
        );
        assert_eq!(
            p.activated(&a("clear-group:org.app:x")),
            Some(Act::Nc(nc::Target::ClearGroup("org.app:x".into())))
        );
        assert_eq!(
            p.activated(&a("previous")),
            Some(Act::Nc(nc::Target::Previous))
        );
        assert_eq!(p.activated(&a("item:7")), Some(Act::Rebuild));
        assert!(p.items_open.contains(&7));
        assert_eq!(p.activated(&a("")), None);
    }

    fn text() -> nk_text::ParleyBackend {
        nk_text::ParleyBackend::new(Arc::new(nk_text::FontSet::discover_required().unwrap()))
            .unwrap()
    }
    /// What the kit reports by `at`, each acted on as the bar does.
    fn run_to(p: &mut View, at: Instant) -> Vec<Act> {
        let tokens = p.tokens.clone().unwrap();
        let done = p.state.tick(&tokens, &mut text(), at).activated;
        done.iter().filter_map(|a| p.activated(a)).collect()
    }
    fn card_alpha(p: &View, key: &str) -> f64 {
        p.state
            .placed()
            .iter()
            .find(|q| q.key.0 == key)
            .map_or(-1., |q| q.alpha)
    }
    fn singles(n: u64) -> Vec<Banner> {
        (1..=n)
            .map(|i| banner(i, &format!("app{i}"), i * 10, serde_json::json!({})))
            .collect()
    }

    #[test]
    fn clear_all_sends_the_cards_off_one_after_another_then_clears_once() {
        let Some(mut p) = laid(singles(3), |_| {}) else {
            return;
        };
        let t0 = Instant::now();
        let clear = Activated {
            key: Key::from("clear-all"),
            action: "clear-all".into(),
        };
        assert_eq!(p.activated(&clear), Some(Act::Motion));
        assert_eq!(p.activated(&clear), None, "a clear under way is let finish");
        let base = p.tokens.as_ref().unwrap().motion.base;
        // The newest (top) leaves first; the clear waits for the last.
        assert!(run_to(&mut p, t0 + base + CASCADE / 2).is_empty());
        assert_eq!(card_alpha(&p, "n3/pane"), 0., "the top card is gone");
        assert!(card_alpha(&p, "n1/pane") > 0., "the bottom one still shows");
        let done = run_to(&mut p, t0 + base + CASCADE * 3);
        assert_eq!(done, [Act::Nc(nc::Target::ClearAll)]);
        assert!(p.clearing.is_none());
    }

    #[test]
    fn a_centre_closed_mid_clear_carries_the_clear_out_at_once() {
        let Some(mut p) = laid(singles(2), |_| {}) else {
            return;
        };
        let clear = Activated {
            key: Key::from("clear-all"),
            action: "clear-all".into(),
        };
        assert_eq!(p.activated(&clear), Some(Act::Motion));
        assert_eq!(p.close(), Some(nc::Target::ClearAll));
        assert_eq!(p.close(), None, "and only once");
    }

    #[test]
    fn a_group_cleared_sends_its_header_and_cards_off_and_clears_only_it() {
        let mut history: Vec<_> = (1..=3)
            .map(|i| banner(i, "mail", i * 10, serde_json::json!({})))
            .collect();
        history.push(banner(9, "chat", 5, serde_json::json!({})));
        let Some(mut p) = laid(history, |p| {
            p.groups_open.insert("mail".into());
        }) else {
            return;
        };
        let t0 = Instant::now();
        let a = Activated {
            key: Key::from("g:mail/clear"),
            action: "clear-group:mail".into(),
        };
        assert_eq!(p.activated(&a), Some(Act::Motion));
        let base = p.tokens.as_ref().unwrap().motion.base;
        let done = run_to(&mut p, t0 + base + CASCADE * 4);
        assert_eq!(done, [Act::Nc(nc::Target::ClearGroup("mail".into()))]);
        for k in ["g:mail/header", "n3/pane", "n2/pane", "n1/pane"] {
            assert_eq!(card_alpha(&p, k), 0., "{k} left");
        }
        assert!(card_alpha(&p, "n9/pane") > 0., "the other app stays");
        assert!(!p.groups_open.contains("mail"));
    }

    #[test]
    fn a_group_folding_keeps_its_rows_built_until_they_have_rolled_up() {
        let history: Vec<_> = (1..=3)
            .map(|i| banner(i, "mail", i * 10, serde_json::json!({})))
            .collect();
        let Some(mut p) = laid(history.clone(), |p| {
            p.groups_open.insert("mail".into());
        }) else {
            return;
        };
        let fold = Activated {
            key: Key::from("g:mail/toggle"),
            action: "group:mail".into(),
        };
        let t0 = Instant::now();
        assert_eq!(p.activated(&fold), Some(Act::Rebuild));
        // Its rows stay built for the reveal's closing (`dur-base`). The deadline is held off
        // here: laying out below looks fonts up, which under a loaded test run can outlast it.
        let base = p.tokens.as_ref().unwrap().motion.base;
        let until = p.folding["mail"];
        assert!(until >= t0 + base && until <= Instant::now() + base);
        p.folding
            .insert("mail".into(), Instant::now() + Duration::from_secs(60));
        let relay = |p: &mut View| {
            let strings = Strings {
                empty: String::new(),
                clear_all: "Clear notifications".into(),
            };
            p.lay(
                &mut text(),
                &TextStyle::default(),
                &strings,
                Arc::new(history.clone()),
                (2026, 11),
                [900., 60., notification_card::WIDTH, 900.],
                1300.,
                1.,
                2_000_000_000,
            );
        };
        relay(&mut p);
        // The front is the stacked card again, and the rows are still there, rolling up.
        assert!(panes(&p).contains(&"f3/pane".to_string()));
        assert!(
            panes(&p).contains(&"n1/pane".to_string()),
            "{:?}",
            panes(&p)
        );
        assert!(p.state.animating(), "the reveal closes");
        // Once rolled up, a rebuild leaves them out.
        for until in p.folding.values_mut() {
            *until = Instant::now();
        }
        relay(&mut p);
        assert!(!panes(&p).contains(&"n1/pane".to_string()));
        // Opening unrolls them from the front.
        let open = Activated {
            key: Key::from("f3/card"),
            action: "group:mail".into(),
        };
        assert_eq!(p.activated(&open), Some(Act::Rebuild));
        relay(&mut p);
        assert!(panes(&p).contains(&"g:mail/header".to_string()));
        assert!(p.state.animating(), "the reveal opens");
    }

    #[test]
    fn every_card_reserves_two_body_lines_and_its_chevron_takes_the_ages_place() {
        let long = "A body long enough to need both of its lines and then a good deal more, \
            so that it is cut with an ellipsis and offers to show the rest of it.";
        let history = vec![
            banner(1, "a", 10, serde_json::json!({"body": "Short"})),
            banner(2, "b", 20, serde_json::json!({"body": long})),
        ];
        let Some(mut p) = laid(history, |_| {}) else {
            return;
        };
        let h = |p: &View, k: &str| p.state.rect(&Key::from(k)).unwrap()[3];
        assert_eq!(h(&p, "n1/pane"), h(&p, "n2/pane"), "one height");
        // The long one offers more; at rest its age shows, hovered its chevron instead.
        let i = |p: &View, k: &str| p.state.placed().iter().position(|q| q.key.0 == k).unwrap();
        let (age, more) = (i(&p, "n2/age"), i(&p, "n2/more"));
        assert!(p.state.shown(age) && !p.state.shown(more));
        let r = p.state.rect(&Key::from("n2/pane")).unwrap();
        p.state.pointer_motion(r[0] + r[2] / 2., r[1] + r[3] / 2.);
        assert!(!p.state.shown(age) && p.state.shown(more));
        assert!(p.state.placed().iter().all(|q| q.key.0 != "n1/more"));
    }

    #[test]
    fn only_a_picture_that_exists_keeps_room_beside_the_text() {
        let dir = std::env::temp_dir().join(format!("nk-nc-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let there = dir.join("there.png");
        std::fs::write(&there, b"").unwrap();
        let hint = |path: &str| serde_json::json!({"hints": {"image-path": path}});
        let history = vec![
            // Pamac: an icon name; Edge: a temporary file already gone.
            banner(1, "a", 10, hint("system-software-install-symbolic")),
            banner(2, "b", 20, hint(&dir.join("gone.png").to_string_lossy())),
            banner(3, "c", 30, hint(&format!("file://{}", there.display()))),
            banner(
                4,
                "d",
                40,
                serde_json::json!({"hints": {"image_path": there}}),
            ),
        ];
        assert_eq!(thumbnail(&history[0]), None);
        assert_eq!(thumbnail(&history[1]), None);
        let path = Some(there.to_string_lossy().into_owned());
        assert_eq!(thumbnail(&history[2]), path);
        assert_eq!(thumbnail(&history[3]), path);
        let laid = laid(history, |_| {});
        std::fs::remove_dir_all(&dir).unwrap();
        let Some(p) = laid else {
            return;
        };
        let thumbs: Vec<_> = (1..=4)
            .filter(|i| {
                p.state
                    .rect(&Key::from(format!("n{i}/thumb").as_str()))
                    .is_some()
            })
            .collect();
        assert_eq!(thumbs, [3, 4]);
    }

    /// A directory of test pictures: `big.png` 400×200, `small.png` 100×100.
    fn pictures() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nk-nc-hero-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        image::RgbaImage::new(400, 200)
            .save(dir.join("big.png"))
            .unwrap();
        image::RgbaImage::new(100, 100)
            .save(dir.join("small.png"))
            .unwrap();
        dir
    }

    #[test]
    fn an_open_card_spans_a_big_picture_under_its_text_with_its_actions_under_that() {
        let dir = pictures();
        let with = |name: &str, actions: serde_json::Value| serde_json::json!({"hints": {"image-path": dir.join(name)}, "actions": actions});
        let reply = serde_json::json!([{"id": "reply", "label": "Reply"}]);
        let history = vec![
            banner(1, "a", 10, with("big.png", reply.clone())),
            banner(2, "b", 20, with("small.png", reply)),
            banner(3, "c", 30, with("big.png", serde_json::json!([]))),
        ];
        let shut = laid(history.clone(), |_| {});
        let open = laid(history, |p| {
            p.items_open.extend([1, 2]);
        });
        std::fs::remove_dir_all(&dir).unwrap();
        let (Some(shut), Some(open)) = (shut, open) else {
            return;
        };
        let at = |p: &View, k: &str| p.state.rect(&Key::from(k));
        // Shut, every picture is a thumbnail; a big one makes its card one to open.
        for i in 1..=3 {
            assert!(at(&shut, &format!("n{i}/thumb")).is_some());
            assert!(at(&shut, &format!("n{i}/hero")).is_none());
        }
        assert!(
            at(&shut, "n3/more").is_some(),
            "a big picture is worth opening"
        );
        // Open, the big one spans the card under the text, at its own proportions.
        assert!(at(&open, "n1/thumb").is_none());
        let hero = at(&open, "n1/hero").expect("the picture across the card");
        let card = at(&open, "n1/pane").unwrap();
        let pad = open.tokens.as_ref().unwrap().spacing.px(Space::S3);
        assert!(
            (hero[2] - (card[2] - 2. * pad)).abs() <= 1.,
            "{hero:?} in {card:?}"
        );
        assert!((hero[3] - (hero[2] / 2.).round().clamp(72., 200.)).abs() <= 1.);
        let row = at(&open, "n1/row").unwrap();
        assert!(hero[1] >= row[1] + row[3]);
        let act = at(&open, "n1/act/reply").unwrap();
        assert!(
            act[1] >= hero[1] + hero[3],
            "the actions sit under the picture"
        );
        // A small picture stays a thumbnail, its actions under its text.
        assert!(at(&open, "n2/hero").is_none() && at(&open, "n2/thumb").is_some());
        let text = at(&open, "n2/text").unwrap();
        let act = at(&open, "n2/act/reply").unwrap();
        assert!(act[1] + act[3] <= text[1] + text[3]);
    }

    #[test]
    fn a_cards_pictures_go_with_it_as_it_is_swiped() {
        let dir = pictures();
        let hint = serde_json::json!({"hints": {"image-path": dir.join("small.png")}});
        let cards: Vec<_> = (0..2)
            .map(|_| laid(vec![banner(1, "a", 10, hint.clone())], |_| {}))
            .collect();
        std::fs::remove_dir_all(&dir).unwrap();
        // Dragged 300 px either way, the card shows at under half, and so does each picture
        // still in view: the one on the side it leaves by is cut off by the list's edge.
        for (p, dx, slot) in cards
            .into_iter()
            .zip([(300., "app"), (-300., "thumb")])
            .map(|(p, (dx, s))| (p, dx, s))
        {
            let Some(mut p) = p else {
                return;
            };
            let r = p.state.rect(&Key::from("n1/pane")).unwrap();
            let (x, y) = (r[0] + r[2] / 2., r[1] + r[3] / 2.);
            p.state.pointer_motion(x, y);
            p.state.button(true, Instant::now());
            p.state.pointer_motion(x + dx, y);
            let title = card_alpha(&p, "n1/title");
            assert!(title > 0. && title < 0.5, "{title}");
            let art: Vec<_> = p
                .artwork()
                .iter()
                .map(|(q, slot, ..)| (slot.to_string(), q.alpha))
                .collect();
            assert!(art.iter().any(|(s, _)| s == slot), "dragged {dx}: {art:?}");
            assert!(
                art.iter().all(|&(_, a)| a == title),
                "dragged {dx}: {art:?}"
            );
        }
    }

    #[test]
    fn a_failed_clear_is_said_under_the_list_and_to_readers() {
        let Some(mut p) = laid(singles(1), |p| {
            p.error = "Could not clear notifications".into();
        }) else {
            return;
        };
        let at = p.state.rect(&Key::from("error")).expect("the error shows");
        let pill = p.state.rect(&Key::from("clear")).unwrap();
        assert!(at[1] < pill[1], "above the clear pill");
        let tree = p.semantics(nc::PANEL + 1);
        assert_eq!(
            tree.nodes[&nc::PANEL].description,
            "Could not clear notifications"
        );
        // A card's reader hears its age and body after its title.
        let card = tree.nodes.values().find(|n| n.name == "Summary 1").unwrap();
        assert!(card.description.ends_with(", Body"), "{}", card.description);
        assert!(card.description.len() > ", Body".len());
    }
}
