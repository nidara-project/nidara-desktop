// SPDX-License-Identifier: LGPL-3.0-or-later
//! The gallery's view (VIEW.md §13.3): a sidebar of pages and the current page, every piece
//! of it a kit node. A page shows one component in each of its states side by side, with
//! the catalogue entries it answers and their GTK and AppKit equivalents.
use nk_view::{
    Align, Cell, Corner, Field, Ink, Justify, Node, Padding, Radius, Role, SettingRow, Shown,
    SidebarEntry, Slider, SliderEnd, SliderStyle, Space, Type, TypeScale, Wash, Weight,
};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct Catalogue {
    pub groups: Vec<Group>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Group {
    pub name: String,
    pub items: Vec<Item>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Item {
    pub name: String,
    pub gtk: String,
    pub appkit: String,
    pub status: String,
    #[serde(default)]
    pub users: String,
    #[serde(default)]
    pub page: Option<String>,
}

impl Catalogue {
    pub fn load() -> Result<Self, String> {
        serde_json::from_str(include_str!("../catalogue.json")).map_err(|e| e.to_string())
    }
    fn on_page(&self, page: &str) -> Vec<&Item> {
        self.groups
            .iter()
            .flat_map(|g| &g.items)
            .filter(|i| i.page.as_deref() == Some(page))
            .collect()
    }
}

/// What a status means, as the status page says it.
fn status_text(s: &str) -> &'static str {
    match s {
        "view" => "In the kit",
        "both" => "Two copies",
        "widgets" => "Old layer only",
        "hand" => "By hand",
        _ => "Missing",
    }
}

/// Each page: its id (what the check and `--page` name), its title and its glyph.
pub const PAGES: [(&str, &str, &str); 15] = [
    ("status", "Status", "nd-emblem-default"),
    ("button", "Button", "nd-hand"),
    ("switch", "Switch", "nd-light-mode"),
    ("check", "Checkbox and radio", "nd-preferences-desktop"),
    ("row", "Setting row", "nd-preferences-system"),
    ("slider", "Slider", "nd-display-brightness"),
    ("field", "Text field", "nd-input-keyboard"),
    ("glass", "Glass card", "nd-preferences-desktop-theme"),
    ("text", "Text", "nd-clipboard-list"),
    ("icons", "Icons", "nd-globe"),
    ("layout", "Layout", "nd-dock"),
    ("scroll", "Scroll", "nd-pan-down"),
    ("overlay", "Overlay", "nd-sidebar-show"),
    ("grid", "Grid", "nd-control-center"),
    ("reveal", "Reveal", "nd-pan-end"),
];

/// What the view is built from: the page, and what the live samples hold.
pub struct Model {
    pub page: usize,
    pub switch: bool,
    pub check: bool,
    /// The slider row's sample (Brightness).
    pub bright: f64,
    /// The activatable rows' samples: a page opened, a setting flipped by its whole row.
    pub opened: u32,
    pub row_on: bool,
    /// The radio group's choice.
    pub choice: usize,
    pub toggle: bool,
    pub presses: u32,
    pub slider: f64,
    pub tile: f64,
    pub open: bool,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            page: 0,
            switch: true,
            check: false,
            bright: 70.,
            opened: 0,
            row_on: false,
            choice: 1,
            toggle: false,
            presses: 0,
            slider: 40.,
            tile: 60.,
            open: false,
        }
    }
}

/// The kit's measures a page needs besides its type: the slider's, and the frame's glyph size.
pub struct Measures<'a> {
    pub slider: &'a SliderStyle,
    pub glyph: f64,
}

pub fn view(m: &Model, cat: &Catalogue, t: &TypeScale, k: &Measures) -> View {
    let sl = k.slider;
    let nav = PAGES
        .iter()
        .enumerate()
        .map(|(i, (id, title, glyph))| {
            Node::sidebar_entry(
                format!("nav/{id}"),
                SidebarEntry {
                    title: (*title).into(),
                    glyph: (*glyph).into(),
                    action: format!("page:{id}"),
                    selected: m.page == i,
                    style: t.style(Type::Body, Weight::Regular),
                },
                k.glyph,
            )
        })
        .collect();
    // The sidebar's list; the window's frame (nk-view FrameStyle) puts it in its glass.
    let sidebar = Node::scroll(
        "side/scroll",
        Node::column("side/pages", nav)
            .gap(Space::S1)
            .padding(Padding::all(Space::S2)),
    );
    let (id, title, _) = PAGES[m.page.min(PAGES.len() - 1)];
    let mut body = vec![header(id, cat, t)];
    body.extend(page(id, m, cat, t, sl));
    let content = Node::column(format!("page/{id}"), body)
        .gap(Space::S5)
        .padding(Padding {
            top: None,
            right: Some(Space::S6),
            bottom: Some(Space::S6),
            left: Some(Space::S6),
        });
    View {
        sidebar,
        content,
        title,
    }
}

/// What the window's frame is given: its sidebar, its content and the band's title.
pub struct View {
    pub sidebar: Node,
    pub content: Node,
    pub title: &'static str,
}

