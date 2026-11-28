// SPDX-License-Identifier: LGPL-3.0-or-later
//! One output's lock surface, on its own thread and event queue (`nk_wayland::run_lock_surface`).
//!
//! What it shows (#1195): the date and the clock on every output; on the one the pointer is
//! on (D6), under them, the avatar, the real name and the password field with its button
//! inside (`nk::PasswordEntry::submit`), what the last attempt said, the Caps Lock warning,
//! and Suspend at the bottom (D3). There is no card and no glass but the field's (D7): the
//! text sits straight on the veil Hyalo draws over the wallpaper, in the shell's white ink.
//!
//! On the login screen (#1195 L1, L3) the same view is for the chosen person, whose session
//! may be open (a mark on the avatar, and said under the name), with the other people in a
//! row under the field, each a button that chooses them.
//!
//! Layout, hover, focus, Tab, the field's editing and input methods and the reader are the
//! kit's (`nk::ViewState`); this says what the view is and acts on what is activated.
use crate::power::Power;
use crate::{Msg, World};
use nk::{
    Activated, Align, Corner, HostRequest, Ink, Key, MenuKey, Node, Padding, Space, Type,
    ViewState, Weight, Widget, WindowLook,
};
use nk_platform::clock::{self, Order, Region};
use nk_platform::exports::Exports;
use nk_render::{Canvas, Raster};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{Application, Event, LockOutput, Material, Options, OutputId, Window};
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// The view's keys and actions.
const SECRET: &str = "secret";
const SUBMIT: &str = "submit";
const PEEK: &str = "peek";
const SUSPEND: &str = "suspend";
const POWER: &str = "power";
const LANGUAGE: &str = "language";
const LAYOUT: &str = "layout";
const WIFI: &str = "wifi";
const ACCESS: &str = "access";
const PREVIOUS: &str = "media-previous";
const PLAY_PAUSE: &str = "media-play-pause";
const NEXT: &str = "media-next";
const CHOOSE: &str = "choose";
const AVATAR: &str = "lock/avatar";
const ROOT: nk_a11y::NodeId = 1;
const ENTER: u32 = 0xff0d;
const KP_ENTER: u32 = 0xff8d;
const LEFT_BUTTON: u32 = 0x110;

/// The lock screen's measures (`toolkit/lockscreen/lock.json`).
#[derive(Clone, Copy, Debug)]
pub struct Measures {
    pub clock_top: f64,
    pub avatar: f64,
    pub name_gap: f64,
    pub field_gap: f64,
    pub field: f64,
    pub line_gap: f64,
    pub power_bottom: f64,
    pub error_seconds: f64,
    pub others: f64,
    pub others_width: f64,
    pub others_gap: f64,
}
impl Measures {
    fn load() -> Result<Self, String> {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../lock.json")).map_err(|e| e.to_string())?;
        let n = |k: &str| {
            v[k].as_f64()
                .filter(|x| x.is_finite() && *x >= 0.)
                .ok_or_else(|| format!("lock.json: no {k}"))
        };
        Ok(Self {
            clock_top: n("clockTop")?,
            avatar: n("avatar")?,
            name_gap: n("nameGap")?,
            field_gap: n("fieldGap")?,
            field: n("field")?,
            line_gap: n("lineGap")?,
            power_bottom: n("powerBottom")?,
            error_seconds: n("errorSeconds")?,
            others: n("others")?,
            others_width: n("othersWidth")?,
            others_gap: n("othersGap")?,
        })
    }
}

static EXPORTS: RwLock<Option<Exports>> = RwLock::new(None);

/// A string of the screen's language (LANG, as the shell starts with, until the login
/// screen's language menu changes it); the key itself when there is no catalogue, so the
/// screen still says something.
pub fn text(key: &str) -> String {
    EXPORTS
        .read()
        .unwrap()
        .as_ref()
        .and_then(|e| e.text(key).ok())
        .map_or_else(|| key.to_owned(), str::to_owned)
}

/// The screen speaks `locale` from now on (L4); false when its strings cannot be read.
pub fn set_language(locale: &str) -> bool {
    match Exports::load_for(&Exports::root(), Some(locale)) {
        Ok(e) => {
            *EXPORTS.write().unwrap() = Some(e);
            true
        }
        Err(e) => {
            eprintln!("nidara-lock: no strings for {locale}: {e}");
            false
        }
    }
}

