//! A test channel: when HYALO_CONTROL names a FIFO, each line is fed to the seat as if it came
//! from a device. It goes through the same seat calls as real input, so what it proves about
//! hit-testing and focus holds for a mouse; it exists because synthetic input through a
//! headless host compositor never delivers motion to a nested window (found in #679).
//! Off unless the variable is set; the session never sets it.
//!
//!   move X Y · click X Y · rclick X Y · press X Y BUTTON · release BUTTON
//!   key KEYCODE · keydown KEYCODE · keyup KEYCODE      (evdev codes: 125 = Super, 42 = Shift)
//!   pinch X Y SCALE                                    (two fingers, to SCALE in ten steps)
//!
//! Keys go through the same path as a keyboard's, bindings included.
use std::io::BufRead;

use smithay::{
    backend::input::{ButtonState, InputTime, KeyState},
    reexports::calloop::{EventLoop, channel},
};

use crate::state::Hyalo;

pub fn init(event_loop: &mut EventLoop<Hyalo>) {
    let Some(path) = std::env::var_os("HYALO_CONTROL") else { return };
    let (tx, rx) = channel::channel::<String>();
    std::thread::spawn(move || loop {
        let Ok(f) = std::fs::File::open(&path) else { return };
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    event_loop
        .handle()
        .insert_source(rx, |ev, _, state| {
            if let channel::Event::Msg(line) = ev {
                state.control(&line);
            }
        })
        .unwrap();
}

impl Hyalo {
    fn control(&mut self, line: &str) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        let num = |i: usize| parts.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        let time = InputTime::now();
        match parts.first().copied() {
            Some("move") => self.control_move(num(1), num(2), time),
            Some(verb @ ("click" | "rclick")) => {
                self.control_move(num(1), num(2), time);
                let button = if verb == "click" { 0x110 } else { 0x111 };
                for state in [ButtonState::Pressed, ButtonState::Released] {
                    self.pointer_button(button, state, time);
                }
            }
            Some("press") => {
                self.control_move(num(1), num(2), time);
                self.pointer_button(num(3) as u32, ButtonState::Pressed, time);
            }
            Some("release") => self.pointer_button(num(1) as u32, ButtonState::Released, time),
            Some(verb @ ("key" | "keydown" | "keyup")) => {
                let code = (num(1) as u32 + 8).into();
                if verb != "keyup" {
                    self.on_key(code, KeyState::Pressed, time);
                }
                if verb != "keydown" {
                    self.on_key(code, KeyState::Released, time);
                }
            }
            Some("pinch") => {
                self.control_move(num(1), num(2), time);
                self.control_pinch(num(3), time);
            }
            _ => eprintln!("[hyalo] control: unknown {line:?}"),
        }
    }

    fn control_move(&mut self, x: f64, y: f64, time: InputTime) {
        self.pointer_moved_to((x, y).into(), time);
    }

    /// A touchpad pinch, through the seat calls a real one goes through (input.rs).
    fn control_pinch(&mut self, to: f64, time: InputTime) {
        use smithay::{input::pointer::{GesturePinchBeginEvent, GesturePinchEndEvent, GesturePinchUpdateEvent}, utils::SERIAL_COUNTER};
        let pointer = self.seat.get_pointer().unwrap();
        pointer.gesture_pinch_begin(self, &GesturePinchBeginEvent { serial: SERIAL_COUNTER.next_serial(), time, fingers: 2 });
        for step in 1..=10 {
            let scale = 1.0 + (to - 1.0) * f64::from(step) / 10.0;
            pointer.gesture_pinch_update(self, &GesturePinchUpdateEvent { time, delta: (0.0, 0.0).into(), scale, rotation: 0.0 });
        }
        pointer.gesture_pinch_end(self, &GesturePinchEndEvent { serial: SERIAL_COUNTER.next_serial(), time, cancelled: false });
    }
}