/// What a page answers in the catalogue; its title is the band's.
fn header(id: &str, cat: &Catalogue, t: &TypeScale) -> Node {
    let items = cat.on_page(id);
    let mut lines = vec![];
    if !items.is_empty() {
        let names = items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>();
        let gtk = items.iter().map(|i| i.gtk.as_str()).collect::<Vec<_>>();
        let appkit = items.iter().map(|i| i.appkit.as_str()).collect::<Vec<_>>();
        let statuses = items
            .iter()
            .map(|i| format!("{}: {}", i.name, status_text(&i.status)))
            .collect::<Vec<_>>();
        for (k, text) in [
            ("names", format!("Catalogue: {}", names.join(", "))),
            ("gtk", format!("GTK: {}", gtk.join(", "))),
            ("appkit", format!("AppKit: {}", appkit.join(", "))),
            ("status", statuses.join(" · ")),
        ] {
            lines.push(
                Node::text(
                    format!("head/{k}"),
                    text,
                    t.style(Type::Small, Weight::Regular),
                )
                .ink(Ink::Secondary)
                .lines(3),
            );
        }
    }
    Node::column("head", lines).gap(Space::S1)
}

/// One labelled section, as Settings' groups: the caption over a card on the window's
/// background (not glass: glass is for what lies over content), holding what it shows.
fn section(key: &str, caption: &str, t: &TypeScale, child: Node) -> Node {
    Node::column(
        format!("s/{key}"),
        vec![
            Node::text(
                format!("s/{key}/cap"),
                caption,
                t.style(Type::Caption, Weight::Semibold),
            )
            .ink(Ink::Secondary),
            Node::group(
                format!("s/{key}/card"),
                Node::column(format!("s/{key}/col"), vec![child]).padding(Padding::all(Space::S4)),
            ),
        ],
    )
    .gap(Space::S2)
}

/// A sample with its state named under it.
fn sample(key: &str, label: &str, t: &TypeScale, child: Node) -> Node {
    Node::column(
        format!("{key}/sample"),
        vec![
            child,
            Node::text(
                format!("{key}/caption"),
                label,
                t.style(Type::Caption, Weight::Regular),
            )
            .ink(Ink::Dim),
        ],
    )
    .gap(Space::S2)
    .align(Align::Center)
}

fn row(key: &str, children: Vec<Node>) -> Node {
    Node::row(key, children).gap(Space::S5).align(Align::Center)
}

/// A button in a page's content: the kit's own, no glass under it (VIEW.md §13.2).
fn content_button(key: &str, text: &str, action: &str, t: &TypeScale) -> Node {
    Node::button(key, text, action, t.style(Type::Small, Weight::Medium))
}

/// A button over content is glass (VIEW.md §13.2): a pill of it around the control, so
/// Hyalo draws its hover, press and on.
fn on_glass(control: Node) -> Node {
    let control = control.corner(Corner::Pill);
    Node::pane(format!("{}/glass", control.key.0), Corner::Pill, control)
}

/// A text button as the NC builds one today (VIEW.md §13: the kit's own button function is
/// #1079 step 3).
fn button(key: &str, text: &str, action: &str, t: &TypeScale) -> Node {
    Node::control(
        key,
        text,
        action,
        Node::row(
            format!("{key}/row"),
            vec![Node::text(
                format!("{key}/text"),
                text,
                t.style(Type::Body, Weight::Medium),
            )],
        )
        .padding(Padding::symmetric(Space::S1, Space::S2)),
    )
}

fn page(id: &str, m: &Model, cat: &Catalogue, t: &TypeScale, sl: &SliderStyle) -> Vec<Node> {
    match id {
        "status" => status(cat, t),
        "button" => buttons(m, t),
        "switch" => switches(m, t),
        "check" => checks(m, t),
        "row" => rows(m, t),
        "slider" => sliders(m, t, sl),
        "field" => fields(t),
        "glass" => glass(t),
        "text" => text(t),
        "icons" => icons(t),
        "layout" => layout(t),
        "scroll" => scroll(t),
        "overlay" => overlay(t),
        "grid" => grid(t),
        "reveal" => reveal(m, t),
        _ => vec![],
    }
}

fn status(cat: &Catalogue, t: &TypeScale) -> Vec<Node> {
    let all = cat.groups.iter().flat_map(|g| &g.items).collect::<Vec<_>>();
    let done = all
        .iter()
        .filter(|i| i.status == "view" && i.page.is_some())
        .count();
    let count = |s: &str| all.iter().filter(|i| i.status == s).count();
    let summary = format!(
        "{done} of {} components are in the kit with a page here. In the kit: {}. Two copies: {}. Old layer only: {}. By hand: {}. Missing: {}.",
        all.len(),
        count("view"),
        count("both"),
        count("widgets"),
        count("hand"),
        count("missing"),
    );
    let mut out =
        vec![Node::text("st/summary", summary, t.style(Type::Body, Weight::Regular)).lines(3)];
    for (gi, g) in cat.groups.iter().enumerate() {
        let rows = g
            .items
            .iter()
            .enumerate()
            .map(|(ii, i)| {
                let k = format!("st/{gi}/{ii}");
                Node::row(
                    k.clone(),
                    vec![
                        Node::text(
                            format!("{k}/name"),
                            &i.name,
                            t.style(Type::Body, Weight::Medium),
                        ),
                        Node::text(
                            format!("{k}/gtk"),
                            if i.users.is_empty() {
                                format!("{} · {}", i.gtk, i.appkit)
                            } else {
                                format!("{} · {} · used by {}", i.gtk, i.appkit, i.users)
                            },
                            t.style(Type::Small, Weight::Regular),
                        )
                        .ink(Ink::Dim)
                        .lines(1)
                        .grow(),
                        Node::text(
                            format!("{k}/status"),
                            status_text(&i.status),
                            t.style(Type::Small, Weight::Semibold),
                        )
                        .ink(if i.status == "view" {
                            Ink::Primary
                        } else {
                            Ink::Secondary
                        }),
                    ],
                )
                .gap(Space::S3)
                .align(Align::Center)
            })
            .collect();
        out.push(section(
            &format!("st{gi}"),
            &g.name,
            t,
            Node::column(format!("st/{gi}"), rows).gap(Space::S2),
        ));
    }
    out
}

