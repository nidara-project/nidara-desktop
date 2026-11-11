// SPDX-License-Identifier: LGPL-3.0-or-later
//! The bar (B1, #959): one layer along the top of each output, three pieces of glass —
//! the left group (Nidara's mark, which opens the system menu, and the focused app's
//! name), the island's capsule (the workspace dots), the right group (the Control
//! Center's button and the clock). The measures are the TS bar's ("B", barmodel.rs); the
//! glass is Hyalo's, declared as the `control` piece of the exported material; the
//! content is ours, in the shell's dark skin (white ink).
//!
//! The model is the hub's (hub.rs): each bar gets a frame for its output — the focused
//! app's name, the workspaces, whether it hides (locked, a fullscreen window) — and
//! paints it. What only the bar needs it keeps itself: the clock, ticking in `idle`.
//!
//! The Control Center (cc.rs, B2.1) hangs from this same surface: while it is open the
//! surface grows to the output's height — its strip reserved as before — takes the whole
//! of its input, so a click outside the panel closes it, and the keyboard, for Escape.
use crate::barmodel::{self as m, Content, Dot};
use crate::menu::{Command, Label, System};
use crate::popup::Look;
use crate::popup::{Outcome, Popup};
use nk_a11y::{Action, Bounds, Node, NodeId, Role, Tree};
use nk_render::{Canvas, Color, ImageFit};
use nk_text::{Rect, TextBackend, TextStyle};
use nk_wayland::{
    Application, Edges, Event, KeyboardMode, LayerLevel, LayerOutput, LayerPlacement, LayerSpec,
    Material, Options, Pane, WakeSource, Window,
};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender};
use std::time::Instant;
use unicode_segmentation::UnicodeSegmentation;

pub const NAMESPACE: &str = "nidara-bar";
/// The surface: the strip it reserves and room below it for the glass's shadow.
const HEIGHT: u32 = 48;
const LEFT_BUTTON: u32 = 0x110;
const RIGHT_BUTTON: u32 = 0x111;
const MIDDLE_BUTTON: u32 = 0x112;
const ESCAPE: u32 = 0xff1b;
const TEXT_SIZE: f32 = 12.;
/// The one hover, 8 % ink (owner, 2026-10-06).
const HOVER: f32 = 0.08;
/// Dot inks: the active one full, an occupied one dim, an empty one faint (the TS bar's
/// text, text-dim and surface-hover in the dark skin).
const DOT_OCCUPIED: f32 = 0.55;
const DOT_EMPTY: f32 = 0.18;

/// What the hub tells one bar.
#[derive(Clone, Debug, Default)]
pub struct BarFrame {
    pub history: Arc<Vec<crate::notifications::Banner>>,
    pub nc_open: bool,
    pub nc_active: bool,
    pub nc_generation: u64,
    pub nc_error: String,
    pub banners: Arc<Vec<crate::notifications::Banner>>,
    pub notification_theme: String,
    pub catalogue: Arc<std::collections::HashMap<String, crate::model::App>>,
    pub dock_prefs: crate::prefs::Prefs,
    pub dock_slots: Vec<crate::geometry::Slot>,
    pub locked: bool,
    pub output_size: (u32, u32),
    /// The focused window's app, when that window is on this output.
    pub app: Option<String>,
    pub workspaces: Arc<Vec<crate::hyalo::Workspace>>,
    pub tokens: Option<Arc<serde_json::Value>>,
    pub reduce_transparency: bool,
    /// Locked, or a fullscreen window on this output.
    pub hidden: bool,
    pub can_settings: bool,
    pub region: m::Region,
    pub status: crate::status::Status,
    /// The Control Center's grid as stored.
    pub cc_layout: Arc<crate::cclayout::Stored>,
    pub tray: Arc<Vec<crate::tray::TrayItem>>,
}

/// What a bar item is, and so what a click on it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    /// Nidara's mark: the system menu.
    Logo,
    /// The focused app's name, or the desktop's.
    Title,
    /// The workspace dots.
    Island,
    /// A tray item, by its place in the frame's tray: the apps' icons come first.
    Tray(usize),
    /// One of the default widgets, before the Control Center.
    Widget(Widget),
    /// The Control Center's button.
    ControlCenter,
    /// The clock: the notifications.
    Clock,
}

/// The TS bar's four default widgets, in its order (category, then `barOrder`): focus
/// (utilities, 20), battery (40), Wi-Fi (80), volume (90). Each is shown only while it has
/// something to say: focus while Do Not Disturb is on, the others while their hardware
/// and service are there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Widget {
    Focus,
    Battery,
    Wifi,
    Volume,
}

fn widgets(s: &crate::status::Status) -> Vec<Widget> {
    [
        (Widget::Focus, s.dnd),
        (Widget::Battery, s.battery.is_some()),
        (Widget::Wifi, s.wifi.is_some()),
        (Widget::Volume, s.volume.is_some()),
    ]
    .into_iter()
    .filter_map(|(w, shown)| shown.then_some(w))
    .collect()
}

/// A widget's icon name (the battery is drawn, not an icon).
fn widget_icon(w: Widget, s: &crate::status::Status) -> Option<&'static str> {
    use crate::status::{volume_icon, wifi_icon};
    match w {
        Widget::Focus => Some("nd-notifications-disabled"),
        Widget::Battery => None,
        Widget::Wifi => s.wifi.map(wifi_icon),
        Widget::Volume => s.volume.map(volume_icon),
    }
}

/// Where everything is, for one width and one frame.
#[derive(Clone, Debug, Default, PartialEq)]
struct Layout {
    glass: Vec<[f64; 4]>,
    /// Each clickable item and its box.
    items: Vec<(Item, [f64; 4])>,
    title: String,
    clock: String,
    dots: Vec<Dot>,
}

struct CardPress {
    instance: u64,
    content: u64,
    target: crate::notification_card::Target,
    start: (f64, f64),
    serial: u32,
}
type CcLayer = (nk_wayland::LayerId, (u32, u32), [f64; 4]);
pub struct Bar {
    cards: Vec<crate::notification_card::Card>,
    card_pages: std::collections::HashMap<u64, usize>,
    card_shape: Vec<(u64, u64, usize)>,
    card_hover: Option<u64>,
    pointer_inside: bool,
    card_keyboard: Option<u64>,
    card_keyboard_active: bool,
    card_press: Option<CardPress>,
    card_pending: Option<(nk_wayland::TokenRequest, u64, u64, String)>,
    card_focus: Option<(u64, u64, String, Instant)>,
    surface_mode: Option<(u32, bool, bool, bool, bool)>,
    name: String,
    frames: Receiver<Arc<BarFrame>>,
    frame: Arc<BarFrame>,
    requests: Sender<crate::hub::Request>,
    bus: Option<zbus::blocking::Connection>,
    look: Option<Look>,
    tried_look: bool,
    logo: Option<nk_icons::Icon>,
    cc_icon: Option<Arc<nk_icons::Icon>>,
    icons: Option<nk_icons::Icons>,
    glyphs: std::collections::HashMap<&'static str, Option<Arc<nk_icons::Icon>>>,
    width: f64,
    hover: Option<Item>,
    pointer: (f64, f64),
    layout: Layout,
    clock: String,
    order: m::Order,
    input: Vec<[i32; 4]>,
    /// The system menu, or its confirmation, while open.
    popup: Option<Popup>,
    popups: u64,
    /// A chosen row waiting for its activation token.
    pending: Option<(nk_wayland::TokenRequest, Command)>,
    waker: nk_wayland::Waker,
    a11y: Option<nk_a11y::bridge::Bridge>,
    a11y_failed: bool,
    a11y_requests: Option<Receiver<(u64, nk_a11y::Request)>>,
    revision: u64,
    shape: Vec<(NodeId, Role, Vec<Action>, String)>,
    /// This output's logical origin: tray calls take global points.
    origin: (i32, i32),
    /// The frame's tray icons, ready to draw, and the tray they were made for.
    /// The open tray menu's session and its item.
    tray_menu: Option<(String, usize)>,
    tray_replies: (Sender<TrayReply>, Receiver<TrayReply>),
    /// The Control Center, drawn while `cc_open`.
    cc: crate::cc::Cc,
    cc_open: bool,
    cc_layers: std::collections::HashMap<&'static str, CcLayer>,
    cc_menu_layer: Option<(nk_wayland::LayerId, [f64; 4])>,
    cc_motion_serial: u32,
    cc_resources_visible: bool,
    nc: crate::nc::Center,
    nc_open: bool,
    nc_generation: u64,
    nc_ghost: Option<(nk_wayland::LayerId, Instant, u8)>,
    cc_writer: Option<crate::cc::Writer>,
    cc_auth: Option<crate::ccauth::Auth>,
    cc_paste: Option<(u64, (u64, usize, u64))>,
    /// The output's logical height: the surface's while the Control Center is open.
    output_height: u32,
}

/// A tray menu level, read off the bar's thread.
struct TrayReply {
    item: usize,
    token: String,
    revision: u32,
    rows: Vec<crate::tray::Props>,
    serial: Option<u32>,
}

impl Bar {
    pub fn new(
        name: String,
        frames: Receiver<Arc<BarFrame>>,
        requests: Sender<crate::hub::Request>,
        bus: Option<zbus::blocking::Connection>,
        waker: nk_wayland::Waker,
        origin: (i32, i32),
        output_height: u32,
    ) -> Self {
        let logo = std::fs::read(crate::paths::logo())
            .map_err(|e| e.to_string())
            .and_then(|svg| nk_icons::Icon::parse(&svg))
            .map_err(|e| eprintln!("nidara-shell: no Nidara mark for the bar: {e}"))
            .ok();
        let mut icons = nk_icons::Icons::new("", &[], &crate::paths::icon_reference())
            .map_err(|e| eprintln!("nidara-shell: no interface icons for the bar: {e}"))
            .ok();
        let cc_icon = icons
            .as_mut()
            .and_then(|i| i.get("nd-control-center", 18).ok());
        let order = glib::DateTime::from_local(2001, 2, 3, 0, 0, 0.)
            .ok()
            .and_then(|d| d.format("%x").ok())
            .map_or(m::Order::DayFirst, |s| m::order_of(&s));
        Self {
            cards: vec![],
            card_pages: Default::default(),
            card_shape: vec![],
            card_hover: None,
            pointer_inside: false,
            card_keyboard: None,
            card_keyboard_active: false,
            card_press: None,
            card_pending: None,
            card_focus: None,
            surface_mode: None,
            name,
            frames,
            frame: Arc::new(BarFrame::default()),
            requests,
            bus,
            look: None,
            tried_look: false,
            logo,
            cc_icon,
            icons,
            glyphs: Default::default(),
            width: 0.,
            hover: None,
            pointer: (-1., -1.),
            layout: Layout::default(),
            clock: String::new(),
            order,
            input: vec![],
            popup: None,
            popups: 0,
            pending: None,
            waker,
            a11y: None,
            a11y_failed: false,
            a11y_requests: None,
            revision: 0,
            shape: vec![],
            origin,
            tray_menu: None,
            tray_replies: std::sync::mpsc::channel(),
            cc: crate::cc::Cc::new(),
            cc_open: false,
            cc_layers: Default::default(),
            cc_menu_layer: None,
            cc_motion_serial: 10,
            cc_resources_visible: false,
            nc: Default::default(),
            nc_open: false,
            nc_generation: 0,
            nc_ghost: None,
            cc_writer: None,
            cc_auth: None,
            cc_paste: None,
            output_height,
        }
    }

