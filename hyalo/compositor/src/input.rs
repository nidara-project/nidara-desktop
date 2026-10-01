//! Input, the same for every backend: the backend hands its events here.
//!
//! The configuration's bindings (binds.rs) run before a key or button reaches a client. Two
//! are built in and cannot be bound over: Ctrl+Alt+F1…F12 switch virtual terminals (a
//! session must always let you leave), and Ctrl+Alt+Backspace ends the session.
//!
//! Focus: a CLICK gives a window the keyboard; the pointer passing over one does not
//! (Hyprland's `follow_mouse = 2` on the other session, for the same reason — the way to the
//! bar's window menu crosses other windows).

use smithay::{
    backend::input::{
        AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputTime, GestureBeginEvent, GestureEndEvent,
        GesturePinchUpdateEvent as _, GestureSwipeUpdateEvent as _, InputBackend, InputEvent, KeyState,
        KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent, PointerMotionEvent,
    },
    input::{
        keyboard::{FilterResult, Keysym, ModifiersState, keysyms},
        pointer::{
            AxisFrame, ButtonEvent, GrabStartData as PointerGrabStartData, GestureHoldBeginEvent, GestureHoldEndEvent, GesturePinchBeginEvent,
            GesturePinchEndEvent, GesturePinchUpdateEvent, GestureSwipeBeginEvent, GestureSwipeEndEvent,
            GestureSwipeUpdateEvent, MotionEvent, RelativeMotionEvent,
        },
    },
    utils::{Logical, Point, SERIAL_COUNTER},
    wayland::{
        pointer_constraints::{PointerConstraint, with_pointer_constraint},
        shell::wlr_layer::Layer,
    },
};

use crate::{
    binds::{self, Mods, Trigger},
    state::Hyalo,
    wm::{actions::Action, grabs::Kind},
};

/// What a key press does before (or instead of) reaching a client.
enum KeyAction {
    SwitchVt(i32),
    Quit,
    Run { action: Action, repeat: bool },
    /// Swallowed: the release of a key whose press ran a binding.
    Swallow,
}

/// Keys between their press and their release, as far as bindings care.
#[derive(Default)]
pub struct KeyTracking {
    /// Keys whose press ran a binding: their release does not reach the client either.
    swallowed: Vec<u32>,
    /// A key with a release binding, held alone so far.
    release_candidate: Option<u32>,
    /// The binding repeating while its key is held.
    repeating: Option<(u32, smithay::reexports::calloop::RegistrationToken)>,
}

impl Hyalo {
    pub fn process_input_event<I: InputBackend>(&mut self, event: InputEvent<I>) {
        match event {
            InputEvent::Keyboard { event } => self.on_key(event.key_code(), event.state(), Event::time(&event)),
            InputEvent::PointerMotion { event } => self.on_relative_motion::<I>(&event),
            InputEvent::PointerMotionAbsolute { event } => {
                let Some(geo) = self.space.outputs().next().and_then(|o| self.space.output_geometry(o)) else {
                    return;
                };
                let pos = event.position_transformed(geo.size) + geo.loc.to_f64();
                self.pointer_moved_to(pos, Event::time(&event));
            }
            InputEvent::PointerButton { event } => {
                self.pointer_button(event.button_code(), event.state(), Event::time(&event))
            }
            InputEvent::PointerAxis { event } => self.on_axis::<I>(&event),
            InputEvent::GestureSwipeBegin { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_swipe_begin(
                    self,
                    &GestureSwipeBeginEvent {
                        serial: SERIAL_COUNTER.next_serial(),
                        time: Event::time(&event),
                        fingers: event.fingers(),
                    },
                );
            }
            InputEvent::GestureSwipeUpdate { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_swipe_update(
                    self,
                    &GestureSwipeUpdateEvent { time: Event::time(&event), delta: event.delta() },
                );
            }
            InputEvent::GestureSwipeEnd { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_swipe_end(
                    self,
                    &GestureSwipeEndEvent {
                        serial: SERIAL_COUNTER.next_serial(),
                        time: Event::time(&event),
                        cancelled: event.cancelled(),
                    },
                );
            }
            InputEvent::GesturePinchBegin { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_pinch_begin(
                    self,
                    &GesturePinchBeginEvent {
                        serial: SERIAL_COUNTER.next_serial(),
                        time: Event::time(&event),
                        fingers: event.fingers(),
                    },
                );
            }
            InputEvent::GesturePinchUpdate { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_pinch_update(
                    self,
                    &GesturePinchUpdateEvent {
                        time: Event::time(&event),
                        delta: event.delta(),
                        scale: event.scale(),
                        rotation: event.rotation(),
                    },
                );
            }
            InputEvent::GesturePinchEnd { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_pinch_end(
                    self,
                    &GesturePinchEndEvent {
                        serial: SERIAL_COUNTER.next_serial(),
                        time: Event::time(&event),
                        cancelled: event.cancelled(),
                    },
                );
            }
            InputEvent::GestureHoldBegin { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_hold_begin(
                    self,
                    &GestureHoldBeginEvent {
                        serial: SERIAL_COUNTER.next_serial(),
                        time: Event::time(&event),
                        fingers: event.fingers(),
                    },
                );
            }
            InputEvent::GestureHoldEnd { event } => {
                let pointer = self.seat.get_pointer().unwrap();
                pointer.gesture_hold_end(
                    self,
                    &GestureHoldEndEvent {
                        serial: SERIAL_COUNTER.next_serial(),
                        time: Event::time(&event),
                        cancelled: event.cancelled(),
                    },
                );
            }
            InputEvent::DeviceAdded { .. } | InputEvent::DeviceRemoved { .. } => {}
            _ => {}
        }
    }