static LARGE_TEXT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The screen's text a quarter larger from now on, or not (the accessibility menu); the
/// surfaces see it at their next rebuild.
pub fn set_large_text(on: bool) {
    LARGE_TEXT.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// What every surface paints with, loaded once.
pub struct Kit {
    look: WindowLook,
    /// The same look with the text a quarter larger (the accessibility menu).
    large: WindowLook,
    pub measures: Measures,
    pub region: Region,
    pub order: Order,
    pub fonts: Arc<FontSet>,
    /// Each person's picture by its identifier (`picture_id`), read once and shared.
    pub pictures: std::collections::HashMap<String, Arc<Raster>>,
}

/// What a person's picture is supplied to the view under.
pub fn picture_id(login: &str) -> String {
    format!("avatar/{login}")
}

impl Kit {
    /// The look in force: with large text when it is on.
    pub fn look(&self) -> &WindowLook {
        if LARGE_TEXT.load(std::sync::atomic::Ordering::Relaxed) {
            &self.large
        } else {
            &self.look
        }
    }
    pub fn load(users: &[crate::user::User]) -> Result<Self, String> {
        let exports = Exports::load(&Exports::root())?;
        let appearance = appearance(&exports);
        // The shell's skin: always dark, white ink (owner's decision), over Hyalo's veil.
        let skin = nk_platform::portal::Appearance {
            dark: true,
            ..appearance
        };
        let look = WindowLook::load(&exports, &skin)?;
        let large = WindowLook::load(
            &exports,
            &nk_platform::portal::Appearance {
                text_scale: skin.text_scale * crate::access::LARGE_TEXT,
                ..skin.clone()
            },
        )?;
        *EXPORTS.write().unwrap() = Some(exports);
        let measures = Measures::load()?;
        let side = (measures.avatar * 2.).round() as u32;
        let pictures = users
            .iter()
            .filter_map(|u| {
                let (w, h, rgba) = nk_icons::read_app_icon(u.picture.as_ref()?, side)?;
                let raster = Raster::from_rgba(w as u16, h as u16, rgba).ok()?;
                Some((picture_id(&u.login), Arc::new(raster)))
            })
            .collect();
        Ok(Self {
            look,
            large,
            measures,
            region: region(),
            order: glib::DateTime::from_local(2001, 2, 3, 0, 0, 0.)
                .ok()
                .and_then(|d| d.format("%x").ok())
                .map_or(Order::DayFirst, |s| clock::order_of(&s)),
            fonts: Arc::new(FontSet::discover_required()?),
            pictures,
        })
    }
}

/// The portal's appearance; without one (it may not be up yet), the first accent of the
/// palette with the shipped defaults, so the lock screen always comes up.
fn appearance(exports: &Exports) -> nk_platform::portal::Appearance {
    let read = || -> Result<_, String> {
        let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
        nk_platform::portal::Portal::watch(&bus)?.read()
    };
    read().unwrap_or_else(|e| {
        eprintln!("nidara-lock: no appearance portal ({e}); the default look");
        let accent = exports.colors["accents"]
            .as_object()
            .and_then(|a| a.values().next())
            .and_then(|h| h.as_str())
            .and_then(hex)
            .unwrap_or([0., 0., 0.]);
        nk_platform::portal::Appearance {
            accent,
            dark: true,
            reduce_transparency: false,
            window_background: "opaque".into(),
            reduced_motion: false,
            font: "Inter 11".into(),
            text_scale: 1.,
        }
    })
}

fn hex(s: &str) -> Option<[f64; 3]> {
    let s = s.strip_prefix('#')?;
    let c = |i: usize| {
        u8::from_str_radix(s.get(i..i + 2)?, 16)
            .ok()
            .map(|v| f64::from(v) / 255.)
    };
    Some([c(0)?, c(2)?, c(4)?])
}

/// How the clock reads (`org.nidara.region`), once: the lock screen lives minutes.
fn region() -> Region {
    let found = gio::SettingsSchemaSource::default()
        .and_then(|s| s.lookup("org.nidara.region", true))
        .filter(|s| s.has_key("date-format"));
    let Some(_) = found else {
        return Region::default();
    };
    use gio::prelude::SettingsExt;
    let s = gio::Settings::new("org.nidara.region");
    Region {
        twelve_hour: s.string("time-format") == "12h",
        seconds: s.boolean("show-seconds"),
        date: s.string("date-format").into(),
    }
}

/// Start `output`'s surface on a thread of its own; it tells the main thread its waker.
pub fn spawn(
    output: LockOutput,
    world: Arc<World>,
    kit: Arc<Kit>,
) -> Option<std::thread::JoinHandle<()>> {
    let id = output.id();
    let (waker, source) = match nk_wayland::wake_channel() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("nidara-lock: no waker for output {}: {e}", id.global());
            return None;
        }
    };
    std::thread::Builder::new()
        .name(format!("lock-{}", id.global()))
        .spawn(move || {
            let tx = world.tx.clone();
            let _ = tx.send(Msg::Surface(id, waker));
            let surface = match Surface::new(id, world, kit) {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Msg::Failed(format!("output {}: {e}", id.global())));
                    return;
                }
            };
            let options = Options {
                material: true,
                map: true,
                app_id: "nidara-lock",
                title: "",
                size: (0, 0),
                require_material: None,
            };
            if let Err(e) =
                nk_wayland::run_lock_surface(surface, options, output, Some(source), Instant::now())
            {
                let _ = tx.send(Msg::Failed(format!("output {}: {e}", id.global())));
            }
            let _ = tx.send(Msg::Gone(id));
        })
        .ok()
}

