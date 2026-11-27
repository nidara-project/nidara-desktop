// SPDX-License-Identifier: LGPL-3.0-or-later
//! One output's lock surface, on its own thread and event queue (`nk_wayland::run_lock_surface`).
//!
//! What it shows (#1195): the date and the clock on every output; on the one the pointer is
//! on (D6), under them, the avatar, the real name and the password field with its button
//! inside (`nk::PasswordEntry::submit`), what the last attempt said, the Caps Lock warning,
//! and Suspend at the bottom (D3). There is no card and no glass but the field's (D7): the
//! text sits straight on the veil Hyalo draws over the wallpaper, in the shell's white ink.
//!
//! Layout, hover, focus, Tab, the field's editing and input methods and the reader are the
//! kit's (`nk::ViewState`); this says what the view is and acts on what is activated.
use crate::{Msg, World};
use nk::{
    Activated, Align, Corner, Ink, Key, Node, Padding, Space, Type, ViewState, Weight, Widget,
    WindowLook,
};
use nk_platform::clock::{self, Order, Region};
use nk_platform::exports::Exports;
use nk_render::{Canvas, ImageFit, Raster};
use nk_text::{FontSet, ParleyBackend, Rect};
use nk_wayland::{Application, Event, LockOutput, Material, Options, OutputId, Window};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

/// The view's keys and actions.
const SECRET: &str = "secret";
const SUBMIT: &str = "submit";
const SUSPEND: &str = "suspend";
const AVATAR: &str = "lock/avatar";
const FIELD_PANE: &str = "lock/field";
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
        })
    }
}

static EXPORTS: OnceLock<Exports> = OnceLock::new();

/// A string of the session's language (LANG, as the shell starts with); the key itself when
/// there is no catalogue, so the screen still says something.
pub fn text(key: &str) -> String {
    EXPORTS
        .get()
        .and_then(|e| e.text(key).ok())
        .map_or_else(|| key.to_owned(), str::to_owned)
}

/// What every surface paints with, loaded once.
pub struct Kit {
    pub look: WindowLook,
    pub measures: Measures,
    pub region: Region,
    pub order: Order,
    pub fonts: Arc<FontSet>,
    /// The user's picture, read once and shared.
    pub picture: Option<Arc<Raster>>,
}

