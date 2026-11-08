// SPDX-License-Identifier: LGPL-3.0-or-later
//! Indexed history viewport. Data/group changes build the index; scrolling touches visible rows only.
use crate::{
    notification_card::{self, Card},
    notifications::Banner,
    popup::Look,
};
use nk_a11y::{Action, Bounds, Node, Role, Tree};
use nk_render::{Canvas, Color};
use nk_text::{Rect, TextStyle};
use nk_wayland::{MaterialRect, Pane, StateRegion};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
pub const PANEL: u64 = 1 << 54;
const CONTROL: u64 = PANEL + 100;
pub const CLEAR_MS: u32 = 150;
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Previous,
    Next,
    Today,
    ClearAll,
    Up,
    Down,
    Group(String),
    ClearGroup(String),
}
#[derive(Clone, Debug)]
pub struct Control {
    pub id: u64,
    pub target: Target,
    pub label: String,
    pub rect: [f64; 4],
    pub expanded: Option<bool>,
}
#[derive(Clone, Debug)]
enum Kind {
    Group {
        key: String,
        name: String,
        count: usize,
    },
    Card(usize),
}
#[derive(Clone, Debug)]
struct Row {
    y: f64,
    height: f64,
    kind: Kind,
}
pub struct Center {
    pub panel: [f64; 4],
    pub viewport: [f64; 4],
    pub cards: Vec<Card>,
    pub controls: Vec<Control>,
    pub focus: Option<u64>,
    control_ids: HashMap<Target, u64>,
    next_control: u64,
    pub hover: Option<u64>,
    pub error: String,
    pub clearing: bool,
    locations: HashMap<u64, (f64, f64)>,
    pub year: i32,
    pub month: i32,
    history: Arc<Vec<Banner>>,
    expanded: HashSet<String>,
    groups: HashMap<String, u64>,
    next: u64,
    rows: Vec<Row>,
    total: f64,
    offset: f64,
    pub minute: u64,
}
impl Default for Center {
    fn default() -> Self {
        let now = glib::DateTime::now_local().ok();
        Self {
            panel: [0.; 4],
            viewport: [0.; 4],
            cards: vec![],
            controls: vec![],
            focus: None,
            control_ids: Default::default(),
            next_control: CONTROL,
            hover: None,
            error: String::new(),
            clearing: false,
            locations: Default::default(),
            year: now.as_ref().map_or(2026, |d| d.year()),
            month: now.as_ref().map_or(1, |d| d.month()),
            history: Default::default(),
            expanded: Default::default(),
            groups: Default::default(),
            next: 32,
            rows: vec![],
            total: 0.,
            offset: 0.,
            minute: 0,
        }
    }
}
pub fn group(b: &Banner) -> String {
    let key = b.notice.hint("desktop-entry");
    if key.is_empty() {
        b.notice.app_name.clone()
    } else {
        key.into()
    }
}
pub fn age(time: u64, now: u64) -> String {
    let seconds = now.saturating_sub(time);
    match seconds {
        0..60 => "now".into(),
        60..3600 => format!("{} min", seconds / 60),
        3600..86400 => format!("{} h", seconds / 3600),
        _ => format!("{} d", seconds / 86400),
    }
}
pub fn calendar(year: i32, month: i32) -> Vec<(i32, usize)> {
    let Ok(first) = glib::DateTime::from_local(year, month, 1, 0, 0, 0.) else {
        return vec![];
    };
    let offset = (first.day_of_week() - 1) as usize;
    (1..=31)
        .take_while(|day| glib::DateTime::from_local(year, month, *day, 0, 0, 0.).is_ok())
        .map(|day| (day, offset + day as usize - 1))
        .collect()
}
impl Center {
    /// Ids survive unrelated arrivals, but never a closed/replaced panel view.
    pub fn retire_view(&mut self) {
        self.control_ids.clear();
        self.controls.clear();
        self.focus = None;
        self.hover = None;
    }
    pub fn set_history(&mut self, history: Arc<Vec<Banner>>) {
        if Arc::ptr_eq(&self.history, &history) {
            return;
        }
        self.history = history;
        self.rebuild();
    }
    fn rebuild(&mut self) {
        let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, b) in self.history.iter().enumerate() {
            if !b.notice.transient() {
                groups.entry(group(b)).or_default().push(i);
            }
        }
        for indices in groups.values_mut() {
            indices.sort_by_key(|i| {
                std::cmp::Reverse((
                    self.history[*i].notice.time,
                    self.history[*i].notice.revision,
                ))
            });
        }
        let mut ordered: Vec<_> = groups.into_iter().collect();
        ordered.sort_by_key(|(_, indices)| {
            std::cmp::Reverse((
                self.history[indices[0]].notice.time,
                self.history[indices[0]].notice.revision,
            ))
        });
        self.rows.clear();
        self.locations.clear();
        let mut y = 0.;
        for (key, indices) in ordered {
            if !self.groups.contains_key(&key) {
                self.next += 1;
                self.groups.insert(key.clone(), self.next);
            }
            self.rows.push(Row {
                y,
                height: 40.,
                kind: Kind::Group {
                    key: key.clone(),
                    name: self.history[indices[0]].notice.app_name.clone(),
                    count: indices.len(),
                },
            });
            y += 40.;
            let count = if self.expanded.contains(&key) {
                indices.len()
            } else {
                1
            };
            for i in indices.into_iter().take(count) {
                let b = &self.history[i];
                let h = if b.notice.actions.iter().any(|a| a.id != "default") {
                    152.
                } else {
                    112.
                } + if b.error.is_empty() { 0. } else { 28. };
                self.locations.insert(b.instance, (y, h));
                self.rows.push(Row {
                    y,
                    height: h,
                    kind: Kind::Card(i),
                });
                y += h + 16.;
            }
        }
        self.total = y;
        self.offset = self.offset.min((y - self.viewport[3]).max(0.));
    }
    pub fn change(&mut self, target: &Target) -> Option<Option<String>> {
        match target {
            Target::Previous | Target::Next => {
                if let Ok(d) = glib::DateTime::from_local(self.year, self.month, 1, 0, 0, 0.)
                    .and_then(|d| d.add_months(if *target == Target::Previous { -1 } else { 1 }))
                {
                    self.year = d.year();
                    self.month = d.month();
                }
            }
            Target::Today => {
                if let Ok(d) = glib::DateTime::now_local() {
                    self.year = d.year();
                    self.month = d.month();
                }
            }
            Target::Up => {
                self.scroll(-self.viewport[3] * 0.8);
            }
            Target::Down => {
                self.scroll(self.viewport[3] * 0.8);
            }
            Target::Group(key) => {
                if !self.expanded.remove(key) {
                    self.expanded.insert(key.clone());
                }
                self.rebuild();
            }
            Target::ClearAll => return Some(None),
            Target::ClearGroup(key) => return Some(Some(key.clone())),
        }
        None
    }
    pub fn reveal(&mut self, instance: u64) {
        if let Some((y, h)) = self.locations.get(&instance).copied() {
            if y < self.offset {
                self.offset = y;
            } else if y + h > self.offset + self.viewport[3] {
                self.offset = (y + h - self.viewport[3]).max(0.);
            }
        }
    }
    pub fn scroll(&mut self, delta: f64) -> bool {
        let old = self.offset;
        self.offset = (self.offset + delta).clamp(0., (self.total - self.viewport[3]).max(0.));
        old != self.offset
    }
    pub fn contains(&self, p: (f64, f64)) -> bool {
        inside(self.panel, p)
    }
    pub fn control(&self, id: u64) -> Option<Target> {
        self.controls
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.target.clone())
    }
    pub fn motion(&mut self, p: (f64, f64)) -> bool {
        let next = self
            .controls
            .iter()
            .find(|c| inside(c.rect, p))
            .map(|c| c.id);
        let changed = self.hover != next;
        self.hover = next;
        changed
    }
    pub fn hit(&self, p: (f64, f64)) -> Option<Target> {
        self.controls
            .iter()
            .find(|c| inside(c.rect, p))
            .map(|c| c.target.clone())
    }
    fn add(
        &mut self,
        _id: u64,
        target: Target,
        label: String,
        rect: [f64; 4],
        expanded: Option<bool>,
    ) {
        let id = *self.control_ids.entry(target.clone()).or_insert_with(|| {
            self.next_control += 1;
            self.next_control
        });
        self.controls.push(Control {
            id,
            target,
            label,
            rect,
            expanded,
        });
    }
    pub fn place(&mut self, right: f64, height: u32, pages: &HashMap<u64, usize>) {
        let w = notification_card::WIDTH.min((right - 4.).max(1.));
        let y = crate::barmodel::TOP + crate::barmodel::CAPSULE_H + crate::cc::HANG;
        self.panel = [right - w, y, w, (height as f64 - y - 4.).max(1.)];
        let x = right - w;
        let h = self.panel[3];
        let calendar_h = 264_f64.min((h - 160.).max(64.));
        self.viewport = [x, y + calendar_h + 36., w, (h - calendar_h - 76.).max(1.)];
        self.offset = self.offset.min((self.total - self.viewport[3]).max(0.));
        self.controls.clear();
        self.cards.clear();
        let nav = (w - 32.) / 3.;
        self.add(
            1,
            Target::Previous,
            "Previous".into(),
            [x + 16., y + 40., nav - 4., 28.],
            None,
        );
        self.add(
            2,
            Target::Today,
            "Today".into(),
            [x + 16. + nav, y + 40., nav - 4., 28.],
            None,
        );
        self.add(
            3,
            Target::Next,
            "Next".into(),
            [x + 16. + nav * 2., y + 40., nav - 4., 28.],
            None,
        );
        self.add(
            4,
            Target::ClearAll,
            "Clear all".into(),
            [right - 88., y + calendar_h, 72., 28.],
            None,
        );
        self.add(
            5,
            Target::Up,
            "Scroll up".into(),
            [x + 16., y + h - 32., 96., 24.],
            None,
        );
        self.add(
            6,
            Target::Down,
            "Scroll down".into(),
            [right - 112., y + h - 32., 96., 24.],
            None,
        );
        let begin = self.rows.partition_point(|r| r.y + r.height <= self.offset);
        let end = self.offset + self.viewport[3];
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.minute = now / 60;
        for row in self.rows[begin..]
            .iter()
            .take_while(|r| r.y < end)
            .cloned()
            .collect::<Vec<_>>()
        {
            let yy = self.viewport[1] + row.y - self.offset;
            match row.kind {
                Kind::Group { key, name, count } => {
                    let id = self.groups[&key] * 4;
                    let expanded = self.expanded.contains(&key);
                    let bounds = intersection([x + 16., yy, w - 120., 32.], self.viewport);
                    self.add(
                        id,
                        Target::Group(key.clone()),
                        format!("{name} ({count})"),
                        bounds,
                        Some(expanded),
                    );
                    self.add(
                        id + 1,
                        Target::ClearGroup(key),
                        format!("Clear {name}"),
                        intersection([right - 96., yy, 80., 32.], self.viewport),
                        None,
                    );
                }
                Kind::Card(i) => {
                    let mut c = notification_card::layout(
                        std::slice::from_ref(&self.history[i]),
                        right,
                        10000,
                        pages,
                    )
                    .remove(0);
                    c.translate(0., yy - c.rect[1]);
                    c.age = Some(age(c.banner.notice.time, now));
                    self.cards.push(c);
                }
            }
        }
    }
    pub fn pane(&self) -> Pane {
        Pane {
            x: self.panel[0],
            y: self.panel[1],
            width: self.panel[2],
            height: self.panel[3],
            radius: notification_card::RADIUS
                .min(self.panel[2] / 2.)
                .min(self.panel[3] / 2.),
            exponent: 2.,
            pointer: None,
        }
    }
    pub fn states(&self) -> Vec<StateRegion> {
        let mut out: Vec<_> = self
            .controls
            .iter()
            .filter(|c| c.rect[2] > 0. && c.rect[3] > 0.)
            .map(|c| StateRegion {
                id: (c.id - CONTROL) as u32 + 50000,
                bounds: MaterialRect {
                    x: c.rect[0],
                    y: c.rect[1],
                    width: c.rect[2],
                    height: c.rect[3],
                },
                radius: c.rect[3] / 2.,
                wash: [
                    1.,
                    1.,
                    1.,
                    if self.focus == Some(c.id) || self.hover == Some(c.id) {
                        0.12
                    } else if matches!(
                        c.target,
                        Target::Previous | Target::Today | Target::Next | Target::ClearAll
                    ) {
                        0.04
                    } else {
                        0.
                    },
                ],
                fade_ms: 150,
            })
            .collect();
        if let Ok(today) = glib::DateTime::now_local()
            && today.year() == self.year
            && today.month() == self.month
        {
            for (day, cell) in calendar(self.year, self.month) {
                if day == today.day_of_month() {
                    let r = self.day_rect(cell);
                    out.push(StateRegion {
                        id: 49999,
                        bounds: MaterialRect {
                            x: r[0],
                            y: r[1],
                            width: r[2],
                            height: r[3],
                        },
                        radius: r[3] / 2.,
                        wash: [1., 1., 1., 0.16],
                        fade_ms: 150,
                    });
                }
            }
        }
        out
    }
    fn day_rect(&self, cell: usize) -> [f64; 4] {
        let room = (self.panel[2] - 32.) / 7.;
        [
            self.panel[0] + 16. + cell as f64 % 7. * room,
            self.panel[1] + 94. + (cell / 7) as f64 * 24.,
            room - 2.,
            24.,
        ]
    }
    pub fn paint(&self, c: &mut Canvas, look: &mut Look, material: bool) -> nk_wayland::Result<()> {
        use notification_card::text;
        let [x, y, w, _] = self.panel;
        let style = TextStyle {
            size: 13.,
            ..look.styles.text.clone()
        };
        if !material {
            c.rounded_rect(
                rect(self.panel),
                self.pane().radius,
                look.style.row.background,
            );
            for s in self.states() {
                c.rounded_rect(
                    Rect {
                        x: s.bounds.x as f32,
                        y: s.bounds.y as f32,
                        width: s.bounds.width as f32,
                        height: s.bounds.height as f32,
                    },
                    s.radius,
                    Color::new([1., 1., 1., s.wash[3] as f32]),
                );
            }
        }
        c.clip_rounded_rect(rect(self.panel), self.pane().radius);
        let month = glib::DateTime::from_local(self.year, self.month, 1, 0, 0, 0.)
            .ok()
            .and_then(|d| d.format("%B %Y").ok())
            .map(|s| s.to_string())
            .unwrap_or_default();
        text(
            c,
            look,
            &month,
            &style,
            [x + 16., y + 14., w - 32., 22.],
            1,
            1.,
        )?;
        for (i, day) in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            .iter()
            .enumerate()
        {
            text(
                c,
                look,
                day,
                &style,
                [
                    x + 16. + i as f64 * (w - 32.) / 7.,
                    y + 73.,
                    (w - 32.) / 7.,
                    20.,
                ],
                1,
                0.65,
            )?;
        }
        for (day, cell) in calendar(self.year, self.month) {
            let r = self.day_rect(cell);
            text(
                c,
                look,
                &day.to_string(),
                &style,
                [r[0] + 8., r[1] + 2., r[2] - 8., 20.],
                1,
                1.,
            )?;
        }
        text(
            c,
            look,
            "Notifications",
            &style,
            [x + 16., self.viewport[1] - 32., w - 120., 24.],
            1,
            1.,
        )?;
        for control in &self.controls {
            text(
                c,
                look,
                &control.label,
                &style,
                [
                    control.rect[0] + 6.,
                    control.rect[1] + 3.,
                    (control.rect[2] - 12.).max(1.),
                    (control.rect[3] - 4.).max(1.),
                ],
                1,
                1.,
            )?;
        }
        if self.rows.is_empty() && !self.clearing {
            text(
                c,
                look,
                "No notifications",
                &style,
                [x + 24., self.viewport[1] + 24., w - 48., 24.],
                1,
                0.65,
            )?;
        }
        if !self.error.is_empty() {
            text(
                c,
                look,
                &self.error,
                &style,
                [x + 120., y + self.panel[3] - 30., (w - 240.).max(1.), 24.],
                1,
                1.,
            )?;
        }
        c.pop_clip();
        Ok(())
    }
    pub fn semantics(&self, tree: &mut Tree) {
        let mut panel = Node::new(PANEL, Role::Panel, "Notification Center");
        panel.bounds = bounds(self.panel);
        panel.description = self.error.clone();
        for c in &self.controls {
            let mut n = Node::new(
                c.id,
                Role::Button,
                match c.target {
                    Target::Previous => "Previous month",
                    Target::Next => "Next month",
                    _ => &c.label,
                },
            );
            n.bounds = bounds(c.rect);
            n.actions = vec![Action::Activate, Action::Focus];
            n.states.focused = self.focus == Some(c.id);
            if let Some(expanded) = c.expanded {
                n.states.expandable = true;
                n.states.expanded = expanded;
            }
            panel.children.push(n.id);
            tree.nodes.insert(n.id, n);
        }
        let mut date = Node::new(
            PANEL + 1,
            Role::Label,
            format!("Calendar {}-{:02}", self.year, self.month),
        );
        date.bounds = bounds([
            self.panel[0] + 16.,
            self.panel[1] + 14.,
            self.panel[2] - 32.,
            22.,
        ]);
        date.description = glib::DateTime::now_local()
            .ok()
            .and_then(|d| d.format("Today: %A, %d %B %Y").ok())
            .map(|s| s.to_string())
            .unwrap_or_default();
        panel.children.push(date.id);
        tree.nodes.insert(date.id, date);
        let today = glib::DateTime::now_local().ok();
        for (day, cell) in calendar(self.year, self.month) {
            let mut n = Node::new(
                PANEL + (1 << 40) + day as u64,
                Role::Label,
                format!("{}-{:02}-{day:02}", self.year, self.month),
            );
            n.bounds = bounds(self.day_rect(cell));
            n.states.selected = today.as_ref().is_some_and(|d| {
                d.year() == self.year && d.month() == self.month && d.day_of_month() == day
            });
            if n.states.selected {
                n.description = "Today".into();
            }
            panel.children.push(n.id);
            tree.nodes.insert(n.id, n);
        }
        if self.rows.is_empty() && !self.clearing {
            let mut n = Node::new(PANEL + 2, Role::Label, "No notifications");
            n.bounds = bounds([
                self.panel[0] + 24.,
                self.viewport[1] + 24.,
                self.panel[2] - 48.,
                24.,
            ]);
            panel.children.push(n.id);
            tree.nodes.insert(n.id, n);
        }
        tree.nodes.get_mut(&tree.root).unwrap().children.push(PANEL);
        tree.nodes.insert(PANEL, panel);
    }
}
fn inside(r: [f64; 4], p: (f64, f64)) -> bool {
    p.0 >= r[0] && p.0 < r[0] + r[2] && p.1 >= r[1] && p.1 < r[1] + r[3]
}
pub fn intersection(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let x = a[0].max(b[0]);
    let y = a[1].max(b[1]);
    [
        x,
        y,
        (a[0] + a[2]).min(b[0] + b[2]).max(x) - x,
        (a[1] + a[3]).min(b[1] + b[3]).max(y) - y,
    ]
}
fn rect(r: [f64; 4]) -> Rect {
    Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}