struct Surface {
    id: OutputId,
    world: Arc<World>,
    kit: Arc<Kit>,
    text: ParleyBackend,
    /// The interface glyphs and the people's pictures.
    glyphs: Option<nk::Glyphs>,
    state: ViewState,
    last: nk::Frame,
    size: (u32, u32),
    scale: f64,
    /// The shared state's revision this view was built from.
    seen: u64,
    active: bool,
    /// The field's key: a new one after each refusal, so the next attempt starts empty.
    field: Key,
    secret: Option<nk::Secret>,
    caps: bool,
    /// When the field's cursor next shows or hides (`ViewState::caret_deadline`).
    blink_at: Option<Instant>,
    /// The password is drawn as typed, from the eye inside the field.
    revealed: bool,
    clock: String,
    pointer_here: bool,
    /// The bar's open menu, on a layer of this surface: a lock surface has no popups.
    menu: Option<nk::LayerMenu>,
    /// The last input was a key, not the pointer: a menu opens with its row lit.
    keys: bool,
    /// A press outside the open menu closed it; its release goes nowhere.
    swallow: bool,
    a11y: Option<nk_a11y::bridge::Bridge>,
    a11y_revision: u64,
    a11y_stopped: bool,
    shape: Vec<(nk_a11y::NodeId, nk_a11y::Role, Vec<nk_a11y::Action>)>,
    ids: std::collections::HashMap<nk_a11y::NodeId, Key>,
    closing: bool,
}

impl Surface {
    fn new(id: OutputId, world: Arc<World>, kit: Arc<Kit>) -> Result<Self, String> {
        let text = ParleyBackend::new(kit.fonts.clone())?;
        let glyphs = nk_icons::Icons::new("", &[], &icon_reference())
            .map_err(|e| eprintln!("nidara-lock: no interface glyphs: {e}"))
            .ok()
            .map(|icons| {
                let mut g = nk::Glyphs::new(icons);
                g.set_pictures(kit.pictures.clone());
                g
            });
        let mut state = ViewState::new(1);
        state.set_reduced_motion(false);
        state.set_caret_blink(true);
        Ok(Self {
            id,
            world,
            kit,
            text,
            glyphs,
            state,
            last: nk::Frame::default(),
            size: (0, 0),
            scale: 1.,
            seen: u64::MAX,
            active: false,
            field: "lock/password/0".into(),
            secret: None,
            caps: false,
            blink_at: None,
            revealed: false,
            clock: String::new(),
            pointer_here: false,
            menu: None,
            keys: false,
            swallow: false,
            a11y: None,
            a11y_revision: 0,
            a11y_stopped: false,
            shape: Vec::new(),
            ids: Default::default(),
            closing: false,
        })
    }

    /// The date line and the time line, in the region's words.
    fn moment(&self) -> (String, String) {
        let Ok(now) = glib::DateTime::now_local() else {
            return (String::new(), String::new());
        };
        let f = |p: &str| now.format(p).map(|s| s.to_string()).unwrap_or_default();
        let r = &self.kit.region;
        let time = f(clock::time_pattern(r));
        let moment = clock::Moment {
            year: now.year(),
            month: now.month() as u32,
            day: now.day_of_month() as u32,
            time: String::new(),
            weekday_short: f("%a"),
            weekday_long: f("%A"),
            month_short: f("%b"),
            month_long: f("%B"),
        };
        // The long date over the clock, whatever the bar shows: here it is the label of a
        // clock, not a clock of its own.
        let long = Region {
            date: "long".into(),
            ..r.clone()
        };
        (
            clock::clock(&long, &moment, self.kit.order)
                .trim()
                .to_owned(),
            time,
        )
    }

