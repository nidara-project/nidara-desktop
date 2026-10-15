// The wire/store shape is Notification.serialize() in the shell. Keep history from
// the GJS server readable, including insertion order and scalar hints only.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use zbus::zvariant::OwnedValue;

pub const MAX_ID: u32 = 0x7fff_ffff;
pub const CAPABILITIES: [&str; 6] = [
    "actions",
    "body",
    "body-markup",
    "body-images",
    "icon-static",
    "persistence",
];
// Each capability is a promise: no sound (the sender would suppress its own),
// hyperlinks (cards discard URLs in markup), or action-icons (buttons draw labels).

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Action {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Notification {
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
    #[serde(default = "now")]
    pub time: u64,
    #[serde(default)]
    pub hints: Map<String, Value>,
    #[serde(default)]
    pub actions: Vec<Action>,
}
fn default_timeout() -> i32 {
    -1
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Match JS truthiness: some senders use integer hints rather than booleans.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(v)) => !v.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
        _ => false,
    }
}

pub fn scalar_hints(hints: &HashMap<String, OwnedValue>) -> Map<String, Value> {
    hints
        .iter()
        .filter_map(|(key, value)| {
            if matches!(key.as_str(), "image-data" | "image_data" | "icon_data") {
                return None;
            }
            // Don't serialize zvariant's tagged JSON representation. These are plain
            // values on disk, exactly as GJS recursiveUnpack + serialize wrote them.
            let v = match &**value {
                zbus::zvariant::Value::Str(v) => Value::from(v.as_str()),
                zbus::zvariant::Value::Bool(v) => Value::from(*v),
                zbus::zvariant::Value::U8(v) => Value::from(*v),
                zbus::zvariant::Value::I16(v) => Value::from(*v),
                zbus::zvariant::Value::U16(v) => Value::from(*v),
                zbus::zvariant::Value::I32(v) => Value::from(*v),
                zbus::zvariant::Value::U32(v) => Value::from(*v),
                zbus::zvariant::Value::I64(v) => Value::from(*v),
                zbus::zvariant::Value::U64(v) => Value::from(*v),
                zbus::zvariant::Value::F64(v) => Value::from(*v),
                _ => return None,
            };
            Some((key.clone(), v))
        })
        .collect()
}

pub fn actions(flat: Vec<String>) -> Vec<Action> {
    flat.as_chunks::<2>()
        .0
        .iter()
        .map(|pair| Action {
            id: pair[0].clone(),
            label: pair[1].clone(),
        })
        .collect()
}

// Bound allocation as well as adoption. A malicious replaces_id must never push
// the sequence through uint32; at the ceiling search the unused lower ids.
pub fn allocate(notifications: &[Notification], next: &mut u32, replaces_id: u32) -> u32 {
    let id = if replaces_id > 0 && replaces_id <= MAX_ID {
        replaces_id
    } else {
        while notifications.iter().any(|n| n.id == *next) {
            *next = if *next >= MAX_ID { 1 } else { *next + 1 };
        }
        *next
    };
    if id >= *next {
        *next = if id >= MAX_ID { 1 } else { id + 1 };
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adopts_resolved_ids_and_wraps_without_overflow() {
        let mut next = 1;
        assert_eq!(allocate(&[], &mut next, 45), 45);
        assert_eq!(next, 46);
        assert_eq!(allocate(&[], &mut next, u32::MAX), 46);
        assert_eq!(allocate(&[], &mut next, MAX_ID), MAX_ID);
        assert_eq!(allocate(&[], &mut next, 0), 1);
    }
    #[test]
    fn old_store_defaults_and_actions() {
        let n: Notification = serde_json::from_str(r#"{"id":7}"#).unwrap();
        assert_eq!(n.expire_timeout, -1);
        assert_eq!(
            actions(vec!["a".into(), "label".into(), "odd".into()]).len(),
            1
        );
        assert!(truthy(Some(&Value::from(1))));
        assert!(!truthy(Some(&Value::from(0))));
    }
}