fn buttons(m: &Model, t: &TypeScale) -> Vec<Node> {
    let in_page = |k: &str, label: &str, f: &dyn Fn(Node) -> Node| {
        sample(
            &format!("b/p/{k}"),
            label,
            t,
            f(content_button(&format!("b/p/{k}"), "Browse", "noop", t)),
        )
    };
    let page = row(
        "b/page",
        vec![
            in_page("rest", "Rest", &|n| n),
            in_page("hover", "Hover", &|n| n.shown(Shown::Hover)),
            in_page("press", "Pressed", &|n| n.shown(Shown::Press)),
            in_page("focus", "Focus", &|n| n.shown(Shown::Focus)),
            in_page("off", "Disabled", &|n| n.enabled(false)),
        ],
    );
    let state = |k: &str, label: &str, f: &dyn Fn(Node) -> Node| {
        sample(
            &format!("b/{k}"),
            label,
            t,
            on_glass(f(button(&format!("b/{k}"), "Button", "noop", t))),
        )
    };
    let states = row(
        "b/states",
        vec![
            state("rest", "Rest", &|n| n),
            state("hover", "Hover", &|n| n.shown(Shown::Hover)),
            state("press", "Pressed", &|n| n.shown(Shown::Press)),
            state("focus", "Focus", &|n| n.shown(Shown::Focus)),
            state("off", "Disabled", &|n| n.enabled(false)),
        ],
    );
    let kinds = row(
        "b/kinds",
        vec![
            state("surface", "Surface", &|n| n.surface()),
            state("on", "On", &|n| n.on(true)),
            state("danger", "Destructive (hover)", &|n| {
                n.wash(Wash::Destructive).shown(Shown::Hover)
            }),
            sample(
                "b/icon",
                "Icon only",
                t,
                on_glass(Node::control(
                    "b/icon",
                    "Search",
                    "noop",
                    Node::row(
                        "b/icon/row",
                        vec![Node::icon("b/icon/glyph", "nd-system-search", 16.)],
                    )
                    .padding(Padding::all(Space::S2)),
                )),
            ),
        ],
    );
    let live = row(
        "b/live",
        vec![
            sample(
                "b/count",
                &format!("Pressed {} times", m.presses),
                t,
                content_button("b/count", "Press me", "press", t),
            ),
            sample(
                "b/toggle",
                if m.toggle {
                    "Toggle: on"
                } else {
                    "Toggle: off"
                },
                t,
                on_glass(
                    button("b/toggle", "Toggle", "toggle", t)
                        .role(Role::Toggle)
                        .marked(m.toggle),
                ),
            ),
        ],
    );
    // A row of a group has no glass under it: its states are the view's to paint (VIEW.md
    // §13.2), from the same tokens Hyalo uses on glass.
    let in_group = |k: &str, label: &str, f: &dyn Fn(Node) -> Node| {
        f(button(&format!("b/g/{k}"), label, "noop", t).corner(Corner::Token(Radius::Md)))
    };
    let grouped = Node::column(
        "b/grouped",
        vec![
            in_group("rest", "Rest", &|n| n),
            in_group("hover", "Hover", &|n| n.shown(Shown::Hover)),
            in_group("press", "Pressed", &|n| n.shown(Shown::Press)),
            in_group("selected", "Selected", &|n| {
                n.role(Role::Toggle).marked(true)
            }),
            in_group("off", "Disabled", &|n| n.enabled(false)),
        ],
    )
    .gap(Space::S1);
    vec![
        section("b-page", "In a page (no glass)", t, page),
        section("b-grouped", "Rows in a group (no glass)", t, grouped),
        section(
            "b-states",
            "Over content (glass: a window's band, a toolbar over a page)",
            t,
            states,
        ),
        section("b-kinds", "Over content: kinds", t, kinds),
        section("b-live", "Try it", t, live),
    ]
}

/// A setting row with a switch (VIEW.md §12.6, §13.6): the row does not respond, only the
/// switch does; the row's text names it. `f` sets the switch's state for the samples.
fn switch_row(
    key: &str,
    label: &str,
    on: bool,
    action: &str,
    t: &TypeScale,
    f: &dyn Fn(Node) -> Node,
) -> Node {
    let switch = f(Node::switch_control(
        format!("{key}/switch"),
        label,
        action,
        on,
    ));
    let disabled = matches!(&switch.kind, nk_view::Kind::Control(c) if !c.enabled);
    Node::setting_row(
        key,
        SettingRow {
            trailing: Some(switch),
            disabled,
            ..setting(label, None, t)
        },
    )
}

/// A setting row's text in the kit's styles: the title in the body, the second line small.
fn setting(title: &str, subtitle: Option<&str>, t: &TypeScale) -> SettingRow {
    SettingRow {
        title: title.into(),
        title_style: t.style(Type::Body, Weight::Regular),
        subtitle: subtitle.map(Into::into),
        subtitle_style: t.style(Type::Small, Weight::Regular),
        ..Default::default()
    }
}