    fn view(&self) -> Node {
        let m = &self.kit.measures;
        let types = &self.kit.look().types;
        let shared = self.world.shared.lock().unwrap();
        let (date, time) = self.moment();
        let strut = |k: &str, px: f64| -> Node { nk::Slot::new(k, px).into() };
        let mut children: Vec<Node> = vec![
            strut("lock/top", m.clock_top),
            nk::Label::new(
                "lock/date",
                date,
                types.style(Type::Title3, Weight::Semibold),
            )
            .into(),
            nk::Label::new("lock/clock", time, types.display()).into(),
        ];
        // D5: what is playing, under the clock of the screen that has the field, with its
        // three buttons. No cover, no card: the text and the glyphs on the veil.
        if let (true, Some(now)) = (self.active, shared.media.as_ref()) {
            children.push(strut("lock/media-gap", m.field_gap));
            children.push(media_view(now, types, m.field));
        }
        children.push(nk::Spacer::new("lock/above").into());
        if self.active {
            let user = shared.user();
            // L3: on the login screen, a person whose session is open says so, on the
            // picture and in words under the name.
            let open = shared.login && shared.open.contains(&user.login);
            children.push(
                nk::Avatar::new(AVATAR, m.avatar)
                    .picture(picture_id(&user.login))
                    .mark(open)
                    .into(),
            );
            children.push(strut("lock/name-gap", m.name_gap));
            children.push(
                nk::Label::new(
                    "lock/name",
                    user.name.clone(),
                    types.style(Type::Title3, Weight::Semibold),
                )
                .into(),
            );
            if open {
                children.push(
                    nk::Label::new(
                        "lock/open",
                        text("lock.session-open"),
                        types.style(Type::Body, Weight::Regular),
                    )
                    .ink(Ink::Secondary)
                    .into(),
                );
            }
            children.push(strut("lock/field-gap", m.field_gap));
            // D7: the one thing of glass here is the field, made of glass in its own shape
            // (`.glass()`), so its glass, its button's washes and its focus ring share one
            // outline.
            let entry: Node =
                nk::PasswordEntry::new(self.field.clone(), text("lock.password"), SECRET)
                    .enabled(!shared.checking)
                    .submit(
                        text(if shared.login {
                            "lock.log-in"
                        } else {
                            "lock.unlock"
                        }),
                        SUBMIT,
                    )
                    .peek(text("lock.show-password"), text("lock.hide-password"), PEEK)
                    .revealed(self.revealed)
                    .glass()
                    .into();
            children.push(entry.width(m.field));
            let body = types.style(Type::Body, Weight::Regular);
            // What the attempt said and the Caps Lock warning keep their room when empty, so
            // the avatar, the name and the field never move when one comes or goes.
            let mut centred = body.clone();
            centred.alignment = nk_text::Alignment::Center;
            let said = shared.lines.join("\n");
            let caps = if self.caps {
                text("lock.caps-lock")
            } else {
                String::new()
            };
            let mut said_label = nk::Label::new("lock/said", said.clone(), centred.clone())
                .lines(4)
                .reserve(2);
            if said.is_empty() {
                said_label = said_label.presentational();
            }
            let mut caps_label = nk::Label::new("lock/caps", caps.clone(), body.clone())
                .ink(Ink::Primary)
                .reserve(1);
            if caps.is_empty() {
                caps_label = caps_label.presentational();
            }
            children.push(strut("lock/said-gap", m.line_gap));
            children.push(
                nk::Column::new("lock/said-box", vec![said_label.into(), caps_label.into()])
                    .gap(Space::S1)
                    .align(Align::Center)
                    .width(m.field)
                    .into(),
            );
            // L1: the other people under the field, each their picture and name, a press away.
            if shared.login && shared.users.len() > 1 {
                children.push(strut("lock/others-gap", m.others_gap));
                children.push(others(&shared, types, m));
            }
            children.push(nk::Spacer::new("lock/below").into());
            if !shared.login {
                children.push(
                    nk::Button::new("lock/suspend", text("lock.suspend"), SUSPEND, body).into(),
                );
            }
        } else {
            children.push(nk::Spacer::new("lock/below").into());
        }
        children.push(strut("lock/bottom", m.power_bottom));
        let screen: Node = nk::Column::new("lock", children)
            .align(Align::Center)
            .width(f64::from(self.size.0))
            .height(f64::from(self.size.1))
            .into();
        // The login screen's bar (#1195): one capsule of glass at the top right, on the
        // screen that has the field.
        if shared.login && self.active {
            nk::Overlay::new("lock/screen", screen)
                .layer(
                    Align::End,
                    Align::Start,
                    Padding::all(Space::S4),
                    bar(&shared, types),
                )
                .into()
        } else {
            screen
        }
    }

    /// Rebuild from the shared state and lay out across the output.
    fn relayout(&mut self) {
        if self.size.0 == 0 {
            return;
        }
        let (revision, active, clear) = {
            let s = self.world.shared.lock().unwrap();
            (s.revision, s.active == Some(self.id), s.clear)
        };
        let became_active = active && !self.active;
        self.seen = revision;
        self.active = active;
        let field: Key = format!("lock/password/{clear}").into();
        let new_field = field != self.field;
        if new_field {
            self.field = field;
            self.secret = None;
        }
        self.clock = self.moment().1;
        let view = self.view();
        let rect = [0., 0., f64::from(self.size.0), f64::from(self.size.1)];
        let kit = self.kit.clone();
        self.state.layout_in(
            &view,
            rect,
            self.scale,
            kit.look().tokens.with_types(&kit.look().types),
            &mut self.text,
            Instant::now(),
        );
        // D2: the field has the keyboard as soon as it is shown, and again after a refusal.
        if active && (became_active || new_field) {
            let input: Key = format!("{}/input", self.field.0).into();
            self.state.request(&input, false);
            // Put there by the screen, not by the keyboard: no ring until Tab brings one.
            self.state.hide_ring();
        }
    }

    fn refresh(&mut self, w: &mut Window) {
        if self.closing {
            return;
        }
        let now = Instant::now();
        self.last = self.state.frame(&self.kit.look().tokens, now);
        self.blink_at = self.state.caret_deadline(now);
        w.set_text_input(self.state.text_input());
        if let Some(m) = &mut self.menu {
            let kit = self.kit.clone();
            if let Err(e) = m.paint(w, kit.look(), &mut self.text, self.glyphs.as_mut()) {
                eprintln!("nidara-lock: the menu was not painted: {e}");
            }
        }
        w.redraw();
    }