    /// The clock's text now, as the frame's region asks.
    fn now(&self) -> String {
        let Ok(now) = glib::DateTime::now_local() else {
            return String::new();
        };
        let f = |p: &str| now.format(p).map(|s| s.to_string()).unwrap_or_default();
        let moment = m::Moment {
            year: now.year(),
            month: now.month() as u32,
            day: now.day_of_month() as u32,
            time: f(m::time_pattern(&self.frame.region)),
            weekday_short: f("%a"),
            weekday_long: f("%A"),
            month_short: f("%b"),
            month_long: f("%B"),
        };
        m::clock(&self.frame.region, &moment, self.order)
    }

    fn style(&self) -> Option<TextStyle> {
        let mut s = self.look.as_ref()?.styles.text.clone();
        s.size = TEXT_SIZE;
        Some(s)
    }

    /// A text's width as drawn.
    fn measure(&mut self, text: &str) -> f64 {
        let Some(style) = self.style() else {
            return 0.;
        };
        let Some(look) = self.look.as_mut() else {
            return 0.;
        };
        look.text
            .layout(text, &style, f32::MAX)
            .map_or(0., |l| f64::from(l.measured_size().width))
    }

    /// `text` cut to `room`, an ellipsis where it is cut.
    fn fit(&mut self, text: &str, room: f64) -> String {
        if self.measure(text) <= room {
            return text.to_string();
        }
        let mut cut = text.to_string();
        while let Some((at, _)) = cut.grapheme_indices(true).next_back() {
            cut.truncate(at);
            let candidate = format!("{}…", cut.trim_end());
            if self.measure(&candidate) <= room || cut.is_empty() {
                return candidate;
            }
        }
        String::new()
    }

    fn relayout(&mut self) {
        let width = self.width;
        let dots = m::dots(&self.frame.workspaces, &self.name);
        let island_w = m::island_width(&dots);
        let word = self.look.as_ref().map_or("Desktop".to_string(), |l| {
            l.text_of(&Label::Key("overview.workspace"))
        });
        let title = self
            .frame
            .app
            .clone()
            .unwrap_or_else(|| m::desktop_title(&self.frame.workspaces, &self.name, &word));
        let room = m::title_room(width, island_w, &[Content::Icon]);
        let title = self.fit(&title, room);
        let title_w = self.measure(&title);
        let (left, left_items) = m::group(m::MARGIN, &[Content::Icon, Content::Text(title_w)]);
        let island = [
            ((width - island_w) / 2.).round(),
            m::TOP,
            island_w,
            m::CAPSULE_H,
        ];
        let clock = self.clock.clone();
        let clock_w = self.measure(&clock);
        let tray = self.frame.tray.len();
        let shown = widgets(&self.frame.status);
        let mut right_content = vec![Content::Icon; tray + shown.len()];
        right_content.extend([Content::Icon, Content::Text(clock_w)]);
        let right_w: f64 = m::group(0., &right_content).0[2];
        let (right, right_items) = m::group(width - m::MARGIN - right_w, &right_content);
        let n = tray + shown.len();
        self.layout = Layout {
            glass: vec![left, island, right],
            items: [
                (Item::Logo, left_items[0]),
                (Item::Title, left_items[1]),
                (Item::Island, island),
            ]
            .into_iter()
            .chain((0..tray).map(|i| (Item::Tray(i), right_items[i])))
            .chain(
                shown
                    .iter()
                    .zip(&right_items[tray..])
                    .map(|(w, b)| (Item::Widget(*w), *b)),
            )
            .chain([
                (Item::ControlCenter, right_items[n]),
                (Item::Clock, right_items[n + 1]),
            ])
            .collect(),
            title,
            clock,
            dots,
        };
        if self.cc_open {
            self.cc.detail_height = self.output_height as f64;
            self.cc.place(
                self.panel_right(),
                m::TOP + m::CAPSULE_H,
                &self.frame.status,
                &self.frame.cc_layout,
            );
        }
        if self
            .card_keyboard
            .is_some_and(|id| !self.cards.iter().any(|c| c.target_for(id).is_some()))
        {
            self.card_keyboard = None;
        }
        self.card_pages.retain(|id, _| {
            self.frame
                .banners
                .iter()
                .chain(self.frame.history.iter())
                .any(|b| b.instance == *id)
        });
        self.cards = crate::notification_card::layout(
            &self.frame.banners,
            if self.nc_open {
                (self.panel_right() - crate::notification_card::WIDTH - 16.)
                    .max(crate::notification_card::WIDTH + 4.)
            } else {
                self.panel_right()
            },
            self.output_height,
            &self.card_pages,
        );
        if self.nc_open {
            self.nc.set_history(self.frame.history.clone());
            self.nc.error = self.frame.nc_error.clone();
            self.nc
                .place(self.panel_right(), self.output_height, &self.card_pages);
            self.cards.extend(self.nc.cards.iter().cloned());
        }
        if self
            .card_keyboard
            .is_some_and(|id| !self.cards.iter().any(|c| c.target_for(id).is_some()))
        {
            self.card_keyboard = None;
        }
    }

