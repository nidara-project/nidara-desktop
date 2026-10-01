//! A test channel: when HYALO_CONTROL names a FIFO, each line is fed to the seat as if it came
//! from a device. It goes through the same seat calls as real input, so what it proves about
//! hit-testing and focus holds for a mouse; it exists because synthetic input through a
//! headless host compositor never delivers motion to a nested window (found in #679).
//! Off unless the variable is set; the session never sets it.
//!
//!   move X Y · click X Y · rclick X Y · press X Y BUTTON · release BUTTON
//!   key KEYCODE · keydown KEYCODE · keyup KEYCODE      (evdev codes: 125 = Super, 42 = Shift)
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
            _ => eprintln!("[hyalo] control: unknown {line:?}"),
        }
    }

    fn control_move(&mut self, x: f64, y: f64, time: InputTime) {
        self.pointer_moved_to((x, y).into(), time);
    }
}
