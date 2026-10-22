// SPDX-License-Identifier: LGPL-3.0-or-later
//! A setting's value as `Config1` carries it: the registry has three types, and the service
//! sends them as `b`, `d` and `s` (`ui/shell/core/ConfigService.ts`, `variant`).

use zbus::zvariant::{OwnedValue, Value as Variant};

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Bool(bool),
    /// Every number is a double on the wire, integers included (`nightlight.temperature`).
    Number(f64),
    /// Enums and strings alike: an enum is a string the schema lists the choices of.
    Text(String),
}

impl Value {
    /// From the schema's JSON (`Snapshot`): the `value` field of a key.
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        match v {
            serde_json::Value::Bool(b) => Some(Self::Bool(*b)),
            serde_json::Value::Number(n) => n.as_f64().map(Self::Number),
            serde_json::Value::String(s) => Some(Self::Text(s.clone())),
            _ => None,
        }
    }

    /// From a D-Bus variant (`Updated`, `Apply`'s answer). Integers are accepted too, though
    /// the service sends none: a value is a value whatever width carried it.
    pub fn from_variant(v: &Variant<'_>) -> Option<Self> {
        Some(match v {
            Variant::Bool(b) => Self::Bool(*b),
            Variant::F64(n) => Self::Number(*n),
            Variant::I32(n) => Self::Number(*n as f64),
            Variant::U32(n) => Self::Number(*n as f64),
            Variant::I64(n) => Self::Number(*n as f64),
            Variant::U64(n) => Self::Number(*n as f64),
            Variant::Str(s) => Self::Text(s.as_str().to_owned()),
            Variant::Value(inner) => return Self::from_variant(inner),
            _ => return None,
        })
    }

    pub fn to_variant(&self) -> OwnedValue {
        match self {
            Self::Bool(b) => OwnedValue::from(*b),
            Self::Number(n) => OwnedValue::from(*n),
            Self::Text(s) => OwnedValue::try_from(Variant::from(s.as_str()))
                .expect("a string variant holds no file descriptor"),
        }
    }

    /// The text a manifest predicate compares (`visibleWhen: {key, in: ["true"]}`): what
    /// JavaScript's `String(value)` gives, which is what the legacy Settings compares —
    /// `true`, `4500` (not `4500.0`), `0.5`, the string itself.
    pub fn predicate_text(&self) -> String {
        match self {
            Self::Bool(b) => b.to_string(),
            Self::Number(n) => n.to_string(),
            Self::Text(s) => s.clone(),
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predicate_text_is_javascripts_string() {
        assert_eq!(Value::Bool(false).predicate_text(), "false");
        assert_eq!(Value::Number(4500.0).predicate_text(), "4500");
        assert_eq!(Value::Number(0.5).predicate_text(), "0.5");
        assert_eq!(Value::Number(-3.0).predicate_text(), "-3");
        assert_eq!(Value::Text("left".into()).predicate_text(), "left");
    }

    #[test]
    fn round_trips_through_a_variant() {
        for v in [
            Value::Bool(true),
            Value::Number(4500.0),
            Value::Text("tinted".into()),
        ] {
            let owned = v.to_variant();
            assert_eq!(Value::from_variant(&owned), Some(v));
        }
        assert_eq!(
            Value::from_variant(&Variant::from(7u32)),
            Some(Value::Number(7.0))
        );
        assert_eq!(Value::from_variant(&Variant::from(vec![1u8])), None);
    }
}
