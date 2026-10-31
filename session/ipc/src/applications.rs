// SPDX-License-Identifier: GPL-3.0-or-later
//! CLI is an External caller. Admission never claims a window appeared or got focus.
use crate::{Client, Fault};
use serde_json::json;
use std::collections::HashMap;
use zbus::{
    blocking::Proxy,
    zvariant::{OwnedValue, Value},
};
type Dict = HashMap<String, OwnedValue>;
fn bad() -> Fault {
    Fault::new("Failed", "malformed Applications1 metadata")
}
fn text<'a>(d: &'a Dict, k: &str) -> Result<&'a str, Fault> {
    d.get(k)
        .and_then(|v| <&str>::try_from(v).ok())
        .ok_or_else(bad)
}
fn number(d: &Dict, k: &str) -> Result<u64, Fault> {
    d.get(k).and_then(|v| u64::try_from(v).ok()).ok_or_else(bad)
}
fn flag(d: &Dict, k: &str) -> bool {
    d.get(k).is_some_and(|v| bool::try_from(v).unwrap_or(false))
}
fn rows(v: OwnedValue) -> Result<Vec<Dict>, Fault> {
    Vec::<Dict>::try_from(v).map_err(|_| bad())
}
fn catalogue(p: &Proxy<'_>) -> Result<(u64, u64, Vec<Dict>), Fault> {
    let (e, _, mut state): (u64, u64, Dict) = p.call("GetSnapshot", &())?;
    let rev = number(&state, "CatalogueRevision")?;
    let mut apps = rows(state.remove("Apps").ok_or_else(bad)?)?;
    let mut token = text(&state, "AppsNext")?.to_string();
    let first = token.clone();
    let result = (|| {
        let mut pages = 0;
        while !token.is_empty() {
            pages += 1;
            if pages > 64 {
                return Err(bad());
            }
            let (page, next): (Vec<Dict>, String) = p.call("ReadSnapshotPage", &(e, &token))?;
            apps.extend(page);
            token = next;
            if apps.len() > 16384 {
                return Err(bad());
            }
        }
        Ok((e, rev, apps))
    })();
    if !first.is_empty() {
        let _ = p.call::<_, _, ()>("CloseSnapshot", &(e, first));
    }
    result
}
pub fn run(client: &Client, cmd: &str, args: &[String]) -> Result<String, Fault> {
    let p = client.proxy(
        "org.nidara.Applications",
        "/org/nidara/Applications",
        "org.nidara.Applications1",
    )?;
    let (epoch, rev, apps) = catalogue(&p)?;
    if cmd == "listApps" {
        if !args.is_empty() {
            return Err(Fault::invalid("listApps accepts no arguments"));
        }
        let result=apps.iter().filter(|a|flag(a,"Visible")&&flag(a,"Launchable")).map(|a|Ok(json!({"id":text(a,"DesktopId")?,"name":text(a,"Name")?,"wmClass":text(a,"StartupWMClass")?}))).collect::<Result<Vec<_>,Fault>>()?;
        return Ok(json!(result).to_string());
    }
    let query = args
        .first()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            Fault::invalid("launchApp <name-or-id> [--new-window|--action=ID|URI...]")
        })?;
    let exact = apps
        .iter()
        .find(|a| text(a, "DesktopId").is_ok_and(|id| id == query))
        .or_else(|| {
            apps.iter().find(|a| {
                text(a, "DesktopId")
                    .is_ok_and(|id| id.strip_suffix(".desktop") == Some(query.as_str()))
            })
        });
    let mut hits = Vec::new();
    let selected = if let Some(a) = exact {
        a
    } else {
        let (_, found): (u64, Vec<Dict>) =
            p.call("Search", &(epoch, rev, query, 100_u32, false))?;
        hits.extend(found);
        let named = hits
            .iter()
            .enumerate()
            .filter(|(_, a)| text(a, "Name").is_ok_and(|n| n.eq_ignore_ascii_case(query)))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if named.len() == 1 {
            &hits[named[0]]
        } else if hits.len() == 1 {
            &hits[0]
        } else {
            let names = hits
                .iter()
                .take(20)
                .filter_map(|a| text(a, "DesktopId").ok())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(Fault::new(
                if hits.is_empty() {
                    "NotFound"
                } else {
                    "Conflict"
                },
                if hits.is_empty() {
                    "no installed app matches".into()
                } else {
                    format!("ambiguous app; choose an exact desktop ID: {names}")
                },
            ));
        }
    };
    let id = text(selected, "DesktopId")?;
    let generation = number(selected, "Generation")?;
    let mut request = Dict::new();
    let tail = &args[1..];
    if tail == ["--new-window"] {
        request.insert(
            "Mode".into(),
            OwnedValue::try_from(Value::from("new-window")).unwrap(),
        );
    } else if tail.len() == 1 && tail[0].starts_with("--action=") {
        request.insert(
            "Mode".into(),
            OwnedValue::try_from(Value::from("action")).unwrap(),
        );
        request.insert(
            "Action".into(),
            OwnedValue::try_from(Value::from(tail[0][9..].to_owned())).unwrap(),
        );
    } else if !tail.is_empty() {
        request.insert(
            "Mode".into(),
            OwnedValue::try_from(Value::from("open")).unwrap(),
        );
        request.insert(
            "Uris".into(),
            OwnedValue::try_from(Value::from(tail.to_vec())).unwrap(),
        );
    }
    let launch_id: String = p.call("Launch", &(epoch, id, generation, request))?;
    // Keep the original kernel-authenticated process alive while queued effects
    // revalidate it. This waits for dispatch, never for a window or focus.
    let until = std::time::Instant::now() + std::time::Duration::from_secs(12);
    let state = loop {
        let state: Dict = p.call("GetLaunch", &(epoch, &launch_id))?;
        if flag(&state, "DispatchFinished") {
            break state;
        }
        if std::time::Instant::now() >= until {
            return Err(Fault::new(
                "Timeout",
                format!("launch {launch_id}: dispatch result unknown; do not retry automatically"),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    let phase = text(&state, "State")?;
    if phase != "dispatched" {
        return Err(Fault::new(
            if phase == "timed-out-unknown" {
                "Timeout"
            } else {
                "Failed"
            },
            format!("launch {launch_id}: {}", text(&state, "Error")?),
        ));
    }
    Ok(json!({"launchId":launch_id,"desktopId":id,"state":"dispatched","windowConfirmed":false,"focusConfirmed":false}).to_string())
}
