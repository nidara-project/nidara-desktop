// SPDX-License-Identifier: LGPL-3.0-or-later
//! Manual Wi-Fi profiles. Network1 handles activation and storage.
use super::{ChoiceContext, button, group, item_text};
use crate::exports::Exports;
use nk::{Node, Secret, Space, Type, TypeScale, Value, Weight};
use std::{collections::HashMap, path::PathBuf};
use zbus::zvariant::{OwnedValue, Value as Wire};

pub type Profile = HashMap<String, HashMap<String, OwnedValue>>;
const SECURITY: [&str; 4] = [
    "settings.network.security.open",
    "settings.network.join.wpa2",
    "settings.network.join.wpa3",
    "settings.network.security.enterprise",
];
const EAP: [&str; 2] = ["PEAP / MSCHAPv2", "TTLS / PAP"];
pub(super) const CERTIFICATES: &[&str] = &[
    "application/x-x509-ca-cert",
    "application/x-pem-file",
    "application/pkix-cert",
    "application/x-x509-user-cert",
    "application/octet-stream",
];

pub(super) struct Join {
    pub id: u64,
    pub device: String,
    pub ap: String,
    ssid: String,
    original: Option<Vec<u8>>,
    security: usize,
    method: usize,
    identity: String,
    password: Option<Secret>,
    pub certificate: Option<PathBuf>,
    pub busy: bool,
}

impl Join {
    pub fn new(id: u64, device: &str, ap: Option<&serde_json::Value>) -> Self {
        Self {
            id,
            device: device.into(),
            ap: ap.map_or("/", |ap| item_text(ap, "path")).into(),
            ssid: ap.map_or("", |ap| item_text(ap, "label")).into(),
            original: ap.and_then(|ap| ap["ssid"].as_array()).and_then(|bytes| {
                bytes
                    .iter()
                    .map(|byte| u8::try_from(byte.as_u64()?).ok())
                    .collect()
            }),
            security: if ap.is_some() { 3 } else { 0 },
            method: 0,
            identity: String::new(),
            password: None,
            certificate: None,
            busy: false,
        }
    }

    fn enterprise(&self) -> bool {
        self.security == 3
    }

    fn ssid(&self) -> &[u8] {
        self.original.as_deref().unwrap_or(self.ssid.as_bytes())
    }

    fn cert(&self) -> Option<&str> {
        let cert = self.certificate.as_deref()?;
        if !cert.is_absolute() {
            return None;
        }
        cert.to_str()
    }

    fn valid(&self) -> bool {
        let password = self.password.as_ref().map_or("", Secret::as_str);
        (1..=32).contains(&self.ssid().len())
            && match self.security {
                0 => true,
                1 => {
                    (8..=63).contains(&password.len())
                        || password.len() == 64
                            && password.bytes().all(|byte| byte.is_ascii_hexdigit())
                }
                2 => (1..=63).contains(&password.len()),
                3 => {
                    !self.identity.trim().is_empty()
                        && !password.is_empty()
                        && self.cert().is_some()
                }
                _ => false,
            }
    }

    pub(super) fn input(&mut self, field: &str, value: Option<&Value>) {
        if self.busy {
            return;
        }
        match (field, value) {
            ("ssid", Some(Value::Text(ssid))) if self.original.is_none() => {
                self.ssid.clone_from(ssid)
            }
            ("security", Some(Value::Index(index)))
                if self.original.is_none() && *index < SECURITY.len() =>
            {
                if self.security != *index {
                    self.password = None;
                    self.security = *index;
                }
            }
            ("method", Some(Value::Index(index))) if *index < EAP.len() => self.method = *index,
            ("identity", Some(Value::Text(identity))) => self.identity.clone_from(identity),
            ("password", Some(Value::Secret(password))) => self.password = Some(password.clone()),
            _ => {}
        }
    }

    pub(super) fn profile(&self) -> Option<Profile> {
        if !self.valid() {
            return None;
        }
        let mut profile = Profile::from([
            (
                "connection".into(),
                props([
                    ("id", Wire::from(self.ssid.clone())),
                    ("type", Wire::from("802-11-wireless")),
                ]),
            ),
            (
                "802-11-wireless".into(),
                props([
                    ("ssid", Wire::from(self.ssid().to_vec())),
                    ("mode", Wire::from("infrastructure")),
                    ("hidden", Wire::from(self.ap == "/")),
                ]),
            ),
        ]);
        let password = self.password.as_ref().map_or("", Secret::as_str);
        match self.security {
            1 | 2 => {
                let method = if self.security == 1 { "wpa-psk" } else { "sae" };
                profile.insert(
                    "802-11-wireless-security".into(),
                    props([
                        ("key-mgmt", Wire::from(method)),
                        ("psk", Wire::from(password)),
                        ("psk-flags", Wire::from(1u32)),
                    ]),
                );
            }
            3 => {
                let (method, inner) = if self.method == 0 {
                    ("peap", "mschapv2")
                } else {
                    ("ttls", "pap")
                };
                let certificate = format!("file://{}\0", self.cert()?).into_bytes();
                profile.insert(
                    "802-11-wireless-security".into(),
                    props([("key-mgmt", Wire::from("wpa-eap"))]),
                );
                profile.insert(
                    "802-1x".into(),
                    props([
                        ("eap", Wire::from(vec![method])),
                        ("identity", Wire::from(self.identity.trim())),
                        ("password", Wire::from(password)),
                        ("password-flags", Wire::from(1u32)),
                        ("phase2-auth", Wire::from(inner)),
                        ("ca-cert", Wire::from(certificate)),
                    ]),
                );
            }
            _ => {}
        }
        Some(profile)
    }