    fn route(&mut self, a: Activated) {
        match a.action.as_str() {
            SECRET => {
                if let Some(nk::Value::Secret(s)) = a.value {
                    self.secret = Some(s);
                    let _ = self.world.tx.send(Msg::Typed);
                }
            }
            SUBMIT => self.submit(),
            PEEK => {
                self.revealed = !self.revealed;
                self.relayout();
                // The eye is GTK's peek icon: pressing it leaves the typing in the field.
                let input: Key = format!("{}/input", self.field.0).into();
                let ring = self.state.ring_shown();
                self.state.request(&input, false);
                if !ring {
                    self.state.hide_ring();
                }
            }
            PREVIOUS => {
                let _ = self.world.tx.send(Msg::Press("SelectedPrevious"));
            }
            PLAY_PAUSE => {
                let _ = self.world.tx.send(Msg::Press("SelectedPlayPause"));
            }
            NEXT => {
                let _ = self.world.tx.send(Msg::Press("SelectedNext"));
            }
            SUSPEND => {
                let _ = self.world.tx.send(Msg::Power(Power::Suspend));
            }
            POWER => {
                if let Some(nk::Value::Index(n)) = a.value
                    && let Some(&what) = Power::MENU.get(n)
                {
                    let _ = self.world.tx.send(Msg::Power(what));
                }
            }
            LANGUAGE => {
                if let Some(nk::Value::Index(n)) = a.value {
                    let _ = self.world.tx.send(Msg::Language(n));
                }
            }
            LAYOUT => {
                if let Some(nk::Value::Index(n)) = a.value {
                    let _ = self.world.tx.send(Msg::Layout(n));
                }
            }
            WIFI => {
                if let Some(nk::Value::Index(n)) = a.value {
                    let _ = self.world.tx.send(Msg::Join(n));
                }
            }
            ACCESS => {
                if let Some(nk::Value::Index(n)) = a.value {
                    let _ = self.world.tx.send(Msg::Access(n));
                }
            }
            CHOOSE => {
                if let Some(nk::Value::Text(login)) = a.value {
                    let _ = self.world.tx.send(Msg::Choose(login));
                }
            }
            _ => {}
        }
    }

    /// What the kit asked of this surface: a menu button's list, opened on a layer (a lock
    /// surface has no popups); the same button again closes it.
    fn host(&mut self, w: &mut Window) {
        for request in self.state.take_host_requests() {
            match request {
                HostRequest::OpenList { owner, list } => {
                    let again = self.menu.as_ref().is_some_and(|m| m.owner() == &owner);
                    self.close_menu(w);
                    if again {
                        continue;
                    }
                    let kit = self.kit.clone();
                    let surface = (f64::from(self.size.0), f64::from(self.size.1));
                    match nk::LayerMenu::open(
                        w,
                        &mut self.state,
                        owner,
                        &list,
                        self.keys,
                        surface,
                        self.scale,
                        kit.look(),
                        &mut self.text,
                    ) {
                        Ok(menu) => self.menu = menu,
                        Err(e) => eprintln!("nidara-lock: the menu did not open: {e}"),
                    }
                }
                HostRequest::Respond { owner, request } => {
                    if let Some(a) = self.state.respond(&owner, request) {
                        self.route(a);
                    }
                }
                _ => {}
            }
        }
    }

    /// Closes the open menu. Worked from the keyboard, the focus stays on its button, ring
    /// and all; worked with the pointer, the keyboard goes back to the field (D2), so what is
    /// typed next is the password and not a key on the button.
    fn close_menu(&mut self, w: &mut Window) {
        if let Some(m) = self.menu.take() {
            m.close(w, &mut self.state, self.keys);
            if !self.keys {
                let input: Key = format!("{}/input", self.field.0).into();
                self.state.request(&input, false);
                self.state.hide_ring();
            }
        }
    }

    /// Row `n` of the open menu chosen: its owner hears it, and the menu closes.
    fn choose(&mut self, n: usize, w: &mut Window) {
        let Some(owner) = self.menu.as_ref().map(|m| m.owner().clone()) else {
            return;
        };
        let a = nk::choose_from_list(&mut self.state, &owner, n);
        self.close_menu(w);
        if let Some(a) = a {
            self.route(a);
        }
    }

    /// A key while a menu is open is the menu's.
    fn menu_key(&mut self, sym: u32, w: &mut Window) {
        let Some(m) = &mut self.menu else {
            return;
        };
        match m.key(sym) {
            MenuKey::Ignored | MenuKey::Moved => {}
            MenuKey::Choose(n) => self.choose(n, w),
            MenuKey::Close => self.close_menu(w),
            MenuKey::Tab(back) => {
                self.close_menu(w);
                let key = if back {
                    nk::KeyInput::ShiftTab
                } else {
                    nk::KeyInput::Tab
                };
                if let Some(a) = self.state.key(key) {
                    self.route(a);
                }
            }
        }
    }

    /// An empty field is an attempt too: an account without a password (`nullok` in
    /// system-auth) unlocks with Enter alone, and PAM says no to one that has a password.
    fn submit(&mut self) {
        let s = self.secret.clone().unwrap_or_default();
        let _ = self.world.tx.send(Msg::Submit(s));
    }

