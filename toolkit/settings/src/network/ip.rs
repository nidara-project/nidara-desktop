// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Network1 IP form and AppWindow controls.
use crate::exports::Exports;
use nk::{Node, Space, Type, TypeScale, Value, Weight};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr};

use super::{ChoiceContext, button, group, item_text};

const V4: &[&str] = &["auto", "manual", "link-local", "shared", "disabled"];
const V6: &[&str] = &["auto", "dhcp", "manual", "link-local", "shared", "disabled"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Family {
    pub method: String,
    pub address: String,
    pub prefix: String,
    pub gateway: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Form {
    pub v4: Family,
    pub v6: Family,
    pub dns: String,
    pub search: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub device: String,
    pub uuid: String,
    pub name: String,
}

pub struct Editor {
    pub target: Target,
    pub saved: Option<Form>,
    pub draft: Option<Form>,
    pub busy: bool,
    pub failed: bool,
}

fn list(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .filter(|part| !part.is_empty())
}

fn valid_address(value: &str, v6: bool) -> bool {
    value
        .trim()
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_ipv6() == v6)
}

fn valid_prefix(value: &str, v6: bool) -> bool {
    let value = value.trim();
    if let Ok(prefix) = value.parse::<u32>() {
        return (1..=if v6 { 128 } else { 32 }).contains(&prefix)
            && (v6 || value.len() <= 2 && value.bytes().all(|byte| byte.is_ascii_digit()));
    }
    !v6 && value.parse::<Ipv4Addr>().is_ok_and(|mask| {
        let bits = u32::from(mask);
        bits != 0 && bits == u32::MAX << bits.trailing_zeros()
    })
}

fn valid_domain(value: &str) -> bool {
    let domain = value.strip_suffix('.').unwrap_or(value);
    value.len() <= 253
        && domain.split('.').all(|label| {
            let bytes = label.as_bytes();
            (1..=63).contains(&bytes.len())
                && bytes[0].is_ascii_alphanumeric()
                && bytes[bytes.len() - 1].is_ascii_alphanumeric()
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
        })
}

fn family_errors(family: &Family, v6: bool) -> [Option<&'static str>; 3] {
    if family.method != "manual" {
        return [None; 3];
    }
    [
        (!valid_address(&family.address, v6)).then_some("settings.network.ip.error.address"),
        (!valid_prefix(&family.prefix, v6)).then_some(if v6 {
            "settings.network.ip.error.prefix"
        } else {
            "settings.network.ip.error.mask"
        }),
        (!family.gateway.trim().is_empty() && !valid_address(&family.gateway, v6))
            .then_some("settings.network.ip.error.router"),
    ]
}

impl Form {
    fn dns_error(&self) -> Option<&'static str> {
        list(&self.dns)
            .any(|address| address.parse::<IpAddr>().is_err())
            .then_some("settings.network.ip.error.dns")
    }

    fn search_error(&self) -> Option<&'static str> {
        list(&self.search)
            .any(|domain| !valid_domain(domain))
            .then_some("settings.network.ip.error.search")
    }

    pub(super) fn valid(&self) -> bool {
        self.dns_error().is_none()
            && self.search_error().is_none()
            && family_errors(&self.v4, false)
                .into_iter()
                .chain(family_errors(&self.v6, true))
                .all(|e| e.is_none())
    }

    fn changed(&self, saved: &Self) -> bool {
        let family_changed =
            |a: &Family, b: &Family| a.method != b.method || (a.method == "manual" && a != b);
        family_changed(&self.v4, &saved.v4)
            || family_changed(&self.v6, &saved.v6)
            || list(&self.dns).ne(list(&saved.dns))
            || list(&self.search).ne(list(&saved.search))
    }
}

fn methods(v6: bool, allow_ignore: bool) -> impl Iterator<Item = &'static str> {
    (if v6 { V6 } else { V4 })
        .iter()
        .copied()
        .chain((v6 && allow_ignore).then_some("ignore"))
}

fn live_family(device: Option<&serde_json::Value>, v6: bool) -> [String; 3] {
    let Some(device) = device else {
        return Default::default();
    };
    let family = &device[if v6 { "ip6" } else { "ip4" }];
    let address = &family["addresses"][0];
    let prefix = address["prefix"]
        .as_u64()
        .filter(|n| *n <= if v6 { 128 } else { 32 });
    let prefix = prefix.map_or_else(String::new, |n| {
        if v6 {
            n.to_string()
        } else {
            Ipv4Addr::from(u32::MAX.checked_shl(32 - n as u32).unwrap_or(0)).to_string()
        }
    });
    [
        item_text(address, "address").into(),
        prefix,
        item_text(family, "gateway").into(),
    ]
}

