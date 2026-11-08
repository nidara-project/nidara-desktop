// SPDX-License-Identifier: LGPL-3.0-or-later
//! Native notifications: bounded card data and the one authoritative banner stack.
//! Presentation retirement preserves ordinary history; transient records expire.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;

pub const MAX_VISIBLE: usize = 4;
pub const GAME_GRACE_MS: u64 = 3000;
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Action {
    pub id: String,
    pub label: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Notice {
    #[serde(default)]
    pub revision: u64,
    pub id: u32,
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub app_icon: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub body: String,
    #[serde(default = "default_timeout")]
    pub expire_timeout: i32,
    #[serde(default)]
    pub time: u64,
    #[serde(default)]
    pub hints: Map<String, Value>,
    #[serde(default)]
    pub actions: Vec<Action>,
}
fn default_timeout() -> i32 {
    -1
}
impl Notice {
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.len() > 1024 * 1024 {
            return Err("notification record exceeds 1 MiB".into());
        }
        let mut n: Self = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if n.id == 0 {
            return Err("zero notification identity".into());
        }
        limit(&mut n.app_name, 1024);
        limit(&mut n.app_icon, 4096);
        limit(&mut n.summary, 8192);
        n.summary = plain_text(&n.summary);
        limit(&mut n.body, 16384);
        n.body = plain_text(&n.body);
        for key in ["desktop-entry", "image-path", "image_path"] {
            if n.hints
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|v| v.len() > 4096)
            {
                n.hints.remove(key);
            }
        }
        n.actions.truncate(32);
        let mut seen = std::collections::HashSet::new();
        n.actions
            .retain(|a| !a.id.is_empty() && a.id.len() <= 256 && seen.insert(a.id.clone()));
        for a in &mut n.actions {
            limit(&mut a.label, 1024);
        }
        Ok(n)
    }
    pub fn transient(&self) -> bool {
        match self.hints.get("transient") {
            Some(Value::Bool(v)) => *v,
            Some(Value::Number(v)) => v.as_f64().is_some_and(|n| n != 0.0),
            Some(Value::String(v)) => !v.is_empty(),
            Some(Value::Array(_) | Value::Object(_)) => true,
            _ => false,
        }
    }
    pub fn critical(&self) -> bool {
        self.hints.get("urgency").and_then(Value::as_u64) == Some(2)
    }
    pub fn has_action(&self, key: &str) -> bool {
        self.actions.iter().any(|a| a.id == key)
    }
    pub fn hint(&self, key: &str) -> &str {
        self.hints.get(key).and_then(Value::as_str).unwrap_or("")
    }
    pub fn duration(&self, popup_seconds: u32) -> Option<u64> {
        if self.critical() || self.expire_timeout == 0 {
            None
        } else if self.expire_timeout > 0 {
            Some(self.expire_timeout as u64)
        } else {
            (popup_seconds > 0).then_some(u64::from(popup_seconds) * 1000)
        }
    }
}
/// Plain labels: remove tags, then decode numeric and named entities in one pass.
/// Decoded characters are never rescanned as another entity or markup tag.
pub fn plain_text(input: &str) -> String {
    let mut stripped = String::new();
    let mut rest = input;
    while let Some(open) = rest.find('<') {
        stripped.push_str(&rest[..open]);
        if let Some(close) = rest[open..].find('>') {
            rest = &rest[open + close + 1..];
        } else {
            stripped.push_str(&rest[open..]);
            rest = "";
            break;
        }
    }
    stripped.push_str(rest);
    let mut decoded = String::new();
    let mut rest = stripped.as_str();
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        rest = &rest[start..];
        // Bound the scan as well as the result; repeated malformed '&' cannot
        // make parsing quadratic. All recognized entities fit in this window.
        let parsed = rest
            .bytes()
            .take(13)
            .position(|b| b == b';')
            .and_then(|end| {
                let entity = &rest[1..end];
                let ch = match entity {
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "amp" => Some('&'),
                    _ => entity.strip_prefix('#').and_then(|number| {
                        let (digits, radix) = number
                            .strip_prefix('x')
                            .or_else(|| number.strip_prefix('X'))
                            .map_or((number, 10), |hex| (hex, 16));
                        if digits.is_empty()
                            || !digits.chars().all(|c| c.is_ascii() && c.is_digit(radix))
                        {
                            return None;
                        }
                        u32::from_str_radix(digits, radix)
                            .ok()
                            .filter(|n| *n > 0)
                            .and_then(char::from_u32)
                    }),
                }?;
                Some((end, ch))
            });
        if let Some((end, ch)) = parsed {
            decoded.push(ch);
            rest = &rest[end + 1..];
        } else {
            decoded.push('&');
            rest = &rest[1..];
        }
    }
    decoded.push_str(rest);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn limit(s: &mut String, max: usize) {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preferences {
    pub popup_seconds: u32,
    pub dnd: bool,
    pub silence_games: bool,
    pub icon_theme: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            popup_seconds: 6,
            dnd: false,
            silence_games: true,
            icon_theme: String::new(),
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Gates {
    pub locked: bool,
    pub panel: bool,
    pub game: bool,
}
#[derive(Clone, Debug)]
pub struct Banner {
    pub notice: Notice,
    /// Never reused during the shell's lifetime; replacements retain it.
    pub instance: u64,
    /// Every replacement retires actions captured from the old content.
    pub content: u64,
    pub output: String,
    pub deadline: Option<u64>,
    pub hovered: bool,
    pub error: String,
}
#[derive(Clone, Debug, Default)]
pub struct Stack {
    pub entries: VecDeque<Banner>,
    next: u64,
    game_until: u64,
    game: bool,
}
impl Stack {
    pub fn clear(&mut self) -> bool {
        let had = !self.entries.is_empty();
        self.entries.clear();
        had
    }
    pub fn gates(&mut self, gates: Gates, prefs: &Preferences, now: u64) -> bool {
        if self.game && !gates.game {
            self.game_until = now.saturating_add(GAME_GRACE_MS);
        }
        self.game = gates.game;
        let before = self.entries.len();
        let silenced = prefs.dnd
            || gates.panel
            || prefs.silence_games && (gates.game || now < self.game_until);
        self.entries
            .retain(|e| !gates.locked && (!silenced || e.notice.critical()));
        before != self.entries.len()
    }
    pub fn push(
        &mut self,
        notice: Notice,
        output: String,
        gates: Gates,
        prefs: &Preferences,
        now: u64,
    ) -> bool {
        let changed = self.gates(gates, prefs, now);
        if gates.locked
            || (!notice.critical()
                && (prefs.dnd
                    || gates.panel
                    || prefs.silence_games && (gates.game || now < self.game_until)))
        {
            return self.resolve(notice.id) || changed;
        }
        let duration = notice.duration(prefs.popup_seconds);
        if let Some(old) = self.entries.iter_mut().find(|e| e.notice.id == notice.id) {
            old.content = old.content.saturating_add(1);
            old.notice = notice;
            old.deadline = if old.hovered {
                None
            } else {
                duration.map(|d| now.saturating_add(d))
            };
            old.error.clear();
            return true;
        }
        self.next = self.next.checked_add(1).expect("banner identity exhausted");
        if self.entries.len() == MAX_VISIBLE {
            // Keep critical cards ahead of ordinary chatter. If every slot is
            // critical, admit the new notice by retiring the oldest critical.
            let retire = self
                .entries
                .iter()
                .position(|e| !e.notice.critical())
                .unwrap_or(0);
            self.entries.remove(retire);
        }
        self.entries.push_back(Banner {
            notice,
            instance: self.next,
            content: 1,
            output,
            deadline: duration.map(|d| now.saturating_add(d)),
            hovered: false,
            error: String::new(),
        });
        true
    }
    pub fn resolve(&mut self, id: u32) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.notice.id != id);
        before != self.entries.len()
    }
    pub fn hover(&mut self, instance: u64, on: bool, prefs: &Preferences, now: u64) -> bool {
        let Some(e) = self.entries.iter_mut().find(|e| e.instance == instance) else {
            return false;
        };
        if e.hovered == on {
            return false;
        }
        e.hovered = on;
        e.deadline = if on {
            None
        } else {
            e.notice
                .duration(prefs.popup_seconds)
                .map(|d| now.saturating_add(d))
        };
        true
    }
    pub fn expire(&mut self, now: u64) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.deadline.is_none_or(|d| d > now));
        before != self.entries.len()
    }
    pub fn next_deadline(&self) -> Option<u64> {
        self.entries.iter().filter_map(|e| e.deadline).min()
    }
    pub fn set_error(&mut self, instance: u64, content: u64, error: String) {
        if let Some(b) = self
            .entries
            .iter_mut()
            .find(|b| b.instance == instance && b.content == content)
        {
            b.error = error;
        }
    }
    pub fn current(&self, instance: u64, content: u64) -> Option<&Banner> {
        self.entries
            .iter()
            .find(|e| e.instance == instance && e.content == content)
    }
}
/// Hydrated history is separate from presentation and never replays as a banner.
#[derive(Clone, Debug)]
pub struct History {
    pub entries: std::sync::Arc<Vec<Banner>>,
    next: u64,
}
impl Default for History {
    fn default() -> Self {
        Self {
            entries: Default::default(),
            next: 1 << 32,
        }
    }
}
impl History {
    pub fn clear(&mut self) {
        self.entries = Default::default();
    }
    pub fn put(&mut self, notice: Notice) {
        if notice.transient() {
            self.remove(&[notice.id]);
            return;
        }
        let entries = std::sync::Arc::make_mut(&mut self.entries);
        if let Some(b) = entries.iter_mut().find(|b| b.notice.id == notice.id) {
            b.content = notice.revision;
            b.notice = notice;
            b.error.clear();
        } else {
            self.next += 1;
            entries.push(Banner {
                content: notice.revision,
                notice,
                instance: self.next,
                output: String::new(),
                deadline: None,
                hovered: false,
                error: String::new(),
            });
        }
    }
    pub fn remove(&mut self, ids: &[u32]) {
        let ids: std::collections::HashSet<_> = ids.iter().copied().collect();
        if !self.entries.iter().any(|b| ids.contains(&b.notice.id)) {
            return;
        }
        std::sync::Arc::make_mut(&mut self.entries).retain(|b| !ids.contains(&b.notice.id));
    }
    pub fn current(&self, instance: u64, content: u64) -> Option<&Banner> {
        self.entries
            .iter()
            .find(|b| b.instance == instance && b.content == content)
    }
    pub fn set_error(&mut self, instance: u64, content: u64, error: String) {
        if self.current(instance, content).is_some()
            && let Some(b) = std::sync::Arc::make_mut(&mut self.entries)
                .iter_mut()
                .find(|b| b.instance == instance)
        {
            b.error = error;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn n(id: u32, timeout: i32, critical: bool) -> Notice {
        Notice::parse(&serde_json::json!({"id":id,"summary":format!("notice{id}"),"expire_timeout":timeout,"hints":{"urgency":if critical {2}else{1}}}).to_string()).unwrap()
    }
    #[test]
    fn errors_belong_only_to_current_content_and_can_be_cleared_for_retry() {
        let mut s = Stack::default();
        let p = Preferences::default();
        s.push(n(1, 0, false), "a".into(), Gates::default(), &p, 0);
        let b = s.entries[0].clone();
        s.set_error(b.instance, b.content, "Could not activate".into());
        assert!(!s.entries[0].error.is_empty());
        s.set_error(b.instance, b.content, String::new());
        assert!(s.entries[0].error.is_empty());
        s.push(n(1, 0, false), "a".into(), Gates::default(), &p, 0);
        s.set_error(b.instance, b.content, "stale".into());
        assert!(s.entries[0].error.is_empty());
    }
    #[test]
    fn cap_replaces_in_place_and_retires_old_action_identity() {
        let mut s = Stack::default();
        let p = Preferences::default();
        let g = Gates::default();
        for i in 1..=4 {
            s.push(n(i, -1, false), "a".into(), g, &p, 0);
        }
        let key = s.entries[1].instance;
        s.push(n(2, 1000, false), "other-output".into(), g, &p, 10);
        assert_eq!(s.entries[1].instance, key);
        assert_eq!(s.entries[1].output, "a");
        assert!(s.current(key, 1).is_none());
        s.push(n(5, -1, false), "a".into(), g, &p, 20);
        assert_eq!(
            s.entries.iter().map(|e| e.notice.id).collect::<Vec<_>>(),
            [2, 3, 4, 5]
        );
    }
    #[test]
    fn saturation_preserves_critical_until_every_slot_is_critical() {
        let mut s = Stack::default();
        let p = Preferences::default();
        let g = Gates::default();
        s.push(n(1, 0, true), "a".into(), g, &p, 0);
        for id in 2..=5 {
            s.push(n(id, 0, false), "a".into(), g, &p, id as u64);
        }
        assert_eq!(
            s.entries.iter().map(|b| b.notice.id).collect::<Vec<_>>(),
            [1, 3, 4, 5]
        );
        s.clear();
        for id in 10..=13 {
            s.push(n(id, 0, true), "a".into(), g, &p, id as u64);
        }
        s.push(n(14, 0, false), "a".into(), g, &p, 14);
        assert_eq!(
            s.entries.iter().map(|b| b.notice.id).collect::<Vec<_>>(),
            [11, 12, 13, 14]
        );
        s.push(n(15, 0, true), "a".into(), g, &p, 15);
        assert_eq!(
            s.entries.iter().map(|b| b.notice.id).collect::<Vec<_>>(),
            [11, 12, 13, 15]
        );
        s.push(n(16, 0, true), "a".into(), g, &p, 16);
        assert_eq!(
            s.entries.iter().map(|b| b.notice.id).collect::<Vec<_>>(),
            [12, 13, 15, 16]
        );
    }
    #[test]
    fn local_timeout_hover_and_critical_are_independent_of_daemon_dismissal() {
        let mut s = Stack::default();
        let p = Preferences::default();
        let g = Gates::default();
        s.push(n(1, 500, false), "a".into(), g, &p, 0);
        let key = s.entries[0].instance;
        s.hover(key, true, &p, 400);
        assert!(!s.expire(9999));
        s.hover(key, false, &p, 10000);
        assert_eq!(s.next_deadline(), Some(10500));
        assert!(!s.expire(10499));
        assert!(s.expire(10500));
        s.push(n(2, 1, true), "a".into(), g, &p, 0);
        s.push(n(3, 0, false), "a".into(), g, &p, 0);
        assert_eq!(s.next_deadline(), None);
        assert!(!s.expire(u64::MAX));
    }
    #[test]
    fn suppression_critical_exception_and_lock() {
        for gate in [
            Gates {
                panel: true,
                ..Default::default()
            },
            Gates {
                game: true,
                ..Default::default()
            },
        ] {
            let mut s = Stack::default();
            let p = Preferences::default();
            assert!(!s.push(n(1, -1, false), "a".into(), gate, &p, 0));
            assert!(s.push(n(2, 1, true), "a".into(), gate, &p, 0));
            assert!(s.gates(
                Gates {
                    locked: true,
                    ..gate
                },
                &p,
                1
            ));
            assert!(s.entries.is_empty());
        }
        let mut s = Stack::default();
        let p = Preferences {
            dnd: true,
            ..Default::default()
        };
        assert!(!s.push(n(1, -1, false), "a".into(), Gates::default(), &p, 0));
        assert!(s.push(n(2, -1, true), "a".into(), Gates::default(), &p, 0));
    }
    #[test]
    fn game_exit_grace_does_not_replay_suppressed_history() {
        let mut s = Stack::default();
        let p = Preferences::default();
        s.gates(
            Gates {
                game: true,
                ..Default::default()
            },
            &p,
            0,
        );
        s.gates(Gates::default(), &p, 10);
        assert!(!s.push(n(1, -1, false), "a".into(), Gates::default(), &p, 3009));
        assert!(s.push(n(2, -1, false), "a".into(), Gates::default(), &p, 3010));
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::*;
    #[test]
    fn suppressed_replacement_retires_the_old_critical_card() {
        let mut stack = Stack::default();
        let mut prefs = Preferences::default();
        let make = |urgency| {
            Notice::parse(&serde_json::json!({"id":9,"hints":{"urgency":urgency}}).to_string())
                .unwrap()
        };
        stack.push(make(2), "a".into(), Gates::default(), &prefs, 0);
        prefs.dnd = true;
        assert!(stack.push(make(1), "a".into(), Gates::default(), &prefs, 1));
        assert!(stack.entries.is_empty());
    }
}

#[cfg(test)]
mod text_tests {
    use super::*;
    #[test]
    fn entities_decode_only_from_original_source() {
        assert_eq!(
            plain_text("&#38;lt; &#x26;lt; &#38;amp; &amp;lt; &#38;#60; &lt;b&gt;text&lt;/b&gt;"),
            "&lt; &lt; &amp; &lt; &#60; <b>text</b>"
        );
        assert_eq!(
            plain_text("&#xD800; &#0; &#x110000; &broken; &#+60;"),
            "&#xD800; &#0; &#x110000; &broken; &#+60;"
        );
    }
    #[test]
    fn markup_is_plain_text_entities_decode_once_and_unicode_is_preserved() {
        assert_eq!(
            plain_text("<b>Hello</b> &lt;unsafe&gt; &amp;lt; &#x65E5;&#26412;\n  &#x1F600;"),
            "Hello <unsafe> &lt; 日本 😀"
        );
        assert_eq!(
            plain_text("literal < without end &bogus; &#0;"),
            "literal < without end &bogus; &#0;"
        );
    }
}