fn bounds(r: [f64; 4]) -> Bounds {
    Bounds {
        x: r[0],
        y: r[1],
        width: r[2],
        height: r[3],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rows(n: u32) -> Arc<Vec<Banner>> {
        let mut history = crate::notifications::History::default();
        for id in 1..=n {
            history.put(crate::notifications::Notice::parse(&serde_json::json!({"id":id,"time":id,"revision":id,"app_name":"One app","summary":format!("record {id}")}).to_string()).unwrap());
        }
        history.entries
    }
    #[test]
    fn controls_survive_arrivals_but_never_retarget_a_new_view() {
        let mut nc = Center::default();
        nc.set_history(rows(1));
        nc.place(1276., 720, &HashMap::new());
        let id = nc
            .controls
            .iter()
            .find(|c| c.target == Target::ClearAll)
            .unwrap()
            .id;
        nc.set_history(rows(2));
        nc.place(1276., 720, &HashMap::new());
        assert_eq!(nc.control(id), Some(Target::ClearAll));
        nc.retire_view();
        nc.place(1276., 720, &HashMap::new());
        assert_eq!(nc.control(id), None);
    }
    #[test]
    fn washes_fit_compositor_budget_and_keep_today() {
        let mut nc = Center::default();
        nc.set_history(rows(2000));
        nc.place(1276., 720, &HashMap::new());
        nc.focus = nc.controls.last().map(|c| c.id);
        nc.hover = nc.controls.get(nc.controls.len() - 2).map(|c| c.id);
        let states = nc.states();
        assert!(states.iter().filter(|s| s.wash[3] > 0.).count() <= 8);
        assert!(states.iter().any(|s| s.id == 49999));
    }
    #[test]
    fn viewport_is_bounded_for_two_thousand_and_collapsed_group_counts() {
        let mut nc = Center::default();
        nc.set_history(rows(2000));
        nc.place(1276., 720, &HashMap::new());
        assert_eq!(nc.cards.len(), 1);
        assert_eq!(nc.cards[0].banner.notice.id, 2000);
        assert!(nc.controls.iter().any(|c| c.label == "One app (2000)"));
        nc.change(&Target::Group("One app".into()));
        nc.place(1276., 720, &HashMap::new());
        assert!(nc.cards.len() <= 4);
        assert!(nc.rows.len() > 2000);
        nc.scroll(1e9);
        nc.place(1276., 720, &HashMap::new());
        assert!(nc.cards.len() <= 4);
        assert!(nc.cards.iter().any(|c| c.banner.notice.id == 1));
    }
    #[test]
    fn calendar_leap_year_and_relative_minutes() {
        let leap = calendar(2024, 2);
        assert_eq!(leap.len(), 29);
        assert_eq!(leap[0], (1, 3));
        assert_eq!(calendar(2023, 2).len(), 28);
        assert_eq!(calendar(2024, 3)[0], (1, 4));
        assert_eq!(age(100, 159), "now");
        assert_eq!(age(100, 160), "1 min");
        assert_eq!(age(500, 100), "now");
    }
}