fn rows(m: &Model, t: &TypeScale) -> Vec<Node> {
    let chevron = |k: &str| Node::icon(format!("{k}/chevron"), "nd-pan-end", 16.);
    let plain = Node::column(
        "rw/plain",
        vec![
            Node::setting_row("rw/p/title", setting("Title only", None, t)),
            Node::setting_row(
                "rw/p/sub",
                setting(
                    "With a second line",
                    Some("What the setting does, in a word or two"),
                    t,
                ),
            ),
            Node::setting_row(
                "rw/p/switch",
                SettingRow {
                    trailing: Some(Node::switch_control(
                        "rw/p/switch/sw",
                        "Ending in a switch",
                        "noop",
                        true,
                    )),
                    ..setting("Ending in a switch", Some("Only the switch responds"), t)
                },
            ),
            Node::setting_row(
                "rw/p/button",
                SettingRow {
                    trailing: Some(content_button("rw/p/button/b", "Browse", "noop", t)),
                    ..setting("Ending in a button", None, t)
                },
            ),
            Node::setting_row(
                "rw/p/off",
                SettingRow {
                    trailing: Some(
                        Node::switch_control("rw/p/off/sw", "Disabled", "noop", false)
                            .enabled(false),
                    ),
                    disabled: true,
                    ..setting("Disabled", Some("Its text says so too"), t)
                },
            ),
        ],
    );
    let activatable = |k: &str, label: &str, f: &dyn Fn(Node) -> Node| {
        f(Node::setting_row(
            format!("rw/a/{k}"),
            SettingRow {
                trailing: Some(chevron(&format!("rw/a/{k}"))),
                action: Some("noop".into()),
                ..setting(label, None, t)
            },
        ))
    };
    let states = Node::column(
        "rw/act",
        vec![
            activatable("rest", "Rest", &|n| n),
            activatable("hover", "Hover", &|n| n.shown(Shown::Hover)),
            activatable("press", "Pressed", &|n| n.shown(Shown::Press)),
            activatable("focus", "Focus", &|n| n.shown(Shown::Focus)),
            activatable("off", "Disabled", &|n| n.enabled(false)),
        ],
    );
    let live = Node::column(
        "rw/live",
        vec![
            Node::setting_row(
                "rw/live/open",
                SettingRow {
                    trailing: Some(chevron("rw/live/open")),
                    action: Some("row-open".into()),
                    ..setting("Displays", Some("Opens its page"), t)
                },
            ),
            Node::setting_row(
                "rw/live/flip",
                SettingRow {
                    trailing: Some(Node::switch("rw/live/flip/sw", m.row_on)),
                    action: Some("row-flip".into()),
                    ..setting("Bluetooth", Some("The whole row flips it"), t)
                },
            )
            .role(Role::Toggle)
            .marked(m.row_on),
            Node::text(
                "rw/live/said",
                format!(
                    "Try it: opened {} times, Bluetooth {}",
                    m.opened,
                    if m.row_on { "on" } else { "off" }
                ),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary),
        ],
    );
    vec![
        section(
            "rw-plain",
            "Not activatable (the default): only its control responds",
            t,
            plain,
        ),
        section(
            "rw-act",
            "Activatable (the app's choice): the whole row responds, painted by the kit",
            t,
            states,
        ),
        section("rw-live", "Try it", t, live),
    ]
}

fn switches(m: &Model, t: &TypeScale) -> Vec<Node> {
    let rows = vec![
        switch_row("sw/off", "Off", false, "noop", t, &|n| n),
        switch_row("sw/on", "On", true, "noop", t, &|n| n),
        switch_row("sw/hover", "Hover", false, "noop", t, &|n| {
            n.shown(Shown::Hover)
        }),
        switch_row("sw/press", "Pressed", false, "noop", t, &|n| {
            n.shown(Shown::Press)
        }),
        switch_row("sw/focus", "Focus", true, "noop", t, &|n| {
            n.shown(Shown::Focus)
        }),
        switch_row("sw/disabled", "Disabled", true, "noop", t, &|n| {
            n.enabled(false)
        }),
    ];
    vec![
        section(
            "sw-states",
            "States (only the switch responds; the row does not)",
            t,
            Node::column("sw/states", rows).gap(Space::S1),
        ),
        section(
            "sw-live",
            "Try it",
            t,
            switch_row("sw/live", "Wi-Fi", m.switch, "switch", t, &|n| n),
        ),
    ]
}

/// A checkbox or a radio and its label (VIEW.md §13.5): the mark responds, the label names
/// it and does not. `f` sets the mark's state for the samples.
fn mark_row(key: &str, label: &str, mark: Node, t: &TypeScale) -> Node {
    let enabled = !matches!(&mark.kind, nk_view::Kind::Control(c) if !c.enabled);
    let text = Node::text(
        format!("{key}/text"),
        label,
        t.style(Type::Body, Weight::Regular),
    )
    .ink(if enabled { Ink::Primary } else { Ink::Disabled })
    .grow();
    Node::row(key, vec![mark, text])
        .gap(Space::S2)
        .align(Align::Center)
        .padding(Padding::symmetric(Space::S2, Space::S2))
}