    fn publish_semantics(&mut self) {
        let mut root = nk_a11y::Node::new(ROOT, nk_a11y::Role::Window, text("lock.title"));
        root.states.active = self.active;
        let tree = self.state.semantics(root, ROOT + 1);
        self.ids = self.state.semantic_keys();
        let shape: Vec<_> = tree
            .nodes
            .values()
            .map(|n| (n.id, n.role, n.actions.clone()))
            .collect();
        if shape != self.shape || self.a11y_revision == 0 {
            self.shape = shape;
            self.a11y_revision += 1;
        }
        if self.a11y_stopped {
            return;
        }
        match &self.a11y {
            Some(bridge) => {
                while bridge.published.try_recv().is_ok() {}
                if let Err(e) = bridge.update(self.a11y_revision, tree) {
                    // Said once; without a reader's bus the bridge stays stopped.
                    eprintln!("nidara-lock: accessibility stopped: {e}");
                    self.a11y_stopped = true;
                }
            }
            None => self.a11y = Some(nk_a11y::bridge::Bridge::new(self.a11y_revision, tree)),
        }
    }

    /// A screen reader's requests; ones made against an older tree are dropped.
    fn a11y(&mut self) {
        let Some(bridge) = &self.a11y else {
            return;
        };
        let requests: Vec<_> = bridge.requests.try_iter().collect();
        for (revision, request) in requests {
            if revision != self.a11y_revision {
                continue;
            }
            let key = |id| self.ids.get(&id).cloned();
            let activated = match request {
                nk_a11y::Request::SetText(id, text) => key(id).and_then(|k| {
                    self.state
                        .respond(&k, nk::components::Request::SetText(text))
                }),
                nk_a11y::Request::Activate(id) => {
                    key(id).and_then(|k| self.state.request(&k, true))
                }
                nk_a11y::Request::Focus(id) => key(id).and_then(|k| self.state.request(&k, false)),
                _ => None,
            };
            if let Some(a) = activated {
                self.route(a);
            }
        }
    }
}

impl Application for Surface {
    fn poll_interval_ms(&self) -> u32 {
        if self.state.animating() || self.menu.as_ref().is_some_and(|m| m.animating()) {
            return 16;
        }
        // The cursor blinks on time; the clock's own wake can be a minute away.
        let blink = self.blink_at.map(|at| {
            at.saturating_duration_since(Instant::now())
                .as_millis()
                .clamp(1, 60_000) as u32
        });
        // Wake at the next second or minute so the clock turns on time.
        let now = glib::DateTime::now_local().ok();
        let ms_into = now.map_or(0, |n| {
            let s = if self.kit.region.seconds {
                0
            } else {
                n.second() as u32 * 1000
            };
            s + (n.microsecond() as u32 / 1000)
        });
        let period = if self.kit.region.seconds {
            1000
        } else {
            60_000
        };
        let clock = (period - ms_into % period).clamp(16, period);
        blink.map_or(clock, |b| b.min(clock))
    }

    fn idle(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if self.closing {
            return Ok(());
        }
        if self.state.animating() {
            let kit = self.kit.clone();
            let t = self.state.tick(
                kit.look().tokens.with_types(&kit.look().types),
                &mut self.text,
                Instant::now(),
            );
            for a in t.activated {
                self.route(a);
            }
            self.refresh(w);
        } else if self.menu.as_ref().is_some_and(|m| m.animating()) {
            self.refresh(w);
        }
        if self.blink_at.is_some_and(|at| Instant::now() >= at) {
            self.refresh(w);
        }
        if self.size.0 > 0 && self.moment().1 != self.clock {
            self.relayout();
            self.refresh(w);
            self.publish_semantics();
        }
        Ok(())
    }

