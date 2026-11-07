// SPDX-License-Identifier: LGPL-3.0-or-later
//! A bounded-lifetime Network1 secrets renderer. Its private connection owns the
//! registration; leaving the Wi-Fi detail closes it and withdraws every question.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::mpsc::{self, Receiver, Sender},
    time::Duration,
};
use zbus::{
    MatchRule,
    blocking::{Connection, MessageIterator},
    message::Type,
    zvariant::OwnedValue,
};
struct Close(Connection);
impl Drop for Close {
    fn drop(&mut self) {
        let _ = self.0.clone().close();
    }
}
const DEST: &str = "org.nidara.Network";
const PATH: &str = "/org/nidara/Network";
const IFACE: &str = "org.nidara.Network1";

pub enum Event {
    Ready,
    Prompt(u64, Value),
    Closed(u64),
    Error(String),
}
enum Input {
    Bus(zbus::Message),
    Submit(u64, Secrets),
    Cancel(u64),
    Close,
}
type Secrets = HashMap<String, HashMap<String, OwnedValue>>;
pub struct Auth {
    tx: Sender<Input>,
    pub events: Receiver<Event>,
}
impl Auth {
    pub fn new(waker: nk_wayland::Waker) -> Self {
        let (tx, rx) = mpsc::channel();
        let (out, events) = mpsc::channel();
        let input = tx.clone();
        let _ = std::thread::Builder::new()
            .name("cc-secrets".into())
            .spawn(move || {
                let emit = |event| {
                    let _ = out.send(event);
                    let _ = waker.wake();
                };
                let work = || -> Result<(), String> {
                    let conn = zbus::blocking::connection::Builder::session()
                        .map_err(|e| e.to_string())?
                        .method_timeout(Duration::from_secs(5))
                        .build()
                        .map_err(|e| e.to_string())?;
                    let _close = Close(conn.clone());
                    let rule = MatchRule::builder()
                        .msg_type(Type::Signal)
                        .sender(DEST)
                        .map_err(|e| e.to_string())?
                        .interface(IFACE)
                        .map_err(|e| e.to_string())?
                        .path(PATH)
                        .map_err(|e| e.to_string())?
                        .build();
                    let messages = MessageIterator::for_match_rule(rule, &conn, Some(64))
                        .map_err(|e| e.to_string())?;
                    let owners = MessageIterator::for_match_rule(
                        MatchRule::builder()
                            .msg_type(Type::Signal)
                            .sender("org.freedesktop.DBus")
                            .map_err(|e| e.to_string())?
                            .interface("org.freedesktop.DBus")
                            .map_err(|e| e.to_string())?
                            .member("NameOwnerChanged")
                            .map_err(|e| e.to_string())?
                            .add_arg(DEST)
                            .map_err(|e| e.to_string())?
                            .build(),
                        &conn,
                        Some(8),
                    )
                    .map_err(|e| e.to_string())?;
                    let owner: String = conn
                        .call_method(
                            Some("org.freedesktop.DBus"),
                            "/org/freedesktop/DBus",
                            Some("org.freedesktop.DBus"),
                            "GetNameOwner",
                            &(DEST,),
                        )
                        .map_err(|e| e.to_string())?
                        .body()
                        .deserialize()
                        .map_err(|e| e.to_string())?;
                    for messages in [messages, owners] {
                        let sender = input.clone();
                        let _ = std::thread::Builder::new()
                            .name("cc-secret-signals".into())
                            .spawn(move || {
                                for msg in messages.flatten() {
                                    if sender.send(Input::Bus(msg)).is_err() {
                                        break;
                                    }
                                }
                            });
                    }
                    let call = |method: &str, id: u64| {
                        conn.call_method(Some(owner.as_str()), PATH, Some(IFACE), method, &(id,))
                            .map(|_| ())
                            .map_err(|e| e.to_string())
                    };
                    conn.call_method(
                        Some(owner.as_str()),
                        PATH,
                        Some(IFACE),
                        "RegisterSecretsUi",
                        &(),
                    )
                    .map_err(|e| e.to_string())?;
                    emit(Event::Ready);
                    let mut pending = None;
                    while let Ok(input) = rx.recv() {
                        match input {
                            Input::Close => {
                                // Closing the renderer withdraws pending prompts without
                                // claiming that NM's user-cancellation button was pressed.
                                break;
                            }
                            Input::Cancel(id) if pending == Some(id) => {
                                call("CancelSecrets", id)?;
                                pending = None;
                                emit(Event::Closed(id));
                            }
                            Input::Submit(id, values) if pending == Some(id) => {
                                conn.call_method(
                                    Some(owner.as_str()),
                                    PATH,
                                    Some(IFACE),
                                    "SubmitSecrets",
                                    &(id, values),
                                )
                                .map_err(|e| e.to_string())?;
                                pending = None;
                                emit(Event::Closed(id));
                            }
                            Input::Bus(msg) => {
                                let h = msg.header();
                                if h.sender()
                                    .is_some_and(|s| s.as_str() == "org.freedesktop.DBus")
                                    && h.interface()
                                        .is_some_and(|i| i.as_str() == "org.freedesktop.DBus")
                                    && h.member().is_some_and(|m| m.as_str() == "NameOwnerChanged")
                                    && let Ok((name, old, _)) =
                                        msg.body().deserialize::<(String, String, String)>()
                                    && name == DEST
                                    && old == owner
                                {
                                    return Err("network service replaced; reopen Wi-Fi".into());
                                }
                                if h.sender().is_none_or(|s| s.as_str() != owner)
                                    || h.path().is_none_or(|p| p.as_str() != PATH)
                                    || h.interface().is_none_or(|i| i.as_str() != IFACE)
                                {
                                    continue;
                                }
                                match h.member().map(|m| m.as_str()) {
                                    Some("SecretsRequested") => {
                                        if let Ok((id, json)) =
                                            msg.body().deserialize::<(u64, String)>()
                                            && let Ok(meta) = serde_json::from_str(&json)
                                        {
                                            pending = Some(id);
                                            emit(Event::Prompt(id, meta));
                                        }
                                    }
                                    Some("SecretsClosed") => {
                                        if let Ok((id, _)) =
                                            msg.body().deserialize::<(u64, String)>()
                                            && pending == Some(id)
                                        {
                                            pending = None;
                                            emit(Event::Closed(id));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }
                    let _ = conn.close();
                    Ok(())
                };
                if let Err(error) = work() {
                    emit(Event::Error(error));
                }
            });
        Self { tx, events }
    }
    pub fn submit(&self, id: u64, setting: String, values: Vec<(String, String)>) {
        let values = values
            .into_iter()
            .map(|(key, text)| {
                let value = if key == "password-raw" {
                    zbus::zvariant::Value::from(text.into_bytes())
                        .try_into()
                        .expect("owned byte array")
                } else {
                    OwnedValue::from(zbus::zvariant::Str::from(text))
                };
                (key, value)
            })
            .collect();
        let _ = self
            .tx
            .send(Input::Submit(id, HashMap::from([(setting, values)])));
    }
    pub fn cancel(&self, id: u64) {
        let _ = self.tx.send(Input::Cancel(id));
    }
}
impl Drop for Auth {
    fn drop(&mut self) {
        let _ = self.tx.send(Input::Close);
    }
}

/// No Debug implementation: values must never enter error/act diagnostics.
pub struct Form {
    pub id: u64,
    pub setting: String,
    pub name: String,
    pub identity: String,
    pub retry: bool,
    pub edit_serial: u64,
    pub fields: Vec<Field>,
    pub focused: usize,
}
pub struct Field {
    pub key: String,
    pub text: String,
    pub caret: usize,
    pub anchor: usize,
}
impl Form {
    pub fn new(id: u64, meta: &Value) -> Option<Self> {
        let setting = meta["setting"].as_str()?;
        let allowed: &[&str] = match setting {
            "802-11-wireless-security" => &[
                "psk",
                "wep-key0",
                "wep-key1",
                "wep-key2",
                "wep-key3",
                "leap-password",
            ],
            "802-1x" => &[
                "password",
                "password-raw",
                "private-key-password",
                "phase2-private-key-password",
                "pin",
            ],
            _ => return None,
        };
        let mut keys: Vec<String> = meta["hints"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| h.as_str())
            .filter(|h| allowed.contains(h))
            .map(str::to_owned)
            .collect();
        if keys.is_empty() {
            let profile = &meta["profile"][setting];
            keys.push(if setting == "802-1x" {
                if profile["eap"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|m| m == "tls"))
                {
                    "private-key-password".into()
                } else {
                    "password".into()
                }
            } else {
                match profile["key-mgmt"].as_str().unwrap_or("") {
                    "wpa-psk" | "sae" => "psk".into(),
                    "ieee8021x" => "leap-password".into(),
                    "none" => format!(
                        "wep-key{}",
                        profile["wep-tx-keyidx"].as_u64().unwrap_or(0).min(3)
                    ),
                    _ => return None,
                }
            });
        }
        keys.sort();
        keys.dedup();
        Some(Self {
            id,
            setting: setting.into(),
            name: meta["name"].as_str().unwrap_or("").to_owned(),
            identity: meta["profile"]["802-1x"]["identity"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            retry: meta["retry"].as_bool().unwrap_or(false),
            edit_serial: 0,
            focused: 0,
            fields: keys
                .into_iter()
                .map(|key| Field {
                    key,
                    text: String::new(),
                    caret: 0,
                    anchor: 0,
                })
                .collect(),
        })
    }
    pub fn focus(&mut self, index: usize) {
        if index < self.fields.len() && index != self.focused {
            self.focused = index;
            self.edit_serial += 1;
        }
    }
    pub fn paste_tag(&self) -> (u64, usize, u64) {
        (self.id, self.focused, self.edit_serial)
    }
    pub fn paste(&mut self, tag: (u64, usize, u64), text: &str) -> bool {
        if tag != self.paste_tag() {
            return false;
        }
        self.key(&nk_wayland::Key {
            serial: None,
            sym: 0,
            text: text.trim_end_matches(['\r', '\n']).into(),
            shift: false,
            ctrl: false,
            alt: false,
        });
        true
    }
    pub fn replace(&mut self, index: usize, text: &str) {
        if text.len() > 4096 || text.chars().any(char::is_control) {
            return;
        }
        if let Some(f) = self.fields.get_mut(index) {
            self.edit_serial += 1;
            f.text = text.into();
            f.caret = text.len();
            f.anchor = f.caret;
        }
    }
    pub fn selection(&mut self, index: usize, range: std::ops::Range<usize>) {
        if let Some(f) = self.fields.get_mut(index)
            && range.end <= f.text.len()
            && f.text.is_char_boundary(range.start)
            && f.text.is_char_boundary(range.end)
        {
            self.edit_serial += 1;
            f.anchor = range.start;
            f.caret = range.end;
        }
    }
    pub fn key(&mut self, key: &nk_wayland::Key) {
        self.edit_serial += 1;
        use unicode_segmentation::UnicodeSegmentation;
        let f = &mut self.fields[self.focused];
        if key.ctrl && (key.sym == b'a' as u32 || key.sym == b'A' as u32) {
            f.anchor = 0;
            f.caret = f.text.len();
            return;
        }
        let low = f.anchor.min(f.caret);
        let high = f.anchor.max(f.caret);
        match key.sym {
            0xff08 | 0xffff => {
                let range = if low != high {
                    low..high
                } else if key.sym == 0xff08 {
                    f.text[..low]
                        .grapheme_indices(true)
                        .next_back()
                        .map(|(i, _)| i)
                        .unwrap_or(low)..high
                } else {
                    low..f.text[high..]
                        .graphemes(true)
                        .next()
                        .map(|g| high + g.len())
                        .unwrap_or(high)
                };
                f.caret = range.start;
                f.anchor = f.caret;
                f.text.replace_range(range, "");
            }
            0xff51 | 0xff53 | 0xff50 | 0xff57 => {
                f.caret = match key.sym {
                    0xff50 => 0,
                    0xff57 => f.text.len(),
                    0xff51 => f.text[..f.caret]
                        .grapheme_indices(true)
                        .next_back()
                        .map(|(i, _)| i)
                        .unwrap_or(0),
                    _ => f.text[f.caret..]
                        .graphemes(true)
                        .next()
                        .map(|g| f.caret + g.len())
                        .unwrap_or(f.text.len()),
                };
                if !key.shift {
                    f.anchor = f.caret;
                }
            }
            _ if !key.ctrl
                && !key.alt
                && !key.text.is_empty()
                && !key.text.chars().any(char::is_control)
                && f.text.len() - (high - low) + key.text.len() <= 4096 =>
            {
                f.text.replace_range(low..high, &key.text);
                f.caret = low + key.text.len();
                f.anchor = f.caret;
            }
            _ => {}
        }
    }
    pub fn take(&mut self) -> Vec<(String, String)> {
        self.fields
            .iter_mut()
            .map(|f| (f.key.clone(), std::mem::take(&mut f.text)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn prompt_fields_are_allowlisted_and_wep_uses_its_actual_slot() {
        let f = Form::new(
            1,
            &json!({"setting":"802-11-wireless-security","hints":["psk","uuid","identity","psk"]}),
        )
        .unwrap();
        assert_eq!(f.fields.len(), 1);
        assert_eq!(f.fields[0].key, "psk");
        let f=Form::new(2,&json!({"setting":"802-11-wireless-security","profile":{"802-11-wireless-security":{"key-mgmt":"none","wep-tx-keyidx":2}}})).unwrap();
        assert_eq!(f.fields[0].key, "wep-key2");
        assert!(Form::new(3, &json!({"setting":"vpn","hints":["password"]})).is_none());
        assert!(Form::new(4,&json!({"setting":"802-11-wireless-security","profile":{"802-11-wireless-security":{"key-mgmt":"unsupported"}}})).is_none());
    }
    #[test]
    fn late_paste_cannot_cross_a_question_field_or_edit() {
        let request = json!({"setting":"802-1x","hints":["password","private-key-password"]});
        let mut form = Form::new(1, &request).unwrap();
        let tag = form.paste_tag();
        form.focus(1);
        assert!(!form.paste(tag, "old field"));
        form.focus(0);
        assert!(!form.paste(tag, "old focus"));
        let tag = form.paste_tag();
        form.replace(0, "typed");
        assert!(!form.paste(tag, "old edit"));
        let tag = form.paste_tag();
        let mut replacement = Form::new(2, &request).unwrap();
        assert!(!replacement.paste(tag, "old question"));
        assert!(form.paste(tag, "日本\n"));
        assert_eq!(form.fields[0].text, "typed日本");
    }
    #[test]
    fn password_editing_has_bounded_unicode_selection_and_no_cut_or_copy_path() {
        let mut f = Form::new(1, &json!({"setting":"802-1x","hints":["password"]})).unwrap();
        f.replace(0, "a日本🙂");
        let key = |sym, text: &str, ctrl| nk_wayland::Key {
            serial: None,
            sym,
            text: text.into(),
            ctrl,
            shift: false,
            alt: false,
        };
        f.key(&key(0xff08, "", false));
        assert_eq!(f.fields[0].text, "a日本");
        f.selection(0, 1..7);
        f.key(&key(0, "é", false));
        assert_eq!(f.fields[0].text, "aé");
        f.key(&key(b'a' as u32, "", true));
        f.key(&key(0, "new", false));
        assert_eq!(f.fields[0].text, "new");
        f.replace(0, &"x".repeat(4097));
        assert_eq!(f.fields[0].text, "new");
        assert_eq!(f.take(), vec![("password".into(), "new".into())]);
        assert_eq!(f.fields[0].text, "");
    }
}