    pub(super) fn rows(
        &self,
        cx: &ChoiceContext<'_>,
        types: &TypeScale,
        e: &Exports,
        error: Option<&str>,
    ) -> Result<Vec<Node>, String> {
        let body = || types.style(Type::Body, Weight::Regular);
        let key = format!("network/join/{}", self.id);
        let action = |field| cx.action("join-edit", field, "");
        let list_row = |field: &str, title: &str, control: Node| {
            nk::ListRow::new(format!("{key}/{field}/row"), title, body())
                .trailing(control)
                .into()
        };
        let ssid = e.text("settings.network.join.ssid")?;
        let security = e.text("settings.network.detail.security")?;
        let labels = SECURITY
            .iter()
            .map(|key| e.text(key).map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?;
        let mut fields = vec![
            list_row(
                "ssid",
                ssid,
                nk::Entry::new(format!("{key}/ssid"), ssid, action("ssid"), &self.ssid)
                    .enabled(!self.busy && self.original.is_none())
                    .into(),
            ),
            list_row(
                "security",
                security,
                nk::DropDown::new(
                    format!("{key}/security"),
                    security,
                    action("security"),
                    labels,
                    self.security,
                )
                .enabled(!self.busy && self.original.is_none())
                .into(),
            ),
        ];
        if self.enterprise() {
            let method = e.text("settings.network.join.eap")?;
            let identity = e.text("settings.network.join.identity")?;
            let cert = e.text("settings.network.join.ca")?;
            let filename = self
                .certificate
                .as_ref()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str())
                .unwrap_or(e.text("settings.network.label.none")?);
            fields.extend([
                list_row(
                    "method",
                    method,
                    nk::DropDown::new(
                        format!("{key}/method"),
                        method,
                        action("method"),
                        EAP.map(str::to_owned).to_vec(),
                        self.method,
                    )
                    .enabled(!self.busy)
                    .into(),
                ),
                list_row(
                    "identity",
                    identity,
                    nk::Entry::new(
                        format!("{key}/identity"),
                        identity,
                        action("identity"),
                        &self.identity,
                    )
                    .enabled(!self.busy)
                    .into(),
                ),
                nk::ListRow::new(format!("{key}/ca/row"), cert, body())
                    .subtitle(filename, types.style(Type::Small, Weight::Regular))
                    .trailing(button(
                        &format!("{key}/ca"),
                        "settings.native.select",
                        cx.action("join-certificate", "", ""),
                        !self.busy,
                        types,
                        e,
                    )?)
                    .into(),
            ]);
        }
        if self.security != 0 {
            let password = e.text("settings.network.join.password")?;
            fields.push(list_row(
                "password",
                password,
                nk::PasswordEntry::new(
                    format!("{key}/password/{}", self.security),
                    password,
                    action("password"),
                )
                .enabled(!self.busy)
                .into(),
            ));
        }
        let mut rows = Vec::new();
        group(
            &mut rows,
            &key,
            "settings.network.ap.other",
            fields,
            types,
            e,
        )?;
        if let Some(error) = error {
            rows.push(super::label(&format!("{key}/error"), error, types, e)?);
        }
        rows.push(
            nk::Row::new(
                format!("{key}/actions"),
                vec![
                    button(
                        &format!("{key}/back"),
                        "settings.native.cancel",
                        cx.action("join-back", "", ""),
                        !self.busy,
                        types,
                        e,
                    )?,
                    button(
                        &format!("{key}/apply"),
                        if self.busy {
                            "settings.network.ap.connecting"
                        } else {
                            "settings.network.ap.connect"
                        },
                        cx.action("join-apply", "", ""),
                        !self.busy && self.valid(),
                        types,
                        e,
                    )?,
                ],
            )
            .gap(Space::S2)
            .into(),
        );
        Ok(rows)
    }
}

fn props<const N: usize>(values: [(&str, Wire<'_>); N]) -> HashMap<String, OwnedValue> {
    values
        .into_iter()
        .map(|(key, value)| {
            (
                key.into(),
                value
                    .try_into()
                    .expect("Wi-Fi profile fields contain no file descriptors"),
            )
        })
        .collect()
}
