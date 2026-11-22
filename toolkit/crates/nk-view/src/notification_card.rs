// SPDX-License-Identifier: LGPL-3.0-or-later
//! The kit's notification card (#1156 step 3, point 5): one notification on its own glass —
//! the app's icon, the title with its age, the body, an optional thumbnail or a picture across
//! the card, its actions and its close. The notification centre's, and any surface's that
//! lists notices. `toolkit/tokens/notification.json` holds every measure; the surface says
//! only what the notice is and what each press reports.
use crate::{
    Align, Button, Column, Corner, Image, Ink, Key, Label, Node, Overlay, Padding, Pane,
    Placeholder, Row, Space, Wash, prelude::*, tokens::NotificationStyle,
};
use nk_text::TextStyle;

/// One action of a notification: a labelled button under its text.
#[derive(Clone, Debug)]
pub struct NotificationAction {
    pub key: Key,
    pub label: String,
    /// What it reports when activated.
    pub action: String,
}

/// One notification on its own glass. Its keys are `{id}/…`: the pane `{id}/pane`, and the
/// slots its surface paints — `{id}/app` (the app's icon), `{id}/thumb` (the thumbnail) and
/// `{id}/hero` (the picture across an open card). The whole card is one button; its close
/// shows on hover, and a swipe does what the close does.
#[must_use]
pub struct NotificationCard<'a> {
    id: String,
    style: &'a NotificationStyle,
    base: &'a TextStyle,
    title: String,
    age: String,
    body: String,
    error: String,
    name: Option<String>,
    description: String,
    open: String,
    close: (String, String),
    count: Option<usize>,
    more: Option<(bool, String)>,
    actions: Vec<NotificationAction>,
    thumbnail: bool,
    hero: Option<f64>,
}

impl<'a> NotificationCard<'a> {
    /// A card titled `title`, `age` old (already written: "now", "5 min").
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        age: impl Into<String>,
        style: &'a NotificationStyle,
        base: &'a TextStyle,
    ) -> Self {
        Self {
            id: id.into(),
            style,
            base,
            title: title.into(),
            age: age.into(),
            body: String::new(),
            error: String::new(),
            name: None,
            description: String::new(),
            open: String::new(),
            close: (String::new(), String::new()),
            count: None,
            more: None,
            actions: vec![],
            thumbnail: false,
            hero: None,
        }
    }
    /// The body under the title: two lines however short folded (every card of its kind one
    /// height), more open.
    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }
    /// Why the notice's last action failed, under its text.
    pub fn error(mut self, error: impl Into<String>) -> Self {
        self.error = error.into();
        self
    }
    /// What the card reports when pressed, and its name for readers (default: its title).
    pub fn open(mut self, action: impl Into<String>, name: impl Into<String>) -> Self {
        self.open = action.into();
        self.name = Some(name.into());
        self
    }
    /// What a reader hears after the name (the age, the body): they are inside the card's
    /// control, so they are not labels of their own.
    pub fn description(mut self, said: impl Into<String>) -> Self {
        self.description = said.into();
        self
    }
    /// What the close and a swipe report, and the close's name.
    pub fn close(mut self, action: impl Into<String>, name: impl Into<String>) -> Self {
        self.close = (action.into(), name.into());
        self
    }
    /// The card fronts a folded group of `n`: shown after its age.
    pub fn count(mut self, n: usize) -> Self {
        self.count = Some(n);
        self
    }
    /// The card opens and folds: `expanded` or not, and what its chevron reports. The chevron
    /// shows on hover in the age's place, so the title line never moves.
    pub fn more(mut self, expanded: bool, action: impl Into<String>) -> Self {
        self.more = Some((expanded, action.into()));
        self
    }
    /// Its actions, shown when open.
    pub fn actions(mut self, actions: Vec<NotificationAction>) -> Self {
        self.actions = actions;
        self
    }
    /// A thumbnail right of the text (`{id}/thumb`), unless a picture spans the card.
    pub fn thumbnail(mut self) -> Self {
        self.thumbnail = true;
        self
    }
    /// Open, a picture `height` tall across the card under its text (`{id}/hero`), with the
    /// actions under it; see `NotificationStyle::hero_height`.
    pub fn hero(mut self, height: f64) -> Self {
        self.hero = Some(height);
        self
    }

    fn text(&self, size: f32, weight: f32) -> TextStyle {
        TextStyle {
            size,
            weight,
            line_height: self.style.line_height,
            ..self.base.clone()
        }
    }
}