    fn event(&mut self, event: Event, w: &mut Window) -> nk_wayland::Result<()> {
        if self.closing {
            return Ok(());
        }
        let quiet = matches!(
            event,
            Event::Motion(..) | Event::PointerLeave | Event::FrameDone
        );
        match event {
            Event::Configure => {
                self.size = w.size();
                self.scale = w.scale();
                self.caps = w.caps_lock();
                self.relayout();
                self.refresh(w);
            }
            Event::Wake => {
                if self.world.shared.lock().unwrap().done {
                    self.closing = true;
                    w.close();
                    return Ok(());
                }
                self.a11y();
                if self.world.shared.lock().unwrap().revision != self.seen {
                    self.relayout();
                }
                self.refresh(w);
            }
            Event::FrameDone => {
                if self.state.animating() {
                    let kit = self.kit.clone();
                    let t = self.state.tick(
                        kit.look().tokens.with_types(&kit.look().types),
                        &mut self.text,
                        Instant::now(),
                    );
                    for a in t.activated {
                        self.route(a);
                    }
                    self.refresh(w);
                }
            }
            Event::Motion(x, y) => {
                if !self.pointer_here {
                    self.pointer_here = true;
                    // D6: the field follows the pointer to this output.
                    let _ = self.world.tx.send(Msg::Pointer(self.id));
                }
                if self.state.pointer_motion(x, y) {
                    self.refresh(w);
                }
            }
            Event::PointerLeave => {
                self.pointer_here = false;
                if self.state.pointer_leave() {
                    self.refresh(w);
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed,
                ..
            } => {
                self.keys = false;
                // A press outside the open menu closes it and presses nothing (a popup's
                // grab); the menu button pressed again closes it the same way.
                if pressed && self.menu.is_some() {
                    self.close_menu(w);
                    self.swallow = true;
                } else if !pressed && std::mem::take(&mut self.swallow) {
                } else {
                    if let Some(a) = self.state.button(pressed, Instant::now()) {
                        self.route(a);
                    }
                    self.host(w);
                }
                self.refresh(w);
            }
            Event::Layer { id, event } => {
                if self.menu.as_ref().is_some_and(|m| m.layer() == id) {
                    if matches!(event, nk_wayland::LayerEvent::Button { .. }) {
                        self.keys = false;
                    }
                    let chosen = self.menu.as_mut().and_then(|m| m.event(event));
                    if let Some(n) = chosen {
                        self.choose(n, w);
                    }
                    self.refresh(w);
                }
            }
            Event::Key(k) if self.menu.is_some() => {
                self.keys = true;
                self.menu_key(k.sym, w);
                self.refresh(w);
            }
            Event::Key(k) => {
                self.keys = true;
                let input: Key = format!("{}/input", self.field.0).into();
                if k.serial.is_some()
                    && matches!(k.sym, ENTER | KP_ENTER)
                    && !k.ctrl
                    && !k.alt
                    && self.state.focus() == Some(&input)
                {
                    // Enter is the host's for a single-line field, as a dialog's default
                    // response is (dialog.rs): here it unlocks. It is taken before the kit
                    // sees it, which would read it as activating the field and drop it.
                    self.submit();
                } else if let (_, Some(a)) = self.state.key_event(&k) {
                    self.route(a);
                }
                self.host(w);
                // What a key changed (the field's dots) is laid out anew,
                // as the kit's window host does after every key it handles.
                self.relayout();
                self.refresh(w);
            }
            Event::Ime(batch) => {
                if let Some(a) = self.state.ime(&batch) {
                    self.route(a);
                }
                self.relayout();
                self.refresh(w);
            }
            Event::Modifiers | Event::Focus(_) => {
                let caps = w.caps_lock();
                if caps != self.caps {
                    self.caps = caps;
                    self.relayout();
                    self.refresh(w);
                }
            }
            Event::Closed => self.closing = true,
            _ => {}
        }
        if !quiet && !self.closing {
            self.publish_semantics();
        }
        Ok(())
    }

    fn paint(&mut self, f: nk_wayland::Frame) -> nk_wayland::Result<Vec<u8>> {
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        if self.closing {
            return Ok(c.finish());
        }
        let kit = self.kit.clone();
        let look = kit.look().tokens.with_types(&kit.look().types);
        // Without the compositor's glass (another compositor), the kit paints the field's
        // own surface from the same frame (D5).
        let fallback = (!f.material).then_some(&self.last);
        match &mut self.glyphs {
            Some(glyphs) => self
                .state
                .paint_with_glyphs(&mut c, look, glyphs, fallback, false)?,
            None => self.state.paint(&mut c, look, &mut |_, _| None, fallback)?,
        }
        Ok(c.finish())
    }

    fn material(&self) -> Option<Material> {
        if self.closing || self.size.0 == 0 {
            return None;
        }
        self.kit.look().glass(&self.last)
    }
}

/// The login screen's bar (#1195): the language it speaks, when there is a choice (L4); the
/// battery, on a machine that has one; and power. One capsule, each a menu button of the kit,
/// their menus on a layer of the surface.
fn bar(shared: &crate::Shared, types: &nk::TypeScale) -> Node {
    let mut items: Vec<Node> = Vec::new();
    if shared.languages.len() > 1 {
        items.push(
            nk::MenuButton::new(
                "lock/bar/language",
                text("lock.language"),
                LANGUAGE,
                "nd-globe",
                shared.languages.iter().map(|l| l.name.clone()).collect(),
            )
            .ticked(shared.language)
            .into(),
        );
    }
    if shared.layouts.len() > 1 {
        items.push(
            nk::MenuButton::new(
                "lock/bar/keyboard",
                text("lock.keyboard"),
                LAYOUT,
                "nd-input-keyboard",
                shared.layouts.clone(),
            )
            .ticked(Some(shared.layout))
            .into(),
        );
    }
    if let Some(w) = &shared.wifi {
        // Only the networks saved for everyone: a new one is added in Settings (wifi.rs).
        let names: Vec<String> = if w.networks.is_empty() {
            vec![text("lock.wifi-none")]
        } else {
            w.networks.iter().map(|n| n.ssid.clone()).collect()
        };
        items.push(
            nk::MenuButton::new("lock/bar/wifi", text("lock.wifi"), WIFI, w.glyph, names)
                .ticked(w.active)
                .into(),
        );
    }
    if !shared.access.is_empty() {
        let on = |row: crate::access::Access| match row {
            crate::access::Access::LargeText => shared.large_text,
            crate::access::Access::ScreenReader => shared.screen_reader,
        };
        items.push(
            nk::MenuButton::new(
                "lock/bar/access",
                text("lock.accessibility"),
                ACCESS,
                "nd-preferences-desktop-accessibility",
                shared.access.iter().map(|r| text(r.key())).collect(),
            )
            .checks(
                (0..shared.access.len())
                    .filter(|&n| on(shared.access[n]))
                    .collect(),
            )
            .into(),
        );
    }
    if let Some(b) = shared.battery {
        let percent = format!("{}%", b.percent.round() as u32);
        items.push(
            nk::Row::new(
                "lock/bar/battery",
                vec![
                    nk::Image::new("lock/bar/battery/glyph", "nd-battery", 16.).into(),
                    nk::Label::new(
                        "lock/bar/battery/level",
                        percent,
                        types.style(Type::Small, Weight::Medium),
                    )
                    .into(),
                ],
            )
            .gap(Space::S1)
            .align(Align::Center)
            .padding(Padding::symmetric(Space::S1, Space::S2))
            .into(),
        );
    }
    items.push(
        nk::MenuButton::new(
            "lock/bar/power",
            text("lock.power"),
            POWER,
            "nd-system-shutdown",
            Power::MENU.iter().map(|p| text(p.key())).collect(),
        )
        .into(),
    );
    nk::Pane::new(
        "lock/bar",
        Corner::Pill,
        nk::Row::new("lock/bar/row", items)
            .gap(Space::S1)
            .align(Align::Center)
            .padding(Padding::all(Space::S1)),
    )
    .into()
}

/// The login screen's other people (L1): one button each, its picture over its name, in the
/// order of their accounts. Its name to a reader is the person's, and that their session is
/// open, when it is.
fn others(shared: &crate::Shared, types: &nk::TypeScale, m: &Measures) -> Node {
    let buttons = shared
        .users
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != shared.chosen)
        .map(|(_, u)| {
            let key = format!("lock/others/{}", u.login);
            let open = shared.open.contains(&u.login);
            let face = nk::Column::new(
                format!("{key}/face"),
                vec![
                    nk::Avatar::new(format!("{key}/avatar"), m.others)
                        .picture(picture_id(&u.login))
                        .mark(open)
                        .into(),
                    nk::Label::new(
                        format!("{key}/name"),
                        u.name.clone(),
                        types.style(Type::Small, Weight::Regular),
                    )
                    .lines(1)
                    .into(),
                ],
            )
            .gap(Space::S2)
            .align(Align::Center)
            .padding(nk::Padding::all(Space::S2))
            // As wide again as the text is large, so a name fits as it did.
            .width(
                m.others_width
                    * if shared.large_text {
                        crate::access::LARGE_TEXT
                    } else {
                        1.
                    },
            );
            let mut button = nk::Button::with_child(key, u.name.clone(), CHOOSE, face)
                .value(nk::Value::Text(u.login.clone()));
            if open {
                button = button.description(text("lock.session-open"));
            }
            button.into()
        })
        .collect();
    nk::Row::new("lock/others", buttons)
        .gap(Space::S3)
        .align(Align::Start)
        .into()
}

