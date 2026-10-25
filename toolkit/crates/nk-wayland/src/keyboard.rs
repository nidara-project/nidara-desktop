// SPDX-License-Identifier: LGPL-3.0-or-later
use std::{
    env,
    time::{Duration, Instant},
};
use xkbcommon::xkb::{self, compose};

#[derive(Clone, Debug)]
pub struct Key {
    /// Originating wl_keyboard serial. None for repeats or synthetic keys.
    pub serial: Option<u32>,
    pub sym: u32,
    pub text: String,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}
pub struct Keyboard {
    pub context: xkb::Context,
    pub state: Option<xkb::State>,
    pub compose: Option<compose::State>,
    pub rate: i32,
    pub delay: i32,
    pub repeat: Option<(u32, Key, Instant)>,
}
impl Keyboard {
    pub fn new() -> Self {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let locale = env::var("LC_ALL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| env::var("LC_CTYPE").ok())
            .or_else(|| env::var("LANG").ok())
            .unwrap_or("C.UTF-8".into());
        let compose = compose::Table::new_from_locale(
            &context,
            std::ffi::OsStr::new(&locale),
            compose::COMPILE_NO_FLAGS,
        )
        .ok()
        .map(|t| compose::State::new(&t, compose::STATE_NO_FLAGS));
        Self {
            context,
            state: None,
            compose,
            rate: 0,
            delay: 0,
            repeat: None,
        }
    }
    pub fn reset(&mut self) {
        self.repeat = None;
        if let Some(c) = &mut self.compose {
            c.reset();
        }
    }
    pub fn press(&mut self, code: u32) -> Option<Key> {
        let s = self.state.as_ref()?;
        let keycode = xkb::Keycode::new(code + 8);
        let sym = s.key_get_one_sym(keycode);
        let mut text = s.key_get_utf8(keycode);
        let ctrl = s.mod_name_is_active(xkb::MOD_NAME_CTRL, xkb::STATE_MODS_EFFECTIVE);
        let alt = s.mod_name_is_active(xkb::MOD_NAME_ALT, xkb::STATE_MODS_EFFECTIVE);
        if !ctrl
            && !alt
            && let Some(c) = &mut self.compose
        {
            c.feed(sym);
            match c.status() {
                compose::Status::Composing => text.clear(),
                compose::Status::Composed => {
                    text = c.utf8().unwrap_or_default();
                    c.reset();
                }
                compose::Status::Cancelled => {
                    text.clear();
                    c.reset();
                }
                _ => {}
            }
        }
        let key = Key {
            serial: None,
            sym: sym.raw(),
            text,
            ctrl,
            alt,
            shift: s.mod_name_is_active(xkb::MOD_NAME_SHIFT, xkb::STATE_MODS_EFFECTIVE),
        };
        if self.rate > 0 && s.get_keymap().key_repeats(keycode) {
            self.repeat = Some((
                code,
                key.clone(),
                Instant::now() + Duration::from_millis(self.delay.max(0) as u64),
            ));
        }
        Some(key)
    }
    pub fn refresh_repeat(&mut self) {
        if let (Some((code, key, _)), Some(s)) = (&mut self.repeat, &self.state) {
            let code = xkb::Keycode::new(*code + 8);
            key.sym = s.key_get_one_sym(code).raw();
            key.text = s.key_get_utf8(code);
            key.ctrl = s.mod_name_is_active(xkb::MOD_NAME_CTRL, xkb::STATE_MODS_EFFECTIVE);
            key.alt = s.mod_name_is_active(xkb::MOD_NAME_ALT, xkb::STATE_MODS_EFFECTIVE);
            key.shift = s.mod_name_is_active(xkb::MOD_NAME_SHIFT, xkb::STATE_MODS_EFFECTIVE);
        }
    }
    pub fn tick(&mut self) -> Option<Key> {
        let (_, key, when) = self.repeat.as_mut()?;
        let now = Instant::now();
        if now < *when {
            return None;
        }
        *when = now + Duration::from_secs_f64(1. / self.rate.max(1) as f64);
        Some(key.clone())
    }
}