impl Editor {
    pub(super) fn dirty(&self) -> bool {
        self.draft
            .as_ref()
            .zip(self.saved.as_ref())
            .is_some_and(|(form, saved)| form.changed(saved))
    }

    pub(super) fn input(
        &mut self,
        field: &str,
        value: Option<&Value>,
        device: Option<&serde_json::Value>,
    ) {
        let Some(draft) = &mut self.draft else { return };
        if self.busy {
            return;
        }
        match (field, value) {
            ("method4" | "method6", Some(Value::Index(index))) => {
                let v6 = field == "method6";
                let family = if v6 { &mut draft.v6 } else { &mut draft.v4 };
                let ignore = self
                    .saved
                    .as_ref()
                    .is_some_and(|saved| saved.v6.method == "ignore");
                if let Some(method) = methods(v6, ignore).nth(*index) {
                    family.method = method.into();
                    if method == "manual" && family.address.is_empty() {
                        [family.address, family.prefix, family.gateway] = live_family(device, v6);
                    }
                }
            }
            (field, Some(Value::Text(value))) => {
                let dst = match field {
                    "address4" => &mut draft.v4.address,
                    "prefix4" => &mut draft.v4.prefix,
                    "gateway4" => &mut draft.v4.gateway,
                    "address6" => &mut draft.v6.address,
                    "prefix6" => &mut draft.v6.prefix,
                    "gateway6" => &mut draft.v6.gateway,
                    "dns" => &mut draft.dns,
                    "search" => &mut draft.search,
                    _ => return,
                };
                dst.clone_from(value);
            }
            _ => {}
        }
    }

