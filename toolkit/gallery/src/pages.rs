// SPDX-License-Identifier: LGPL-3.0-or-later
//! The gallery's view (VIEW.md §13.3): a sidebar of pages and the current page, every piece
//! of it a kit node. A page shows one component in each of its states side by side, with
//! the catalogue entries it answers and their GTK and AppKit equivalents.
use nk::prelude::*;
use nk::{
    Align, Cell, Corner, DropdownStyle, Ink, Justify, Node, Padding, Radius, Role, Shown, Space,
    Type, TypeScale, Wash, Weight,
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
    /// The kit's types that build it (`nk::Button`…), shown on its page.
    #[serde(default)]
    pub nk: Vec<String>,
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
pub const PAGES: [(&str, &str, &str); 31] = [
    ("status", "Status", "nd-emblem-default"),
    ("window", "Window", "nd-sidebar-show"),
    ("button", "Button", "nd-hand"),
    ("switch", "Switch", "nd-light-mode"),
    ("check", "Checkbox and radio", "nd-preferences-desktop"),
    ("dropdown", "Dropdown", "nd-pan-down"),
    ("segmented", "Segmented choice", "nd-view-grid"),
    ("swatches", "Swatches", "nd-view-grid"),
    ("row", "List row", "nd-preferences-system"),
    ("slider", "Slider", "nd-display-brightness"),
    ("glass", "Glass card", "nd-preferences-desktop-theme"),
    ("text", "Text", "nd-clipboard-list"),
    ("icons", "Icons", "nd-globe"),
    ("layout", "Layout", "nd-dock"),
    ("scroll", "Scroll", "nd-pan-down"),
    ("overlay", "Overlay", "nd-sidebar-show"),
    ("grid", "Grid", "nd-control-center"),
    ("tile", "Tile", "nd-control-center"),
    ("notification", "Notification card", "nd-notifications"),
    ("icongrid", "Icon item", "nd-view-grid"),
    ("reveal", "Reveal", "nd-pan-end"),
    ("disclosure", "Disclosure", "nd-pan-end"),
    ("entry", "Text field", "nd-input-keyboard"),
    ("search", "Search", "nd-system-search"),
    ("time", "Time field", "nd-preferences-system-time"),
    (
        "arrangement",
        "Arrangement",
        "nd-preferences-system-display",
    ),
    ("list", "Long list", "nd-clipboard-list"),
    ("focus", "Focus", "nd-input-keyboard"),
    ("dialog", "Dialog and alert", "nd-dialog-information"),
    ("system-dialog", "System dialogs", "nd-dialog-information"),
    ("files", "Files", "nd-folder"),
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
    pub profile: usize,
    /// The radio group's choice.
    pub choice: usize,
    /// The live dropdown's choice.
    pub speed: usize,
    /// The menu button's last command, and the row it keeps ticked.
    pub command: Option<usize>,
    /// The live segmented choice's.
    pub size: usize,
    pub accent: usize,
    pub toggle: bool,
    pub presses: u32,
    pub slider: f64,
    pub tile: f64,
    pub open: bool,
    pub expanded: bool,
    pub entry: String,
    pub search: String,
    /// The suggestions sample: what is typed, and the city last chosen from its list.
    pub city: String,
    /// The time field's sample, "HH:MM".
    pub time: String,
    pub arrangement_selected: usize,
    pub arrangement_offsets: [(f64, f64); 2],
    pub arrangement_preview: (f64, f64),
    pub city_chosen: Option<usize>,
    pub submitted: u32,
    pub selected_row: usize,
    pub list_opened: u32,
    pub files: crate::files::Browser,
    pub font: nk::FontChoice,
    /// The entry chosen in the Window page's sample sidebar.
    pub window_side: String,
    pub modal_answers: u32,
    pub modal_result: String,
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
            profile: 1,
            choice: 1,
            speed: 1,
            command: None,
            size: 1,
            accent: 0,
            toggle: false,
            presses: 0,
            slider: 40.,
            tile: 60.,
            open: false,
            expanded: false,
            entry: "Nidara".into(),
            search: String::new(),
            city: String::new(),
            time: "22:30".into(),
            arrangement_selected: 0,
            arrangement_offsets: [(0., 0.); 2],
            arrangement_preview: (0., 0.),
            city_chosen: None,
            submitted: 0,
            selected_row: 0,
            list_opened: 0,
            files: crate::files::Browser::default(),
            font: nk::FontChoice::new("Inter Variable", nk::FontSize::Points(11.)),
            window_side: "home".into(),
            modal_answers: 0,
            modal_result: "Nothing answered".into(),
        }
    }
}

/// The kit's measures a page needs besides its type: the slider's, and the frame's glyph size.
pub struct Measures<'a> {
    pub dropdown: &'a DropdownStyle,
    pub tile: &'a nk::TileStyle,
    pub notification: &'a nk::NotificationStyle,
    pub icon_grid: &'a nk::IconGridStyle,
    pub colors: &'a [(String, nk_render::Color)],
    pub glyph: f64,
    pub row_height: f64,
    pub list_window: Option<(f64, f64)>,
    pub disabled_list_window: Option<(f64, f64)>,
    pub files_window: Option<(f64, f64)>,
}

