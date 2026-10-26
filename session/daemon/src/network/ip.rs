// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    Error, Settings,
    nm::{self, Nm, Props, owned, text},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::IpAddr};
use zbus::zvariant::OwnedObjectPath as Path;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Family {
    method: String,
    address: String,
    prefix: String,
    gateway: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Form {
    v4: Family,
    v6: Family,
    dns: String,
    search: String,
}
fn list(s: &str) -> Vec<String> {
    s.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn prefix(s: &str, v6: bool) -> Result<u32, Error> {
    let p = if !v6 && s.contains('.') {
        let addr: std::net::Ipv4Addr = s
            .parse()
            .map_err(|_| Error::Invalid("invalid netmask".into()))?;
        let bits = u32::from(addr);
        let n = bits.leading_ones();
        if bits != u32::MAX.checked_shl(32 - n).unwrap_or(0) {
            return Err(Error::Invalid("non-contiguous netmask".into()));
        }
        n
    } else {
        s.parse()
            .map_err(|_| Error::Invalid("invalid prefix".into()))?
    };
    if p > if v6 { 128 } else { 32 } || p == 0 {
        return Err(Error::Invalid("invalid prefix".into()));
    }
    Ok(p)
}
fn valid_addr(s: &str, v6: bool) -> bool {
    s.parse::<IpAddr>().is_ok_and(|a| a.is_ipv6() == v6)
}
fn family(settings: &Props) -> Family {
    let addresses: Vec<Props> = settings
        .get("address-data")
        .and_then(|v| Vec::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default();
    let first = addresses.first();
    Family {
        method: {
            let s = text(Some(settings), "method");
            if s.is_empty() { "auto".into() } else { s }
        },
        address: text(first, "address"),
        prefix: nm::number(first, "prefix").to_string(),
        gateway: text(Some(settings), "gateway"),
    }
}
pub fn read(s: &Settings) -> Form {
    let empty = Props::new();
    let s4 = s.get("ipv4").unwrap_or(&empty);
    let s6 = s.get("ipv6").unwrap_or(&empty);
    let mut dns = Vec::new();
    let mut search = Vec::new();
    for (p, v6) in [(s4, false), (s6, true)] {
        if let Some(v) = p.get("dns-data") {
            dns.extend(Vec::<String>::try_from(v.try_clone().unwrap()).unwrap_or_default());
        } else if let Some(v) = p.get("dns") {
            if v6 {
                let a: Vec<Vec<u8>> = Vec::try_from(v.try_clone().unwrap()).unwrap_or_default();
                for a in a {
                    if let Ok(a) = <[u8; 16]>::try_from(a) {
                        dns.push(std::net::Ipv6Addr::from(a).to_string());
                    }
                }
            } else {
                let a: Vec<u32> = Vec::try_from(v.try_clone().unwrap()).unwrap_or_default();
                dns.extend(
                    a.into_iter()
                        .map(|a| std::net::Ipv4Addr::from(a.to_ne_bytes()).to_string()),
                );
            }
        }
        if let Some(v) = p.get("dns-search") {
            for v in Vec::<String>::try_from(v.try_clone().unwrap()).unwrap_or_default() {
                if !search.contains(&v) {
                    search.push(v);
                }
            }
        }
    }
    Form {
        v4: family(s4),
        v6: family(s6),
        dns: dns.join(", "),
        search: search.join(", "),
    }
}
pub fn edit(s: &mut Settings, form: Form) -> Result<(), Error> {
    let dns = list(&form.dns);
    let search = list(&form.search);
    if dns.iter().any(|d| d.parse::<IpAddr>().is_err()) {
        return Err(Error::Invalid("invalid DNS address".into()));
    }
    for (name, f, v6) in [("ipv4", form.v4, false), ("ipv6", form.v6, true)] {
        let allowed = if v6 {
            &[
                "auto",
                "manual",
                "disabled",
                "ignore",
                "link-local",
                "dhcp",
                "shared",
            ][..]
        } else {
            &["auto", "manual", "disabled", "link-local", "shared"][..]
        };
        if !allowed.contains(&f.method.as_str()) {
            return Err(Error::Invalid("invalid IP method".into()));
        }
        let p = s.entry(name.into()).or_default();
        let mut rest: Vec<Props> = p
            .get("address-data")
            .and_then(|v| Vec::try_from(v.try_clone().ok()?).ok())
            .unwrap_or_default();
        if !rest.is_empty() {
            rest.remove(0);
        }
        let mut addresses = Vec::new();
        if f.method == "manual" {
            if !valid_addr(f.address.trim(), v6)
                || !f.gateway.trim().is_empty() && !valid_addr(f.gateway.trim(), v6)
            {
                return Err(Error::Invalid("invalid IP address or gateway".into()));
            }
            let n = prefix(f.prefix.trim(), v6)?;
            addresses.push(HashMap::from([
                ("address".into(), owned(f.address.trim())),
                ("prefix".into(), n.into()),
            ]));
            addresses.extend(rest);
            if f.gateway.trim().is_empty() {
                p.remove("gateway");
            } else {
                p.insert("gateway".into(), owned(f.gateway.trim()));
            }
        } else {
            p.remove("gateway");
        }
        p.remove("addresses");
        p.insert("method".into(), owned(f.method.as_str()));
        p.insert("address-data".into(), owned(addresses));
        p.remove("dns-data");
        if v6 {
            let a: Vec<Vec<u8>> = dns
                .iter()
                .filter_map(|d| match d.parse::<IpAddr>().ok()? {
                    IpAddr::V6(a) => Some(a.octets().to_vec()),
                    _ => None,
                })
                .collect();
            p.insert("dns".into(), owned(a));
        } else {
            let a: Vec<u32> = dns
                .iter()
                .filter_map(|d| match d.parse::<IpAddr>().ok()? {
                    IpAddr::V4(a) => Some(u32::from_ne_bytes(a.octets())),
                    _ => None,
                })
                .collect();
            p.insert("dns".into(), owned(a));
        }
        p.insert("ignore-auto-dns".into(), (!dns.is_empty()).into());
        p.insert(
            "dns-search".into(),
            owned(if v6 { Vec::new() } else { search.clone() }),
        );
    }
    Ok(())
}
pub async fn apply(nm: &Nm, uuid: &str, device: &Path, form: Form) -> Result<Option<Path>, Error> {
    let (path, mut s) = if uuid.is_empty() {
        let p = nm.props(device, nm::DEVICE).await?;
        if nm::number(Some(&p), "DeviceType") != 1 {
            return Err(Error::NeedsProfile("Wi-Fi needs a saved profile".into()));
        }
        (
            nm::root_path(),
            HashMap::from([
                (
                    "connection".into(),
                    HashMap::from([
                        ("id".into(), owned("Ethernet")),
                        ("type".into(), owned("802-3-ethernet")),
                        ("interface-name".into(), owned(text(Some(&p), "Interface"))),
                    ]),
                ),
                ("802-3-ethernet".into(), Props::new()),
            ]),
        )
    } else {
        nm.profile(uuid).await?
    };
    edit(&mut s, form)?;
    let path = if path.as_str() == "/" {
        nm.call(
            nm::SETTINGS,
            "org.freedesktop.NetworkManager.Settings",
            "AddConnection",
            &(&s,),
        )
        .await?
    } else {
        nm.update(&path, &s).await?;
        path
    };
    if device.as_str() != "/" {
        let p = nm.props(device, nm::DEVICE).await?;
        let active = text(Some(&p), "ActiveConnection");
        if !active.is_empty() && active != "/" {
            let a = nm.props(&active, nm::ACTIVE).await?;
            if text(Some(&a), "Connection") == path.as_str()
                && nm
                    .call::<()>(device, nm::DEVICE, "Reapply", &(&s, 0u64, 0u32))
                    .await
                    .is_err()
            {
                let a = nm.activate(&path, device, &nm::root_path()).await?;
                return Ok(Some(a));
            }
        }
    }
    Ok(None)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mask_and_validation() {
        assert_eq!(prefix("255.255.255.0", false).unwrap(), 24);
        assert!(prefix("255.0.255.0", false).is_err());
        assert!(prefix("129", true).is_err());
    }
    #[test]
    fn preserves_other_profile_fields() {
        let mut s = Settings::from([(
            "802-11-wireless-security".into(),
            Props::from([("psk".into(), owned("private"))]),
        )]);
        edit(
            &mut s,
            Form {
                v4: Family {
                    method: "manual".into(),
                    address: "192.0.2.10".into(),
                    prefix: "24".into(),
                    gateway: "192.0.2.1".into(),
                },
                v6: Family {
                    method: "auto".into(),
                    address: "".into(),
                    prefix: "".into(),
                    gateway: "".into(),
                },
                dns: "1.1.1.1, 2001:4860:4860::8888".into(),
                search: "test".into(),
            },
        )
        .unwrap();
        assert_eq!(text(s.get("802-11-wireless-security"), "psk"), "private");
        assert_eq!(read(&s).v4.address, "192.0.2.10");
        assert_eq!(read(&s).dns, "1.1.1.1, 2001:4860:4860::8888");
    }
}