fn checks(m: &Model, t: &TypeScale) -> Vec<Node> {
    let states = |kind: &str, make: &dyn Fn(String, &str, bool) -> Node| {
        let one = |k: &str, label: &str, on: bool, f: &dyn Fn(Node) -> Node| {
            let key = format!("{kind}/{k}");
            mark_row(&key, label, f(make(format!("{key}/mark"), label, on)), t)
        };
        Node::column(
            format!("{kind}/states"),
            vec![
                one("off", "Off", false, &|n| n),
                one("on", "On", true, &|n| n),
                one("hover", "Hover", false, &|n| n.shown(Shown::Hover)),
                one("press", "Pressed", false, &|n| n.shown(Shown::Press)),
                one("focus", "Focus", true, &|n| n.shown(Shown::Focus)),
                one("disabled", "Disabled", false, &|n| n.enabled(false)),
                one("disabled-on", "Disabled, on", true, &|n| n.enabled(false)),
            ],
        )
        .gap(Space::S1)
    };
    let checkbox = |key: String, label: &str, on: bool| Node::check_control(key, label, "noop", on);
    let radio = |key: String, label: &str, on: bool| Node::radio_control(key, label, "noop", on);
    let options = ["Small", "Medium", "Large"];
    let group = options
        .iter()
        .enumerate()
        .map(|(i, label)| {
            mark_row(
                &format!("ck/live/r{i}"),
                label,
                Node::radio_control(
                    format!("ck/live/r{i}/mark"),
                    *label,
                    format!("choice:{i}"),
                    m.choice == i,
                ),
                t,
            )
        })
        .collect();
    let live = Node::column(
        "ck/live",
        vec![
            mark_row(
                "ck/live/check",
                "Show hidden files",
                Node::check_control("ck/live/check/mark", "Show hidden files", "check", m.check),
                t,
            ),
            Node::column("ck/live/group", group).gap(Space::S1),
            Node::text(
                "ck/live/said",
                format!(
                    "Try it: hidden files {}, size {}",
                    if m.check { "shown" } else { "hidden" },
                    options[m.choice.min(options.len() - 1)]
                ),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary),
        ],
    )
    .gap(Space::S2);
    vec![
        section(
            "ck-check",
            "Checkbox (only the box responds; the label does not)",
            t,
            states("ck/c", &checkbox),
        ),
        section(
            "ck-radio",
            "Radio (one Tab stop per group; the arrows move the choice)",
            t,
            states("ck/r", &radio),
        ),
        section("ck-live", "Try it", t, live),
    ]
}

fn sliders(m: &Model, t: &TypeScale, sl: &SliderStyle) -> Vec<Node> {
    let line = |k: &str, label: &str, s: Node| {
        Node::row(
            format!("sl/{k}/line"),
            vec![
                Node::text(
                    format!("sl/{k}/label"),
                    label,
                    t.style(Type::Body, Weight::Regular),
                ),
                s.grow(),
            ],
        )
        .gap(Space::S4)
        .align(Align::Center)
    };
    let s = |k: &str, v: f64| {
        Node::slider(
            format!("sl/{k}"),
            k,
            "noop",
            Slider::new(0., 100., 1., v).unit(" %"),
        )
    };
    let states = Node::column(
        "sl/states",
        vec![
            line("min", "At 0", s("min", 0.)),
            line("mid", "At 50", s("mid", 50.)),
            line("max", "At 100", s("max", 100.)),
            line("hover", "Hover", s("hover", 30.).shown(Shown::Hover)),
            line("focus", "Focus", s("focus", 70.).shown(Shown::Focus)),
            line("off", "Disabled", s("off", 50.).enabled(false)),
        ],
    )
    .gap(Space::S3);
    let tile = Node::grid(
        "sl/tile",
        2,
        96.,
        12.,
        vec![Cell {
            at: (0, 0),
            span: (1, 1),
            child: Node::pane(
                "sl/tile/pane",
                Corner::Token(Radius::Lg),
                Node::slider(
                    "sl/tile/slider",
                    "Brightness",
                    "tile",
                    Slider::new(0., 100., 1., m.tile).fill(),
                )
                .corner(Corner::Token(Radius::Lg)),
            ),
        }],
    );
    vec![
        section("sl-states", "States", t, states),
        section(
            "sl-live",
            &format!("Try it: {:.0} %", m.slider),
            t,
            Node::column(
                "sl/live/col",
                vec![line(
                    "live",
                    "Volume",
                    Node::slider(
                        "sl/live",
                        "Volume",
                        "slider",
                        Slider::new(0., 100., 1., m.slider).unit(" %"),
                    ),
                )],
            ),
        ),
        section(
            "sl-rows",
            "In a setting row (Settings')",
            t,
            slider_rows(m, t, sl),
        ),
        section("sl-tile", "Tile slider (the CC's)", t, tile),
    ]
}