    fn panel_right(&self) -> f64 {
        crate::notification_card::right_edge(
            self.width,
            self.output_height,
            &self.frame.dock_prefs,
            if self.frame.hidden {
                &[]
            } else {
                &self.frame.dock_slots
            },
        )
    }
    fn card_at(&self, p: (f64, f64)) -> Option<(u64, u64, crate::notification_card::Target)> {
        self.cards
            .iter()
            .rev()
            .filter(|c| c.age.is_none() || self.nc_open && inside(self.nc.viewport, p))
            .find_map(|c| c.hit(p).map(|t| (c.banner.instance, c.banner.content, t)))
    }
    fn card_current(&self, instance: u64, content: u64) -> bool {
        !self.frame.locked
            && (self
                .frame
                .banners
                .iter()
                .any(|b| b.instance == instance && b.content == content)
                || self.nc_open
                    && self
                        .frame
                        .history
                        .iter()
                        .any(|b| b.instance == instance && b.content == content))
    }
    fn card_hover(&mut self, on: Option<u64>) {
        if self.card_hover == on {
            return;
        }
        if let Some(instance) = self.card_hover.take() {
            let _ = self.requests.send(crate::hub::Request::NotificationHover {
                instance,
                on: false,
            });
        }
        self.card_hover = on;
        if let Some(instance) = on {
            let _ = self
                .requests
                .send(crate::hub::Request::NotificationHover { instance, on: true });
        }
    }
    fn card_send(&self, instance: u64, content: u64, key: Option<String>, token: Option<String>) {
        if self.card_current(instance, content) {
            let _ = self.requests.send(crate::hub::Request::NotificationAction {
                instance,
                content,
                key,
                token,
            });
        }
    }
    fn card_error(&self, instance: u64, content: u64, message: &str) {
        if self.card_current(instance, content) {
            let _ = self.requests.send(crate::hub::Request::NotificationError {
                instance,
                content,
                message: message.into(),
            });
        }
    }
    fn card_activate(
        &mut self,
        instance: u64,
        content: u64,
        target: crate::notification_card::Target,
        serial: Option<u32>,
        w: &mut Window,
    ) {
        use crate::notification_card::Target;
        let Some(b) = self
            .frame
            .banners
            .iter()
            .chain(self.frame.history.iter())
            .find(|b| b.instance == instance && b.content == content)
        else {
            return;
        };
        let key = match target {
            Target::More => {
                *self.card_pages.entry(instance).or_default() += 1;
                self.refresh(w);
                return;
            }
            Target::Close => None,
            Target::Body => b
                .notice
                .has_action("default")
                .then(|| "default".to_string()),
            Target::Action(k) => Some(k),
        };
        let Some(key) = key else {
            self.card_send(instance, content, None, None);
            return;
        };
        if self.card_pending.is_some() || self.card_focus.is_some() {
            return;
        }
        self.card_error(instance, content, "");
        let result = match serial {
            Some(s) => w.request_activation_token(s, None),
            None => w.request_focused_activation_token(None),
        };
        match result {
            Ok(r) => self.card_pending = Some((r, instance, content, key)),
            Err(nk_wayland::TokenFailure::UndeliveredSerial) if serial.is_none() => {
                self.card_focus = Some((instance, content, key, Instant::now()));
                self.refresh(w);
            }
            Err(e) => {
                eprintln!("nidara-shell: notification activation unavailable: {e:?}");
                self.card_error(instance, content, "Could not activate. Try again.");
            }
        }
    }
    fn sync_surface(&mut self, w: &mut Window) {
        let banners = !self.cards.is_empty() && !self.frame.locked;
        let focus = self.card_focus.is_some() || self.card_keyboard.is_some();
        let height = if self.cc_open || self.nc_open || banners || focus {
            self.output_height
        } else {
            HEIGHT
        };
        let mode = (
            height,
            self.cc_open || self.nc_open,
            banners,
            focus,
            self.cc.editor.active,
        );
        if self.surface_mode != Some(mode) {
            let mut p = placement(height, self.cc_open || self.nc_open);
            if focus || self.nc_open || self.cc.editor.active {
                p.keyboard = KeyboardMode::Exclusive;
            }
            if let Err(e) = w.set_layer_placement(p) {
                eprintln!("nidara-shell: banner surface: {e}");
            }
            if let Err(e) = w.set_layer_level(if banners || self.nc_open {
                LayerLevel::Overlay
            } else {
                LayerLevel::Top
            }) {
                eprintln!("nidara-shell: banner stacking: {e}");
            }
            self.surface_mode = Some(mode);
        }
    }
    fn item_at(&self, (x, y): (f64, f64)) -> Option<Item> {
        self.layout
            .items
            .iter()
            .find(|(_, r)| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
            .map(|(i, _)| *i)
    }

    /// Only the glass takes input; nothing at all while hidden.
    fn sync_input(&mut self, w: &mut Window) {
        // While the Control Center is open the whole surface takes input (None below).
        const WHOLE: [i32; 4] = [-1; 4];
        let input: Vec<[i32; 4]> = if self.frame.locked {
            vec![]
        } else if self.cc_open || self.nc_open {
            vec![WHOLE]
        } else {
            self.layout
                .glass
                .iter()
                .filter(|_| !self.frame.hidden)
                .chain(self.cards.iter().map(|c| &c.rect))
                .map(|g| {
                    [
                        g[0] as i32,
                        g[1] as i32,
                        g[2].ceil() as i32,
                        g[3].ceil() as i32,
                    ]
                })
                .collect()
        };
        if input != self.input {
            let region = (input != [WHOLE]).then_some(&input[..]);
            if let Err(e) = w.set_input_region(region) {
                eprintln!("nidara-shell: the bar's input region: {e}");
            }
            self.input = input;
        }
    }

    fn close_popup(&mut self, w: &mut Window) {
        if let Some(p) = self.popup.take() {
            p.close(w);
            w.redraw();
            self.publish_semantics(w);
        }
    }

    /// A menu under an item: the system menu or its confirmation under the mark, a tray
    /// item's under its icon.
    fn open_menu(
        &mut self,
        w: &mut Window,
        rows: Vec<crate::menu::Row>,
        serial: Option<u32>,
        under: Item,
    ) {
        self.close_popup(w);
        // No pointer: a menu hangs flush with its capsule's outer edge, the system menu
        // from the left one's left, the tray's from the right one's right (the TS bar's).
        let end = under != Item::Logo;
        let Some(g) = (if end {
            self.layout.glass.last()
        } else {
            self.layout.glass.first()
        }) else {
            return;
        };
        let x = if end { g[0] + g[2] } else { g[0] };
        let Some(look) = self.look.as_mut() else {
            return;
        };
        look.refresh();
        self.popups += 1;
        let opened = Popup::open(
            w,
            look,
            crate::popup::Request {
                rows: &rows,
                title: if under == Item::Logo {
                    "System"
                } else {
                    "Tray"
                },
                anchor: None,
                rect: [x.round() as i32, m::MENU_TOP as i32 - 1, 1, 1],
                side: nk_wayland::PopupSide::Below,
                serial,
                keyboard: serial.is_none(),
                ordinal: self.popups,
                pointer: false,
                align_end: end,
            },
        );
        match opened {
            Ok(p) => self.popup = Some(p),
            Err(e) => eprintln!("nidara-shell: the bar's menu did not open: {e}"),
        }
        w.redraw();
    }

    fn popup_outcome(&mut self, w: &mut Window, outcome: Result<Outcome, String>) {
        match outcome {
            Ok(Outcome::None) => {}
            Ok(Outcome::Closed) => {
                self.close_popup(w);
                self.end_tray_menu();
            }
            Ok(Outcome::Chosen(command, serial)) => {
                self.close_popup(w);
                self.choose(command, serial, w);
            }
            Err(e) => {
                eprintln!("nidara-shell: the bar's menu failed: {e}");
                self.close_popup(w);
                self.end_tray_menu();
            }
        }
    }

    /// A tray call on a worker of the bar's own; a menu level it reads comes back with a
    /// wake.
    fn tray_job(
        &self,
        f: impl FnOnce(&zbus::blocking::Connection) -> Result<Option<TrayReply>, String>
        + Send
        + 'static,
    ) {
        let Some(conn) = self.bus.clone() else {
            return;
        };
        let (tx, waker) = (self.tray_replies.0.clone(), self.waker.clone());
        let _ = std::thread::Builder::new()
            .name("bar-tray".into())
            .spawn(move || match f(&conn) {
                Ok(Some(reply)) => {
                    if tx.send(reply).is_ok() {
                        let _ = waker.wake();
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("nidara-shell: tray: {e}"),
            });
    }

    /// The open tray menu's session ends: Tray1 forgets it.
    fn end_tray_menu(&mut self) {
        if let Some((token, _)) = self.tray_menu.take() {
            self.tray_job(move |c| crate::tray::close_menu(c, &token).map(|_| None));
        }
    }

    /// An item's place as a global logical point: the middle of its bottom edge.
    fn global(&self, item: Item) -> (i32, i32) {
        let b = self
            .layout
            .items
            .iter()
            .find(|(i, _)| *i == item)
            .map_or([0.; 4], |(_, b)| *b);
        (
            self.origin.0 + (b[0] + b[2] / 2.).round() as i32,
            self.origin.1 + (b[1] + b[3]).round() as i32,
        )
    }

    /// A tray item's click: left raises or activates (or opens an item that is only a
    /// menu), right opens its menu, middle is its secondary action.
    fn tray_click(&mut self, index: usize, button: u32, serial: Option<u32>, w: &mut Window) {
        let Some(item) = self.frame.tray.get(index).cloned() else {
            return;
        };
        let at = self.global(Item::Tray(index));
        let menu = match button {
            LEFT_BUTTON => item.item_is_menu && item.menu,
            RIGHT_BUTTON => item.menu,
            _ => false,
        };
        if menu {
            let open = self.tray_menu.as_ref().is_some_and(|(_, i)| *i == index);
            self.close_popup(w);
            self.end_tray_menu();
            if !open {
                self.tray_job(move |c| {
                    let (token, revision, rows) = crate::tray::open_menu(c, &item)?;
                    Ok(Some(TrayReply {
                        item: index,
                        token,
                        revision,
                        rows,
                        serial,
                    }))
                });
            }
            return;
        }
        match button {
            LEFT_BUTTON => {
                let _ = self
                    .requests
                    .send(crate::hub::Request::TrayActivate { item, at });
            }
            RIGHT_BUTTON => self
                .tray_job(move |c| crate::tray::point(c, "ContextMenu", &item, at).map(|_| None)),
            _ => self.tray_job(move |c| {
                crate::tray::point(c, "SecondaryActivate", &item, at).map(|_| None)
            }),
        }
    }

    /// A wheel over a tray item: the app's own scroll (a volume, a page).
    fn tray_scroll(&self, delta: f64, horizontal: bool) {
        let Some(Item::Tray(i)) = self.item_at(self.pointer) else {
            return;
        };
        let Some(item) = self.frame.tray.get(i).cloned() else {
            return;
        };
        let steps = delta.round() as i32;
        if steps != 0 {
            self.tray_job(move |c| crate::tray::scroll(c, &item, steps, horizontal).map(|_| None));
        }
    }

    /// Menu levels read since: each opens under its item, in the open session's place.
    fn tray_replies(&mut self, w: &mut Window) {
        let replies: Vec<TrayReply> = self.tray_replies.1.try_iter().collect();
        for reply in replies {
            // A session the bar no longer shows (another menu since): end it.
            if self
                .tray_menu
                .as_ref()
                .is_some_and(|(t, _)| *t != reply.token)
            {
                self.close_popup(w);
                self.end_tray_menu();
            }
            let rows = crate::tray::rows_of(&reply.rows, &reply.token, reply.revision);
            self.tray_menu = Some((reply.token, reply.item));
            self.open_menu(w, rows, reply.serial, Item::Tray(reply.item));
        }
    }

    fn choose(&mut self, command: Command, serial: Option<u32>, w: &mut Window) {
        match command {
            Command::System {
                action,
                confirmed: false,
            } => self.open_menu(w, crate::menu::confirm_menu(action), serial, Item::Logo),
            Command::System {
                action: System::Settings,
                ..
            } if serial.is_some() => {
                // Settings comes to the front with a token from the click that chose it.
                match w.request_activation_token(serial.unwrap(), Some("org.nidara.Settings")) {
                    Ok(t) => self.pending = Some((t, command)),
                    Err(_) => self.send(command, None),
                }
            }
            Command::System { .. } => self.send(command, None),
            Command::Tray {
                token,
                revision,
                id,
                submenu,
            } => {
                let Some(item) = self.tray_menu.as_ref().map(|(_, i)| *i) else {
                    return;
                };
                if submenu {
                    // The submenu opens in its parent's place, in the same session.
                    self.tray_job(move |c| {
                        let (revision, rows) = crate::tray::read_menu(c, &token, id)?;
                        Ok(Some(TrayReply {
                            item,
                            token,
                            revision,
                            rows,
                            serial,
                        }))
                    });
                } else {
                    self.tray_menu = None;
                    self.tray_job(move |c| {
                        let clicked = crate::tray::clicked(c, &token, revision, id);
                        let _ = crate::tray::close_menu(c, &token);
                        clicked.map(|_| None)
                    });
                }
            }
            _ => {}
        }
    }

    fn send(&self, command: Command, token: Option<String>) {
        let _ = self
            .requests
            .send(crate::hub::Request::Menu { command, token });
    }

    fn click(&mut self, item: Item, serial: Option<u32>, w: &mut Window) {
        match item {
            Item::Logo => {
                if self.cc_open {
                    self.toggle_cc(w);
                }
                let system = self.popup.is_some() && self.tray_menu.is_none();
                self.close_popup(w);
                self.end_tray_menu();
                if !system {
                    let rows = crate::menu::system_menu(self.frame.can_settings);
                    self.open_menu(w, rows, serial, Item::Logo);
                }
            }
            // The dots open the desktops' overview, which the Rust shell does not have yet.
            Item::Island => {}
            Item::Tray(i) => self.tray_click(i, LEFT_BUTTON, serial, w),
            Item::Widget(Widget::Focus) => {
                let on = !self.frame.status.dnd;
                let _ = std::thread::Builder::new()
                    .name("dnd".into())
                    .spawn(move || {
                        if let Err(e) = crate::prefs::set_dnd(on) {
                            eprintln!("nidara-shell: Do Not Disturb: {e}");
                        }
                    });
            }
            Item::ControlCenter => self.toggle_cc(w),
            Item::Clock => self.toggle_nc(w),
            other => eprintln!("nidara-shell: the bar's {other:?} opens nothing yet"),
        }
    }

    /// The Control Center opens over the output and closes back to the strip.
    fn toggle_cc(&mut self, w: &mut Window) {
        let open = !self.cc_open && !self.frame.hidden;
        if open == self.cc_open {
            return;
        }
        if open {
            self.close_popup(w);
            self.end_tray_menu();
            if self.frame.nc_active {
                self.nc_open = false;
                let _ = self.requests.send(crate::hub::Request::CloseNc);
            }
        }
        self.cc_open = open;
        self.cc.release();
        if !open {
            self.cc.back();
            self.cc.editor.close();
        }
        let _ = self.requests.send(crate::hub::Request::NotificationPanel {
            output: self.name.clone(),
            open,
        });
        self.refresh(w);
    }

    fn toggle_nc(&mut self, w: &mut Window) {
        if self.frame.locked {
            return;
        }
        // Close locally at once; opening waits for the hub's chosen output/generation.
        if self.nc_open {
            self.nc_open = false;
            self.nc.clearing = false;
            self.card_keyboard = None;
            self.nc.focus = None;
            if let Some((layer, _, _)) = self.nc_ghost.take() {
                let _ = w.destroy_layer(layer);
            }
            if self.card_pending.as_ref().is_some_and(|p| p.1 >= 1 << 32)
                && let Some((request, _, _, _)) = self.card_pending.take()
            {
                w.cancel_activation_token(request);
            }
            if self.card_focus.as_ref().is_some_and(|p| p.0 >= 1 << 32) {
                self.card_focus = None;
            }
        }
        let _ = self.requests.send(crate::hub::Request::ToggleNc {
            output: Some(self.name.clone()),
        });
        self.refresh(w);
    }
    fn nc_act(&mut self, target: crate::nc::Target, w: &mut Window) {
        if let Some(group) = self.nc.change(&target) {
            crate::icon_metrics::emit(
                "nc-clear-request",
                serde_json::json!({"view":self.nc_generation}),
            );
            let _ = self.requests.send(crate::hub::Request::NotificationBulk {
                view: self.nc_generation,
                group,
            });
        }
        self.refresh(w);
    }
    fn nc_key(&mut self, key: &nk_wayland::Key, w: &mut Window) {
        if key.sym == ESCAPE {
            self.toggle_nc(w);
            return;
        }
        if key.sym == 0xff55 || key.sym == 0xff56 {
            self.nc
                .scroll(self.nc.viewport[3] * if key.sym == 0xff55 { -0.8 } else { 0.8 });
            self.refresh(w);
            return;
        }
        let mut ids: Vec<_> = self.nc.controls.iter().map(|c| c.id).collect();
        ids.extend(self.cards.iter().flat_map(|c| {
            std::iter::once(c.node_id())
                .chain((0..c.buttons.len()).map(|i| c.node_id() + 1 + i as u64))
        }));
        if matches!(key.sym, 0xff09 | 0xfe20) && !ids.is_empty() {
            let old = self.nc.focus.or(self.card_keyboard);
            let at = ids.iter().position(|id| Some(*id) == old);
            let next = at.map_or(
                if key.shift || key.sym == 0xfe20 {
                    ids.len() - 1
                } else {
                    0
                },
                |i| {
                    if key.shift || key.sym == 0xfe20 {
                        (i + ids.len() - 1) % ids.len()
                    } else {
                        (i + 1) % ids.len()
                    }
                },
            );
            let id = ids[next];
            if self.nc.control(id).is_some() {
                self.nc.focus = Some(id);
                self.card_keyboard = None;
            } else {
                self.card_keyboard = Some(id);
                if let Some(c) = self.cards.iter().find(|c| c.target_for(id).is_some()) {
                    self.nc.reveal(c.banner.instance);
                }
                self.nc.focus = None;
            }
            self.refresh(w);
        } else if matches!(key.sym, 0xff0d | 0x20) {
            if let Some(t) = self.nc.focus.and_then(|id| self.nc.control(id)) {
                self.nc_act(t, w);
            } else if let Some((instance, content, target)) = self.card_keyboard.and_then(|id| {
                self.cards.iter().find_map(|c| {
                    c.target_for(id)
                        .map(|t| (c.banner.instance, c.banner.content, t))
                })
            }) {
                self.card_activate(instance, content, target, key.serial, w);
            }
        }
    }
    fn finish_nc_clear(&mut self, w: &mut Window) {
        crate::icon_metrics::emit(
            "nc-clear-finished",
            serde_json::json!({"stage":self.nc_ghost.map(|(_,_,s)|s),"elapsed_us":self.nc_ghost.map(|(_,t,_)|t.elapsed().as_micros())}),
        );
        if let Some((layer, _, _)) = self.nc_ghost.take() {
            let _ = w.destroy_layer(layer);
        }
        self.nc.clearing = false;
        self.refresh(w);
    }
    fn nc_clear_animation(
        &mut self,
        next: &Arc<Vec<crate::notifications::Banner>>,
        w: &mut Window,
    ) {
        if !self.nc_open || Arc::ptr_eq(next, &self.frame.history) || !w.supports_layers() {
            return;
        }
        let mut cards: Vec<_> = self
            .cards
            .iter()
            .filter(|c| c.age.is_some() && !next.iter().any(|b| b.instance == c.banner.instance))
            .cloned()
            .collect();
        if cards.is_empty() {
            return;
        }
        crate::icon_metrics::emit(
            "nc-clear-capture",
            serde_json::json!({"visible":cards.len()}),
        );
        let r = self.nc.viewport;
        for c in &mut cards {
            c.translate(-r[0], -r[1]);
        }
        let Some(look) = self.look.as_mut() else {
            return;
        };
        let result = (|| -> nk_wayland::Result<nk_wayland::LayerId> {
            let layer = w.create_layer((r[2].ceil().max(1.) as u32, r[3].ceil().max(1.) as u32))?;
            w.set_layer_input_region(layer, Some(&[]))?;
            w.set_position(layer, r[0], r[1])?;
            let art = crate::notification_card::Artwork {
                theme: &self.frame.notification_theme,
                catalogue: &self.frame.catalogue,
                namespace: &self.name,
                scale: w.scale(),
            };
            w.paint_layer(layer, |f| {
                let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
                for card in &cards {
                    card.paint(&mut c, look, true, &art)?;
                }
                Ok(c.finish())
            })?;
            w.set_opacity(layer, 1.)?;
            w.redraw();
            Ok(layer)
        })();
        match result {
            Ok(layer) => {
                if let Some((old, _, _)) = self.nc_ghost.take() {
                    let _ = w.destroy_layer(old);
                }
                // The first commit establishes opacity 1; idle arms the compositor transition.
                self.nc_ghost = Some((layer, Instant::now(), 0));
                self.nc.clearing = true;
            }
            Err(e) => eprintln!("nidara-shell: clear animation: {e}"),
        }
    }
    /// A Control Center act, to its service off the bar's thread.
    fn act(&mut self, act: crate::cc::Act, w: &mut Window) {
        match act {
            crate::cc::Act::OpenDetail(page) => {
                if self.cc.detail.as_ref().is_some_and(|d| d.page == page) {
                    return;
                }
                self.cc.open_detail(page, &self.frame.status);
                if page == "clipboard" {
                    if self.cc_writer.is_none() {
                        self.cc_writer = self
                            .bus
                            .clone()
                            .map(|conn| crate::cc::Writer::new(conn, self.waker.clone()));
                    }
                    if let Some(writer) = &self.cc_writer {
                        writer.send(
                            self.cc.view_id(),
                            crate::cc::Act::Detail(crate::cc::detail::Action::ClipboardList),
                        );
                    }
                }
                self.cc_auth = None;
                if page == "wifi" {
                    self.cc_auth = Some(crate::ccauth::Auth::new(self.waker.clone()));
                }
                return;
            }
            crate::cc::Act::Detail(crate::cc::detail::Action::Back) => {
                if let (Some(auth), Some(form)) = (
                    &self.cc_auth,
                    self.cc.detail.as_ref().and_then(|d| d.form.as_ref()),
                ) {
                    auth.cancel(form.id);
                }
                self.cc.back();
                return;
            }
            crate::cc::Act::Detail(crate::cc::detail::Action::SecretSubmit) => {
                if let (Some(auth), Some(d)) = (&self.cc_auth, &mut self.cc.detail)
                    && let Some(mut form) = d.form.take()
                {
                    let values = form.take();
                    auth.submit(form.id, form.setting.clone(), values);
                }
                return;
            }
            crate::cc::Act::Detail(crate::cc::detail::Action::SecretCancel) => {
                if let (Some(auth), Some(d)) = (&self.cc_auth, &mut self.cc.detail)
                    && let Some(form) = d.form.take()
                {
                    auth.cancel(form.id);
                }
                return;
            }
            crate::cc::Act::Detail(crate::cc::detail::Action::Capture { mode, copy }) => {
                let job = crate::capture::Job::Screenshot {
                    mode,
                    copy,
                    output: self.name.clone(),
                };
                if let Err(e) = crate::capture::send(job) {
                    if let Some(d) = &mut self.cc.detail {
                        d.error = e;
                    }
                } else if self.cc_open {
                    self.toggle_cc(w);
                }
                return;
            }
            crate::cc::Act::Detail(crate::cc::detail::Action::Record { mode, audio }) => {
                let job = crate::capture::Job::Record {
                    mode,
                    audio,
                    output: self.name.clone(),
                };
                if let Err(e) = crate::capture::send(job) {
                    if let Some(d) = &mut self.cc.detail {
                        d.error = e;
                    }
                } else if self.cc_open {
                    self.toggle_cc(w);
                }
                return;
            }
            crate::cc::Act::Detail(crate::cc::detail::Action::StopRecording) => {
                if let Err(error) = crate::capture::send(crate::capture::Job::Stop)
                    && let Some(detail) = &mut self.cc.detail
                {
                    detail.error = error;
                }
                return;
            }
            _ => {}
        }

        if self.cc_writer.is_none() {
            self.cc_writer = self
                .bus
                .clone()
                .map(|conn| crate::cc::Writer::new(conn, self.waker.clone()));
        }
        match &self.cc_writer {
            Some(writer) => writer.send(
                if matches!(act, crate::cc::Act::Layout(..)) {
                    (1u64 << 63) | self.cc.editor.write_serial
                } else {
                    self.cc.view_id()
                },
                act,
            ),
            None => eprintln!("nidara-shell: no session bus for the Control Center's {act:?}"),
        }
    }

    fn auth_events(&mut self, w: &mut Window) {
        let events: Vec<_> = self
            .cc_auth
            .as_ref()
            .map(|a| a.events.try_iter().collect())
            .unwrap_or_default();
        for event in events {
            if let Some(d) = &mut self.cc.detail {
                match event {
                    crate::ccauth::Event::Ready => d.auth_ready = true,
                    crate::ccauth::Event::Prompt(id, meta) => {
                        d.form = crate::ccauth::Form::new(id, &meta);
                        if d.form.is_none() {
                            if let Some(auth) = &self.cc_auth {
                                auth.cancel(id);
                            }
                            d.error = "unsupported network authentication request".into();
                        }
                        d.offset = 0;
                    }
                    crate::ccauth::Event::Closed(id) => {
                        if d.form.as_ref().is_some_and(|f| f.id == id) {
                            d.form = None;
                        }
                    }
                    crate::ccauth::Event::Error(error) => {
                        d.auth_ready = false;
                        d.form = None;
                        d.error = error;
                    }
                }
            }
            self.refresh(w);
        }
    }
    fn clear_cc_layers(&mut self, w: &mut Window) {
        for (_, (id, _, _)) in self.cc_layers.drain() {
            let _ = w.destroy_layer(id);
        }
        if let Some((id, _)) = self.cc_menu_layer.take() {
            let _ = w.destroy_layer(id);
        }
        self.cc.editor.layered = false;
        self.cc.editor.menu_layered = false;
    }
    fn sync_cc_layers(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if !self.cc_open
            || !self.cc.editor.active
            || !w.supports_layers()
            || self.look.is_none()
            || self.frame.tokens.is_none()
        {
            self.clear_cc_layers(w);
            return Ok(());
        }
        let tiles = self.cc.edit_tiles();
        let viewport = self.cc.editor.viewport;
        let dead: Vec<_> = self
            .cc_layers
            .keys()
            .filter(|id| !tiles.iter().any(|t| t.0 == **id))
            .copied()
            .collect();
        for id in dead {
            if let Some((layer, _, _)) = self.cc_layers.remove(id) {
                w.destroy_layer(layer)?;
            }
        }
        for (id, r, size) in tiles {
            let pixels = (r[2].ceil() as u32 + 12, r[3].ceil() as u32 + 12);
            if self.cc_layers.get(id).is_some_and(|old| old.1 != pixels) {
                let (old, _, _) = self.cc_layers.remove(id).unwrap();
                w.destroy_layer(old)?;
            }
            let existing = self.cc_layers.get(id).copied();
            let layer = if let Some((layer, _, _)) = existing {
                layer
            } else {
                let layer = w.create_layer(pixels)?;
                w.set_layer_input_region(layer, Some(&[]))?;
                layer
            };
            let changed = existing.is_some_and(|old| old.2 != r);
            if changed || existing.is_none() {
                self.cc_motion_serial = self.cc_motion_serial.wrapping_add(1).max(10);
                let animate = existing.is_some() && self.cc.editor.held() != Some(id);
                w.set_transition(
                    layer,
                    nk_wayland::Property::Position,
                    self.cc_motion_serial,
                    nk_wayland::Curve::Bezier {
                        x1: 0.2,
                        y1: 0.,
                        x2: 0.2,
                        y2: 1.,
                        duration_ms: if animate { 180 } else { 0 },
                    },
                )?;
                w.set_position(layer, r[0] - 6., r[1] - 6.)?;
                if animate {
                    self.cc.editor.settling =
                        Some(Instant::now() + std::time::Duration::from_millis(190));
                }
            }
            let radius = match size {
                crate::cclayout::Size::Square => 38.,
                crate::cclayout::Size::FullWidth => 24.,
                _ => r[2].min(r[3]) / 2.,
            };
            let pane = Pane {
                x: 6.,
                y: 6.,
                width: r[2],
                height: r[3],
                radius,
                exponent: 2.,
                pointer: None,
            };
            let mut material = crate::material::piece(
                self.frame.tokens.as_ref().unwrap(),
                "controlCenter",
                true,
                self.frame.reduce_transparency,
                pane,
            )
            .ok_or("missing CC material")?;
            material.groups = vec![nk_wayland::Group {
                tone: material.tone,
                shadow: material.shadow,
                shapes: std::mem::take(&mut material.shapes),
                opacity: 1.,
                clip: None,
            }];
            w.set_layer_parent_clip(
                layer,
                Some((
                    viewport[0].round() as i32,
                    viewport[1].round() as i32,
                    viewport[2].round() as i32,
                    viewport[3].round() as i32,
                )),
            )?;
            if !crate::cclayout::meta_of(id).unwrap().fixed {
                material.groups[0].shapes.push(Pane {
                    x: r[2] - 19.,
                    y: 3.,
                    width: 28.,
                    height: 28.,
                    radius: 14.,
                    exponent: 2.,
                    pointer: None,
                });
            }
            if self.cc.editor.focus == Some(crate::cc::edit::Target::Tile(id)) {
                material.states.push(nk_wayland::StateRegion {
                    id: 1,
                    bounds: nk_wayland::MaterialRect {
                        x: 6.,
                        y: 6.,
                        width: r[2],
                        height: r[3],
                    },
                    radius,
                    wash: [1., 1., 1., 0.12],
                    fade_ms: 150,
                });
            }
            w.set_layer_material(layer, Some(&material))?;
            let look = self.look.as_mut().unwrap();
            w.paint_layer(layer, |frame| {
                let mut c = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
                self.cc
                    .paint_edit_layer(id, &mut c, look, &self.frame.status)?;
                Ok(c.finish())
            })?;
            self.cc_layers.insert(id, (layer, pixels, r));
        }
        self.cc.editor.layered = true;
        if self.cc.editor.menu.is_some() {
            let controls: Vec<_> = self
                .cc
                .editor
                .controls
                .iter()
                .filter(|c| c.target != crate::cc::edit::Target::Toggle)
                .cloned()
                .collect();
            if let Some(first) = controls.first() {
                let r = [
                    first.rect[0],
                    first.rect[1],
                    180.,
                    controls.len() as f64 * 34.,
                ];
                if self.cc_menu_layer.is_some_and(|(_, old)| old != r) {
                    let (id, _) = self.cc_menu_layer.take().unwrap();
                    w.destroy_layer(id)?;
                }
                let layer = if let Some((id, _)) = self.cc_menu_layer {
                    id
                } else {
                    let id = w.create_layer((r[2] as u32, r[3] as u32))?;
                    w.set_layer_input_region(id, Some(&[]))?;
                    w.set_position(id, r[0], r[1])?;
                    self.cc_menu_layer = Some((id, r));
                    id
                };
                let pane = Pane {
                    x: 0.,
                    y: 0.,
                    width: r[2],
                    height: r[3],
                    radius: 16.,
                    exponent: 2.,
                    pointer: None,
                };
                let material = crate::material::piece(
                    self.frame.tokens.as_ref().unwrap(),
                    "controlCenter",
                    true,
                    self.frame.reduce_transparency,
                    pane,
                )
                .ok_or("missing menu material")?;
                w.set_layer_material(layer, Some(&material))?;
                let look = self.look.as_mut().unwrap();
                w.paint_layer(layer, |frame| {
                    let mut c = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
                    for item in controls {
                        let label = self.cc.editor.label(&item, Some(look));
                        let label = if item.checked {
                            format!("✓ {label}")
                        } else {
                            label
                        };
                        crate::notification_card::text(
                            &mut c,
                            look,
                            &label,
                            &nk_text::TextStyle {
                                size: 13.,
                                ..look.styles.text.clone()
                            },
                            [
                                8.,
                                item.rect[1] - r[1] + if item.disabled { 2. } else { 6. },
                                164.,
                                if item.disabled { 18. } else { 24. },
                            ],
                            1,
                            if item.disabled { 0.4 } else { 1. },
                        )?;
                        if item.disabled {
                            let reason = crate::cc::edit::Editor::full_text(Some(look));
                            crate::notification_card::text(
                                &mut c,
                                look,
                                &reason,
                                &nk_text::TextStyle {
                                    size: 10.,
                                    ..look.styles.text.clone()
                                },
                                [8., item.rect[1] - r[1] + 19., 164., 14.],
                                1,
                                0.65,
                            )?;
                        }
                    }
                    Ok(c.finish())
                })?;
                self.cc.editor.menu_layered = true;
            }
        } else {
            if let Some((id, _)) = self.cc_menu_layer.take() {
                w.destroy_layer(id)?;
            }
            self.cc.editor.menu_layered = false;
        }
        Ok(())
    }

    fn refresh(&mut self, w: &mut Window) {
        if self.cc.detail.as_ref().is_none_or(|d| d.page != "wifi") {
            self.cc_auth = None;
        }

        self.relayout();
        let viewport = self.cc.editor.viewport;
        let resources = self.cc_open
            && self.cc.detail.is_none()
            && self.cc.edit_tiles().iter().any(|t| {
                let r = t.1;
                t.0 == "cpu_memory"
                    && r[0] < viewport[0] + viewport[2]
                    && r[0] + r[2] > viewport[0]
                    && r[1] < viewport[1] + viewport[3]
                    && r[1] + r[3] > viewport[1]
            });
        if resources != self.cc_resources_visible {
            self.cc_resources_visible = resources;
            crate::ccaux::mapped(&self.name, resources);
        }
        if let Err(error) = self.sync_cc_layers(w) {
            eprintln!("nidara-shell: CC layers: {error}");
            self.clear_cc_layers(w);
        }
        self.sync_surface(w);
        self.card_hover(if self.pointer_inside {
            self.card_at(self.pointer).map(|(id, _, _)| id)
        } else {
            None
        });
        self.sync_input(w);
        w.redraw();
        self.publish_semantics(w);
        let input = self
            .cc
            .detail
            .as_ref()
            .map(|d| d.text_input(self.look.as_mut()))
            .unwrap_or_default();
        w.set_text_input(input);
    }

    /// What a reader is told: a window named Bar holding its items in the order drawn, an
    /// open menu's rows joining under its root (the dock's way, #971).
    fn publish_semantics(&mut self, w: &Window) {
        let mut tree = tree(
            &self.layout,
            self.width,
            self.frame.hidden,
            &self.frame.status,
            &self.frame.tray,
            self.cc_open,
        );
        if let Some(id) = id_of(Item::Clock)
            && let Some(n) = tree.nodes.get_mut(&id)
        {
            n.states.expanded = self.nc_open;
        }
        if self.nc_open {
            self.nc.semantics(&mut tree);
            if let Some(root) = tree.nodes.get_mut(&tree.root) {
                root.states.active = self.card_keyboard_active;
            }
        }
        if self.cc_open {
            let panel = self.cc.panel();
            let mut group = Node::new(CC_PANEL, Role::Panel, "Control Center");
            group.description = if self.cc.editor.active {
                self.cc.editor.description(self.look.as_ref())
            } else {
                String::new()
            };
            if let Some(root) = tree.nodes.get_mut(&tree.root) {
                root.states.active = self.card_keyboard_active;
            }
            group.bounds = Bounds {
                x: panel[0],
                y: panel[1],
                width: panel[2],
                height: panel[3],
            };
            for (node, _) in self
                .cc
                .nodes(CC_TILES, &self.frame.status, self.look.as_ref())
            {
                group.children.push(node.id);
                tree.nodes.insert(node.id, node);
            }
            if let Some(root) = tree.nodes.get_mut(&tree.root) {
                root.children.push(CC_PANEL);
            }
            tree.nodes.insert(CC_PANEL, group);
        }
        if !self.frame.locked {
            if let Some(root) = tree.nodes.get_mut(&tree.root) {
                root.bounds.height = self.output_height as f64;
                root.states.hidden = false;
            }
            for c in &self.cards {
                let root = tree.root;
                if c.age.is_some() {
                    tree.root = crate::nc::PANEL;
                }
                c.semantics(&mut tree);
                tree.root = root;
                if c.age.is_some() {
                    let ids = std::iter::once(c.node_id())
                        .chain((0..c.buttons.len()).map(|i| c.node_id() + 1 + i as u64));
                    for id in ids {
                        if let Some(n) = tree.nodes.get_mut(&id) {
                            let b = n.bounds;
                            let r = crate::nc::intersection(
                                [b.x, b.y, b.width, b.height],
                                self.nc.viewport,
                            );
                            n.bounds = Bounds {
                                x: r[0],
                                y: r[1],
                                width: r[2],
                                height: r[3],
                            };
                            n.states.offscreen = r[2] == 0. || r[3] == 0.;
                            if n.states.offscreen {
                                n.actions = vec![Action::Focus];
                            }
                        }
                    }
                }
            }
            if self.nc_open
                && let Some(id) = self.nc.focus
                && let Some(n) = tree.nodes.get_mut(&id)
            {
                n.states.focused = true;
                if let Some(root) = tree.nodes.get_mut(&tree.root) {
                    root.states.active = self.card_keyboard_active;
                }
            }
            if let Some(id) = self.card_keyboard.filter(|_| self.card_keyboard_active) {
                if let Some(n) = tree.nodes.get_mut(&id) {
                    n.states.focused = true;
                }
                if let Some(n) = tree.nodes.get_mut(&tree.root) {
                    n.states.active = true;
                }
            }
        }
        if let Some(menu) = self.popup.as_mut().and_then(|p| p.semantics(w)) {
            for node in tree.nodes.values_mut() {
                node.actions.clear();
            }
            let children = menu.nodes[&menu.root].children.clone();
            if let Some(root) = tree.nodes.get_mut(&tree.root) {
                root.children.extend(children);
            }
            for (id, node) in menu.nodes {
                if id != menu.root {
                    tree.nodes.insert(id, node);
                }
            }
        }
        let shape: Vec<_> = tree
            .nodes
            .values()
            .map(|n| (n.id, n.role, n.actions.clone(), n.name.clone()))
            .collect();
        let cards: Vec<_> = self
            .cards
            .iter()
            .map(|c| {
                (
                    c.banner.instance,
                    c.banner.content,
                    self.card_pages
                        .get(&c.banner.instance)
                        .copied()
                        .unwrap_or(0),
                )
            })
            .collect();
        if shape != self.shape || cards != self.card_shape || self.revision == 0 {
            self.card_shape = cards;
            self.shape = shape;
            self.revision += 1;
        }
        match &self.a11y {
            Some(bridge) => {
                if !self.a11y_failed
                    && let Err(error) = bridge.check()
                {
                    eprintln!("nidara-shell: the bar's accessibility failed: {error}");
                    self.a11y_failed = true;
                }
                if self.a11y_failed {
                    return;
                }
                while bridge.published.try_recv().is_ok() {}
                if let Err(e) = bridge.update(self.revision, tree) {
                    eprintln!("nidara-shell: the bar's accessibility stopped: {e}");
                }
            }
            None => {
                let mut bridge = nk_a11y::bridge::Bridge::new(self.revision, tree);
                // Forwarded with this bar's waker, so a request is handled at once.
                let (requests, rx) = std::sync::mpsc::channel();
                let from = std::mem::replace(&mut bridge.requests, std::sync::mpsc::channel().1);
                let waker = self.waker.clone();
                let _ = std::thread::Builder::new()
                    .name("bar-a11y".into())
                    .spawn(move || {
                        for r in from {
                            if requests.send(r).is_err() {
                                return;
                            }
                            let _ = waker.wake();
                        }
                    });
                self.a11y = Some(bridge);
                self.a11y_requests = Some(rx);
            }
        }
    }

    /// The Control Center's target a semantic node stands for.
    fn cc_target(&self, id: NodeId) -> Option<crate::cc::Target> {
        if !self.cc_open || id < CC_TILES {
            return None;
        }
        self.cc
            .nodes(CC_TILES, &self.frame.status, None)
            .into_iter()
            .find(|(n, _)| n.id == id)
            .map(|(_, t)| t)
    }

    /// Requests made against an older tree are dropped.
    fn a11y(&mut self, w: &mut Window) {
        let Some(rx) = &self.a11y_requests else {
            return;
        };
        let requests: Vec<_> = rx.try_iter().collect();
        for (revision, request) in requests {
            if revision != self.revision {
                // A header remains the same command while cards arrive. Its id is
                // retired on every view/owner change, independently of tree revisions.
                let current_nc = match &request {
                    nk_a11y::Request::Activate(id) | nk_a11y::Request::Focus(id) => {
                        self.nc_open && self.nc.control(*id).is_some()
                    }
                    _ => false,
                };
                if !current_nc {
                    continue;
                }
            }
            if let nk_a11y::Request::SetText(id, ref value) = request {
                if let Some(crate::cc::Target::Detail(row)) = self.cc_target(id) {
                    if let Some(d) = &mut self.cc.detail {
                        let index =
                            d.rows
                                .iter()
                                .find(|r| r.id == row)
                                .and_then(|r| match r.action {
                                    Some(crate::cc::detail::Action::SecretFocus(i)) => Some(i),
                                    _ => None,
                                });
                        if let (Some(index), Some(form)) = (index, &mut d.form) {
                            form.replace(index, value);
                        }
                    }
                    self.refresh(w);
                }
                continue;
            }
            if let nk_a11y::Request::SetSelection(id, ref range) = request {
                if let Some(crate::cc::Target::Detail(row)) = self.cc_target(id)
                    && let Some(d) = &mut self.cc.detail
                {
                    let index = d
                        .rows
                        .iter()
                        .find(|r| r.id == row)
                        .and_then(|r| match r.action {
                            Some(crate::cc::detail::Action::SecretFocus(i)) => Some(i),
                            _ => None,
                        });
                    if let (Some(index), Some(form)) = (index, &mut d.form) {
                        form.selection(index, range.clone());
                    }
                }
                continue;
            }
            if let nk_a11y::Request::SetValue(id, value) = request {
                let target = self.cc_target(id);
                if let Some(crate::cc::Target::Detail(id)) = target {
                    if let Some(act) = self.cc.action(
                        crate::cc::Target::Detail(id),
                        &self.frame.status,
                        Some(value),
                    ) {
                        self.act(act, w);
                    }
                    self.refresh(w);
                    continue;
                }
                if let Some(crate::cc::Target::Slider(slider)) = target
                    && let Some(act) = self.cc.set_from_reader(slider, value, &self.frame.status)
                {
                    self.act(act, w);
                }
                continue;
            }
            if let nk_a11y::Request::Named(id, ref name) = request {
                if let Some(target) = self.cc_target(id)
                    && let Some(act) = self.cc.named(target, name, &self.frame.status)
                {
                    self.act(act, w);
                }
                self.refresh(w);
                continue;
            }
            let (nk_a11y::Request::Activate(id) | nk_a11y::Request::Focus(id)) = request else {
                continue;
            };
            let activate = matches!(request, nk_a11y::Request::Activate(_));
            if self.nc_open
                && let Some(target) = self.nc.control(id)
            {
                if activate {
                    self.nc_act(target, w);
                } else {
                    self.nc.focus = Some(id);
                    self.card_keyboard = None;
                    self.refresh(w);
                }
                continue;
            }
            if let Some((instance, content, target)) = self.cards.iter().find_map(|c| {
                c.target_for(id)
                    .map(|t| (c.banner.instance, c.banner.content, t))
            }) {
                if activate {
                    self.card_activate(instance, content, target, None, w);
                } else {
                    self.card_keyboard = Some(id);
                    self.nc.reveal(instance);
                    self.nc.focus = None;
                    self.card_hover(Some(instance));
                    self.refresh(w);
                }
                continue;
            }
            if let Some(target) = self.cc_target(id) {
                if !activate {
                    self.cc.focus(target);
                }
                if activate && let Some(act) = self.cc.action(target, &self.frame.status, None) {
                    self.act(act, w);
                }
                self.refresh(w);
                continue;
            }
            if let Some(popup) = self.popup.as_mut().filter(|p| p.owns(id)) {
                let outcome = popup.request(id, activate);
                self.popup_outcome(w, outcome);
                continue;
            }
            if let Some(item) = item_of(id)
                && activate
            {
                // No input event behind it, so no activation token.
                self.click(item, None, w);
            }
        }
    }
}

const ROOT: NodeId = 1;
/// Each item's semantic id: fixed, as the bar's items are.
const ITEMS: [(Item, NodeId); 9] = [
    (Item::Logo, 2),
    (Item::Title, 3),
    (Item::Island, 4),
    (Item::ControlCenter, 5),
    (Item::Clock, 6),
    (Item::Widget(Widget::Focus), 7),
    (Item::Widget(Widget::Battery), 8),
    (Item::Widget(Widget::Wifi), 9),
    (Item::Widget(Widget::Volume), 10),
];

/// Tray items take the ids from here on, by their place.
const TRAY_IDS: NodeId = 100;
/// The Control Center's panel, and its tiles from here on, in reading order.
const CC_PANEL: NodeId = 900;
const CC_TILES: NodeId = 901;

fn item_of(id: NodeId) -> Option<Item> {
    if id >= CC_PANEL {
        return None;
    }
    if id >= TRAY_IDS {
        return usize::try_from(id - TRAY_IDS).ok().map(Item::Tray);
    }
    ITEMS.iter().find(|(_, n)| *n == id).map(|(i, _)| *i)
}

fn id_of(item: Item) -> Option<NodeId> {
    match item {
        Item::Tray(i) => Some(TRAY_IDS + i as NodeId),
        _ => ITEMS.iter().find(|(i, _)| *i == item).map(|(_, n)| *n),
    }
}

/// What a widget says to a reader: its name and its state.
fn widget_node(w: Widget, s: &crate::status::Status) -> (&'static str, String) {
    use crate::status::Wifi;
    match w {
        Widget::Focus => ("Do Not Disturb", "on".into()),
        Widget::Battery => (
            "Battery",
            s.battery.map_or(String::new(), |b| {
                let pct = (b.fraction * 100.).round();
                if b.charging {
                    format!("{pct}%, on AC")
                } else {
                    format!("{pct}%")
                }
            }),
        ),
        Widget::Wifi => (
            "Wi-Fi",
            match s.wifi {
                Some(Wifi::Off) => "off".into(),
                Some(Wifi::Connecting) => "connecting".into(),
                Some(Wifi::Connected(l)) => format!("connected, signal {l} of 3"),
                _ => "not connected".into(),
            },
        ),
        Widget::Volume => (
            "Volume",
            s.volume.map_or(String::new(), |v| {
                if v.muted {
                    "muted".into()
                } else {
                    format!("{}%", (v.level * 100.).round())
                }
            }),
        ),
    }
}

fn tree(
    layout: &Layout,
    width: f64,
    hidden: bool,
    status: &crate::status::Status,
    tray: &[crate::tray::TrayItem],
    cc_open: bool,
) -> Tree {
    let mut root = Node::new(ROOT, Role::Window, "Bar");
    root.states.hidden = hidden;
    root.bounds = Bounds {
        x: 0.,
        y: 0.,
        width,
        height: f64::from(HEIGHT),
    };
    let mut nodes = std::collections::BTreeMap::new();
    let active = layout.dots.iter().position(|d| *d == Dot::Active);
    for (item, b) in &layout.items {
        let Some(id) = id_of(*item) else {
            continue;
        };
        let mut node = match item {
            Item::Logo => Node::new(id, Role::Button, "System menu"),
            Item::Title => Node::new(id, Role::Label, &layout.title),
            Item::Island => {
                let mut n = Node::new(id, Role::Button, "Desktops");
                n.states.disabled = true;
                n.description = active.map_or(String::new(), |a| {
                    format!("desktop {} of {}", a + 1, layout.dots.len())
                });
                n
            }
            Item::ControlCenter => {
                let mut n = Node::new(id, Role::Button, "Control Center");
                n.states.expandable = true;
                n.states.expanded = cc_open;
                n
            }
            // The clock opens the Notification Center/calendar.
            Item::Clock => {
                let mut n = Node::new(id, Role::Button, &layout.clock);
                n.states.expandable = true;
                n
            }
            Item::Tray(i) => Node::new(
                id,
                Role::Button,
                tray.get(*i).map_or("", |t| t.title.as_str()),
            ),
            Item::Widget(w) => {
                let (name, state) = widget_node(*w, status);
                let mut n = Node::new(id, Role::Button, name);
                n.description = state;
                // Only focus acts here; the others' panels come with the Control Center.
                n.states.disabled = *w != Widget::Focus;
                n
            }
        };
        if matches!(
            item,
            Item::Logo
                | Item::Tray(_)
                | Item::Widget(Widget::Focus)
                | Item::ControlCenter
                | Item::Clock
        ) {
            node.actions = vec![Action::Activate];
        }
        node.states.hidden = hidden;
        node.bounds = Bounds {
            x: b[0],
            y: b[1],
            width: b[2],
            height: b[3],
        };
        root.children.push(id);
        nodes.insert(id, node);
    }
    nodes.insert(ROOT, root);
    Tree { root: ROOT, nodes }
}

/// The battery glyph: `nd-battery-symbolic.svg` redrawn (24-unit grid; body 1,6
/// 18.5×12 r2 stroke 2, nub 22,9 2×6), filled in proportion to the charge — green on AC,
/// red at 15 % and below (the semantic status colours, never the accent).
pub(crate) fn paint_battery(c: &mut Canvas, r: Rect, b: crate::status::Battery) {
    const LOW: f64 = 0.15;
    let (x0, y0) = (f64::from(r.x), f64::from(r.y));
    let u = |n: f64| n * f64::from(r.width) / 24.;
    let at = |x: f64, y: f64, w: f64, h: f64| Rect {
        x: (x0 + u(x)) as f32,
        y: (y0 + u(y)) as f32,
        width: u(w) as f32,
        height: u(h) as f32,
    };
    let solid = ink(0.9);
    // The stroke straddles the path: its outer edge is a unit outside it.
    c.rounded_ring(at(0., 5., 20.5, 14.), u(3.), u(2.), solid);
    c.rounded_rect(at(22., 9., 2., 6.), u(1.), solid);
    let gap = 0.75;
    let inner = 16.5 - 2. * gap;
    let fill = inner * b.fraction;
    if u(fill) > 0.5 {
        let color = if b.charging {
            Color::new([
                0x30 as f32 / 255.,
                0xd1 as f32 / 255.,
                0x58 as f32 / 255.,
                0.95,
            ])
        } else if b.fraction <= LOW {
            Color::new([1., 0x3b as f32 / 255., 0x30 as f32 / 255., 0.95])
        } else {
            ink(1.)
        };
        c.rounded_rect(
            at(2. + gap, 7. + gap, fill, 10. - 2. * gap),
            u(1. - gap).max(0.5),
            color,
        );
    }
}

fn ink(alpha: f32) -> Color {
    Color::new([1., 1., 1., alpha])
}

fn rect(r: [f64; 4]) -> Rect {
    Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}

impl Application for Bar {
    fn poll_interval_ms(&self) -> u32 {
        match self.nc_ghost {
            Some((_, start, 2)) => (crate::nc::CLEAR_MS + 50)
                .saturating_sub(start.elapsed().as_millis().min(u32::MAX as u128) as u32)
                .clamp(1, 1000),
            Some(_) => 8,
            None => 1000,
        }
    }
    fn event(&mut self, event: Event, w: &mut Window) -> nk_wayland::Result<()> {
        match event {
            Event::Layer {
                id,
                event:
                    nk_wayland::LayerEvent::Done { serial: 1, .. }
                    | nk_wayland::LayerEvent::Cancelled { serial: 1 },
            } if self
                .nc_ghost
                .is_some_and(|(layer, _, stage)| layer == id && stage == 2) =>
            {
                self.finish_nc_clear(w)
            }
            Event::Configure => {
                self.width = f64::from(w.size().0);
                if !self.tried_look {
                    self.tried_look = true;
                    if let Some(bus) = &self.bus {
                        self.look = Look::load(bus)
                            .map_err(|e| eprintln!("nidara-shell: the bar has no look: {e}"))
                            .ok();
                    }
                }
                self.clock = self.now();
                self.refresh(w);
            }
            Event::Wake => {
                let mut latest = None;
                loop {
                    match self.frames.try_recv() {
                        Ok(f) => latest = Some(f),
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        // The hub let this output go: the bar goes with it.
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            w.close();
                            return Ok(());
                        }
                    }
                }
                if let Some(f) = latest {
                    self.nc_clear_animation(&f.history, w);
                    if f.nc_generation != self.nc_generation {
                        self.nc_generation = f.nc_generation;
                        self.nc.retire_view();
                        self.nc_open = f.nc_open && !f.locked;
                        if f.nc_active && self.cc_open {
                            self.toggle_cc(w);
                        }
                        if self.nc_open {
                            self.close_popup(w);
                            self.end_tray_menu();
                        } else {
                            self.nc.clearing = false;
                            if let Some((layer, _, _)) = self.nc_ghost.take() {
                                let _ = w.destroy_layer(layer);
                            }
                        }
                    }
                    if f.locked {
                        self.nc_open = false;
                        self.nc.focus = None;
                        if let Some((layer, _, _)) = self.nc_ghost.take() {
                            let _ = w.destroy_layer(layer);
                        }
                    }
                    self.frame = f;
                    if self.frame.output_size.1 > 0 {
                        self.output_height = self.frame.output_size.1;
                    }
                    if self
                        .card_focus
                        .as_ref()
                        .is_some_and(|p| !self.card_current(p.0, p.1))
                    {
                        self.card_focus = None;
                    }
                    if self
                        .card_pending
                        .as_ref()
                        .is_some_and(|p| !self.card_current(p.1, p.2))
                        && let Some((request, _, _, _)) = self.card_pending.take()
                    {
                        w.cancel_activation_token(request);
                    }
                    if self.frame.locked {
                        self.card_keyboard = None;
                        self.card_press = None;
                    }
                    Arc::make_mut(&mut self.frame).status.capture = crate::capture::state();
                    // Locked, or a fullscreen window: the Control Center goes with the bar.
                    if self.frame.hidden && self.cc_open {
                        self.toggle_cc(w);
                    }
                    self.clock = self.now();
                    self.refresh(w);
                }
                self.tray_replies(w);
            }
            Event::Closed => w.close(),
            Event::Motion(x, y) => {
                self.pointer = (x, y);
                self.pointer_inside = true;
                if self.nc_open && self.nc.motion((x, y)) {
                    w.redraw();
                }
                self.card_hover(self.card_at((x, y)).map(|(id, _, _)| id));
                if self.cc_open {
                    let (changed, act) = self.cc.motion((x, y), &self.frame.status);
                    if let Some(act) = act {
                        self.act(act, w);
                    }
                    if changed {
                        if self.cc.editor.active {
                            self.refresh(w);
                        } else {
                            w.redraw();
                            self.publish_semantics(w);
                        }
                    }
                }
                let hover = self.item_at((x, y));
                if hover != self.hover {
                    self.hover = hover;
                    w.redraw();
                }
            }
            Event::PointerLeave => {
                self.pointer_inside = false;
                self.nc.hover = None;
                self.card_hover(None);
                self.card_press = None;
                let cc = self.cc.leave();
                if self.hover.take().is_some() || cc {
                    w.redraw();
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: true,
                serial,
                ..
            } => {
                let p = self.pointer;
                crate::icon_metrics::emit(
                    "nc-pointer-press",
                    serde_json::json!({"point":[p.0,p.1],"nc":self.nc_open,"whole":self.input==[[-1;4]]}),
                );
                if let Some((id, content, target)) = self.card_at(p) {
                    self.card_press = Some(CardPress {
                        instance: id,
                        content,
                        target,
                        start: p,
                        serial,
                    });
                } else if self.nc_open && self.nc.contains(p) {
                    if let Some(target) = self.nc.hit(p) {
                        self.nc_act(target, w);
                    }
                } else if self.cc_open && self.cc.contains(p) {
                    if let Some(act) = self.cc.press(p, &self.frame.status) {
                        self.act(act, w);
                    }
                    self.refresh(w);
                } else if let Some(item) = self.item_at(p) {
                    if self.nc_open && item != Item::Clock {
                        self.toggle_nc(w);
                    }
                    if self.cc_open && item != Item::ControlCenter {
                        self.toggle_cc(w);
                    }
                    self.click(item, Some(serial), w);
                } else if self.nc_open {
                    self.toggle_nc(w);
                } else if self.cc_open {
                    // Outside the panel and the bar's glass: the Control Center closes.
                    self.toggle_cc(w);
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: false,
                ..
            } => {
                if let Some(CardPress {
                    instance,
                    content,
                    target,
                    start,
                    serial,
                }) = self.card_press.take()
                {
                    if (self.pointer.0 - start.0).abs() > 80.
                        && (self.pointer.1 - start.1).abs() < 60.
                    {
                        self.card_send(instance, content, None, None);
                    } else if self.card_at(self.pointer)
                        == Some((instance, content, target.clone()))
                    {
                        self.card_activate(instance, content, target, Some(serial), w);
                    }
                }
                let editing = self.cc.editor.active;
                if let Some(act) = self.cc.release_edit(&self.frame.status) {
                    self.act(act, w);
                }
                if self.cc.release() || editing {
                    // A rejected/outside drop has no Act but must still restore its layers.
                    self.refresh(w);
                }
            }
            Event::Key(key) if self.nc_open => self.nc_key(&key, w),
            Event::Key(key) if self.card_keyboard.is_some() => {
                if key.sym == ESCAPE {
                    self.card_keyboard = None;
                    self.card_hover(None);
                    self.refresh(w);
                } else if key.sym == 0xff09 {
                    let ids: Vec<_> = self
                        .cards
                        .iter()
                        .flat_map(|c| {
                            std::iter::once(c.node_id())
                                .chain((0..c.buttons.len()).map(|i| c.node_id() + 1 + i as u64))
                        })
                        .collect();
                    if let Some(at) = ids.iter().position(|id| Some(*id) == self.card_keyboard) {
                        let next = if key.shift {
                            (at + ids.len() - 1) % ids.len()
                        } else {
                            (at + 1) % ids.len()
                        };
                        self.card_keyboard = Some(ids[next]);
                        self.refresh(w);
                    }
                } else if matches!(key.sym, 0xff0d | 0x20)
                    && let Some(id) = self.card_keyboard
                    && let Some((instance, content, target)) = self.cards.iter().find_map(|c| {
                        c.target_for(id)
                            .map(|t| (c.banner.instance, c.banner.content, t))
                    })
                {
                    self.card_activate(instance, content, target, key.serial, w);
                }
            }
            Event::Key(key)
                if self.cc_open && self.cc.detail.as_ref().is_some_and(|d| d.form.is_some()) =>
            {
                if key.sym == ESCAPE {
                    self.act(
                        crate::cc::Act::Detail(crate::cc::detail::Action::SecretCancel),
                        w,
                    );
                } else if [0xff09, 0xfe20].contains(&key.sym)
                    || self
                        .cc
                        .detail
                        .as_ref()
                        .and_then(|d| d.focused_field())
                        .is_none()
                {
                    if let Some(act) = self.cc.key(&key, &self.frame.status) {
                        self.act(act, w);
                    }
                } else if key.ctrl && [b'v' as u32, b'V' as u32].contains(&key.sym) {
                    self.cc_paste = self
                        .cc
                        .detail
                        .as_ref()
                        .and_then(|d| d.form.as_ref())
                        .map(|f| (self.cc.view_id(), f.paste_tag()));
                    if let Err(error) = w.paste() {
                        self.cc_paste = None;
                        if let Some(d) = &mut self.cc.detail {
                            d.error = error.to_string();
                        }
                    }
                } else if key.sym == 0xff0d {
                    self.act(
                        crate::cc::Act::Detail(crate::cc::detail::Action::SecretSubmit),
                        w,
                    );
                } else if let Some(form) = self.cc.detail.as_mut().and_then(|d| d.form.as_mut()) {
                    form.key(&key);
                }
                self.refresh(w);
            }
            Event::Paste(text) => {
                if let Some((view, tag)) = self.cc_paste.take()
                    && view == self.cc.view_id()
                    && self.cc.detail.as_ref().and_then(|d| d.focused_field()) == Some(tag.1)
                    && let Some(form) = self.cc.detail.as_mut().and_then(|d| d.form.as_mut())
                {
                    form.paste(tag, &text);
                    self.refresh(w);
                }
            }
            Event::Ime(batch) if self.cc_open => {
                if self
                    .cc
                    .detail
                    .as_ref()
                    .and_then(|d| d.focused_field())
                    .is_some()
                    && let Some(text) = batch.commit
                    && let Some(form) = self.cc.detail.as_mut().and_then(|d| d.form.as_mut())
                {
                    form.key(&nk_wayland::Key {
                        serial: None,
                        sym: 0,
                        text,
                        shift: false,
                        ctrl: false,
                        alt: false,
                    });
                }
                self.refresh(w);
            }
            Event::Key(key) if self.cc_open && key.sym == ESCAPE => {
                if self.cc.editor.active {
                    self.cc.key(&key, &self.frame.status);
                    self.refresh(w);
                } else if self.cc.back() {
                    self.refresh(w);
                } else {
                    self.toggle_cc(w);
                }
            }
            Event::Key(key) if self.cc_open => {
                if let Some(act) = self.cc.key(&key, &self.frame.status) {
                    self.act(act, w);
                }
                self.refresh(w);
            }
            Event::Button {
                button: button @ (RIGHT_BUTTON | MIDDLE_BUTTON),
                pressed: true,
                serial,
                ..
            } => {
                if self.cc_open && button == RIGHT_BUTTON && self.cc.contains(self.pointer) {
                    if let Some(act) = self.cc.context(self.pointer, &self.frame.status) {
                        self.act(act, w);
                    }
                    self.refresh(w);
                } else if let Some(Item::Tray(i)) = self.item_at(self.pointer) {
                    self.tray_click(i, button, Some(serial), w);
                }
            }
            Event::Scroll(nk_wayland::ScrollAmount { pixels: delta, .. }) => {
                if self.nc_open {
                    self.nc.scroll(delta * 32.);
                    self.refresh(w);
                } else if self.cc_open && self.cc.scroll_detail(delta, &self.frame.status) {
                    self.refresh(w);
                } else {
                    self.tray_scroll(delta, false);
                }
            }
            Event::HorizontalScroll(nk_wayland::ScrollAmount { pixels: delta, .. }) => {
                self.tray_scroll(delta, true)
            }
            Event::PopupOverlay { id, event } => {
                if let Some(popup) = self.popup.as_mut().filter(|p| p.id == id) {
                    let outcome = popup.event(w, event);
                    self.popup_outcome(w, outcome);
                }
            }
            Event::Focus(focused) if self.card_focus.is_none() => {
                self.card_keyboard_active = focused;
                if !focused && self.card_keyboard.take().is_some() {
                    self.card_hover(None);
                    self.refresh(w);
                } else {
                    self.publish_semantics(w);
                }
            }
            Event::Focus(true) if self.card_focus.is_some() => {
                if let Some((instance, content, key, _)) = self.card_focus.take() {
                    if self.card_current(instance, content) {
                        match w.request_focused_activation_token(None) {
                            Ok(r) => self.card_pending = Some((r, instance, content, key)),
                            Err(e) => {
                                eprintln!(
                                    "nidara-shell: assistive notification token unavailable: {e:?}"
                                );
                                self.card_error(
                                    instance,
                                    content,
                                    "Could not activate. Try again.",
                                );
                            }
                        }
                    }
                    self.refresh(w);
                }
            }
            Event::ActivationToken { request, token } => {
                if self.card_pending.as_ref().is_some_and(|p| p.0 == request) {
                    let (_, instance, content, key) = self.card_pending.take().unwrap();
                    self.card_send(instance, content, Some(key), Some(token.into_string()));
                    return Ok(());
                }
                if let Some((r, command)) = self.pending.take() {
                    if r == request {
                        self.send(command, Some(token.into_string()));
                    } else {
                        self.pending = Some((r, command));
                    }
                }
            }
            Event::ActivationTokenFailed { request, reason } => {
                if self.card_pending.as_ref().is_some_and(|p| p.0 == request) {
                    let (_, instance, content, _) = self.card_pending.take().unwrap();
                    self.card_error(instance, content, "Could not activate. Try again.");
                    eprintln!("nidara-shell: notification token failed: {reason:?}");
                }
                if let Some((r, command)) = self.pending.take() {
                    if r == request {
                        self.send(command, None);
                    } else {
                        self.pending = Some((r, command));
                    }
                }
            }
            _ => {}
        }
        let aux = crate::ccaux::snapshot();
        if self.frame.status.aux != aux {
            Arc::make_mut(&mut self.frame).status.aux = aux;
            self.refresh(w);
        }
        self.auth_events(w);
        self.a11y(w);
        let results: Vec<_> = self
            .cc_writer
            .as_ref()
            .map(|writer| writer.replies.try_iter().collect())
            .unwrap_or_default();
        for (version, result) in results {
            if version & (1u64 << 63) != 0 {
                if self
                    .cc
                    .editor
                    .write_finished(version & !(1u64 << 63), result)
                {
                    self.refresh(w);
                }
                continue;
            }
            if version != self.cc.view_id() {
                continue;
            }
            if let Some(d) = &mut self.cc.detail {
                d.error = result.clone().err().unwrap_or_default();
            }
            self.refresh(w);
        }
        if let (Some(popup), Some(look)) = (self.popup.as_mut(), self.look.as_mut()) {
            match popup.sync(w, look) {
                Ok(true) => self.publish_semantics(w),
                Ok(false) => {}
                Err(e) => {
                    eprintln!("nidara-shell: the system menu cannot be drawn: {e}");
                    self.close_popup(w);
                }
            }
        }
        Ok(())
    }

    fn idle(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        self.auth_events(w);
        if let Some((layer, start, stage)) = self.nc_ghost {
            if stage == 2
                && start.elapsed()
                    >= std::time::Duration::from_millis(crate::nc::CLEAR_MS as u64 + 50)
            {
                crate::icon_metrics::emit("nc-clear-fallback", serde_json::json!({}));
                self.finish_nc_clear(w);
            } else if stage == 1 {
                crate::icon_metrics::emit("nc-clear-armed", serde_json::json!({}));
                let _ = w.set_transition(
                    layer,
                    nk_wayland::Property::Opacity,
                    1,
                    nk_wayland::Curve::Bezier {
                        x1: 0.2,
                        y1: 0.,
                        x2: 0.2,
                        y2: 1.,
                        duration_ms: crate::nc::CLEAR_MS,
                    },
                );
                let _ = w.set_opacity(layer, 0.);
                self.nc_ghost = Some((layer, Instant::now(), 2));
                // The pending child state commits without repainting the root.
            }
        }
        let minute = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 60;
        if self.nc_open && minute != self.nc.minute {
            self.refresh(w);
        }
        if self
            .card_focus
            .as_ref()
            .is_some_and(|p| p.3.elapsed() >= std::time::Duration::from_secs(2))
        {
            let (instance, content, _, _) = self.card_focus.take().unwrap();
            self.card_error(instance, content, "Could not focus. Try again.");
            self.refresh(w);
            eprintln!("nidara-shell: notification keyboard focus timed out");
        }
        if self.cc_open
            && self.cc.detail.as_ref().is_some_and(|d| d.page == "media")
            && self.frame.status.media.as_ref().is_some_and(|m| m.playing)
        {
            self.refresh(w);
        }
        let capture = crate::capture::state();
        if capture != self.frame.status.capture {
            Arc::make_mut(&mut self.frame).status.capture = capture;
            self.refresh(w);
        }

        let now = self.now();
        if now != self.clock {
            self.clock = now;
            self.refresh(w);
        }
        Ok(())
    }

    fn paint(&mut self, f: nk_wayland::Frame) -> nk_wayland::Result<Vec<u8>> {
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        if self.frame.locked || self.look.is_none() {
            return Ok(c.finish());
        }
        if !self.frame.hidden {
            if !f.material {
                // No compositor glass: the capsules' own opaque base (D5).
                let base = self.look.as_ref().unwrap().style.row.background;
                for g in &self.layout.glass {
                    c.rounded_rect(rect(*g), g[3] / 2., base);
                }
            }
            for (item, b) in self.layout.items.clone() {
                if item == Item::Island {
                    continue;
                }
                let lit = self.hover == Some(item);
                if lit {
                    let p = m::pill(b);
                    c.rounded_rect(rect(p), p[3] / 2., ink(HOVER));
                }
                let icon_box = |b: [f64; 4]| Rect {
                    x: (b[0] + m::ICON_PAD) as f32,
                    y: (b[1] + (b[3] - m::ICON) / 2.) as f32,
                    width: m::ICON as f32,
                    height: m::ICON as f32,
                };
                match item {
                    Item::Logo => {
                        if let Some(logo) = &self.logo {
                            c.icon(logo, icon_box(b), ink(1.));
                        }
                    }
                    Item::ControlCenter => {
                        if let Some(cc) = &self.cc_icon {
                            c.icon(cc, icon_box(b), ink(1.));
                        }
                    }
                    Item::Widget(Widget::Battery) => {
                        if let Some(battery) = self.frame.status.battery {
                            paint_battery(&mut c, icon_box(b), battery);
                        }
                    }
                    Item::Widget(w) => {
                        if let Some(name) = widget_icon(w, &self.frame.status) {
                            let icons = &mut self.icons;
                            let icon = self
                                .glyphs
                                .entry(name)
                                .or_insert_with(|| {
                                    icons.as_mut().and_then(|i| {
                                        i.get(name, 18)
                                            .map_err(|e| eprintln!("nidara-shell: no {name}: {e}"))
                                            .ok()
                                    })
                                })
                                .clone();
                            if let Some(icon) = icon {
                                c.icon(&icon, icon_box(b), ink(1.));
                            }
                        }
                    }
                    Item::Title | Item::Clock => {
                        let text = if item == Item::Title {
                            self.layout.title.clone()
                        } else {
                            self.layout.clock.clone()
                        };
                        let style = self.style().unwrap();
                        let look = self.look.as_mut().unwrap();
                        if let Ok(layout) = look.text.layout(&text, &style, f32::MAX) {
                            let h = f64::from(layout.measured_size().height);
                            let at = (
                                (b[0] + m::TEXT_PAD) as f32,
                                (b[1] + (b[3] - h) / 2.).round() as f32,
                            );
                            c.layout(&layout, at, ink(1.))?;
                        }
                    }
                    Item::Island => {}
                    Item::Tray(i) => {
                        if let Some(p) = self
                            .frame
                            .tray
                            .get(i)
                            .and_then(|t| t.icon.as_ref())
                            .and_then(|p| p.asset())
                        {
                            c.image(&p.raster, icon_box(b), ImageFit::Contain);
                        }
                    }
                }
            }
        }
        if self.cc_open {
            let fallback = (!f.material).then(|| self.look.as_ref().unwrap().style.row.background);
            let look = self.look.as_mut().unwrap();
            self.cc.paint(&mut c, look, &self.frame.status, fallback)?;
        }
        if self.nc_open {
            self.nc
                .paint(&mut c, self.look.as_mut().unwrap(), f.material)?;
        }
        // The dots, centred in the island's capsule.
        if !self.frame.hidden {
            let island = self.layout.glass[1];
            let mut x = island[0] + m::PILL_PAD;
            let y = island[1] + (island[3] - m::DOT) / 2.;
            for d in &self.layout.dots {
                let (wd, alpha) = match d {
                    Dot::Active => (m::DOT_ACTIVE, 1.),
                    Dot::Occupied => (m::DOT, DOT_OCCUPIED),
                    Dot::Empty => (m::DOT, DOT_EMPTY),
                };
                c.rounded_rect(rect([x, y, wd, m::DOT]), m::DOT / 2., ink(alpha));
                x += wd + m::DOT_GAP;
            }
        }
        let look = self.look.as_mut().unwrap();
        for card in &self.cards {
            if card.age.is_some() {
                c.clip(rect(self.nc.viewport));
            }
            card.paint(
                &mut c,
                look,
                f.material || card.age.is_some(),
                &crate::notification_card::Artwork {
                    theme: &self.frame.notification_theme,
                    catalogue: &self.frame.catalogue,
                    namespace: &self.name,
                    scale: f.scale,
                },
            )?;
            if card.age.is_some() {
                c.pop_clip();
            }
        }
        if let Some((layer, _, 0)) = self.nc_ghost {
            crate::icon_metrics::emit("nc-clear-first-commit", serde_json::json!({}));
            self.nc_ghost = Some((layer, Instant::now(), 1));
        }
        Ok(c.finish())
    }

    fn material(&self) -> Option<Material> {
        if self.frame.locked
            || self.layout.glass.is_empty()
            || self.frame.hidden && self.cards.is_empty() && !self.nc_open
        {
            return None;
        }
        let mut panes: Vec<Pane> = self
            .layout
            .glass
            .iter()
            .filter(|_| !self.frame.hidden)
            .map(|g| Pane {
                x: g[0],
                y: g[1],
                width: g[2],
                height: g[3],
                radius: g[3] / 2.,
                exponent: 2.,
                pointer: None,
            })
            .collect();
        let cards: Vec<_> = self
            .cards
            .iter()
            .filter(|c| c.age.is_none())
            .map(|c| c.pane())
            .collect();
        if self.frame.hidden {
            panes = cards.clone();
            if self.nc_open {
                panes.push(self.nc.pane());
            }
        }
        let tokens = self.frame.tokens.as_ref()?;
        let mut material = crate::material::piece(
            tokens,
            if self.frame.hidden {
                "controlCenter"
            } else {
                "control"
            },
            true,
            self.frame.reduce_transparency,
            panes[0],
        )?;
        material.shapes = panes;
        if self.cc_open {
            let (groups, veils) = self.cc.glass(tokens, self.frame.reduce_transparency);
            material.groups = groups;
            material.veils = veils;
            material.states = self.cc.states(&self.frame.status);
        }
        if !self.frame.hidden
            && let Some(pane) = cards.first()
            && let Some(card) = crate::material::piece(
                tokens,
                "controlCenter",
                true,
                self.frame.reduce_transparency,
                *pane,
            )
        {
            material.groups.push(nk_wayland::Group {
                clip: None,
                opacity: 1.,
                tone: card.tone,
                shadow: card.shadow,
                shapes: cards,
            });
        }
        if self.nc_open
            && let Some(nc) = crate::material::piece(
                tokens,
                "controlCenter",
                true,
                self.frame.reduce_transparency,
                self.nc.pane(),
            )
        {
            if !self.frame.hidden {
                material.groups.push(nk_wayland::Group {
                    clip: None,
                    opacity: 1.,
                    tone: nc.tone,
                    shadow: nc.shadow,
                    shapes: vec![self.nc.pane()],
                });
            }
            material.states.extend(self.nc.states());
        }
        Some(material)
    }
}

/// Along the top, reserving the strip, `height` tall: the strip and its shadow's room,
/// or the whole output while the Control Center is open (and then the keyboard, for
/// Escape).
fn placement(height: u32, open: bool) -> LayerPlacement {
    LayerPlacement {
        anchor: Edges::TOP | Edges::LEFT | Edges::RIGHT,
        size: (0, height),
        exclusive_zone: m::BAR_H as i32,
        margin: [0; 4],
        keyboard: if open {
            KeyboardMode::OnDemand
        } else {
            KeyboardMode::None
        },
    }
}

/// One bar's whole life on its own thread: along the top of `output`, reserving its strip.
pub fn run(bar: Bar, output: LayerOutput, wake: WakeSource) -> nk_wayland::Result<()> {
    nk_wayland::run_layer(
        bar,
        Options {
            material: true,
            map: true,
            app_id: NAMESPACE,
            title: "",
            size: (0, HEIGHT),
            require_material: None,
        },
        LayerSpec {
            namespace: NAMESPACE,
            output: Some(output),
            layer: LayerLevel::Top,
            placement: placement(HEIGHT, false),
        },
        Some(wake),
        Instant::now(),
    )
}

fn inside(r: [f64; 4], p: (f64, f64)) -> bool {
    p.0 >= r[0] && p.0 < r[0] + r[2] && p.1 >= r[1] && p.1 < r[1] + r[3]
}

impl Drop for Bar {
    fn drop(&mut self) {
        crate::ccaux::mapped(&self.name, false);
    }
}