    pub fn on_key(&mut self, code: smithay::backend::input::Keycode, state: KeyState, time: InputTime) {
        let serial = SERIAL_COUNTER.next_serial();
        let keyboard = self.seat.get_keyboard().unwrap();
        let raw = code.raw();
        let action = keyboard.input::<KeyAction, _>(self, code, state, serial, time, |data, mods, handle| {
            let sym = handle.raw_latin_sym_or_raw_current_sym().unwrap_or_else(|| handle.modified_sym());
            if state == KeyState::Released {
                if let Some((key, token)) = data.keys.repeating.take() {
                    if key == raw {
                        data.loop_handle.remove(token);
                    } else {
                        data.keys.repeating = Some((key, token));
                    }
                }
                if data.keys.release_candidate.take() == Some(raw)
                    && let Some(b) = binds::release_binding(&data.binds, sym)
                {
                    return FilterResult::Intercept(KeyAction::Run { action: b.action.clone(), repeat: false });
                }
                if let Some(i) = data.keys.swallowed.iter().position(|k| *k == raw) {
                    data.keys.swallowed.swap_remove(i);
                    return FilterResult::Intercept(KeyAction::Swallow);
                }
                return FilterResult::Forward;
            }
            // Any other key pressed while a release key is held cancels it: Super+T is not Super.
            data.keys.release_candidate = None;
            if let Some(a) = builtin(mods, handle.modified_sym()) {
                data.keys.swallowed.push(raw);
                return FilterResult::Intercept(a);
            }
            if let Some(b) = binds::find_key(&data.binds, Mods::from(mods), sym) {
                data.keys.swallowed.push(raw);
                return FilterResult::Intercept(KeyAction::Run { action: b.action.clone(), repeat: b.repeat });
            }
            if binds::release_binding(&data.binds, sym).is_some() {
                data.keys.release_candidate = Some(raw);
            }
            FilterResult::Forward
        });
        match action {
            Some(KeyAction::SwitchVt(vt)) => self.backend.change_vt(vt),
            Some(KeyAction::Quit) => {
                tracing::info!("Ctrl+Alt+Backspace: ending the session");
                self.loop_signal.stop();
            }
            Some(KeyAction::Run { action, repeat }) => {
                if repeat {
                    self.start_repeat(raw, action.clone());
                }
                self.run_bound(action);
            }
            Some(KeyAction::Swallow) | None => {}
        }
    }

    fn run_bound(&mut self, action: Action) {
        let shown = format!("{action:?}");
        if let Err(err) = self.run_action(action) {
            tracing::debug!(action = %shown, %err, "binding did nothing");
        }
    }

    /// Runs `action` again while key `raw` stays down, at the keyboard's repeat delay and rate.
    fn start_repeat(&mut self, raw: u32, action: Action) {
        use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
        let kb = &self.config.input.keyboard;
        let delay = std::time::Duration::from_millis(kb.repeat_delay.max(1) as u64);
        let every = std::time::Duration::from_millis((1000 / kb.repeat_rate.max(1)) as u64);
        if let Some((_, token)) = self.keys.repeating.take() {
            self.loop_handle.remove(token);
        }
        let token = self.loop_handle.insert_source(Timer::from_duration(delay), move |_, _, state| {
            state.run_bound(action.clone());
            TimeoutAction::ToDuration(every)
        });
        if let Ok(token) = token {
            self.keys.repeating = Some((raw, token));
        }
    }