/// Settings' slider rows (VIEW.md §13.7): the kit's slider and its value at a row's end,
/// with its glyphs when it has them; the row itself does not respond.
fn slider_rows(m: &Model, t: &TypeScale, sl: &SliderStyle) -> Node {
    let row = |k: &str, title: &str, action: &str, value: f64, icons: bool, disabled: bool| {
        let key = format!("sl/r/{k}");
        Node::setting_row(
            key.clone(),
            SettingRow {
                trailing: Some(Node::slider_end(
                    format!("{key}/slider"),
                    SliderEnd {
                        name: title.into(),
                        action: action.into(),
                        slider: Slider::new(0., 100., 1., value).unit(" %"),
                        value_style: t.style(Type::Body, Weight::Regular),
                        icons: icons.then(|| {
                            [
                                "nd-display-brightness-low".into(),
                                "nd-display-brightness".into(),
                            ]
                        }),
                        disabled,
                    },
                    sl,
                )),
                disabled,
                ..setting(title, None, t)
            },
        )
    };
    Node::column(
        "sl/rows",
        vec![
            row("plain", "Plain", "noop", 30., false, false),
            row("live", "Brightness", "bright", m.bright, true, false),
            row("off", "Disabled", "noop", 60., true, true),
        ],
    )
}

fn fields(t: &TypeScale) -> Vec<Node> {
    let f = |k: &str, shown: &str, caret: usize, anchor: usize, secret: bool| {
        Node::field(
            format!("f/{k}"),
            k,
            "noop",
            Field {
                shown: shown.into(),
                caret,
                anchor,
                secret,
            },
            t.style(Type::Body, Weight::Regular),
        )
    };
    let line = |k: &str, label: &str, field: Node| {
        Node::row(
            format!("f/{k}/line"),
            vec![
                Node::text(
                    format!("f/{k}/label"),
                    label,
                    t.style(Type::Body, Weight::Regular),
                ),
                field.grow(),
            ],
        )
        .gap(Space::S4)
        .align(Align::Center)
    };
    let text = "Nidara";
    let dots = "••••••";
    let states = Node::column(
        "f/states",
        vec![
            line("empty", "Empty", f("empty", "", 0, 0, false)),
            line("text", "With text", f("text", text, 6, 6, false)),
            line(
                "focus",
                "Focus",
                f("focus", text, 6, 6, false).shown(Shown::Focus),
            ),
            line("secret", "Password", f("secret", dots, 18, 18, true)),
            line(
                "off",
                "Disabled",
                f("off", text, 6, 6, false).enabled(false),
            ),
        ],
    )
    .gap(Space::S3);
    vec![
        section("f-states", "States", t, states),
        Node::text(
            "f/note",
            "Typing into a field belongs to its owner today (VIEW.md §12.2); one field for the kit is #1079 step 2.",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .lines(3),
    ]
}

fn glass(t: &TypeScale) -> Vec<Node> {
    let card = |k: &str, label: &str, corner: Corner, opacity: f64| {
        Node::pane(
            format!("g/{k}"),
            corner,
            Node::column(
                format!("g/{k}/col"),
                vec![Node::text(
                    format!("g/{k}/text"),
                    label,
                    t.style(Type::Body, Weight::Medium),
                )],
            )
            .padding(Padding::all(Space::S5)),
        )
        .opacity(opacity)
    };
    let corners = [
        ("xs", "Corner xs", Corner::Token(Radius::Xs)),
        ("sm", "Corner sm", Corner::Token(Radius::Sm)),
        ("md", "Corner md", Corner::Token(Radius::Md)),
        ("lg", "Corner lg", Corner::Token(Radius::Lg)),
        ("xl", "Corner xl", Corner::Token(Radius::Xl)),
        ("pill", "Pill", Corner::Pill),
    ];
    vec![
        Node::row(
            "g/corners",
            corners.iter().map(|(k, l, c)| card(k, l, *c, 1.)).collect(),
        )
        .gap(Space::S4),
        Node::row(
            "g/opacity",
            [
                ("o100", "Formed 100 %", 1.),
                ("o66", "66 %", 0.66),
                ("o33", "33 %", 0.33),
            ]
            .iter()
            .map(|(k, l, o)| card(k, l, Corner::Token(Radius::Lg), *o))
            .collect(),
        )
        .gap(Space::S4),
    ]
}

fn text(t: &TypeScale) -> Vec<Node> {
    let types = [
        (Type::Title1, "Title 1"),
        (Type::Title2, "Title 2"),
        (Type::Title3, "Title 3"),
        (Type::Subtitle, "Subtitle"),
        (Type::Body, "Body"),
        (Type::Small, "Small"),
        (Type::Caption, "Caption"),
        (Type::Mini, "Mini"),
    ];
    let scale = types
        .iter()
        .enumerate()
        .map(|(i, (ty, name))| {
            Node::row(
                format!("t/{i}"),
                [
                    (Weight::Regular, "Regular"),
                    (Weight::Medium, "Medium"),
                    (Weight::Semibold, "Semibold"),
                    (Weight::Bold, "Bold"),
                ]
                .iter()
                .map(|(w, wn)| {
                    Node::text(
                        format!("t/{i}/{wn}"),
                        format!("{name} {wn}"),
                        t.style(*ty, *w),
                    )
                })
                .collect(),
            )
            .gap(Space::S4)
            .align(Align::FirstLine)
        })
        .collect();
    let inks = row(
        "t/inks",
        [
            (Ink::Primary, "Primary"),
            (Ink::Secondary, "Secondary"),
            (Ink::Dim, "Dim"),
        ]
        .iter()
        .map(|(ink, n)| {
            Node::text(
                format!("t/ink/{n}"),
                *n,
                t.style(Type::Body, Weight::Regular),
            )
            .ink(*ink)
        })
        .collect(),
    );
    let long = "Text from outside is wrapped to the lines it is given and ends in an ellipsis; \
        its whole text stays with the readers. An interface label is one line and never cut: \
        a label that does not fit is a wording problem, not a layout one.";
    vec![
        section(
            "t-scale",
            "Type scale × weight",
            t,
            Node::column("t/scale", scale).gap(Space::S2),
        ),
        section("t-inks", "Inks", t, inks),
        section(
            "t-lines",
            "Wrapped to two lines",
            t,
            Node::text("t/long", long, t.style(Type::Body, Weight::Regular)).lines(2),
        ),
    ]
}

fn icons(t: &TypeScale) -> Vec<Node> {
    let names = [
        "nd-system-search",
        "nd-notifications",
        "nd-network-wireless",
        "nd-bluetooth-active",
        "nd-audio-volume-high",
        "nd-night-light",
        "nd-user-trash",
        "nd-system-shutdown",
    ];
    let sizes = [16., 20., 24., 32.];
    let rows = sizes
        .iter()
        .map(|s| {
            let mut items = vec![
                Node::text(
                    format!("i/{s}/label"),
                    format!("{s:.0} px"),
                    t.style(Type::Small, Weight::Regular),
                )
                .ink(Ink::Dim),
            ];
            items.extend(
                names
                    .iter()
                    .map(|n| Node::icon(format!("i/{s}/{n}"), *n, *s)),
            );
            row(&format!("i/{s}"), items)
        })
        .collect();
    let inks = row(
        "i/inks",
        [
            (Ink::Primary, "Primary"),
            (Ink::Secondary, "Secondary"),
            (Ink::Dim, "Dim"),
        ]
        .iter()
        .map(|(ink, n)| {
            sample(
                &format!("i/ink/{n}"),
                n,
                t,
                Node::icon(format!("i/ink/{n}"), "nd-ai", 24.).ink(*ink),
            )
        })
        .collect(),
    );
    vec![
        section(
            "i-sizes",
            "Interface glyphs (nd-) by size",
            t,
            Node::column("i/sizes", rows).gap(Space::S3),
        ),
        section("i-inks", "Inks", t, inks),
    ]
}

/// A small card for the layout samples: a group, not glass.
fn block(key: &str, label: &str, t: &TypeScale) -> Node {
    Node::group(
        key,
        Node::column(
            format!("{key}/col"),
            vec![Node::text(
                format!("{key}/text"),
                label,
                t.style(Type::Small, Weight::Medium),
            )],
        )
        .padding(Padding::symmetric(Space::S2, Space::S3)),
    )
}

fn layout(t: &TypeScale) -> Vec<Node> {
    let mut out = vec![];
    for (i, s) in Space::ALL.iter().enumerate() {
        let name = format!("{s:?}");
        out.push(
            Node::row(
                format!("l/gap/{i}"),
                vec![
                    Node::text(
                        format!("l/gap/{i}/label"),
                        format!("Gap {name}"),
                        t.style(Type::Small, Weight::Regular),
                    )
                    .ink(Ink::Dim),
                    block(&format!("l/gap/{i}/a"), "A", t),
                    block(&format!("l/gap/{i}/b"), "B", t),
                    block(&format!("l/gap/{i}/c"), "C", t),
                ],
            )
            .gap(*s)
            .align(Align::Center),
        );
    }
    for (k, j) in [
        ("start", Justify::Start),
        ("center", Justify::Center),
        ("end", Justify::End),
    ] {
        out.push(
            Node::row(
                format!("l/j/{k}"),
                vec![
                    block(&format!("l/j/{k}/a"), &format!("Justify {k}"), t),
                    block(&format!("l/j/{k}/b"), "B", t),
                ],
            )
            .gap(Space::S2)
            .justify(j),
        );
    }
    out.push(
        Node::row(
            "l/spacer",
            vec![
                block("l/spacer/a", "Start", t),
                Node::spacer("l/spacer/gap"),
                block("l/spacer/b", "A spacer between", t),
            ],
        )
        .gap(Space::S2),
    );
    out
}

fn scroll(t: &TypeScale) -> Vec<Node> {
    let mut out = vec![Node::text(
        "sc/note",
        "This page is the scroll region: the content scrolls under the wheel, Page Up and Page Down, Ctrl+Home and Ctrl+End, and its bar shows while it moves.",
        t.style(Type::Body, Weight::Regular),
    )
    .lines(3)];
    out.extend((1..=30).map(|i| block(&format!("sc/{i}"), &format!("Row {i}"), t)));
    out
}

fn overlay(t: &TypeScale) -> Vec<Node> {
    let base = Node::group(
        "o/base",
        Node::column(
            "o/base/col",
            vec![
                Node::text(
                    "o/base/text",
                    "The base gives the size",
                    t.style(Type::Body, Weight::Medium),
                ),
                Node::text(
                    "o/base/room",
                    "Layers lie over it, placed by alignment and inset.",
                    t.style(Type::Small, Weight::Regular),
                )
                .ink(Ink::Secondary)
                .reserve(5),
            ],
        )
        .padding(Padding::all(Space::S5)),
    );
    // What lies over the base is glass, as anything over content is.
    let tag = |k: &str, glyph: &str| {
        Node::pane(
            format!("o/{k}/glass"),
            Corner::Pill,
            Node::control(
                format!("o/{k}"),
                k,
                "noop",
                Node::row(
                    format!("o/{k}/row"),
                    vec![Node::icon(format!("o/{k}/icon"), glyph, 16.)],
                )
                .padding(Padding::all(Space::S1)),
            )
            .corner(Corner::Pill),
        )
    };
    let layered = Node::overlay("o/overlay", base)
        .layer(
            Align::End,
            Align::Start,
            Padding::all(Space::S2),
            tag("top-end", "nd-user-trash"),
        )
        .layer(
            Align::Start,
            Align::End,
            Padding::all(Space::S2),
            tag("bottom-start", "nd-pan-start"),
        )
        .layer(
            Align::Center,
            Align::Center,
            Padding::default(),
            tag("centre", "nd-ai"),
        );
    vec![
        layered,
        Node::text(
            "o/note",
            "Layers placed by alignment and inset, as the CC's remove marks are.",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary),
    ]
}

fn grid(t: &TypeScale) -> Vec<Node> {
    let tile = |k: &str, at: (usize, usize), span: (usize, usize)| Cell {
        at,
        span,
        child: block(&format!("gr/{k}"), &format!("{}×{}", span.0, span.1), t),
    };
    vec![
        Node::grid(
            "gr/grid",
            4,
            72.,
            12.,
            vec![
                tile("a", (0, 0), (1, 1)),
                tile("b", (1, 0), (1, 1)),
                tile("c", (2, 0), (2, 1)),
                tile("d", (0, 1), (2, 2)),
                tile("e", (2, 1), (1, 2)),
                tile("f", (3, 1), (1, 1)),
                tile("g", (3, 2), (1, 1)),
            ],
        ),
        Node::text(
            "gr/note",
            "Square cells; where each tile goes is the surface's to decide (VIEW.md §12.4).",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary),
    ]
}

fn reveal(m: &Model, t: &TypeScale) -> Vec<Node> {
    vec![
        Node::row(
            "r/toggle/line",
            vec![content_button(
                "r/toggle",
                if m.open { "Close" } else { "Open" },
                "reveal",
                t,
            )],
        ),
        Node::reveal(
            "r/reveal",
            m.open,
            Node::group(
                "r/pane",
                Node::column(
                    "r/col",
                    vec![
                        Node::text(
                            "r/title",
                            "Revealed",
                            t.style(Type::Subtitle, Weight::Semibold),
                        ),
                        Node::text(
                            "r/body",
                            "It unrolls downward in place, and what is under it moves with it.",
                            t.style(Type::Body, Weight::Regular),
                        )
                        .lines(2),
                    ],
                )
                .gap(Space::S2)
                .padding(Padding::all(Space::S5)),
            ),
        ),
        block("r/below", "Below the reveal", t),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scale() -> TypeScale {
        let statics: serde_json::Value = serde_json::json!({"scss": {
            "fse-mini": "0.77em", "fse-caption": "0.85em", "fse-small": "0.92em", "fse-body": "1em",
            "fse-subtitle": "1.08em", "fse-title-3": "1.23em", "fse-title-2": "1.54em", "fse-title-1": "2em",
            "fw-regular": "400", "fw-medium": "500", "fw-semibold": "600", "fw-bold": "700"}});
        TypeScale::from_static(&statics, nk_text::TextStyle::default()).unwrap()
    }

    /// Every key in a view is unique: hover, focus and the readers follow keys.
    fn keys(n: &Node, out: &mut Vec<String>) {
        out.push(n.key.0.clone());
        let json = serde_json::to_value(&n.kind).unwrap();
        fn walk(v: &serde_json::Value, out: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(o) => {
                    if let (Some(k), Some(_)) = (o.get("key"), o.get("kind")) {
                        out.push(k.as_str().unwrap_or_default().to_owned());
                    }
                    o.values().for_each(|v| walk(v, out));
                }
                serde_json::Value::Array(a) => a.iter().for_each(|v| walk(v, out)),
                _ => {}
            }
        }
        walk(&json, out);
    }

    #[test]
    fn every_page_builds_with_unique_keys() {
        let cat = Catalogue::load().unwrap();
        let t = scale();
        for (i, (id, _, _)) in PAGES.iter().enumerate() {
            let m = Model {
                page: i,
                open: true,
                ..Default::default()
            };
            let sl = nk_view::slider_from(&serde_json::json!({"slider": {"width": 140, "track": 6,
                "thumbRadius": 9, "valueGap": 12, "fillOpacity": 0.9, "pageSteps": 10,
                "iconSize": 16, "iconOpacity": 0.5, "iconGap": 12}}))
            .unwrap();
            let v = view(
                &m,
                &cat,
                &t,
                &Measures {
                    slider: &sl,
                    glyph: 16.,
                },
            );
            let mut all = vec![];
            keys(&v.sidebar, &mut all);
            keys(&v.content, &mut all);
            let mut seen = std::collections::HashSet::new();
            for k in &all {
                assert!(seen.insert(k), "page {id}: key {k} twice");
            }
        }
    }

    #[test]
    fn every_page_named_in_the_catalogue_exists() {
        let cat = Catalogue::load().unwrap();
        for g in &cat.groups {
            for i in &g.items {
                if let Some(p) = &i.page {
                    assert!(
                        PAGES.iter().any(|(id, _, _)| id == p),
                        "{}: no page {p}",
                        i.name
                    );
                }
                assert!(
                    ["view", "both", "widgets", "hand", "missing"].contains(&i.status.as_str()),
                    "{}: status {}",
                    i.name,
                    i.status
                );
            }
        }
    }
}