impl Kit {
    pub fn load(user: &crate::user::User) -> Result<Self, String> {
        let exports = Exports::load(&Exports::root())?;
        let appearance = appearance(&exports);
        // The shell's skin: always dark, white ink (owner's decision), over Hyalo's veil.
        let skin = nk_platform::portal::Appearance {
            dark: true,
            ..appearance
        };
        let look = WindowLook::load(&exports, &skin)?;
        let _ = EXPORTS.set(exports);
        let measures = Measures::load()?;
        let side = (measures.avatar * 2.).round() as u32;
        let picture = user.picture.as_ref().and_then(|p| {
            let (w, h, rgba) = nk_icons::read_app_icon(p, side)?;
            Raster::from_rgba(w as u16, h as u16, rgba)
                .ok()
                .map(Arc::new)
        });
        Ok(Self {
            look,
            measures,
            region: region(),
            order: glib::DateTime::from_local(2001, 2, 3, 0, 0, 0.)
                .ok()
                .and_then(|d| d.format("%x").ok())
                .map_or(Order::DayFirst, |s| clock::order_of(&s)),
            fonts: Arc::new(FontSet::discover_required()?),
            picture,
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
    icons: Option<nk_icons::Icons>,
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
    clock: String,
    pointer_here: bool,
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
        let icons = nk_icons::Icons::new("", &[], &icon_reference())
            .map_err(|e| eprintln!("nidara-lock: no interface glyphs: {e}"))
            .ok();
        let mut state = ViewState::new(1);
        state.set_reduced_motion(false);
        Ok(Self {
            id,
            world,
            kit,
            text,
            icons,
            state,
            last: nk::Frame::default(),
            size: (0, 0),
            scale: 1.,
            seen: u64::MAX,
            active: false,
            field: "lock/password/0".into(),
            secret: None,
            caps: false,
            clock: String::new(),
            pointer_here: false,
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
        let types = &self.kit.look.types;
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
            nk::Spacer::new("lock/above").into(),
        ];
        if self.active {
            let avatar: Node = if self.kit.picture.is_some() {
                nk::Slot::new(AVATAR, m.avatar).into()
            } else {
                nk::Image::new(AVATAR, "nd-avatar-default-symbolic", m.avatar).into()
            };
            children.push(avatar.presentational());
            children.push(strut("lock/name-gap", m.name_gap));
            children.push(
                nk::Label::new(
                    "lock/name",
                    shared.user.name.clone(),
                    types.style(Type::Title3, Weight::Semibold),
                )
                .into(),
            );
            children.push(strut("lock/field-gap", m.field_gap));
            let entry: Node =
                nk::PasswordEntry::new(self.field.clone(), text("lock.password"), SECRET)
                    .enabled(!shared.checking)
                    .submit(text("lock.unlock"), SUBMIT)
                    .into();
            children.push(
                nk::Pane::new(
                    FIELD_PANE,
                    Corner::Pill,
                    nk::Row::new("lock/field/row", vec![entry.grow()])
                        .align(Align::Center)
                        .padding(Padding::symmetric(Space::S1, Space::S3)),
                )
                .width(m.field)
                .into(),
            );
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
            children.push(nk::Spacer::new("lock/below").into());
            children
                .push(nk::Button::new("lock/suspend", text("lock.suspend"), SUSPEND, body).into());
        } else {
            children.push(nk::Spacer::new("lock/below").into());
        }
        children.push(strut("lock/bottom", m.power_bottom));
        nk::Column::new("lock", children)
            .align(Align::Center)
            .width(f64::from(self.size.0))
            .height(f64::from(self.size.1))
            .into()
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
            kit.look.tokens.with_types(&kit.look.types),
            &mut self.text,
            Instant::now(),
        );
        // D2: the field has the keyboard as soon as it is shown, and again after a refusal.
        if active && (became_active || new_field) {
            let input: Key = format!("{}/input", self.field.0).into();
            self.state.request(&input, false);
        }
    }

    fn refresh(&mut self, w: &mut Window) {
        if self.closing {
            return;
        }
        self.last = self.state.frame(&self.kit.look.tokens, Instant::now());
        w.set_text_input(self.state.text_input());
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
            SUSPEND => {
                let _ = self.world.tx.send(Msg::Suspend);
            }
            _ => {}
        }
    }

    fn submit(&mut self) {
        if let Some(s) = self.secret.clone() {
            let _ = self.world.tx.send(Msg::Submit(s));
        }
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
        if self.state.animating() {
            return 16;
        }
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
        (period - ms_into % period).clamp(16, period)
    }

    fn idle(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if self.closing {
            return Ok(());
        }
        if self.state.animating() {
            let kit = self.kit.clone();
            let t = self.state.tick(
                kit.look.tokens.with_types(&kit.look.types),
                &mut self.text,
                Instant::now(),
            );
            for a in t.activated {
                self.route(a);
            }
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
                        kit.look.tokens.with_types(&kit.look.types),
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
                if let Some(a) = self.state.button(pressed, Instant::now()) {
                    self.route(a);
                }
                self.refresh(w);
            }
            Event::Key(k) => {
                let (handled, activated) = self.state.key_event(&k);
                if let Some(a) = activated {
                    self.route(a);
                } else if !handled && k.serial.is_some() && matches!(k.sym, ENTER | KP_ENTER) {
                    // Enter is the host's for a single-line field: here it unlocks.
                    self.submit();
                }
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
        let look = kit.look.tokens.with_types(&kit.look.types);
        // Without the compositor's glass (another compositor), the kit paints the field's
        // own surface from the same frame (D5).
        let fallback = (!f.material).then_some(&self.last);
        let icons = &mut self.icons;
        self.state
            .paint(&mut c, look, &mut |n, size| glyph(icons, n, size), fallback)?;
        // The user's picture, cut to a circle, in its slot.
        if let Some(picture) = &kit.picture
            && let Some(p) = self.state.placed().iter().find(|p| p.key.0 == AVATAR)
        {
            let r = Rect {
                x: p.rect[0] as f32,
                y: p.rect[1] as f32,
                width: p.rect[2] as f32,
                height: p.rect[3] as f32,
            };
            c.clip_rounded_rect(r, p.rect[2].min(p.rect[3]) / 2.);
            c.image(picture, r, ImageFit::Cover);
            c.pop_clip();
        }
        Ok(c.finish())
    }

    fn material(&self) -> Option<Material> {
        if self.closing || self.size.0 == 0 {
            return None;
        }
        self.kit.look.glass(&self.last)
    }
}

/// A themed glyph for the kit, by name and logical size.
fn glyph(
    icons: &mut Option<nk_icons::Icons>,
    name: &str,
    size: f64,
) -> Option<Arc<nk_icons::Icon>> {
    if name.is_empty() {
        return None;
    }
    icons.as_mut()?.get(name, size.round() as u32).ok()
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