    pub(super) fn rows(
        &self,
        cx: &ChoiceContext<'_>,
        types: &TypeScale,
        e: &Exports,
        device: Option<&serde_json::Value>,
    ) -> Result<Vec<Node>, String> {
        let body = || types.style(Type::Body, Weight::Regular);
        let mut rows = vec![
            button(
                "network/ip/back",
                "settings.nav.back",
                cx.action("ip-back", "", ""),
                !self.busy,
                types,
                e,
            )?,
            nk::Label::new(
                "network/ip/title",
                &self.target.name,
                types.style(Type::Body, Weight::Medium),
            )
            .into(),
        ];
        if self.failed {
            rows.push(
                nk::Label::new(
                    "network/ip/error",
                    e.text("settings.network.ip.error.save")?,
                    body(),
                )
                .into(),
            );
        }
        let Some(form) = &self.draft else {
            rows.push(if self.failed {
                button(
                    "network/ip/retry",
                    "settings.network.ip.revert",
                    cx.action("ip-revert", "", ""),
                    !self.busy,
                    types,
                    e,
                )?
            } else {
                nk::Label::new(
                    "network/ip/loading",
                    e.text("settings.native.loading")?,
                    body(),
                )
                .into()
            });
            return Ok(rows);
        };
        for (digit, family, live, title) in [
            (
                "4",
                &form.v4,
                live_family(device, false),
                "settings.network.ip.group.ipv4",
            ),
            (
                "6",
                &form.v6,
                live_family(device, true),
                "settings.network.ip.group.ipv6",
            ),
        ] {
            let v6 = digit == "6";
            let ignore = self
                .saved
                .as_ref()
                .is_some_and(|saved| saved.v6.method == "ignore");
            let options: Vec<_> = methods(v6, ignore).collect();
            let labels = options
                .iter()
                .map(|method| {
                    let suffix = match (*method, v6) {
                        ("auto", true) => "auto6",
                        ("dhcp", true) => "dhcp6",
                        _ => method,
                    };
                    e.text(&format!("settings.network.ip.method.{suffix}"))
                        .map(str::to_owned)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let key = format!("network/ip/{digit}");
            let method_label = e.text(&format!("settings.network.ip.method{digit}"))?;
            let mut fields = vec![
                nk::ListRow::new(format!("{key}/method-row"), method_label, body())
                    .trailing(
                        nk::DropDown::new(
                            format!("{key}/method"),
                            method_label,
                            cx.action("ip-edit", &format!("method{digit}"), ""),
                            labels,
                            options
                                .iter()
                                .position(|value| *value == family.method)
                                .unwrap_or(0),
                        )
                        .enabled(!self.busy),
                    )
                    .into(),
            ];
            if !matches!(family.method.as_str(), "disabled" | "ignore") {
                let errors = family_errors(family, v6);
                for (index, (field, label, value)) in [
                    (
                        "address",
                        "settings.network.ip.address",
                        family.address.as_str(),
                    ),
                    (
                        "prefix",
                        if v6 {
                            "settings.network.ip.prefix"
                        } else {
                            "settings.network.ip.mask"
                        },
                        family.prefix.as_str(),
                    ),
                    (
                        "gateway",
                        "settings.network.ip.router",
                        family.gateway.as_str(),
                    ),
                ]
                .into_iter()
                .enumerate()
                {
                    fields.push(if family.method == "manual" {
                        entry(
                            cx,
                            &format!("{field}{digit}"),
                            label,
                            value,
                            "",
                            errors[index],
                            !self.busy,
                            types,
                            e,
                        )?
                    } else {
                        let value = if live[index].is_empty() {
                            "—"
                        } else {
                            &live[index]
                        };
                        nk::ListRow::new(format!("{key}/{field}/row"), e.text(label)?, body())
                            .trailing(nk::Label::new(
                                format!("{key}/{field}/value"),
                                value,
                                body(),
                            ))
                            .into()
                    });
                }
            }
            if !v6
                && family.method == "auto"
                && device.is_some()
                && self.saved.as_ref().is_some_and(|f| f.v4.method == "auto")
            {
                fields.push(button(
                    "network/ip/renew",
                    "settings.network.ip.renew.btn",
                    cx.action("ip-renew", "", ""),
                    !self.busy,
                    types,
                    e,
                )?);
            }
            group(&mut rows, &key, title, fields, types, e)?;
        }
        let live_values = |key: &str| {
            device
                .into_iter()
                .flat_map(|d| [&d["ip4"], &d["ip6"]])
                .flat_map(|family| nk_platform::network::items(family, key))
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let dns = live_values("nameservers");
        let dns_hint = if dns.is_empty() {
            e.text("settings.network.ip.dns.auto")?
        } else {
            &dns
        };
        group(
            &mut rows,
            "network/ip/dns",
            "settings.network.ip.group.dns",
            vec![
                entry(
                    cx,
                    "dns",
                    "settings.network.ip.dns",
                    &form.dns,
                    dns_hint,
                    form.dns_error(),
                    !self.busy,
                    types,
                    e,
                )?,
                entry(
                    cx,
                    "search",
                    "settings.network.ip.search",
                    &form.search,
                    &live_values("domains"),
                    form.search_error(),
                    !self.busy,
                    types,
                    e,
                )?,
            ],
            types,
            e,
        )?;
        rows.push(
            nk::Row::new(
                "network/ip/actions",
                vec![
                    button(
                        "network/ip/revert",
                        "settings.network.ip.revert",
                        cx.action("ip-revert", "", ""),
                        !self.busy && self.dirty(),
                        types,
                        e,
                    )?,
                    button(
                        "network/ip/apply",
                        "settings.network.ip.apply",
                        cx.action("ip-apply", "", ""),
                        !self.busy && self.dirty() && form.valid(),
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

#[allow(clippy::too_many_arguments)]
fn entry(
    cx: &ChoiceContext<'_>,
    field: &str,
    label: &str,
    value: &str,
    hint: &str,
    error: Option<&str>,
    enabled: bool,
    types: &TypeScale,
    e: &Exports,
) -> Result<Node, String> {
    let key = format!("network/ip/field/{field}");
    let body = types.style(Type::Body, Weight::Regular);
    let title = e.text(label)?;
    let mut row = nk::ListRow::new(format!("{key}/row"), title, body.clone()).trailing(
        nk::Entry::new(key.clone(), title, cx.action("ip-edit", field, ""), value)
            .placeholder(hint)
            .enabled(enabled),
    );
    if let Some(error) = error {
        row = row.subtitle(e.text(error)?, types.style(Type::Small, Weight::Regular));
    }
    Ok(row.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_validation_accepts_contiguous_masks_and_rejects_invalid_dns_and_domains() {
        assert!(valid_prefix("255.255.255.0", false));
        assert!(valid_prefix("24", false));
        assert!(!valid_prefix("255.255.254.255", false));
        assert!(!valid_prefix("0.0.0.0", false));
        assert!(!valid_prefix("+24", false));
        assert!(valid_prefix("128", true));
        assert!(!valid_prefix("129", true));

        let automatic = Family {
            method: "auto".into(),
            address: "".into(),
            prefix: "".into(),
            gateway: "".into(),
        };
        let mut form = Form {
            v4: automatic.clone(),
            v6: automatic,
            dns: "1.1.1.1; 2001:db8::53".into(),
            search: "example.org., dev.example.org".into(),
        };
        assert!(form.valid());
        let mut equivalent = form.clone();
        equivalent.dns = "1.1.1.1,2001:db8::53".into();
        equivalent.v4.address = "192.0.2.42".into();
        assert!(!equivalent.changed(&form));
        form.dns = "1.1.1.400".into();
        form.search = "bad-.example".into();
        assert!(form.dns_error().is_some());
        assert!(form.search_error().is_some());
    }
}
