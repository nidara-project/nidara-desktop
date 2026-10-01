//! Input, the same for every backend: the backend hands its events here.
//!
//! Compositor key bindings are deliberately few until the desktop's own move over (#682):
//! Ctrl+Alt+F1…F12 switch virtual terminals (a session must always let you leave), and
//! Ctrl+Alt+Backspace ends the session — the way out of a preview while nothing else is.

use smithay::{
    backend::input::{
        AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputTime, GestureBeginEvent, GestureEndEvent,
        GesturePinchUpdateEvent as _, GestureSwipeUpdateEvent as _, InputBackend, InputEvent, KeyState,
        KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent, PointerMotionEvent,
    },
    input::{
        keyboard::{FilterResult, Keysym, ModifiersState, keysyms},
        pointer::{
            AxisFrame, ButtonEvent, GestureHoldBeginEvent, GestureHoldEndEvent, GesturePinchBeginEvent,
            GesturePinchEndEvent, GesturePinchUpdateEvent, GestureSwipeBeginEvent, GestureSwipeEndEvent,
            GestureSwipeUpdateEvent, MotionEvent, RelativeMotionEvent,
        },
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Point, SERIAL_COUNTER},
    wayland::{
        pointer_constraints::{PointerConstraint, with_pointer_constraint},
        seat::WaylandFocus,
        shell::wlr_layer::Layer,
    },
};

use crate::state::Hyalo;

/// What a key press does before (or instead of) reaching a client.
enum KeyAction {
    SwitchVt(i32),
    Quit,
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
        let action = keyboard.input::<KeyAction, _>(self, code, state, serial, time, |_, mods, handle| {
            if state != KeyState::Pressed {
                return FilterResult::Forward;
            }
            match binding(mods, handle.modified_sym()) {
                Some(action) => FilterResult::Intercept(action),
                None => FilterResult::Forward,
            }
        });
        match action {
            Some(KeyAction::SwitchVt(vt)) => self.backend.change_vt(vt),
            Some(KeyAction::Quit) => {
                tracing::info!("Ctrl+Alt+Backspace: ending the session");
                self.loop_signal.stop();
            }
            None => {}
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
        let under = self.surface_under(pos);
        pointer.motion(self, under, &MotionEvent { location: pos, serial, time: Event::time(event) });
        pointer.frame(self);
        self.activate_constraint_under_pointer();
        self.queue_redraw(None);
    }

    /// The pointer goes to `pos` (absolute devices, the control channel).
    pub fn pointer_moved_to(&mut self, pos: Point<f64, Logical>, time: InputTime) {
        let pos = self.clamp_to_outputs(pos);
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
            let pos = pointer.current_location();
            let under = self.surface_under(pos).map(|(s, _)| s);
            self.focus_grab_press(under.as_ref());
        }
        if button_state == ButtonState::Pressed && !pointer.is_grabbed() {
            let pos = pointer.current_location();
            if let Some((layer, _, _)) = self.layer_under(&[Layer::Overlay, Layer::Top], pos) {
                if Self::layer_wants_keyboard(&layer) {
                    keyboard.set_focus(self, Some(layer.wl_surface().clone()), serial);
                }
            } else if let Some(window) = self.space.element_under(pos).map(|(w, _)| w.clone()) {
                self.space.raise_element(&window, true);
                keyboard.set_focus(self, window.wl_surface().map(|s| s.into_owned()), serial);
                self.space.elements().for_each(|w| {
                    w.set_activated(w == &window);
                    if let Some(t) = w.toplevel() {
                        t.send_pending_configure();
                    }
                });
                self.queue_redraw(None);
            } else if let Some((layer, _, _)) = self.layer_under(&[Layer::Bottom, Layer::Background], pos) {
                if Self::layer_wants_keyboard(&layer) {
                    keyboard.set_focus(self, Some(layer.wl_surface().clone()), serial);
                }
            } else {
                self.space.elements().for_each(|w| {
                    w.set_activated(false);
                    if let Some(t) = w.toplevel() {
                        t.send_pending_configure();
                    }
                });
                keyboard.set_focus(self, Option::<WlSurface>::None, serial);
            }
        }

        pointer.button(self, &ButtonEvent { button, state: button_state, serial, time });
        pointer.frame(self);
    }
}

fn binding(mods: &ModifiersState, sym: Keysym) -> Option<KeyAction> {
    let raw = sym.raw();
    if (keysyms::KEY_XF86Switch_VT_1..=keysyms::KEY_XF86Switch_VT_12).contains(&raw) {
        return Some(KeyAction::SwitchVt((raw - keysyms::KEY_XF86Switch_VT_1 + 1) as i32));
    }
    if mods.ctrl && mods.alt && raw == keysyms::KEY_BackSpace {
        return Some(KeyAction::Quit);
    }
    None
}