    fn on_relative_motion<I: InputBackend>(&mut self, event: &I::PointerMotionEvent) {
        let pointer = self.seat.get_pointer().unwrap();
        let mut pos = pointer.current_location();
        let serial = SERIAL_COUNTER.next_serial();
        let under = self.surface_under(pos);

        // A locked pointer stays put, a confined one stays in its region; either way the
        // client gets the relative motion (games, 3D viewports).
        let mut locked = false;
        let mut confined = false;
        if let Some((surface, origin)) = &under {
            with_pointer_constraint(surface, &pointer, |constraint| match constraint {
                Some(c) if c.is_active() => match &*c {
                    PointerConstraint::Locked(_) => locked = true,
                    PointerConstraint::Confined(confine) => {
                        let new = pos + event.delta() - *origin;
                        let inside = confine
                            .region()
                            .is_none_or(|r| r.contains(new.to_i32_round()));
                        confined = !inside;
                    }
                },
                _ => {}
            });
        }
        pointer.relative_motion(
            self,
            under.clone(),
            &RelativeMotionEvent {
                delta: event.delta(),
                delta_unaccel: event.delta_unaccel(),
                time: Event::time(event),
            },
        );
        if locked || confined {
            pointer.frame(self);
            return;
        }
        pos += event.delta();
        pos = self.clamp_to_outputs(pos);
        self.pointer_on_output(pos);
        let under = self.surface_under(pos);
        pointer.motion(self, under, &MotionEvent { location: pos, serial, time: Event::time(event) });
        pointer.frame(self);
        self.activate_constraint_under_pointer();
        self.queue_redraw(None);
    }

    /// The pointer goes to `pos` (absolute devices, the control channel).
    pub fn pointer_moved_to(&mut self, pos: Point<f64, Logical>, time: InputTime) {
        let pos = self.clamp_to_outputs(pos);
        self.pointer_on_output(pos);
        let under = self.surface_under(pos);
        let pointer = self.seat.get_pointer().unwrap();
        pointer.motion(self, under, &MotionEvent { location: pos, serial: SERIAL_COUNTER.next_serial(), time });
        pointer.frame(self);
        self.activate_constraint_under_pointer();
        self.queue_redraw(None);
    }

    fn activate_constraint_under_pointer(&mut self) {
        let pointer = self.seat.get_pointer().unwrap();
        let Some(surface) = pointer.current_focus() else { return };
        with_pointer_constraint(&surface, &pointer, |constraint| {
            if let Some(c) = constraint
                && !c.is_active() {
                    c.activate();
                }
        });
    }

    /// Inside the union of the outputs: the nearest point of the nearest output.
    fn clamp_to_outputs(&self, pos: Point<f64, Logical>) -> Point<f64, Logical> {
        let geos: Vec<_> = self.space.outputs().filter_map(|o| self.space.output_geometry(o)).collect();
        if geos.iter().any(|g| g.to_f64().contains(pos)) || geos.is_empty() {
            return pos;
        }
        geos.iter()
            .map(|g| {
                let g = g.to_f64();
                let x = pos.x.clamp(g.loc.x, g.loc.x + g.size.w - 1.0);
                let y = pos.y.clamp(g.loc.y, g.loc.y + g.size.h - 1.0);
                Point::from((x, y))
            })
            .min_by(|a, b| {
                let da = (a.x - pos.x).powi(2) + (a.y - pos.y).powi(2);
                let db = (b.x - pos.x).powi(2) + (b.y - pos.y).powi(2);
                da.total_cmp(&db)
            })
            .unwrap_or(pos)
    }

    fn on_axis<I: InputBackend>(&mut self, event: &I::PointerAxisEvent) {
        let source = event.source();
        // A wheel binding (Super+wheel switches workspace) takes the notch; a touchpad's
        // continuous scroll is never a binding.
        if source == AxisSource::Wheel {
            let v = event.amount_v120(Axis::Vertical).or_else(|| event.amount(Axis::Vertical)).unwrap_or(0.0);
            if v != 0.0 {
                let mods = Mods::from(&self.seat.get_keyboard().unwrap().modifier_state());
                let trigger = if v > 0.0 { Trigger::WheelDown } else { Trigger::WheelUp };
                if let Some(b) = binds::find_pointer(&self.binds, mods, trigger) {
                    let action = b.action.clone();
                    self.run_bound(action);
                    return;
                }
            }
        }
        let natural = match source {
            AxisSource::Finger => self.config.input.touchpad.natural_scroll,
            _ => self.config.input.pointer.natural_scroll,
        };
        // Natural scrolling is done here for devices libinput does not configure (winit).
        let sign = if natural && !self.backend.configures_devices() { -1.0 } else { 1.0 };
        let amount = |axis| {
            event
                .amount(axis)
                .unwrap_or_else(|| event.amount_v120(axis).unwrap_or(0.0) * 15.0 / 120.0)
                * sign
        };
        let (h, v) = (amount(Axis::Horizontal), amount(Axis::Vertical));
        let mut frame = AxisFrame::new(Event::time(event)).source(source);
        if h != 0.0 {
            frame = frame.value(Axis::Horizontal, h);
            if let Some(d) = event.amount_v120(Axis::Horizontal) {
                frame = frame.v120(Axis::Horizontal, (d * sign) as i32);
            }
        }
        if v != 0.0 {
            frame = frame.value(Axis::Vertical, v);
            if let Some(d) = event.amount_v120(Axis::Vertical) {
                frame = frame.v120(Axis::Vertical, (d * sign) as i32);
            }
        }
        if source == AxisSource::Finger {
            if event.amount(Axis::Horizontal) == Some(0.0) {
                frame = frame.stop(Axis::Horizontal);
            }
            if event.amount(Axis::Vertical) == Some(0.0) {
                frame = frame.stop(Axis::Vertical);
            }
        }
        let pointer = self.seat.get_pointer().unwrap();
        pointer.axis(self, frame);
        pointer.frame(self);
    }