/// What is playing: the title, the artist, and previous / play or pause / next as the kit's
/// icon buttons (the gallery's "Icon only"), each named for readers.
fn media_view(now: &crate::media::Now, types: &nk::TypeScale, width: f64) -> Node {
    let line = |key: &str, text: &str, weight: Weight| -> Node {
        nk::Label::new(key, text.to_owned(), types.style(Type::Body, weight))
            .ink(Ink::Primary)
            .lines(1)
            .into()
    };
    let button = |key: &str, name: &str, action: &str, glyph: &str, on: bool| -> Node {
        nk::Button::with_child(
            key,
            text(name),
            action,
            nk::Row::new(
                format!("{key}/row"),
                vec![nk::Image::new(format!("{key}/glyph"), glyph, 16.).into()],
            )
            .padding(nk::Padding::all(Space::S2)),
        )
        .enabled(on)
        .into()
    };
    let play = if now.playing {
        "nd-media-playback-pause"
    } else {
        "nd-media-playback-start"
    };
    let mut lines = vec![line("lock/media/title", &now.title, Weight::Semibold)];
    if !now.artist.is_empty() {
        lines.push(line("lock/media/artist", &now.artist, Weight::Regular));
    }
    let controls = nk::Row::new(
        "lock/media/controls",
        vec![
            button(
                "lock/media/previous",
                "lock.media.previous",
                PREVIOUS,
                "nd-media-skip-backward",
                now.can_control && now.can_previous,
            ),
            button(
                "lock/media/play",
                "lock.media.play-pause",
                PLAY_PAUSE,
                play,
                now.can_control,
            ),
            button(
                "lock/media/next",
                "lock.media.next",
                NEXT,
                "nd-media-skip-forward",
                now.can_control && now.can_next,
            ),
        ],
    )
    .gap(Space::S3)
    .align(Align::Center);
    lines.push(controls.into());
    nk::Column::new("lock/media", lines)
        .gap(Space::S1)
        .align(Align::Center)
        .width(width)
        .into()
}

/// The interface glyphs' reference set (the shell's `paths::icon_reference`).
fn icon_reference() -> std::path::PathBuf {
    std::env::var_os("NK_ICON_REFERENCE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let installed =
                std::path::PathBuf::from("/usr/share/nidara/ui/shell/assets/icons/nidara");
            if installed.is_dir() {
                installed
            } else {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../ui/shell/assets/icons/nidara")
            }
        })
}
