// SPDX-License-Identifier: LGPL-3.0-or-later
//! Allowlisted Network1 secret fields for the shell prompt.
use serde_json::Value;
use std::collections::HashMap;
use zbus::zvariant::{OwnedValue, Str};

/// No Debug implementation: values must never enter error/act diagnostics.
pub struct Form {
    pub setting: String,
    pub name: String,
    pub identity: String,
    pub retry: bool,
    pub fields: Vec<Field>,
}
pub struct Field {
    pub key: String,
    pub value: Option<nk::Secret>,
}
impl Form {
    pub fn new(meta: &Value) -> Option<Self> {
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
            setting: setting.into(),
            name: meta["name"].as_str().unwrap_or("").to_owned(),
            identity: meta["profile"]["802-1x"]["identity"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            retry: meta["retry"].as_bool().unwrap_or(false),
            fields: keys
                .into_iter()
                .map(|key| Field { key, value: None })
                .collect(),
        })
    }
    pub fn ready(&self) -> bool {
        self.fields
            .iter()
            .all(|f| f.value.as_ref().is_some_and(|v| !v.as_str().is_empty()))
    }

    pub fn values(&self) -> super::prompts::Secrets {
        let fields = self
            .fields
            .iter()
            .filter_map(|field| {
                let text = field.value.as_ref()?.as_str();
                let value = if field.key == "password-raw" {
                    zbus::zvariant::Value::from(text.as_bytes().to_vec())
                        .try_into()
                        .expect("owned byte array")
                } else {
                    OwnedValue::from(Str::from(text.to_owned()))
                };
                Some((field.key.clone(), value))
            })
            .collect();
        HashMap::from([(self.setting.clone(), fields)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn prompt_fields_are_allowlisted_and_wep_uses_its_actual_slot() {
        let f = Form::new(
            &json!({"setting":"802-11-wireless-security","hints":["psk","uuid","identity","psk"]}),
        )
        .unwrap();
        assert_eq!(f.fields.len(), 1);
        assert_eq!(f.fields[0].key, "psk");
        let f=Form::new(&json!({"setting":"802-11-wireless-security","profile":{"802-11-wireless-security":{"key-mgmt":"none","wep-tx-keyidx":2}}})).unwrap();
        assert_eq!(f.fields[0].key, "wep-key2");
        assert!(Form::new(&json!({"setting":"vpn","hints":["password"]})).is_none());
        assert!(Form::new(&json!({"setting":"802-11-wireless-security","profile":{"802-11-wireless-security":{"key-mgmt":"unsupported"}}})).is_none());
    }
}