pub fn view(m: &Model, cat: &Catalogue, t: &TypeScale, k: &Measures) -> View {
    let nav = PAGES.iter().enumerate().map(|(i, (id, title, glyph))| {
        nk::SidebarEntry::new(
            format!("nav/{id}"),
            *title,
            *glyph,
            format!("page:{id}"),
            t.style(Type::Body, Weight::Regular),
            k.glyph,
        )
        .selected(m.page == i)
    });
    // The kit's sidebar; the window's frame (nk-view FrameStyle) puts it in its glass.
    let sidebar = nk::SidebarList::new("side/pages").entries(nav);
    let (id, title, _) = PAGES[m.page.min(PAGES.len() - 1)];
    let mut body = vec![header(id, cat, t)];
    body.extend(page(id, m, cat, t, k));
    let content = nk::Column::new(format!("page/{id}"), body)
        .gap(Space::S5)
        .padding(Padding {
            top: None,
            right: Some(Space::S6),
            bottom: Some(Space::S6),
            left: Some(Space::S6),
        });
    View {
        sidebar: sidebar.into(),
        content: content.into(),
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
    let mut lines: Vec<Node> = vec![];
    if !items.is_empty() {
        let names = items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>();
        let mut types: Vec<&str> = items
            .iter()
            .flat_map(|i| &i.nk)
            .map(String::as_str)
            .collect();
        types.dedup();
        let gtk = items.iter().map(|i| i.gtk.as_str()).collect::<Vec<_>>();
        let appkit = items.iter().map(|i| i.appkit.as_str()).collect::<Vec<_>>();
        let statuses = items
            .iter()
            .map(|i| format!("{}: {}", i.name, status_text(&i.status)))
            .collect::<Vec<_>>();
        if !types.is_empty() {
            lines.push(
                nk::Label::new(
                    "head/nk",
                    types.join(", "),
                    t.style(Type::Body, Weight::Semibold),
                )
                .lines(2)
                .into(),
            );
        }
        for (k, text) in [
            ("names", format!("Catalogue: {}", names.join(", "))),
            ("gtk", format!("GTK: {}", gtk.join(", "))),
            ("appkit", format!("AppKit: {}", appkit.join(", "))),
            ("status", statuses.join(" · ")),
        ] {
            lines.push(
                nk::Label::new(
                    format!("head/{k}"),
                    text,
                    t.style(Type::Small, Weight::Regular),
                )
                .ink(Ink::Secondary)
                .lines(3)
                .into(),
            );
        }
    }
    nk::Column::new("head", lines).gap(Space::S1).into()
}

/// One labelled section, as Settings' groups: the caption over a card on the window's
/// background (not glass: glass is for what lies over content), holding what it shows.
fn section(key: &str, caption: &str, t: &TypeScale, child: Node) -> Node {
    nk::Column::new(
        format!("s/{key}"),
        vec![
            nk::Label::new(
                format!("s/{key}/cap"),
                caption,
                t.style(Type::Caption, Weight::Semibold),
            )
            .ink(Ink::Secondary)
            .into(),
            nk::Group::new(
                format!("s/{key}/card"),
                nk::Column::new(format!("s/{key}/col"), vec![child])
                    .padding(Padding::all(Space::S4)),
            )
            .into(),
        ],
    )
    .gap(Space::S2)
    .into()
}

/// A sample with its state named under it.
fn sample(key: &str, label: &str, t: &TypeScale, child: Node) -> Node {
    nk::Column::new(
        format!("{key}/sample"),
        vec![
            child,
            nk::Label::new(
                format!("{key}/caption"),
                label,
                t.style(Type::Caption, Weight::Regular),
            )
            .ink(Ink::Dim)
            .into(),
        ],
    )
    .gap(Space::S2)
    .align(Align::Center)
    .into()
}

fn row(key: &str, children: Vec<Node>) -> Node {
    nk::Row::new(key, children)
        .gap(Space::S5)
        .align(Align::Center)
        .into()
}

/// A button in a page's content: the kit's own, no glass under it (VIEW.md §13.2).
fn content_button(key: &str, text: &str, action: &str, t: &TypeScale) -> nk::Button {
    nk::Button::new(key, text, action, t.style(Type::Small, Weight::Medium))
}

/// A text button as the NC builds one today (VIEW.md §13: the kit's own button function is
/// #1079 step 3).
fn button(key: &str, text: &str, action: &str, t: &TypeScale) -> nk::Button {
    nk::Button::with_child(
        key,
        text,
        action,
        nk::Row::new(
            format!("{key}/row"),
            vec![
                nk::Label::new(
                    format!("{key}/text"),
                    text,
                    t.style(Type::Body, Weight::Medium),
                )
                .into(),
            ],
        )
        .padding(Padding::symmetric(Space::S1, Space::S2)),
    )
}

fn page(id: &str, m: &Model, cat: &Catalogue, t: &TypeScale, k: &Measures) -> Vec<Node> {
    match id {
        "status" => status(cat, t),
        "window" => window(m, t, k),
        "button" => buttons(m, t),
        "switch" => switches(m, t),
        "check" => checks(m, t),
        "dropdown" => dropdowns(m, t, k.dropdown),
        "segmented" => segmenteds(m, t),
        "swatches" => swatches(m, t, k.colors),
        "row" => rows(m, t),
        "slider" => sliders(m, t),
        "glass" => glass(t),
        "text" => text(t),
        "icons" => icons(t),
        "layout" => layout(t),
        "scroll" => scroll(t),
        "overlay" => overlay(t),
        "grid" => grid(t, k.tile),
        "tile" => tiles(m, t, k.tile),
        "notification" => notifications(m, t, k),
        "icongrid" => icon_items(m, t, k.icon_grid),
        "reveal" => reveal(m, t),
        "disclosure" => disclosures(m, t),
        // One text field page (owner, #1156): the kit's field, then the CC's password field
        // that still uses the old one.
        "entry" => {
            let mut nodes = entries(m, t);
            nodes.push(nk::PasswordEntry::new("e/password", "Password", "noop").into());
            // The lock screen's field, with its button inside (#1195).
            nodes.push(
                nk::PasswordEntry::new("e/password-submit", "Password", "noop")
                    .submit("Unlock", "noop")
                    .into(),
            );
            // The same field made of glass, as the lock screen has it (#1195), with the eye
            // that shows the characters.
            nodes.push(
                nk::PasswordEntry::new("e/password-glass", "Password", "noop")
                    .submit("Unlock", "noop")
                    .peek("Show password", "Hide password", "noop")
                    .glass()
                    .into(),
            );
            nodes.extend(fields(t));
            nodes
        }
        "search" => search_field(m, t),
        "time" => time_field(m, t),
        "arrangement" => arrangement(m, t),
        "list" => long_list(m, t, k),
        "focus" => focus_page(t, k),
        "dialog" => dialogs(m, t),
        "system-dialog" => system_dialogs(m, t),
        "files" => m.files.view(t, k.row_height, k.files_window, k.glyph),
        _ => vec![],
    }
}

/// The window itself: this gallery is an `nk::AppWindow`, and its sidebar an `nk::SidebarList`,
/// shown here on its own as any app would place one.
fn window(m: &Model, t: &TypeScale, k: &Measures) -> Vec<Node> {
    let body = || t.style(Type::Body, Weight::Regular);
    let entry = |id: &str, title: &str, glyph: &str, on: bool| {
        nk::SidebarEntry::new(
            format!("win/side/{id}"),
            title,
            glyph,
            format!("win-side:{id}"),
            body(),
            k.glyph,
        )
        .selected(on)
    };
    let chosen = m.window_side.as_str();
    let list = nk::SidebarList::new("win/side")
        .entries([
            entry("home", "Home", "nd-user-home", chosen == "home"),
            entry(
                "recent",
                "Recent",
                "nd-document-open-recent",
                chosen == "recent",
            ),
        ])
        .section(
            "Folders",
            t.style(Type::Caption, Weight::Medium),
            [
                entry(
                    "documents",
                    "Documents",
                    "nd-folder-documents",
                    chosen == "documents",
                ),
                entry(
                    "pictures",
                    "Pictures",
                    "nd-folder-pictures",
                    chosen == "pictures",
                ),
                entry("music", "Music", "nd-folder-music", chosen == "music"),
            ],
        );
    vec![
        section(
            "win-this",
            "This window",
            t,
            nk::Label::new(
                "win/this",
                "This gallery is an nk::AppWindow: the title band (the sidebar button, back and \
                 forward, the page's title), the content scrolling under it, the floating glass \
                 sidebar on the left (an nk::SidebarList), and Hyalo's window controls.",
                body(),
            )
            .lines(4)
            .into(),
        ),
        section(
            "win-side",
            "A sidebar list, with sections",
            t,
            nk::Column::new("win/side-box", vec![list.into()])
                .height(260.)
                .into(),
        ),
    ]
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
    let mut out: Vec<Node> = vec![
        nk::Label::new("st/summary", summary, t.style(Type::Body, Weight::Regular))
            .lines(3)
            .into(),
    ];
    // The same rows Settings shows: each component's name, what it is called elsewhere under
    // it, its state at the end, in a group with the kit's separators.
    for (gi, g) in cat.groups.iter().enumerate() {
        let rows = g
            .items
            .iter()
            .enumerate()
            .map(|(ii, i)| {
                let k = format!("st/{gi}/{ii}");
                let mut about = i.nk.join(", ");
                for part in [&i.gtk, &i.appkit] {
                    if !about.is_empty() {
                        about.push_str(" · ");
                    }
                    about.push_str(part);
                }
                if !i.users.is_empty() {
                    about.push_str(&format!(" · used by {}", i.users));
                }
                nk::ListRow::new(k.clone(), &i.name, t.style(Type::Body, Weight::Regular))
                    .subtitle(about, t.style(Type::Small, Weight::Regular))
                    .trailing(
                        nk::Label::new(
                            format!("{k}/status"),
                            status_text(&i.status),
                            t.style(Type::Small, Weight::Semibold),
                        )
                        .ink(if i.status == "view" {
                            Ink::Primary
                        } else {
                            Ink::Secondary
                        }),
                    )
                    .into()
            })
            .collect();
        out.push(
            nk::Column::new(
                format!("s/st{gi}"),
                vec![
                    nk::Label::new(
                        format!("s/st{gi}/cap"),
                        &g.name,
                        t.style(Type::Caption, Weight::Semibold),
                    )
                    .ink(Ink::Secondary)
                    .into(),
                    nk::Group::new(
                        format!("s/st{gi}/card"),
                        nk::Column::new(format!("st/{gi}"), rows),
                    )
                    .into(),
                ],
            )
            .gap(Space::S2)
            .into(),
        );
    }
    out
}

fn buttons(m: &Model, t: &TypeScale) -> Vec<Node> {
    let in_page = |k: &str, label: &str, f: &dyn Fn(nk::Button) -> nk::Button| {
        sample(
            &format!("b/p/{k}"),
            label,
            t,
            f(content_button(&format!("b/p/{k}"), "Browse", "noop", t)).into(),
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
    // The page's own action in the accent, and one that deletes in red (owner, #1156).
    let kind = |k: &str, text: &str, label: &str, a: nk::ButtonAppearance| {
        sample(
            &format!("b/a/{k}"),
            label,
            t,
            content_button(&format!("b/a/{k}"), text, "noop", t)
                .appearance(a)
                .into(),
        )
    };
    let appearances = row(
        "b/appearances",
        vec![
            kind("normal", "Cancel", "Normal", nk::ButtonAppearance::Normal),
            kind("default", "Save", "Default", nk::ButtonAppearance::Default),
            kind(
                "destructive",
                "Delete",
                "Destructive",
                nk::ButtonAppearance::Destructive,
            ),
        ],
    );
    // The same three, made of glass: one component, two materials (`.glass()`).
    let glass_kind = |k: &str, text: &str, label: &str, a: nk::ButtonAppearance| {
        sample(
            &format!("b/g/{k}"),
            label,
            t,
            content_button(&format!("b/g/{k}"), text, "noop", t)
                .appearance(a)
                .glass()
                .into(),
        )
    };
    let glass_appearances = row(
        "b/glass-appearances",
        vec![
            glass_kind("normal", "Cancel", "Normal", nk::ButtonAppearance::Normal),
            glass_kind("default", "Save", "Default", nk::ButtonAppearance::Default),
            glass_kind(
                "destructive",
                "Delete",
                "Destructive",
                nk::ButtonAppearance::Destructive,
            ),
        ],
    );
    let state = |k: &str, label: &str, f: &dyn Fn(nk::Button) -> nk::Button| {
        sample(
            &format!("b/{k}"),
            label,
            t,
            f(button(&format!("b/{k}"), "Button", "noop", t))
                .glass()
                .into(),
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
                nk::Button::with_child(
                    "b/icon",
                    "Search",
                    "noop",
                    nk::Row::new(
                        "b/icon/row",
                        vec![nk::Image::new("b/icon/glyph", "nd-system-search", 16.).into()],
                    )
                    .padding(Padding::all(Space::S2)),
                )
                .glass()
                .into(),
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
                content_button("b/count", "Press me", "press", t).into(),
            ),
            sample(
                "b/toggle",
                if m.toggle {
                    "Toggle: on"
                } else {
                    "Toggle: off"
                },
                t,
                button("b/toggle", "Toggle", "toggle", t)
                    .role(Role::Toggle)
                    .marked(m.toggle)
                    .glass()
                    .into(),
            ),
        ],
    );
    vec![
        section("b-page", "In a page (no glass)", t, page),
        section(
            "b-appearance",
            "In a page: what it does (.appearance)",
            t,
            appearances,
        ),
        section(
            "b-glass",
            "The same buttons made of glass (.glass())",
            t,
            glass_appearances,
        ),
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

/// A list row with a switch (VIEW.md §12.6, §13.6): the row does not respond, only the
/// switch does; the row's text names it. `f` sets the switch's state for the samples.
fn switch_row(
    key: &str,
    label: &str,
    on: bool,
    action: &str,
    t: &TypeScale,
    f: &dyn Fn(nk::Switch) -> nk::Switch,
) -> Node {
    let switch: Node = f(nk::Switch::new(format!("{key}/switch"), label, action, on)).into();
    let disabled = matches!(&switch.kind, nk::Kind::Control(c) if !c.enabled);
    setting(key, label, None, t)
        .trailing(switch)
        .enabled(!disabled)
        .into()
}

/// A list row's text in the kit's styles: the title in the body, the second line small.
fn setting(
    key: impl Into<nk::Key>,
    title: &str,
    subtitle: Option<&str>,
    t: &TypeScale,
) -> nk::ListRow {
    let row = nk::ListRow::new(key, title, t.style(Type::Body, Weight::Regular));
    match subtitle {
        Some(sub) => row.subtitle(sub, t.style(Type::Small, Weight::Regular)),
        None => row,
    }
}

fn rows(m: &Model, t: &TypeScale) -> Vec<Node> {
    let chevron = |k: &str| nk::Image::new(format!("{k}/chevron"), "nd-pan-end", 16.);
    let plain = nk::Column::new(
        "rw/plain",
        vec![
            setting("rw/p/title", "Title only", None, t).into(),
            setting(
                "rw/p/sub",
                "With a second line",
                Some("What the setting does, in a word or two"),
                t,
            )
            .into(),
            setting(
                "rw/p/switch",
                "Ending in a switch",
                Some("Only the switch responds"),
                t,
            )
            .trailing(nk::Switch::new(
                "rw/p/switch/sw",
                "Ending in a switch",
                "noop",
                true,
            ))
            .into(),
            setting("rw/p/button", "Ending in a button", None, t)
                .trailing(content_button("rw/p/button/b", "Browse", "noop", t))
                .into(),
            setting("rw/p/off", "Disabled", Some("Its text says so too"), t)
                .trailing(nk::Switch::new("rw/p/off/sw", "Disabled", "noop", false).enabled(false))
                .enabled(false)
                .into(),
        ],
    );
    let activatable = |k: &str, label: &str, f: &dyn Fn(nk::ListRow) -> nk::ListRow| -> Node {
        f(setting(format!("rw/a/{k}"), label, None, t)
            .trailing(chevron(&format!("rw/a/{k}")))
            .action("noop"))
        .into()
    };
    let states = nk::Column::new(
        "rw/act",
        vec![
            activatable("rest", "Rest", &|n| n),
            activatable("hover", "Hover", &|n| n.shown(Shown::Hover)),
            activatable("press", "Pressed", &|n| n.shown(Shown::Press)),
            activatable("focus", "Focus", &|n| n.shown(Shown::Focus)),
            activatable("off", "Disabled", &|n| n.enabled(false)),
        ],
    );
    let live = nk::Column::new(
        "rw/live",
        vec![
            setting("rw/live/open", "Displays", Some("Opens its page"), t)
                .trailing(chevron("rw/live/open"))
                .action("row-open")
                .into(),
            setting(
                "rw/live/flip",
                "Bluetooth",
                Some("The whole row flips it"),
                t,
            )
            .trailing(nk::Switch::drawn("rw/live/flip/sw", m.row_on))
            .action("row-flip")
            .role(Role::Toggle)
            .marked(m.row_on)
            .into(),
            nk::Label::new(
                "rw/live/said",
                format!(
                    "Try it: opened {} times, Bluetooth {}",
                    m.opened,
                    if m.row_on { "on" } else { "off" }
                ),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary)
            .into(),
        ],
    );
    vec![
        section(
            "rw-plain",
            "Not activatable (the default): only its control responds",
            t,
            plain.into(),
        ),
        section(
            "rw-act",
            "Activatable (the app's choice): the whole row responds, painted by the kit",
            t,
            states.into(),
        ),
        section("rw-live", "Try it", t, live.into()),
        section(
            "rw-profiles",
            "Power profile",
            t,
            nk::ListBox::new(
                "rw/profiles",
                "Power profile",
                "profile-select",
                vec![
                    nk::ListBoxOption::new("Performance").icon("nd-power-profile-performance"),
                    nk::ListBoxOption::new("Balanced").icon("nd-power-profile-balanced"),
                    nk::ListBoxOption::new("Power Saver").icon("nd-power-profile-power-saver"),
                ],
                t.style(Type::Body, Weight::Regular),
            )
            .selected(Some(m.profile))
            .into(),
        ),
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
            nk::Column::new("sw/states", rows).gap(Space::S1).into(),
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
fn mark_row(key: &str, label: &str, mark: impl Into<Node>, t: &TypeScale) -> Node {
    let mark = mark.into();
    let enabled = !matches!(&mark.kind, nk::Kind::Control(c) if !c.enabled);
    let text = nk::Label::new(
        format!("{key}/text"),
        label,
        t.style(Type::Body, Weight::Regular),
    )
    .ink(if enabled { Ink::Primary } else { Ink::Disabled })
    .grow();
    nk::Row::new(key, vec![mark, text.into()])
        .gap(Space::S2)
        .align(Align::Center)
        .padding(Padding::symmetric(Space::S2, Space::S2))
        .into()
}

fn checks(m: &Model, t: &TypeScale) -> Vec<Node> {
    let states = |kind: &str, make: &dyn Fn(String, &str, bool) -> nk::CheckButton| {
        let one =
            |k: &str, label: &str, on: bool, f: &dyn Fn(nk::CheckButton) -> nk::CheckButton| {
                let key = format!("{kind}/{k}");
                mark_row(&key, label, f(make(format!("{key}/mark"), label, on)), t)
            };
        nk::Column::new(
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
    let checkbox =
        |key: String, label: &str, on: bool| nk::CheckButton::new(key, label, "noop", on);
    let radio = |key: String, label: &str, on: bool| nk::CheckButton::radio(key, label, "noop", on);
    let options = ["Small", "Medium", "Large"];
    let group = options
        .iter()
        .enumerate()
        .map(|(i, label)| {
            mark_row(
                &format!("ck/live/r{i}"),
                label,
                nk::CheckButton::radio(
                    format!("ck/live/r{i}/mark"),
                    *label,
                    format!("choice:{i}"),
                    m.choice == i,
                )
                .value(nk::Value::Index(i)),
                t,
            )
        })
        .collect();
    let live = nk::Column::new(
        "ck/live",
        vec![
            mark_row(
                "ck/live/check",
                "Show hidden files",
                nk::CheckButton::new("ck/live/check/mark", "Show hidden files", "check", m.check),
                t,
            ),
            nk::Column::new("ck/live/group", group)
                .gap(Space::S1)
                .into(),
            nk::Label::new(
                "ck/live/said",
                format!(
                    "Try it: hidden files {}, size {}",
                    if m.check { "shown" } else { "hidden" },
                    options[m.choice.min(options.len() - 1)]
                ),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary)
            .into(),
        ],
    )
    .gap(Space::S2);
    vec![
        section(
            "ck-check",
            "Checkbox (only the box responds; the label does not)",
            t,
            states("ck/c", &checkbox).into(),
        ),
        section(
            "ck-radio",
            "Radio (one Tab stop per group; the arrows move the choice)",
            t,
            states("ck/r", &radio).into(),
        ),
        section("ck-live", "Try it", t, live.into()),
    ]
}

/// The live dropdown's options.
pub const SPEEDS: [&str; 3] = ["Slow", "Normal", "Fast"];

const COMMANDS: [&str; 3] = ["Suspend", "Restart", "Power off"];
fn menu_buttons(m: &Model, t: &TypeScale) -> nk::Column {
    let commands = || COMMANDS.map(String::from).to_vec();
    let one = |k: &str, shown: Option<Shown>, disabled: bool| -> Node {
        let b = nk::MenuButton::new(
            format!("mb/{k}"),
            "Power",
            "noop",
            "nd-system-shutdown",
            commands(),
        )
        .enabled(!disabled);
        match shown {
            Some(s) => b.shown(s).into(),
            None => b.into(),
        }
    };
    let states = nk::Row::new(
        "mb/states",
        vec![
            one("rest", None, false),
            one("hover", Some(Shown::Hover), false),
            one("press", Some(Shown::Press), false),
            one("focus", Some(Shown::Focus), false),
            one("disabled", None, true),
        ],
    )
    .gap(Space::S3);
    let said = match m.command {
        Some(n) => format!("Try it: chose {}", COMMANDS[n.min(COMMANDS.len() - 1)]),
        None => "Try it: nothing chosen yet".into(),
    };
    nk::Column::new(
        "mb",
        vec![
            states.into(),
            nk::Row::new(
                "mb/live",
                vec![
                    nk::MenuButton::new(
                        "mb/live/b",
                        "Power",
                        "command",
                        "nd-system-shutdown",
                        commands(),
                    )
                    .ticked(m.command)
                    .into(),
                    nk::Label::new("mb/live/said", said, t.style(Type::Small, Weight::Regular))
                        .ink(Ink::Secondary)
                        .into(),
                ],
            )
            .gap(Space::S3)
            .into(),
        ],
    )
    .gap(Space::S3)
}
fn dropdowns(m: &Model, t: &TypeScale, dd: &DropdownStyle) -> Vec<Node> {
    let speeds = || SPEEDS.map(String::from).to_vec();
    let one =
        |k: &str, label: &str, f: &dyn Fn(nk::DropDown) -> nk::DropDown, disabled: bool| -> Node {
            let key = format!("dd/s/{k}");
            setting(key.clone(), label, None, t)
                .trailing(f(nk::DropDown::new(
                    format!("{key}/d"),
                    label,
                    "noop",
                    speeds(),
                    1,
                )
                .enabled(!disabled)))
                .enabled(!disabled)
                .into()
        };
    let states = nk::Column::new(
        "dd/states",
        vec![
            one("rest", "Rest", &|n| n, false),
            one("hover", "Hover", &|n| n.shown(Shown::Hover), false),
            one("press", "Pressed", &|n| n.shown(Shown::Press), false),
            one("focus", "Focus", &|n| n.shown(Shown::Focus), false),
            one("disabled", "Disabled", &|n| n, true),
        ],
    );
    // The open list's rows as its popup shows them, on the same panel glass.
    let row =
        |k: &str, label: &str, chosen: bool, f: &dyn Fn(nk::MenuItem) -> nk::MenuItem| -> Node {
            f(nk::MenuItem::new(
                format!("dd/m/{k}"),
                label,
                "noop",
                chosen,
            ))
            .into()
        };
    let list = nk::Pane::new(
        "dd/menu",
        Corner::Fixed(dd.menu.radius.round() as u32),
        nk::Column::new(
            "dd/menu/rows",
            vec![
                row("rest", "Rest", false, &|n| n),
                row("chosen", "Chosen", true, &|n| n),
                row("lit", "Under the pointer", false, &|n| {
                    n.shown(Shown::Hover)
                }),
                row("press", "Pressed", false, &|n| n.shown(Shown::Press)),
                row("lit-chosen", "Chosen, under the keyboard", true, &|n| {
                    n.shown(Shown::Focus)
                }),
            ],
        )
        .padding(Padding::all(Space::S2)),
    )
    .width(280.);
    let live = nk::Column::new(
        "dd/live",
        vec![
            setting(
                "dd/live/row",
                "Animation speed",
                Some("Click, or Enter, Space or an arrow, to open its list"),
                t,
            )
            .trailing(nk::DropDown::new(
                "dd/live/d",
                "Animation speed",
                "speed",
                speeds(),
                m.speed,
            ))
            .into(),
            nk::Label::new(
                "dd/live/said",
                format!("Try it: speed {}", SPEEDS[m.speed.min(SPEEDS.len() - 1)]),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary)
            .into(),
        ],
    )
    .gap(Space::S2);
    vec![
        section(
            "dd-states",
            "Dropdown (the list opens over the window; the app hears only the choice)",
            t,
            states.into(),
        ),
        section(
            "dd-list",
            "Its list (the pointer or the keyboard in the accent; the chosen one ticked)",
            t,
            nk::Row::new("dd/list/row", vec![list.into()]).into(),
        ),
        section("dd-live", "Try it", t, live.into()),
        section(
            "dd-menu-button",
            "Menu button (a glyph that opens commands; each row reports itself, every time)",
            t,
            menu_buttons(m, t).into(),
        ),
    ]
}

/// The live segmented choice's options.
pub const SIZES: [&str; 3] = ["Small", "Medium", "Large"];

/// A segmented choice with `shown` forced on some of its segments, for the states page.
fn segments_shown(mut n: nk::Segmented, shown: &[(usize, Shown)]) -> nk::Segmented {
    for (index, shown) in shown {
        n = n.sample_state(*index, *shown);
    }
    n
}

fn segmenteds(m: &Model, t: &TypeScale) -> Vec<Node> {
    let sizes = || SIZES.map(String::from).to_vec();
    let one = |k: &str, label: &str, shown: &[(usize, Shown)], disabled: bool| -> Node {
        let key = format!("sg/s/{k}");
        setting(key.clone(), label, None, t)
            .trailing(segments_shown(
                nk::Segmented::new(format!("{key}/g"), label, "noop", sizes(), 1)
                    .enabled(!disabled),
                shown,
            ))
            .enabled(!disabled)
            .into()
    };
    // Each state on the first segment and on the chosen one, side by side.
    let states = nk::Column::new(
        "sg/states",
        vec![
            one("rest", "Rest", &[], false),
            one(
                "hover",
                "Hover",
                &[(0, Shown::Hover), (1, Shown::Hover)],
                false,
            ),
            one(
                "press",
                "Pressed",
                &[(0, Shown::Press), (1, Shown::Press)],
                false,
            ),
            one("focus", "Focus", &[(1, Shown::Focus)], false),
            one("disabled", "Disabled", &[], true),
        ],
    );
    let live = nk::Column::new(
        "sg/live",
        vec![
            setting(
                "sg/live/row",
                "Dock size",
                Some("Click, or Tab to it and move the choice with the arrows"),
                t,
            )
            .trailing(nk::Segmented::new(
                "sg/live/g",
                "Dock size",
                "size",
                sizes(),
                m.size,
            ))
            .into(),
            nk::Label::new(
                "sg/live/said",
                format!("Try it: dock size {}", SIZES[m.size.min(SIZES.len() - 1)]),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary)
            .into(),
        ],
    )
    .gap(Space::S2);
    vec![
        section(
            "sg-states",
            "Segmented choice (the first segment and the chosen one in each state)",
            t,
            states.into(),
        ),
        section("sg-live", "Try it", t, live.into()),
    ]
}

pub fn colors_from(export: &serde_json::Value) -> Result<Vec<(String, nk_render::Color)>, String> {
    let colors = export["accents"]
        .as_object()
        .filter(|v| !v.is_empty())
        .ok_or("colors.json: no accents")?;
    let order = export["accentOrder"]
        .as_array()
        .filter(|v| v.len() == colors.len())
        .ok_or("colors.json: no complete accentOrder")?;
    let mut seen = std::collections::BTreeSet::new();
    order
        .iter()
        .map(|key| {
            let key = key.as_str().ok_or("colors.json: invalid accentOrder key")?;
            if !seen.insert(key) {
                return Err("colors.json: repeated accentOrder key".into());
            }
            let value = colors
                .get(key)
                .ok_or("colors.json: unknown accentOrder key")?;
            let name = export["accentNames"][key]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("colors.json: no accent name {key}"))?;
            let color = nk::parse_color(
                value
                    .as_str()
                    .ok_or_else(|| format!("colors.json: no accent colour {key}"))?,
            )?;
            Ok((name.into(), color))
        })
        .collect()
}
fn swatches(m: &Model, t: &TypeScale, colors: &[(String, nk_render::Color)]) -> Vec<Node> {
    let one = |key: &str, name: &str, disabled: bool, shown: &[(usize, Shown)]| -> Node {
        let mut samples =
            nk::Swatches::new(format!("sw/{key}/g"), name, "noop", colors.to_vec(), 0)
                .enabled(!disabled);
        for (index, shown) in shown {
            samples = samples.sample_state(*index, *shown);
        }
        setting(format!("sw/{key}"), name, None, t)
            .trailing(samples)
            .enabled(!disabled)
            .into()
    };
    let states = nk::Column::new(
        "sw/states",
        vec![
            one("rest", "Rest", false, &[]),
            one(
                "hover",
                "Hover",
                false,
                &[(0, Shown::Hover), (1, Shown::Hover)],
            ),
            one(
                "pressed",
                "Pressed",
                false,
                &[(0, Shown::Press), (1, Shown::Press)],
            ),
            one("focus", "Focus", false, &[(0, Shown::Focus)]),
            one("disabled", "Disabled", true, &[]),
        ],
    );
    let chosen = m.accent.min(colors.len().saturating_sub(1));
    let live = nk::Column::new(
        "sw/live",
        vec![
            setting(
                "sw/live/row",
                "Accent colour",
                Some("Choose a colour, or use Tab and the arrow keys"),
                t,
            )
            .trailing(nk::Swatches::new(
                "sw/live/g",
                "Accent colour",
                "accent",
                colors.to_vec(),
                chosen,
            ))
            .into(),
            nk::Label::new(
                "sw/live/said",
                format!(
                    "Try it: accent {}",
                    colors
                        .get(chosen)
                        .map(|(name, _)| name.as_str())
                        .unwrap_or("none")
                ),
                t.style(Type::Small, Weight::Regular),
            )
            .ink(Ink::Secondary)
            .into(),
        ],
    )
    .gap(Space::S2);
    vec![
        section("sw-states", "Swatches in every state", t, states.into()),
        section("sw-live", "Try it", t, live.into()),
    ]
}

fn sliders(m: &Model, t: &TypeScale) -> Vec<Node> {
    let line = |k: &str, label: &str, s: Node| {
        nk::Row::new(
            format!("sl/{k}/line"),
            vec![
                nk::Label::new(
                    format!("sl/{k}/label"),
                    label,
                    t.style(Type::Body, Weight::Regular),
                )
                .into(),
                s.grow(),
            ],
        )
        .gap(Space::S4)
        .align(Align::Center)
    };
    let s = |k: &str, v: f64| {
        nk::Slider::new(
            format!("sl/{k}"),
            k,
            "noop",
            nk::SliderRange::new(0., 100., 1., v).unit(" %"),
        )
    };
    let states = nk::Column::new(
        "sl/states",
        vec![
            line("min", "At 0", s("min", 0.).into()).into(),
            line("mid", "At 50", s("mid", 50.).into()).into(),
            line("max", "At 100", s("max", 100.).into()).into(),
            line("hover", "Hover", s("hover", 30.).shown(Shown::Hover).into()).into(),
            line("focus", "Focus", s("focus", 70.).shown(Shown::Focus).into()).into(),
            line("off", "Disabled", s("off", 50.).enabled(false).into()).into(),
        ],
    )
    .gap(Space::S3);
    let tile = nk::Grid::new(
        "sl/tile",
        2,
        96.,
        12.,
        vec![Cell {
            at: (0, 0),
            span: (1, 1),
            child: nk::Pane::new(
                "sl/tile/pane",
                Corner::Token(Radius::Lg),
                nk::Slider::new(
                    "sl/tile/slider",
                    "Brightness",
                    "tile",
                    nk::SliderRange::new(0., 100., 1., m.tile).fill(),
                )
                .corner(Corner::Token(Radius::Lg)),
            )
            .into(),
        }],
    );
    vec![
        section("sl-states", "States", t, states.into()),
        section(
            "sl-live",
            &format!("Try it: {:.0} %", m.slider),
            t,
            nk::Column::new(
                "sl/live/col",
                vec![
                    line(
                        "live",
                        "Volume",
                        nk::Slider::new(
                            "sl/live",
                            "Volume",
                            "slider",
                            nk::SliderRange::new(0., 100., 1., m.slider).unit(" %"),
                        )
                        .into(),
                    )
                    .into(),
                ],
            )
            .into(),
        ),
        section("sl-rows", "In a list row", t, slider_rows(m, t)),
        section("sl-tile", "Tile slider (the CC's)", t, tile.into()),
    ]
}

/// Settings' slider rows (VIEW.md §13.7): the kit's slider and its value at a row's end,
/// with its glyphs when it has them; the row itself does not respond.
fn slider_rows(m: &Model, t: &TypeScale) -> Node {
    let row =
        |k: &str, title: &str, action: &str, value: f64, icons: bool, disabled: bool| -> Node {
            let key = format!("sl/r/{k}");
            let mut end = nk::SliderEnd::new(
                format!("{key}/slider"),
                title,
                action,
                nk::SliderRange::new(0., 100., 1., value).unit(" %"),
                t.style(Type::Body, Weight::Regular),
            )
            .enabled(!disabled);
            if icons {
                end = end.icons([
                    "nd-display-brightness-low".into(),
                    "nd-display-brightness".into(),
                ]);
            }
            setting(key.clone(), title, None, t)
                .trailing(end)
                .enabled(!disabled)
                .into()
        };
    nk::Column::new(
        "sl/rows",
        vec![
            row("plain", "Plain", "noop", 30., false, false),
            row("live", "Brightness", "bright", m.bright, true, false),
            row("off", "Disabled", "noop", 60., true, true),
        ],
    )
    .into()
}

fn fields(t: &TypeScale) -> Vec<Node> {
    let f = |k: &str, shown: &str, caret: usize, anchor: usize, secret: bool| {
        nk::Field::new(
            format!("f/{k}"),
            k,
            "noop",
            nk::FieldState {
                shown: shown.into(),
                caret,
                anchor,
                secret,
            },
            t.style(Type::Body, Weight::Regular),
        )
    };
    let line = |k: &str, label: &str, field: Node| {
        nk::Row::new(
            format!("f/{k}/line"),
            vec![
                nk::Label::new(
                    format!("f/{k}/label"),
                    label,
                    t.style(Type::Body, Weight::Regular),
                )
                .into(),
                field.grow(),
            ],
        )
        .gap(Space::S4)
        .align(Align::Center)
    };
    let text = "Nidara";
    let dots = "●●●●●●";
    let states = nk::Column::new(
        "f/states",
        vec![
            line("empty", "Empty", f("empty", "", 0, 0, false).into()).into(),
            line("text", "With text", f("text", text, 6, 6, false).into()).into(),
            line(
                "focus",
                "Focus",
                f("focus", text, 6, 6, false).shown(Shown::Focus).into(),
            )
            .into(),
            line("secret", "Password", f("secret", dots, 18, 18, true).into()).into(),
            line(
                "off",
                "Disabled",
                f("off", text, 6, 6, false).enabled(false).into(),
            )
            .into(),
        ],
    )
    .gap(Space::S3);
    vec![
        section(
            "f-states",
            "Password (nk::Field, old: the CC's, until nk::Entry has a password mode)",
            t,
            states.into(),
        ),
        nk::Label::new(
            "f/note",
            "nk::Field is the old field whose owner does the typing (VIEW.md §12.2). It goes when nk::Entry has a password mode and the CC moves to it.",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .lines(3).into(),
    ]
}

fn glass(t: &TypeScale) -> Vec<Node> {
    let card = |k: &str, label: &str, corner: Corner, opacity: f64| {
        nk::Pane::new(
            format!("g/{k}"),
            corner,
            nk::Column::new(
                format!("g/{k}/col"),
                vec![
                    nk::Label::new(
                        format!("g/{k}/text"),
                        label,
                        t.style(Type::Body, Weight::Medium),
                    )
                    .into(),
                ],
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
        nk::Row::new(
            "g/corners",
            corners
                .iter()
                .map(|(k, l, c)| card(k, l, *c, 1.))
                .map(Node::from)
                .collect(),
        )
        .gap(Space::S4)
        .into(),
        // A pane formed part-way is not a lighter material: it is how the CC's edit mode shows
        // a free cell (`ccedit.rs`, 16 %), and how every pane looks while it reveals.
        nk::Row::new(
            "g/opacity",
            [
                ("o100", "Formed", Corner::Token(Radius::Lg), 1.),
                ("o16", "Free cell", Corner::Pill, 0.16),
            ]
            .iter()
            .map(|(k, l, c, o)| card(k, l, *c, *o))
            .map(Node::from)
            .collect(),
        )
        .gap(Space::S4)
        .into(),
        nk::Label::new(
            "g/opacity/note",
            "Formed part-way: the CC edit mode's free cell at 16 %, and any pane while it reveals.",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .into(),
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
    // A column per weight, headed by its name and its value as the kit sets it (`fw-*`); the
    // type scale down each one, so a row is one size in every weight.
    let weights = [
        (Weight::Regular, "Regular"),
        (Weight::Medium, "Medium"),
        (Weight::Semibold, "Semibold"),
        (Weight::Bold, "Bold"),
    ];
    let scale: Vec<Node> = vec![
        nk::Row::new(
            "t/scale",
            weights
                .iter()
                .map(|(w, wn)| {
                    let head = format!("{wn} {}", t.style(Type::Body, *w).weight);
                    let mut cells: Vec<Node> = vec![
                        nk::Label::new(
                            format!("t/{wn}/head"),
                            head,
                            t.style(Type::Caption, Weight::Semibold),
                        )
                        .ink(Ink::Secondary)
                        .into(),
                    ];
                    cells.extend(types.iter().enumerate().map(|(i, (ty, name))| {
                        Node::from(nk::Label::new(
                            format!("t/{i}/{wn}"),
                            *name,
                            t.style(*ty, *w),
                        ))
                    }));
                    Node::from(nk::Column::new(format!("t/{wn}"), cells).gap(Space::S2))
                })
                .collect(),
        )
        .gap(Space::S6)
        .into(),
    ];
    let inks = row(
        "t/inks",
        [
            (Ink::Primary, "Primary"),
            (Ink::Secondary, "Secondary"),
            (Ink::Dim, "Dim"),
        ]
        .iter()
        .map(|(ink, n)| {
            nk::Label::new(
                format!("t/ink/{n}"),
                *n,
                t.style(Type::Body, Weight::Regular),
            )
            .ink(*ink)
        })
        .map(Node::from)
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
            nk::Column::new("t/scale/col", scale).into(),
        ),
        section("t-inks", "Inks", t, inks),
        section(
            "t-lines",
            "Wrapped to two lines",
            t,
            nk::Label::new("t/long", long, t.style(Type::Body, Weight::Regular))
                .lines(2)
                .into(),
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
            let mut items: Vec<Node> = vec![
                nk::Label::new(
                    format!("i/{s}/label"),
                    format!("{s:.0} px"),
                    t.style(Type::Small, Weight::Regular),
                )
                .ink(Ink::Dim)
                .into(),
            ];
            items.extend(
                names
                    .iter()
                    .map(|n| nk::Image::new(format!("i/{s}/{n}"), *n, *s).into()),
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
                nk::Image::new(format!("i/ink/{n}"), "nd-ai", 24.)
                    .ink(*ink)
                    .into(),
            )
        })
        .collect(),
    );
    vec![
        section(
            "i-sizes",
            "Interface glyphs (nd-) by size",
            t,
            nk::Column::new("i/sizes", rows).gap(Space::S3).into(),
        ),
        section("i-inks", "Inks", t, inks),
        section(
            "i-avatars",
            "Avatar: without a picture, and with the mark",
            t,
            row(
                "i/avatars",
                vec![
                    sample(
                        "i/avatar/plain",
                        "80 px",
                        t,
                        nk::Avatar::new("i/avatar/80", 80.).into(),
                    ),
                    sample(
                        "i/avatar/small",
                        "48 px",
                        t,
                        nk::Avatar::new("i/avatar/48", 48.).into(),
                    ),
                    sample(
                        "i/avatar/mark",
                        "Marked",
                        t,
                        nk::Avatar::new("i/avatar/marked", 48.).mark(true).into(),
                    ),
                ],
            ),
        ),
    ]
}

/// A small card for the layout samples: a group, not glass.
fn block(key: &str, label: &str, t: &TypeScale) -> Node {
    nk::Group::new(
        key,
        nk::Column::new(
            format!("{key}/col"),
            vec![
                nk::Label::new(
                    format!("{key}/text"),
                    label,
                    t.style(Type::Small, Weight::Medium),
                )
                .into(),
            ],
        )
        .padding(Padding::symmetric(Space::S2, Space::S3)),
    )
    .into()
}

fn layout(t: &TypeScale) -> Vec<Node> {
    let mut out: Vec<Node> = vec![];
    for (i, s) in Space::ALL.iter().enumerate() {
        let name = format!("{s:?}");
        out.push(
            nk::Row::new(
                format!("l/gap/{i}"),
                vec![
                    nk::Label::new(
                        format!("l/gap/{i}/label"),
                        format!("Gap {name}"),
                        t.style(Type::Small, Weight::Regular),
                    )
                    .ink(Ink::Dim)
                    .into(),
                    block(&format!("l/gap/{i}/a"), "A", t),
                    block(&format!("l/gap/{i}/b"), "B", t),
                    block(&format!("l/gap/{i}/c"), "C", t),
                ],
            )
            .gap(*s)
            .align(Align::Center)
            .into(),
        );
    }
    for (k, j) in [
        ("start", Justify::Start),
        ("center", Justify::Center),
        ("end", Justify::End),
    ] {
        out.push(
            nk::Row::new(
                format!("l/j/{k}"),
                vec![
                    block(&format!("l/j/{k}/a"), &format!("Justify {k}"), t),
                    block(&format!("l/j/{k}/b"), "B", t),
                ],
            )
            .gap(Space::S2)
            .justify(j)
            .into(),
        );
    }
    out.push(
        nk::Row::new(
            "l/spacer",
            vec![
                block("l/spacer/a", "Start", t),
                nk::Spacer::new("l/spacer/gap").into(),
                block("l/spacer/b", "A spacer between", t),
            ],
        )
        .gap(Space::S2)
        .into(),
    );
    out
}

fn scroll(t: &TypeScale) -> Vec<Node> {
    let mut out: Vec<Node> = vec![nk::Label::new(
        "sc/note",
        "This page is the scroll region: the content scrolls under the wheel, Page Up and Page Down, Ctrl+Home and Ctrl+End, and its bar shows while it moves.",
        t.style(Type::Body, Weight::Regular),
    )
    .lines(3)
    .into()];
    out.extend((1..=30).map(|i| block(&format!("sc/{i}"), &format!("Row {i}"), t)));
    out
}

fn overlay(t: &TypeScale) -> Vec<Node> {
    let base = nk::Group::new(
        "o/base",
        nk::Column::new(
            "o/base/col",
            vec![
                nk::Label::new(
                    "o/base/text",
                    "The base gives the size",
                    t.style(Type::Body, Weight::Medium),
                )
                .into(),
                nk::Label::new(
                    "o/base/room",
                    "Layers lie over it, placed by alignment and inset.",
                    t.style(Type::Small, Weight::Regular),
                )
                .ink(Ink::Secondary)
                .reserve(5)
                .into(),
            ],
        )
        .padding(Padding::all(Space::S5)),
    );
    // What lies over the base is glass, as anything over content is.
    let tag = |k: &str, glyph: &str| {
        nk::Pane::new(
            format!("o/{k}/glass"),
            Corner::Pill,
            nk::Button::with_child(
                format!("o/{k}"),
                k,
                "noop",
                nk::Row::new(
                    format!("o/{k}/row"),
                    vec![nk::Image::new(format!("o/{k}/icon"), glyph, 16.).into()],
                )
                .padding(Padding::all(Space::S1)),
            )
            .corner(Corner::Pill),
        )
    };
    let layered = nk::Overlay::new("o/overlay", base)
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
        layered.into(),
        nk::Label::new(
            "o/note",
            "Layers placed by alignment and inset, as the CC's remove marks are.",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .into(),
    ]
}

fn grid(t: &TypeScale, s: &nk::TileStyle) -> Vec<Node> {
    let tile = |k: &str, at: (usize, usize), span: (usize, usize)| Cell {
        at,
        span,
        child: block(&format!("gr/{k}"), &format!("{}×{}", span.0, span.1), t),
    };
    // The Control Center's grid as it is: its four columns, its cell and gap from the tile
    // tokens (`toolkit/tokens/tile.json`), and every size a tile has there, the 4×1 included.
    vec![
        nk::Grid::new(
            "gr/grid",
            4,
            s.cell,
            s.gap,
            vec![
                tile("single", (0, 0), (1, 1)),
                tile("wide", (1, 0), (2, 1)),
                tile("single2", (3, 0), (1, 1)),
                tile("tall", (0, 1), (1, 2)),
                tile("square", (1, 1), (2, 2)),
                tile("single3", (3, 1), (1, 1)),
                tile("single4", (3, 2), (1, 1)),
                tile("full", (0, 3), (4, 1)),
            ],
        )
        .into(),
        nk::Label::new(
            "gr/note",
            "The Control Center's grid and its five tile sizes: 1×1, 2×1, 1×2, 2×2 and 4×1. Square cells; where each tile goes is the surface's to decide (VIEW.md §12.4).",
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .lines(2)
        .into(),
    ]
}

/// The kit's icon item (#1168): `nk::IconItem` on `nk::Grid`, Apps' tile, with its tokens
/// (`toolkit/tokens/icon-grid.json`): the icon, the name under it (one line, ended in an
/// ellipsis), one marked new. Here the icons are themed glyphs; Apps paints app icons in the
/// same slot.
fn icon_items(m: &Model, t: &TypeScale, s: &nk::IconGridStyle) -> Vec<Node> {
    let base = t.style(Type::Body, Weight::Regular);
    let items = [
        ("Files", "nd-folder"),
        ("Settings", "nd-preferences-system"),
        ("Notifications", "nd-notifications"),
        ("Keyboard", "nd-input-keyboard"),
        ("Control Center", "nd-control-center"),
        ("Apps", "nd-view-grid"),
        ("A name far too long to fit", "nd-hand"),
    ];
    let cells = items
        .iter()
        .enumerate()
        .map(|(n, (name, icon))| {
            let item = nk::IconItem::new(format!("ig-{n}"), *name, "press", s, &base).icon(*icon);
            nk::Cell {
                at: (n % s.columns, n / s.columns),
                span: (1, 1),
                child: if n == 1 { item.new_mark("new") } else { item }.into(),
            }
        })
        .collect();
    let width = s.columns as f64 * s.cell + (s.columns as f64 - 1.) * s.gap;
    vec![
        section(
            "ig-grid",
            "A row of icon items, one marked new, one name too long",
            t,
            nk::Grid::new("ig/grid", s.columns, s.cell, s.gap, cells)
                .width(width)
                .into(),
        ),
        nk::Label::new(
            "ig/note",
            format!(
                "nk::IconItem: an icon with its name under it, the whole of it one control in a square cell; a dot by the icon when new. nk::panel_layout places a panel of them under a floating search: at most {} × {}, the same panel on any larger output. Presses: {}.",
                s.columns, s.rows, m.presses
            ),
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .lines(4)
        .into(),
    ]
}

/// The kit's notification card (#1156 step 3, point 5): `nk::NotificationCard` folded, open
/// with its actions, fronting a group and with an error, at the notification centre's width
/// (the tile grid's) with its tokens (`toolkit/tokens/notification.json`). The app icons,
/// thumbnails and pictures are slots its surface paints (here: empty).
fn notifications(m: &Model, t: &TypeScale, k: &Measures) -> Vec<Node> {
    let base = t.style(Type::Body, Weight::Regular);
    let s = k.notification;
    let width = 4. * k.tile.cell + 3. * k.tile.gap;
    let card = |id: &str, title: &str, age: &str| {
        nk::NotificationCard::new(format!("no-{id}"), title, age, s, &base)
            .open("press", title)
            .close("press", "Close notification")
    };
    let body = "The quarterly report is ready to review. Open it to see the figures and the notes left for you.";
    let cards: Vec<Node> = vec![
        card("folded", "Report ready", "5 min")
            .body(body)
            .more(false, "press")
            .thumbnail()
            .into(),
        card("open", "New message", "now")
            .body("Are we still on for tomorrow at ten?")
            .more(true, "press")
            .actions(vec![
                nk::NotificationAction {
                    key: "no-open/act/reply".into(),
                    label: "Reply".into(),
                    action: "press".into(),
                },
                nk::NotificationAction {
                    key: "no-open/act/mark".into(),
                    label: "Mark as read".into(),
                    action: "press".into(),
                },
            ])
            .into(),
        card("group", "Download complete", "1 h")
            .body("Report.pdf, 40 MB")
            .count(3)
            .into(),
        card("error", "Backup", "2 h")
            .body("Nightly backup to the external disk.")
            .error("The disk could not be found.")
            .into(),
    ];
    vec![
        section(
            "no-cards",
            "Folded, open with its actions, fronting a group, with an error",
            t,
            nk::Column::new("no/list", cards)
                .gap(Space::S4)
                .width(width)
                .into(),
        ),
        nk::Label::new(
            "no/note",
            format!(
                "nk::NotificationCard: the app's icon, the title with its age (a chevron in its place on hover when it opens), the body, a thumbnail or a picture across the open card, its actions and its close on hover; the whole card one control, a swipe its close. Icons and pictures are slots the surface paints. Presses: {}.",
                m.presses
            ),
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .lines(4)
        .into(),
    ]
}

/// The kit's tiles (#1156 step 4): `nk::Tile` in each of its contents and `nk::SliderTile`, on
/// the tile grid with its tokens (`toolkit/tokens/tile.json`) — the Control Center's tiles,
/// usable by any surface. Pictures and values are slots its surface paints (here: empty).
fn tiles(m: &Model, t: &TypeScale, s: &nk::TileStyle) -> Vec<Node> {
    use nk::{TileAction, TileContent, TileSize};
    let base = t.style(Type::Body, Weight::Regular);
    let action = |k: &str, icon: &str, name: &str, primary: bool| TileAction {
        key: format!("ti/{k}").into(),
        action: "press".into(),
        icon: icon.into(),
        name: name.into(),
        enabled: true,
        primary,
    };
    // Each player tile has keys of its own: the page's keys are unique.
    let player = |id: &str| TileContent::Picture {
        title: "Song title".into(),
        subtitle: "Artist".into(),
        actions: vec![
            action(
                &format!("{id}/prev"),
                "nd-media-skip-backward",
                "Previous",
                false,
            ),
            action(
                &format!("{id}/play"),
                "nd-media-playback-start",
                "Play",
                true,
            ),
            action(
                &format!("{id}/next"),
                "nd-media-skip-forward",
                "Next",
                false,
            ),
        ],
    };
    let cell = |at: (usize, usize), span: (usize, usize), child: Node| Cell { at, span, child };
    let tile = |id: &str, size: TileSize, content: TileContent| {
        nk::Tile::new(format!("ti-{id}"), size, content, s, &base)
    };
    let grid = nk::Grid::new(
        "ti/grid",
        4,
        s.cell,
        s.gap,
        vec![
            cell(
                (0, 0),
                (1, 1),
                tile(
                    "focus",
                    TileSize::Single,
                    TileContent::Icon("nd-notifications-disabled".into()),
                )
                .control("ti/focus", "Focus")
                .action("toggle")
                .toggle(m.toggle)
                .into(),
            ),
            cell(
                (1, 0),
                (2, 1),
                tile(
                    "bt",
                    TileSize::Wide,
                    TileContent::Badge {
                        icon: "nd-bluetooth-active".into(),
                        title: "Bluetooth".into(),
                        subtitle: if m.toggle { "On" } else { "Off" }.into(),
                        toggle: Some("ti/bt/badge".into()),
                        lit: m.toggle,
                    },
                )
                .control("ti/bt", "Bluetooth")
                .action("press")
                .into(),
            ),
            cell(
                (3, 0),
                (1, 1),
                tile("cover", TileSize::Single, player("cover"))
                    .control("ti/cover", "Now playing")
                    .action("press")
                    .into(),
            ),
            cell(
                (0, 1),
                (1, 2),
                nk::SliderTile::new(
                    "ti-tall",
                    TileSize::Tall,
                    "ti/tall",
                    nk::SliderRange::new(0., 100., 5., m.tile),
                    ("nd-display-brightness-low", 14., "nd-display-brightness"),
                    s,
                )
                .named("Brightness", "tile")
                .into(),
            ),
            cell(
                (1, 1),
                (2, 2),
                tile("player", TileSize::Square, player("player"))
                    .control("ti/player", "Now playing")
                    .action("press")
                    .into(),
            ),
            cell(
                (3, 1),
                (1, 1),
                tile(
                    "icon",
                    TileSize::Single,
                    TileContent::Icon("nd-screenshot".into()),
                )
                .control("ti/icon", "Screenshot")
                .action("press")
                .into(),
            ),
            cell(
                (0, 3),
                (4, 1),
                nk::SliderTile::new(
                    "ti-full",
                    TileSize::Full,
                    "ti/full",
                    nk::SliderRange::new(0., 100., 5., m.tile),
                    ("nd-audio-volume-low", 16., "nd-audio-volume-high"),
                    s,
                )
                .named("Volume", "tile")
                .into(),
            ),
            cell(
                (0, 4),
                (2, 1),
                tile(
                    "download",
                    TileSize::Wide,
                    TileContent::Picture {
                        title: "Report.pdf".into(),
                        subtitle: "12 of 40 MB".into(),
                        actions: vec![action("pause", "nd-media-playback-pause", "Pause", true)],
                    },
                )
                .control("ti/download", "Report.pdf")
                .action("press")
                .into(),
            ),
            cell(
                (2, 4),
                (2, 1),
                tile("wide-player", TileSize::Wide, player("wide-player"))
                    .control("ti/wide-player", "Now playing")
                    .action("press")
                    .into(),
            ),
        ],
    );
    vec![
        section("ti-grid", "Every content and size, on the tile grid", t, grid.into()),
        nk::Label::new(
            "ti/note",
            format!(
                "nk::Tile: a glyph, a badge with its titles, a picture with up to three actions (a player, a download), or its surface's own content; the whole tile one control, a toggle or not. nk::SliderTile: 4×1 and 1×2. Pictures and values are slots the surface paints. Presses: {}.",
                m.presses
            ),
            t.style(Type::Small, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .lines(4)
        .into(),
    ]
}

fn reveal(m: &Model, t: &TypeScale) -> Vec<Node> {
    vec![
        nk::Row::new(
            "r/toggle/line",
            vec![
                content_button(
                    "r/toggle",
                    if m.open { "Close" } else { "Open" },
                    "reveal",
                    t,
                )
                .into(),
            ],
        )
        .into(),
        nk::Revealer::new(
            "r/reveal",
            m.open,
            nk::Group::new(
                "r/pane",
                nk::Column::new(
                    "r/col",
                    vec![
                        nk::Label::new(
                            "r/title",
                            "Revealed",
                            t.style(Type::Subtitle, Weight::Semibold),
                        )
                        .into(),
                        nk::Label::new(
                            "r/body",
                            "It unrolls downward in place, and what is under it moves with it.",
                            t.style(Type::Body, Weight::Regular),
                        )
                        .lines(2)
                        .into(),
                    ],
                )
                .gap(Space::S2)
                .padding(Padding::all(Space::S5)),
            ),
        )
        .into(),
        block("r/below", "Below the reveal", t),
    ]
}

fn disclosures(m: &Model, t: &TypeScale) -> Vec<Node> {
    let sample = |key: &str, label: &str, open: bool| nk::Expander::new(key, label, "noop", open);
    let states = nk::Column::new(
        "d/states",
        vec![
            sample("d/closed", "Closed", false).into(),
            sample("d/open", "Expanded", true).into(),
            sample("d/hover", "Hover", false).shown(Shown::Hover).into(),
            sample("d/press", "Pressed", true)
                .shown(Shown::Press)
                .into(),
            sample("d/focus", "Focus", false).shown(Shown::Focus).into(),
            sample("d/disabled", "Disabled", false)
                .enabled(false)
                .into(),
        ],
    );
    let live = nk::Expander::new("d/live", "Advanced", "disclosure", m.expanded).child(
        nk::Column::new(
            "d/details",
            vec![
                nk::Label::new(
                    "d/explanation",
                    "The model owns expansion; the component reports its new value.",
                    t.style(Type::Body, Weight::Regular),
                )
                .lines(2)
                .into(),
                content_button("d/child", "Revealed action", "press", t).into(),
            ],
        )
        .gap(Space::S3)
        .padding(Padding::all(Space::S3)),
    );
    vec![
        section(
            "d/live-section",
            "Try it: click the whole header, Enter or Space",
            t,
            live.into(),
        ),
        section("d/state-section", "States", t, states.into()),
    ]
}

fn entries(m: &Model, t: &TypeScale) -> Vec<Node> {
    let field = |key: &str, text: &str| nk::Entry::new(key, "Sample text", "noop", text);
    let live = nk::Entry::new("e/input", "Editable text", "entry-edit", m.entry.clone())
        .placeholder("Write here")
        .submit("entry-submit");
    vec![
        section(
            "entry-live",
            "Try it: type, compose, select and paste",
            t,
            nk::Column::new(
                "e/live",
                vec![
                    live.into(),
                    nk::Label::new(
                        "e/value",
                        format!("Value: {}", m.entry),
                        t.style(Type::Body, Weight::Regular),
                    )
                    .lines(2)
                    .into(),
                    nk::Label::new(
                        "e/submitted",
                        format!("Submitted: {}", m.submitted),
                        t.style(Type::Body, Weight::Regular),
                    )
                    .into(),
                ],
            )
            .gap(Space::S3)
            .into(),
        ),
        section(
            "entry-states",
            "States",
            t,
            nk::Column::new(
                "e/states",
                vec![
                    field("e/empty", "").into(),
                    field("e/text", "Nidara").into(),
                    field("e/focus", "Keyboard focus")
                        .shown(Shown::Focus)
                        .into(),
                    field("e/disabled", "Disabled").enabled(false).into(),
                ],
            )
            .gap(Space::S3)
            .into(),
        ),
    ]
}
fn search_field(m: &Model, t: &TypeScale) -> Vec<Node> {
    let mut out = vec![section(
        "search-live",
        "Try it: Escape clears before it leaves; the clear control returns focus",
        t,
        nk::Column::new(
            "q/live",
            vec![
                nk::SearchEntry::new(
                    "q/search",
                    "Search text",
                    "search-edit",
                    m.search.clone(),
                    "Clear search",
                )
                .placeholder("Search the catalogue")
                .submit("search-submit")
                .into(),
                nk::Label::new(
                    "q/value",
                    format!("Query: {}", m.search),
                    t.style(Type::Body, Weight::Regular),
                )
                .lines(2)
                .into(),
            ],
        )
        .gap(Space::S3)
        .into(),
    )];
    // Suggestions: the matches sit under the field, in the flow, never in a popup that would
    // take the keyboard from it. Down goes to them and Up from the first comes back.
    let matches = city_matches(&m.city);
    let mut suggest = vec![
        nk::SearchEntry::new("q/city", "City", "city-edit", m.city.clone(), "Clear city")
            .placeholder("Search for a city")
            .suggestions("q/cities")
            .into(),
    ];
    if !matches.is_empty() {
        suggest.push(
            nk::ListBox::new(
                "q/cities",
                "Matching cities",
                "city-choose",
                matches
                    .iter()
                    .map(|&i| nk::ListBoxOption::new(CITIES[i].0).subtitle(CITIES[i].1))
                    .collect(),
                t.style(Type::Body, Weight::Regular),
            )
            .subtitle_style(t.style(Type::Small, Weight::Regular))
            .into(),
        );
    }
    suggest.push(
        nk::Label::new(
            "q/city-chosen",
            match m.city_chosen {
                Some(i) => format!("Chosen: {} — {}", CITIES[i].0, CITIES[i].1),
                None => "Chosen: none".into(),
            },
            t.style(Type::Body, Weight::Regular),
        )
        .ink(Ink::Secondary)
        .into(),
    );
    out.push(section(
        "search-suggest",
        "With suggestions: type, then Down to the matches; Up from the first returns",
        t,
        nk::Column::new("q/suggest", suggest).gap(Space::S3).into(),
    ));
    let specimen = |key: &str, name: &str, value: &str, disabled: bool| -> Node {
        nk::SearchEntry::new(key, name, "noop", value, format!("Clear {name}"))
            .placeholder("Search")
            .enabled(!disabled)
            .into()
    };
    out.push(section(
        "search-states",
        "States",
        t,
        nk::Column::new(
            "q/states",
            vec![
                specimen("q/empty", "Empty search", "", false),
                specimen("q/filled", "Filled search", "Nidara", false),
                specimen("q/disabled", "Disabled search", "Nidara", true),
            ],
        )
        .gap(Space::S3)
        .into(),
    ));
    out
}

fn time_field(m: &Model, t: &TypeScale) -> Vec<Node> {
    let body = t.style(Type::Body, Weight::Regular);
    let specimen = |key: &str, name: &str, time: &str| {
        nk::TimeField::new(key, name, "noop", time, body.clone())
    };
    vec![
        section(
            "time-live",
            "Try it: Left and Right pick the part, Up and Down step it, digits type it",
            t,
            nk::Column::new(
                "t/live",
                vec![
                    nk::TimeField::new("t/time", "Turns on", "time-set", &m.time, body.clone())
                        .into(),
                    nk::Label::new("t/value", format!("Value: {}", m.time), body.clone()).into(),
                ],
            )
            .gap(Space::S3)
            .into(),
        ),
        section(
            "time-states",
            "States",
            t,
            nk::Column::new(
                "t/states",
                vec![
                    specimen("t/rest", "At rest", "07:05").into(),
                    specimen("t/focus", "Keyboard focus", "18:45")
                        .shown(Shown::Focus)
                        .into(),
                    specimen("t/disabled", "Disabled", "23:59")
                        .enabled(false)
                        .into(),
                ],
            )
            .gap(Space::S3)
            .into(),
        ),
    ]
}

/// The suggestions sample's cities, with the region each is shown under.
pub const CITIES: [(&str, &str); 8] = [
    ("Madrid", "Europe"),
    ("Managua", "Americas"),
    ("Manila", "Asia"),
    ("Marseille", "Europe"),
    ("Melbourne", "Australia"),
    ("Mexico City", "Americas"),
    ("Montevideo", "Americas"),
    ("Nairobi", "Africa"),
];
/// The cities whose name starts with what is typed (none for an empty query, or once the
/// text is exactly a city: it was chosen).
pub fn city_matches(query: &str) -> Vec<usize> {
    let q = query.trim().to_lowercase();
    if q.is_empty() || CITIES.iter().any(|c| c.0.to_lowercase() == q) {
        return vec![];
    }
    (0..CITIES.len())
        .filter(|&i| CITIES[i].0.to_lowercase().starts_with(&q))
        .collect()
}

struct Records<'a>(&'a TypeScale);
impl nk::ListSource for Records<'_> {
    fn item(&self, index: usize) -> nk::RowInfo {
        nk::RowInfo {
            key: format!("record-{index}").into(),
            name: format!("Record {}", index + 1),
        }
    }
    fn build(&self, index: usize, key: &nk::Key) -> Node {
        // The same row as in a group: a long list holds `nk::ListRow`s too.
        nk::ListRow::new(
            format!("{}/row", key.0),
            format!("Record {}", index + 1),
            self.0.style(Type::Body, Weight::Regular),
        )
        .into()
    }
}
fn long_list(m: &Model, t: &TypeScale, k: &Measures) -> Vec<Node> {
    let source = Records(t);
    vec![
        section(
            "long-list",
            "5,000 records · arrows, Home/End, Page Up/Down · Enter or double click opens",
            t,
            nk::Column::new(
                "ll/sample",
                vec![
                    nk::Label::new(
                        "ll/value",
                        format!(
                            "Selected: {} · Opened: {}",
                            m.selected_row + 1,
                            m.list_opened
                        ),
                        t.style(Type::Body, Weight::Regular),
                    )
                    .into(),
                    nk::ListView::new(
                        "ll/live",
                        "Records",
                        "list-select",
                        &source,
                        5000,
                        m.selected_row,
                        k.row_height,
                    )
                    .window(k.list_window)
                    .activate("list-open")
                    .height(k.row_height * 6.)
                    .into(),
                ],
            )
            .gap(Space::S2)
            .into(),
        ),
        section(
            "long-list-states",
            "Disabled and empty",
            t,
            nk::Column::new(
                "ll/states",
                vec![
                    nk::ListView::new(
                        "ll/disabled",
                        "Disabled records",
                        "noop",
                        &source,
                        20,
                        2,
                        k.row_height,
                    )
                    .window(k.disabled_list_window)
                    .height(k.row_height * 2.)
                    .enabled(false)
                    .into(),
                    nk::ListView::new(
                        "ll/empty",
                        "Empty records",
                        "noop",
                        &source,
                        0,
                        0,
                        k.row_height,
                    )
                    .height(k.row_height)
                    .into(),
                ],
            )
            .gap(Space::S2)
            .into(),
        ),
    ]
}

/// The same outline on every component, in the portal's light or dark appearance.
/// Background panes never change the controls' shape or add an interactive wrapper.
fn focus_page(t: &TypeScale, k: &Measures) -> Vec<Node> {
    let mut sections = vec![];
    for glass in [false, true] {
        let prefix = if glass { "focus/glass" } else { "focus/page" };
        let key = |name: &str| format!("{prefix}/{name}");
        let name = |name: &str| format!("{name} {}", if glass { "on glass" } else { "off glass" });
        let segment = nk::Column::new(
            key("segment-samples"),
            (0..3)
                .map(|index| {
                    nk::Segmented::new(
                        key(&format!("segments{index}")),
                        name(&format!("Segment {index}")),
                        "noop",
                        vec!["Start".into(), "Middle".into(), "End".into()],
                        1,
                    )
                    .sample_state(index, Shown::Focus)
                    .into()
                })
                .collect(),
        )
        .gap(Space::S3);
        // colors_from validates a non-empty, complete named export before the page exists.
        let color = k.colors.first().expect("validated accent palette").1;
        let swatches = nk::Swatches::new(
            key("swatches"),
            name("Swatches"),
            "noop",
            vec![(name("Swatch"), color)],
            0,
        )
        .sample_state(0, Shown::Focus);
        let samples: Vec<Node> = vec![
            content_button(&key("button"), &name("Button"), "noop", t)
                .shown(Shown::Focus)
                .into(),
            button(&key("capsule"), &name("Capsule"), "noop", t)
                .shown(Shown::Focus)
                .into(),
            nk::Switch::new(key("switch"), name("Switch"), "noop", true)
                .shown(Shown::Focus)
                .into(),
            nk::CheckButton::new(key("check"), name("Checkbox"), "noop", true)
                .shown(Shown::Focus)
                .into(),
            nk::CheckButton::radio(key("radio"), name("Radio"), "noop", true)
                .shown(Shown::Focus)
                .into(),
            nk::DropDown::new(
                key("dropdown"),
                name("Dropdown"),
                "noop",
                vec!["Option".into()],
                0,
            )
            .shown(Shown::Focus)
            .into(),
            segment.into(),
            swatches.into(),
            nk::Slider::new(
                key("slider"),
                name("Slider"),
                "noop",
                nk::SliderRange::new(0., 100., 1., 50.),
            )
            .width(240.)
            .shown(Shown::Focus)
            .into(),
            nk::Field::new(
                key("display"),
                name("Display field"),
                "noop",
                nk::FieldState {
                    shown: "Nidara".into(),
                    caret: 0,
                    anchor: 0,
                    secret: false,
                },
                t.style(Type::Body, Weight::Regular),
            )
            .shown(Shown::Focus)
            .into(),
            nk::Expander::new(key("disclosure"), name("Disclosure"), "noop", false)
                .shown(Shown::Focus)
                .into(),
            nk::Entry::new(key("entry"), name("Text field"), "noop", "Nidara")
                .width(240.)
                .shown(Shown::Focus)
                .into(),
            nk::SearchEntry::new(
                key("search"),
                name("Search"),
                "noop",
                "Nidara",
                name("Clear search"),
            )
            .width(240.)
            .sample_state(0, Shown::Focus)
            .into(),
            nk::SearchEntry::new(
                key("search-clear"),
                name("Search clear"),
                "noop",
                "Nidara",
                name("Clear button"),
            )
            .width(240.)
            .sample_state(1, Shown::Focus)
            .into(),
            nk::SidebarEntry::new(
                key("sidebar"),
                name("Sidebar entry"),
                "nd-preferences-system",
                "noop",
                t.style(Type::Body, Weight::Regular),
                k.glyph,
            )
            .width(240.)
            .shown(Shown::Focus)
            .into(),
            // Reference: menu focus is its accent selection, without a ring.
            nk::MenuItem::new(key("menu"), name("Menu row"), "noop", false)
                .width(240.)
                .shown(Shown::Focus)
                .into(),
            nk::ListView::new(
                key("list"),
                name("List"),
                "noop",
                &Records(t),
                3,
                0,
                k.row_height,
            )
            .window(Some((0., k.row_height * 2.)))
            .height(k.row_height * 2.)
            .width(240.)
            .shown(Shown::Focus)
            .into(),
            nk::ListView::new(
                key("empty"),
                name("Empty list"),
                "noop",
                &Records(t),
                0,
                0,
                k.row_height,
            )
            .height(k.row_height)
            .width(240.)
            .shown(Shown::Focus)
            .into(),
            content_button(&key("disabled"), &name("Disabled, no ring"), "noop", t)
                .enabled(false)
                .shown(Shown::Focus)
                .into(),
        ];
        let rows = samples
            .into_iter()
            .enumerate()
            .map(|(i, node)| {
                let body = nk::Row::new(key(&format!("cell{i}")), vec![node])
                    .padding(Padding::all(Space::S3));
                if glass {
                    nk::Pane::new(key(&format!("pane{i}")), Corner::Token(Radius::Sm), body).into()
                } else {
                    body.into()
                }
            })
            .collect();
        sections.push(section(
            &key("section"),
            if glass {
                "On glass · the same 2 px gap"
            } else {
                "Off glass · solid accent, width 2 px, gap 2 px"
            },
            t,
            nk::Column::new(key("samples"), rows).gap(Space::S2).into(),
        ));
    }
    sections
}

fn dialogs(m: &Model, t: &TypeScale) -> Vec<Node> {
    vec![section(
        "dialogs",
        "A modal window owned by this window",
        t,
        nk::Column::new(
            "dialogs/samples",
            vec![
                content_button("dialogs/open", "Open dialog", "dialog-open", t).into(),
                setting("dialogs/font-row", "Font", None, t)
                    .trailing(nk::FontButton::new("dialogs/font", &m.font, "font-open"))
                    .into(),
                content_button("dialogs/alert", "Open alert", "alert-open", t).into(),
                content_button("dialogs/timed", "Open timed alert", "alert-timed", t).into(),
                content_button(
                    "dialogs/destructive",
                    "Open destructive alert",
                    "alert-delete",
                    t,
                )
                .into(),
                content_button(
                    "dialogs/invalid",
                    "Reject destructive default",
                    "dialog-invalid",
                    t,
                )
                .into(),
                nk::Label::new(
                    "dialogs/result",
                    format!("Dialog answers: {} · {}", m.modal_answers, m.modal_result),
                    t.style(Type::Body, Weight::Regular),
                )
                .into(),
            ],
        )
        .gap(Space::S3)
        .into(),
    )]
}

fn system_dialogs(m: &Model, t: &TypeScale) -> Vec<Node> {
    vec![section(
        "system-dialogs",
        "Independent windows",
        t,
        nk::Column::new(
            "system-dialogs/samples",
            vec![
                content_button(
                    "system-dialogs/open",
                    "Open system dialog",
                    "system-dialog-open",
                    t,
                )
                .into(),
                content_button(
                    "system-dialogs/alert",
                    "Open system alert",
                    "system-alert-open",
                    t,
                )
                .into(),
                content_button(
                    "system-dialogs/timed",
                    "Open timed system alert",
                    "system-alert-timed",
                    t,
                )
                .into(),
                nk::Label::new(
                    "system-dialogs/result",
                    format!("Response: {}", m.modal_result),
                    t.style(Type::Small, Weight::Regular),
                )
                .into(),
            ],
        )
        .gap(Space::S3)
        .into(),
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scale() -> TypeScale {
        let statics: serde_json::Value = serde_json::json!({"scss": {
            "fse-mini": "0.77em", "fse-caption": "0.85em", "fse-small": "0.92em", "fse-body": "1em",
            "fse-subtitle": "1.08em", "fse-title-3": "1.23em", "fse-title-2": "1.54em", "fse-title-1": "2em",
            "fw-regular": "400", "fw-medium": "500", "fw-semibold": "600", "fw-bold": "700",
            "fs-display": "88px", "fw-display": "200"}});
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

    /// The dropdown as `toolkit/tokens/dropdown.json` gives it, its colours any.
    fn dropdown() -> nk::DropdownStyle {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../tokens/dropdown.json")).unwrap();
        let grey = "#808080";
        let names = [
            "--nidara-surface-back",
            "--nidara-surface-hover",
            "--nidara-surface-active",
            "--nidara-text",
            "--nidara-text-dim",
            "--nidara-accent",
            "--nidara-accent-fg",
            "--nidara-popover-bg",
            "--nidara-popover-border",
        ];
        let set = serde_json::json!({ "tokens": names
            .iter()
            .map(|n| (n.to_string(), serde_json::json!(grey)))
            .collect::<serde_json::Map<_, _>>() });
        let statics = serde_json::json!({
            "scss": {"space-1": "4px", "space-2": "8px", "space-3": "12px", "space-4": "16px",
                "space-5": "20px", "space-6": "24px", "space-8": "32px", "space-10": "40px"},
            "ts": {"RADIUS": {"xs": 6, "sm": 10, "md": 16, "lg": 24, "xl": 32}}});
        nk::dropdown_from(
            &file["default"],
            &set,
            &nk::Radii::from_static(&statics).unwrap(),
            &nk::Spacing::from_static(&statics).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn palette_requires_exported_colours_and_names() {
        let good = serde_json::json!({"accentOrder":["red","blue"],"accents":{"blue":"#0088ff","red":"#ff0000"},
            "accentNames":{"blue":"Blue","red":"Red"}});
        let c = colors_from(&good).unwrap();
        assert_eq!(
            c.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
            ["Red", "Blue"]
        );
        assert_eq!(c[1].1.components, [0., 136. / 255., 1., 1.]);
        for bad in [serde_json::json!({}), serde_json::json!({"accents":{}})] {
            assert!(colors_from(&bad).is_err());
        }
        for (field, value) in [
            ("accentNames", serde_json::json!({})),
            ("accentOrder", serde_json::json!(null)),
            ("accentOrder", serde_json::json!([])),
            ("accentOrder", serde_json::json!(["red", "red"])),
            ("accentOrder", serde_json::json!(["red", "unknown"])),
            ("accentOrder", serde_json::json!(["red", 1])),
            (
                "accents",
                serde_json::json!({"blue":"invalid","red":"#ff0000"}),
            ),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(colors_from(&bad).is_err(), "{field}");
        }
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
            let v = view(
                &m,
                &cat,
                &t,
                &Measures {
                    dropdown: &dropdown(),
                    tile: &nk::tile_from(
                        &serde_json::from_str::<serde_json::Value>(include_str!(
                            "../../tokens/tile.json"
                        ))
                        .unwrap()["default"],
                    )
                    .unwrap(),
                    icon_grid: &nk::icon_grid_from(
                        &serde_json::from_str::<serde_json::Value>(include_str!(
                            "../../tokens/icon-grid.json"
                        ))
                        .unwrap()["default"],
                    )
                    .unwrap(),
                    notification: &nk::notification_from(
                        &serde_json::from_str::<serde_json::Value>(include_str!(
                            "../../tokens/notification.json"
                        ))
                        .unwrap()["default"],
                    )
                    .unwrap(),
                    colors: &[
                        ("Blue".into(), nk_render::rgba(0, 128, 255, 255)),
                        ("Red".into(), nk_render::rgba(255, 0, 0, 255)),
                    ],
                    glyph: 16.,
                    row_height: 40.,
                    list_window: None,
                    disabled_list_window: None,
                    files_window: None,
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

#[cfg(test)]
mod catalogue_tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Public names of the kit that are not components a page can show, and why.
    const NOT_SHOWN: &[(&str, &str)] = &[
        ("Widget", "the trait every component implements"),
        ("prelude", "the import that brings Widget in"),
        (
            "Slot",
            "room a surface paints itself: an app window cannot paint into it yet (#1103)",
        ),
    ];

    /// The names in `pub use <module>::{…};` of nk-view's lib.rs.
    fn exported(lib: &str, module: &str) -> Vec<String> {
        let start = format!("pub use {module}::{{");
        let at = lib
            .find(&start)
            .unwrap_or_else(|| panic!("no `{start}` in lib.rs"))
            + start.len();
        let end = at + lib[at..].find('}').expect("an unclosed export");
        lib[at..end]
            .split(',')
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// The gallery is the kit's proof (#1156): every public component of the kit is shown on
    /// a page, under its `nk::` name, and the catalogue names no type the kit does not have.
    /// The chooser built its own sidebar because the kit's was on no page; this fails first.
    #[test]
    fn every_public_component_of_the_kit_is_on_a_page() {
        let lib = include_str!("../../crates/nk-view/src/lib.rs");
        let mut public: BTreeSet<String> = exported(lib, "widgets").into_iter().collect();
        public.extend(exported(lib, "file_views"));
        public.extend(exported(lib, "tiles"));
        public.extend(exported(lib, "notification_card"));
        public.extend(exported(lib, "icon_grid"));
        public.extend(["AppWindow", "Alert", "Dialog", "FontDialog"].map(String::from));
        let cat = Catalogue::load().unwrap();
        let pages: BTreeSet<&str> = PAGES.iter().map(|(id, _, _)| *id).collect();
        let items: Vec<&Item> = cat.groups.iter().flat_map(|g| &g.items).collect();
        for item in &items {
            if let Some(page) = &item.page {
                assert!(
                    pages.contains(page.as_str()),
                    "{}: no page {page:?}",
                    item.name
                );
            }
            for name in &item.nk {
                let bare = name
                    .strip_prefix("nk::")
                    .unwrap_or_else(|| panic!("{}: {name:?} is not written nk::Name", item.name));
                assert!(
                    public.contains(bare),
                    "{}: the kit has no {name}",
                    item.name
                );
            }
        }
        let shown: BTreeSet<&str> = items
            .iter()
            .filter(|i| i.page.is_some())
            .flat_map(|i| &i.nk)
            .map(|n| n.trim_start_matches("nk::"))
            .collect();
        let missing: Vec<&String> = public
            .iter()
            .filter(|n| !shown.contains(n.as_str()))
            .filter(|n| !NOT_SHOWN.iter().any(|(x, _)| x == n))
            .collect();
        assert!(
            missing.is_empty(),
            "public components on no gallery page (add them to catalogue.json with a page): {missing:?}"
        );
    }
}

fn arrangement(model: &Model, types: &TypeScale) -> Vec<Node> {
    let size = (360., 180.);
    let mut items: Vec<_> = [[0., 0., 1920., 1080.], [1920., 0., 1280., 1024.]]
        .into_iter()
        .enumerate()
        .map(|(index, mut bounds)| {
            let (x, y) = model.arrangement_offsets[index];
            bounds[0] += x;
            bounds[1] += y;
            let name = format!("Display {}", index + 1);
            nk::ArrangementItem {
                key: format!("arrangement/sample/{index}").into(),
                label: name.clone(),
                name,
                action: format!("arrange:{index}"),
                bounds,
                selected: model.arrangement_selected == index,
                movable: true,
            }
        })
        .collect();
    let projection = nk::ArrangementProjection::fit(&items, size, 12.);
    let moved = &mut items[model.arrangement_selected];
    moved.bounds[0] += model.arrangement_preview.0;
    moved.bounds[1] += model.arrangement_preview.1;
    vec![nk::Arrangement::view(
        "arrangement/sample",
        size,
        projection,
        items,
        types.style(Type::Body, Weight::Regular),
    )]
}
