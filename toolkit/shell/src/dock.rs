// SPDX-License-Identifier: LGPL-3.0-or-later
//! One output's dock (DOCK.md §2): a layer root on that output's own connection. It reads
//! the hub's latest frame on `Event::Wake`, lays out, paints icons/dots/separators (the
//! glass is Hyalo's), and sends what a click asks for back to the hub. It never calls a
//! service from its own loop.
use crate::actions::{Action, primary};
use crate::geometry::{CAPSULE_EXPONENT, DOT, Layout, Position, Slot, layout};
use crate::hub::{Frame, Request};
use crate::model::{Item, Kind, View};
use nk_render::{Canvas, ImageFit, rgba};
use nk_text::Rect;
use nk_wayland::{
    Application, Edges, Event, KeyboardMode, LayerLevel, LayerOutput, LayerPlacement, LayerSpec,
    Material, Options, Pane, TokenRequest, WakeSource, Waker, Window,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::time::Instant;

pub const NAMESPACE: &str = "nidara-dock";
const LEFT_BUTTON: u32 = 0x110;

pub struct Dock {
    frames: Receiver<Arc<Frame>>,
    hub: Sender<Request>,
    output_name: String,
    /// The output's logical size, as the supervisor last saw it.
    output_size: (u32, u32),
    frame: Arc<Frame>,
    layout: Layout,
    pointer: (f64, f64),
    pressed: Option<usize>,
    /// Token requests in flight, and what each will start once it has its token.
    pending: HashMap<TokenRequest, Request>,
    trash_icon: Option<Arc<nk_icons::Icon>>,
    published: BTreeMap<u64, [f64; 4]>,
    /// The last keyboard-focus request taken, and the item holding the focus while the dock
    /// has the keyboard (by key: items move between frames).
    keyboard_seen: u64,
    focus: Option<String>,
    /// The focused window when the dock took the keyboard: once another window is focused
    /// (a click on it), the dock lets go, since an exclusive layer keeps the keys otherwise.
    focus_window: Option<u64>,
    /// The screen reader's view (DOCK.md §7), published after every change it can see.
    a11y: Option<nk_a11y::bridge::Bridge>,
    a11y_requests: Option<Receiver<(u64, nk_a11y::Request)>>,
    ids: crate::semantics::Ids,
    revision: u64,
    waker: Waker,
}

fn slots(view: &View) -> Vec<Slot> {
    view.items
        .iter()
        .map(|i| {
            if i.kind == Kind::Separator {
                Slot::Separator
            } else {
                Slot::Icon
            }
        })
        .collect()
}

/// The keyboard is the dock's only while it holds the roving focus (Shell1 `focus:dock`);
/// a click never takes it from the app.
pub fn placement(l: &Layout, keyboard: bool) -> LayerPlacement {
    let gap = crate::geometry::SCREEN_GAP as i32;
    let (anchor, margin) = match l.position {
        Position::Bottom => (Edges::BOTTOM, [0, 0, gap, 0]),
        Position::Left => (Edges::LEFT, [0, 0, 0, gap]),
        Position::Right => (Edges::RIGHT, [0, gap, 0, 0]),
    };
    LayerPlacement {
        anchor,
        size: l.size,
        exclusive_zone: l.exclusive_zone,
        margin,
        keyboard: if keyboard {
            KeyboardMode::Exclusive
        } else {
            KeyboardMode::None
        },
    }
}

impl Dock {
    pub fn new(
        frames: Receiver<Arc<Frame>>,
        hub: Sender<Request>,
        output_name: String,
        output_size: (u32, u32),
        frame: Arc<Frame>,
        trash_icon: Option<Arc<nk_icons::Icon>>,
        waker: Waker,
    ) -> Self {
        let layout = Self::lay(&frame, output_size);
        Self {
            frames,
            hub,
            output_name,
            output_size,
            frame,
            layout,
            pointer: (0., 0.),
            pressed: None,
            pending: HashMap::new(),
            trash_icon,
            published: BTreeMap::new(),
            keyboard_seen: 0,
            focus: None,
            focus_window: None,
            a11y: None,
            a11y_requests: None,
            ids: Default::default(),
            revision: 0,
            waker,
        }
    }

    fn lay(frame: &Frame, output: (u32, u32)) -> Layout {
        let reserved = if frame.prefs.position.horizontal() {
            0.
        } else {
            frame.reserved_top
        };
        layout(
            &slots(&frame.view),
            frame.prefs.icon_size,
            frame.prefs.position,
            output,
            reserved,
        )
    }

    /// The latest frame wins; a closed channel ends the dock.
    fn drain(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        let mut latest = None;
        loop {
            match self.frames.try_recv() {
                Ok(f) => latest = Some(f),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    w.close();
                    return Ok(());
                }
            }
        }
        let Some(frame) = latest else { return Ok(()) };
        if let Some(size) = frame.output_sizes.get(&self.output_name) {
            self.output_size = *size;
        }
        let had_keyboard = self.focus.is_some();
        if frame.keyboard > self.keyboard_seen {
            self.keyboard_seen = frame.keyboard;
            self.focus_window = frame.focused;
            self.focus =
                crate::keys::first(&frame.view.items).map(|n| frame.view.items[n].key.clone());
            eprintln!(
                "nidara-shell: the dock on {} takes the keyboard",
                self.output_name
            );
        }
        self.frame = frame;
        if self.focus.is_some()
            && (self.frame.hidden
                || self.focused_slot().is_none()
                || self.frame.focused != self.focus_window)
        {
            eprintln!(
                "nidara-shell: the dock on {} lets the keyboard go",
                self.output_name
            );
            self.focus = None;
        }
        let next = Self::lay(&self.frame, self.output_size);
        let keyboard = self.focus.is_some();
        if placement(&next, keyboard) != placement(&self.layout, had_keyboard) {
            w.set_layer_placement(placement(&next, keyboard))?;
        }
        self.layout = next;
        self.apply(w)
    }

    fn focused_slot(&self) -> Option<usize> {
        let key = self.focus.as_ref()?;
        self.frame.view.items.iter().position(|i| &i.key == key)
    }

    fn leave_keyboard(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if self.focus.take().is_some() {
            eprintln!(
                "nidara-shell: the dock on {} lets the keyboard go",
                self.output_name
            );
            w.set_layer_placement(placement(&self.layout, false))?;
            w.redraw();
            self.publish_semantics();
        }
        Ok(())
    }

    fn key(&mut self, key: nk_wayland::Key, w: &mut Window) -> nk_wayland::Result<()> {
        let Some(slot) = self.focused_slot() else {
            return Ok(());
        };
        let Some(nav) = crate::keys::nav(key.sym, key.shift, self.layout.position.horizontal())
        else {
            return Ok(());
        };
        match nav {
            crate::keys::Nav::Leave => self.leave_keyboard(w)?,
            crate::keys::Nav::Act => {
                // A repeat has no serial, so no token: only a real press acts.
                if let Some(serial) = key.serial {
                    self.click(slot, Some(serial), w);
                    self.leave_keyboard(w)?;
                }
            }
            nav => {
                if let Some(to) = crate::keys::moved(&self.frame.view.items, slot, nav) {
                    self.focus = Some(self.frame.view.items[to].key.clone());
                    w.redraw();
                    self.publish_semantics();
                }
            }
        }
        Ok(())
    }

    /// Input region, targets and a repaint for the current layout, once the surface has
    /// the size the layout asked for (a new size arrives with the configure).
    fn apply(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if w.size() != self.layout.size {
            return Ok(());
        }
        let (width, height) = self.layout.size;
        if self.frame.hidden {
            w.set_input_region(Some(&[]))?;
        } else {
            w.set_input_region(Some(&[[0, 0, width as i32, height as i32]]))?;
        }
        self.publish_targets();
        w.redraw();
        self.publish_semantics();
        Ok(())
    }

    fn publish_semantics(&mut self) {
        let focus = self.focused_slot();
        let tree = crate::semantics::tree(
            &mut self.ids,
            &crate::semantics::Input {
                items: &self.frame.view.items,
                rects: &self.layout.rects,
                size: self.layout.size,
                focus,
                focused_window: self.frame.focused,
                can_launch: self.frame.can_launch,
                hidden: self.frame.hidden,
            },
        );
        self.revision += 1;
        match &self.a11y {
            Some(bridge) => {
                // Publication receipts are only for checks that wait on them.
                while bridge.published.try_recv().is_ok() {}
                if let Err(e) = bridge.update(self.revision, tree) {
                    eprintln!("nidara-shell: accessibility stopped: {e}");
                }
            }
            None => {
                let mut bridge = nk_a11y::bridge::Bridge::new(self.revision, tree);
                // The bridge queues requests on a channel nobody wakes for: forward them
                // with this dock's waker, so a request is handled at once without polling.
                let (requests, rx) = std::sync::mpsc::channel();
                let from = std::mem::replace(&mut bridge.requests, std::sync::mpsc::channel().1);
                let waker = self.waker.clone();
                let _ = std::thread::Builder::new()
                    .name("dock-a11y".into())
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

    /// Requests made against an older tree are dropped: the item may be another by now.
    fn a11y(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        let Some(rx) = &self.a11y_requests else {
            return Ok(());
        };
        let requests: Vec<_> = rx.try_iter().collect();
        for (revision, request) in requests {
            if revision != self.revision {
                continue;
            }
            let (nk_a11y::Request::Activate(id) | nk_a11y::Request::Focus(id)) = request else {
                continue;
            };
            let Some(key) = self.ids.key(id).map(str::to_string) else {
                continue;
            };
            let Some(slot) = self.frame.view.items.iter().position(|i| i.key == key) else {
                continue;
            };
            if matches!(request, nk_a11y::Request::Activate(_)) {
                // No input event behind it, so no activation token.
                self.click(slot, None, w);
            } else if self.focus.is_some() {
                self.focus = Some(key);
                w.redraw();
                self.publish_semantics();
            }
        }
        Ok(())
    }

    /// Where each minimized window this dock owns goes: its slot, in surface coordinates.
    fn publish_targets(&mut self) {
        let mut targets = BTreeMap::new();
        for (n, item) in self.frame.view.items.iter().enumerate() {
            if let Kind::Minimized { window, .. } = item.kind
                && self.frame.targets.contains(&window)
            {
                targets.insert(window, self.layout.rects[n]);
            }
        }
        if targets != self.published {
            self.published = targets.clone();
            let _ = self.hub.send(Request::Targets {
                output: self.output_name.clone(),
                targets,
            });
        }
    }

    fn click(&mut self, slot: usize, serial: Option<u32>, w: &mut Window) {
        let item = &self.frame.view.items[slot];
        let Some(action) = primary(item, self.frame.focused, self.frame.can_launch) else {
            return;
        };
        let epoch = self.frame.hyalo_epoch;
        let request = match action {
            Action::Focus(id) => Request::Window {
                verb: "focus-window",
                id,
                epoch,
            },
            Action::Minimize(id) => Request::Window {
                verb: "minimize",
                id,
                epoch,
            },
            Action::Restore(id) => Request::Window {
                verb: "unminimize",
                id,
                epoch,
            },
            Action::Launch { id, generation } => Request::Launch {
                id,
                generation,
                token: None,
            },
            Action::OpenFolder(uri) => Request::OpenFolder { uri, token: None },
            Action::OpenTrash => Request::OpenTrash { token: None },
            Action::Unavailable => {
                eprintln!("nidara-shell: {} cannot be opened now", item.label);
                return;
            }
        };
        // What starts something gets a token from this very click; focus and minimize do not.
        if matches!(
            request,
            Request::Launch { .. } | Request::OpenFolder { .. } | Request::OpenTrash { .. }
        ) {
            let target = match &item.kind {
                Kind::App { id, .. } => Some(id.trim_end_matches(".desktop").to_string()),
                _ => None,
            };
            if let Some(serial) = serial {
                match w.request_activation_token(serial, target.as_deref()) {
                    Ok(t) => {
                        self.pending.insert(t, request);
                        return;
                    }
                    Err(e) => {
                        eprintln!("nidara-shell: no activation token ({e:?}); opening without one")
                    }
                }
            }
        }
        let _ = self.hub.send(request);
    }

    fn with_token(request: Request, token: Option<String>) -> Request {
        match request {
            Request::Launch { id, generation, .. } => Request::Launch {
                id,
                generation,
                token,
            },
            Request::OpenFolder { uri, .. } => Request::OpenFolder { uri, token },
            Request::OpenTrash { .. } => Request::OpenTrash { token },
            other => other,
        }
    }

    fn paint_item(&self, c: &mut Canvas, n: usize, item: &Item) {
        let [x, y, w, h] = self.layout.rects[n];
        let r = Rect {
            x: x as f32,
            y: y as f32,
            width: w as f32,
            height: h as f32,
        };
        let ink = if self.frame.dark {
            rgba(255, 255, 255, 255)
        } else {
            rgba(0, 0, 0, 255)
        };
        let faint = if self.frame.dark {
            rgba(255, 255, 255, 64)
        } else {
            rgba(0, 0, 0, 56)
        };
        match &item.kind {
            // One physical pixel, on the grid: a hairline between pixels reads as a thick
            // blurred one. Its ink is the TS dock's `--nidara-text-disabled` (white at 0.3).
            Kind::Separator => {
                let line = if self.frame.dark {
                    rgba(255, 255, 255, 77)
                } else {
                    rgba(0, 0, 0, 77)
                };
                if self.layout.position.horizontal() {
                    c.vertical_rule(r, 1., line)
                } else {
                    c.horizontal_rule(r, 1., line)
                }
            }
            Kind::Trash => {
                c.rounded_rect(r, w * 0.22, faint);
                if let Some(icon) = &self.trash_icon {
                    let inset = w * 0.22;
                    let i = Rect {
                        x: (x + inset) as f32,
                        y: (y + inset) as f32,
                        width: (w - 2. * inset) as f32,
                        height: (h - 2. * inset) as f32,
                    };
                    c.icon(icon, i, ink);
                }
            }
            kind => {
                let id = match kind {
                    Kind::App { id, .. } => Some(id.as_str()),
                    Kind::Minimized { app, .. } => app.as_deref(),
                    _ => None,
                };
                match id.and_then(|id| self.frame.icons.get(id)) {
                    Some(icon) => c.image(icon, r, ImageFit::Contain),
                    None => c.rounded_rect(r, w * 0.22, faint),
                }
            }
        }
        if self.focused_slot() == Some(n) {
            // The roving focus: an ink ring just outside the icon.
            let grow = (3. * self.layout.scale.max(0.5)) as f32;
            let ring = Rect {
                x: r.x - grow,
                y: r.y - grow,
                width: r.width + 2. * grow,
                height: r.height + 2. * grow,
            };
            c.rounded_ring(ring, w * 0.22 + grow as f64, 2., ink);
        }
        if self.frame.prefs.indicators
            && item.running()
            && !matches!(item.kind, Kind::Minimized { .. })
        {
            // The kit's `INK.solid` (0.9), as the TS dock's running dot.
            let mark = if self.frame.dark {
                rgba(255, 255, 255, 230)
            } else {
                rgba(0, 0, 0, 230)
            };
            c.dot(self.layout.dot(n), DOT * self.layout.scale.max(0.4), mark);
        }
    }
}

impl Application for Dock {
    fn poll_interval_ms(&self) -> u32 {
        // Everything arrives by Wake; nothing here needs a timer.
        60_000
    }
    fn event(&mut self, event: Event, w: &mut Window) -> nk_wayland::Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Wake => {
                self.drain(w)?;
                self.a11y(w)?;
            }
            Event::Configure => self.apply(w)?,
            Event::Motion(x, y) => self.pointer = (x, y),
            Event::Key(key) => self.key(key, w)?,
            // The compositor gave the keyboard elsewhere: the roving focus ends with it.
            Event::Focus(false) => self.leave_keyboard(w)?,
            Event::PointerLeave => self.pressed = None,
            Event::Button {
                button: LEFT_BUTTON,
                pressed: true,
                ..
            } if !self.frame.hidden => {
                self.pressed = self.layout.hit(self.pointer.0, self.pointer.1);
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: false,
                serial,
                ..
            } => {
                let here = self.layout.hit(self.pointer.0, self.pointer.1);
                if let Some(slot) = self.pressed.take().filter(|s| Some(*s) == here) {
                    self.click(slot, Some(serial), w);
                }
            }
            Event::ActivationToken { request, token } => {
                if let Some(r) = self.pending.remove(&request) {
                    let _ = self
                        .hub
                        .send(Self::with_token(r, Some(token.into_string())));
                }
            }
            Event::ActivationTokenFailed { request, reason } => {
                if let Some(r) = self.pending.remove(&request) {
                    eprintln!(
                        "nidara-shell: activation token failed ({reason:?}); opening without one"
                    );
                    let _ = self.hub.send(Self::with_token(r, None));
                }
            }
            Event::Closed => {}
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: nk_wayland::Frame) -> nk_wayland::Result<Vec<u8>> {
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        if !self.frame.hidden && f.width == self.layout.size.0 && f.height == self.layout.size.1 {
            if !f.material {
                // No compositor glass (another compositor): an opaque base of our own (D5).
                let (w, h) = (f.width as f32, f.height as f32);
                let base = if self.frame.dark {
                    rgba(40, 40, 44, 235)
                } else {
                    rgba(236, 236, 240, 235)
                };
                c.rounded_rect(
                    Rect {
                        x: 0.,
                        y: 0.,
                        width: w,
                        height: h,
                    },
                    (w.min(h) / 2.) as f64,
                    base,
                );
            }
            for (n, item) in self.frame.view.items.iter().enumerate() {
                self.paint_item(&mut c, n, item);
            }
        }
        Ok(c.finish())
    }
    fn material(&self) -> Option<Material> {
        if self.frame.hidden {
            return None;
        }
        let (w, h) = (self.layout.size.0 as f64, self.layout.size.1 as f64);
        let pane = Pane {
            x: 0.,
            y: 0.,
            width: w,
            height: h,
            radius: w.min(h) / 2.,
            exponent: CAPSULE_EXPONENT,
        };
        self.frame.tokens.as_ref().and_then(|t| {
            crate::material::dock(
                t,
                self.frame.dark,
                self.frame.prefs.reduce_transparency,
                pane,
            )
        })
    }
}

/// One dock's whole life on its own thread; returns when its surface closes or the hub
/// drops it.
pub fn run(dock: Dock, output: LayerOutput, wake: WakeSource) -> nk_wayland::Result<()> {
    let p = placement(&dock.layout, false);
    nk_wayland::run_layer(
        dock,
        Options {
            material: true,
            map: true,
            app_id: NAMESPACE,
            title: "",
            size: p.size,
            require_material: None,
        },
        LayerSpec {
            namespace: NAMESPACE,
            output: Some(output),
            layer: LayerLevel::Top,
            placement: p,
        },
        Some(wake),
        Instant::now(),
    )
}