    pub fn pointer_button(&mut self, button: u32, button_state: ButtonState, time: InputTime) {
        let pointer = self.seat.get_pointer().unwrap();
        let keyboard = self.seat.get_keyboard().unwrap();
        let serial = SERIAL_COUNTER.next_serial();

        if button_state == ButtonState::Pressed {
            // A click while Super is held is not "Super alone".
            self.keys.release_candidate = None;
            let pos = pointer.current_location();
            let under = self.surface_under(pos).map(|(s, _)| s);
            self.focus_grab_press(under.as_ref());
        }
        if button_state == ButtonState::Pressed && !pointer.is_grabbed() {
            let pos = pointer.current_location();
            // Super+drag: carry or resize the window under the pointer.
            let mods = Mods::from(&keyboard.modifier_state());
            if let Some(b) = binds::find_pointer(&self.binds, mods, Trigger::Button(button)) {
                let action = b.action.clone();
                if let Some(id) = self.window_under(pos) {
                    let kind = match action {
                        Action::ResizeWithPointer => Kind::Resize(self.edges_nearest(id, pos)),
                        _ => Kind::Move,
                    };
                    let start = PointerGrabStartData { focus: None, button, location: pos };
                    self.focus_window(Some(id));
                    self.start_window_grab(id, kind, start, button);
                }
                return;
            }
            if let Some((layer, _, _)) = self.layer_under(&[Layer::Overlay], pos) {
                if Self::layer_wants_keyboard(&layer) {
                    keyboard.set_focus(self, Some(layer.wl_surface().clone()), serial);
                }
            } else if let Some(id) = self.window_under(pos).filter(|_| self.window_hit_before_top_layer(pos)) {
                self.focus_window(Some(id));
            } else if let Some((layer, _, _)) = self.layer_under(&[Layer::Top], pos) {
                if Self::layer_wants_keyboard(&layer) {
                    keyboard.set_focus(self, Some(layer.wl_surface().clone()), serial);
                }
            } else if let Some(id) = self.window_under(pos) {
                self.focus_window(Some(id));
            } else if let Some((layer, _, _)) = self.layer_under(&[Layer::Bottom, Layer::Background], pos) {
                if Self::layer_wants_keyboard(&layer) {
                    keyboard.set_focus(self, Some(layer.wl_surface().clone()), serial);
                }
            } else {
                self.focus_window(None);
            }
        }

        pointer.button(self, &ButtonEvent { button, state: button_state, serial, time });
        pointer.frame(self);
    }

    /// Is the window under `pos` one drawn over the top layers (a fullscreen window)?
    fn window_hit_before_top_layer(&self, pos: Point<f64, Logical>) -> bool {
        let Some(output) = self.space.output_under(pos).next() else { return false };
        let (above, _) = crate::render::windows_front_to_back(&self.space, &self.wm, output);
        above.iter().any(|w| self.space.element_geometry(w).is_some_and(|g| g.to_f64().contains(pos)))
    }
}

/// The two bindings no configuration can take away.
fn builtin(mods: &ModifiersState, sym: Keysym) -> Option<KeyAction> {
    let raw = sym.raw();
    if (keysyms::KEY_XF86Switch_VT_1..=keysyms::KEY_XF86Switch_VT_12).contains(&raw) {
        return Some(KeyAction::SwitchVt((raw - keysyms::KEY_XF86Switch_VT_1 + 1) as i32));
    }
    if mods.ctrl && mods.alt && raw == keysyms::KEY_BackSpace {
        return Some(KeyAction::Quit);
    }
    None
}