impl From<NotificationCard<'_>> for Node {
    fn from(c: NotificationCard<'_>) -> Node {
        let s = c.style;
        let id = &c.id;
        let k = |part: &str| format!("{id}/{part}");
        let pane = k("pane");
        let expanded = c.more.as_ref().is_some_and(|(open, _)| *open);
        let hero = c.hero.filter(|_| expanded);
        let age = Label::new(k("age"), c.age.clone(), c.text(s.age, 400.)).ink(Ink::Dim);
        let age: Node = match &c.more {
            Some((open, action)) => Overlay::new(k("when"), age.hidden_with(pane.clone()))
                .layer(
                    Align::Center,
                    Align::Center,
                    Padding::default(),
                    Button::with_child(
                        k("more"),
                        if *open { "Show less" } else { "Show more" },
                        action.clone(),
                        Image::new(
                            k("more/icon"),
                            if *open { "nd-pan-up" } else { "nd-pan-down" },
                            s.glyph,
                        ),
                    )
                    .revealed_with(pane.clone()),
                )
                .into(),
            None => age.into(),
        };
        let mut head: Vec<Node> = vec![
            Label::new(k("title"), c.title.clone(), c.text(s.title, s.title_weight))
                .lines(1)
                .grow()
                .into(),
            age,
        ];
        if let Some(n) = c.count {
            head.push(
                Label::new(k("count"), n.to_string(), c.text(s.count, s.count_weight))
                    .ink(Ink::Secondary)
                    .into(),
            );
        }
        let mut text: Vec<Node> = vec![
            Row::new(k("head"), head)
                .gap(Space::S2)
                .align(Align::Center)
                .into(),
        ];
        if !c.body.is_empty() {
            text.push(
                Label::new(k("body"), c.body.clone(), c.text(s.body, 400.))
                    .lines(if expanded {
                        s.lines_open
                    } else {
                        s.lines_folded
                    })
                    .reserve(if expanded { 0 } else { s.lines_folded })
                    .ink(Ink::Secondary)
                    .into(),
            );
        }
        let mut actions = (expanded && !c.actions.is_empty()).then(|| {
            Row::new(
                k("actions"),
                c.actions
                    .iter()
                    .map(|a| {
                        let key = a.key.0.clone();
                        Button::with_child(
                            a.key.clone(),
                            a.label.clone(),
                            a.action.clone(),
                            Row::new(
                                format!("{key}/pad"),
                                vec![
                                    Label::new(
                                        format!("{key}/text"),
                                        a.label.clone(),
                                        c.text(s.action, 400.),
                                    )
                                    .lines(1)
                                    .into(),
                                ],
                            )
                            .padding(Padding::symmetric(Space::S1, Space::S3)),
                        )
                        .into()
                    })
                    .collect(),
            )
            .gap(Space::S2)
        });
        if hero.is_none()
            && let Some(row) = actions.take()
        {
            text.push(row.into());
        }
        if !c.error.is_empty() {
            text.push(
                Label::new(k("error"), c.error.clone(), c.text(s.error, 400.))
                    .lines(s.lines_error)
                    .into(),
            );
        }
        let mut row: Vec<Node> = vec![
            Image::new(k("app"), "", s.art).into(),
            Column::new(k("text"), text).gap(Space::S1).grow().into(),
        ];
        if hero.is_none() && c.thumbnail {
            row.push(Image::new(k("thumb"), "", s.art).into());
        }
        let mut body: Vec<Node> = vec![
            Row::new(k("row"), row)
                .gap(Space::S3)
                .align(Align::Center)
                .into(),
        ];
        if let Some(h) = hero {
            body.push(Placeholder::new(k("hero"), h).into());
        }
        body.extend(actions.map(Node::from));
        let corner = Corner::Token(s.corner);
        let (close_action, close_name) = c.close;
        let content = Button::with_child(
            k("card"),
            c.name.unwrap_or(c.title),
            c.open,
            Column::new(k("body-col"), body)
                .gap(Space::S3)
                .padding(Padding::all(Space::S3)),
        )
        .description(c.description)
        .wash(Wash::None)
        .corner(corner)
        .swipe(close_action.clone());
        let close = Button::with_child(
            k("close"),
            close_name,
            close_action,
            Row::new(
                k("close/pad"),
                vec![Image::new(k("close/icon"), "nd-window-close", s.glyph).into()],
            )
            .padding(Padding::all(Space::S1)),
        )
        .wash(Wash::Destructive)
        .revealed_with(pane.clone());
        Pane::new(
            pane,
            corner,
            Overlay::new(k("over"), content).layer(
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
        .into()
    }
}
