// SPDX-License-Identifier: LGPL-3.0-or-later
//! The data layer against the session it runs in, read-only: the snapshot, the portal's
//! appearance, the token set it picks and Appearance's rows with their values. Changes nothing.
//!
//!     NK_SETTINGS_DATA=build/settings-data cargo run -p nk-settings --example data-report

use nk_settings::client::Client;
use nk_settings::exports::Exports;
use nk_settings::manifest::Item;
use nk_settings::portal::Portal;
use nk_settings::session::Notice;
use std::time::{Duration, Instant};

fn main() -> Result<(), String> {
    let t = Instant::now();
    let exports = Exports::load(&Exports::root())?;
    eprintln!("exports {:?} (locale {})", t.elapsed(), exports.locale);
    let mut client = Client::connect()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let notices = client.wait(deadline);
        if notices.contains(&Notice::Ready) {
            break;
        }
        if let Some(Notice::Error(e)) = notices.iter().find(|n| matches!(n, Notice::Error(_))) {
            return Err(e.clone());
        }
        if Instant::now() >= deadline {
            return Err("no snapshot before the deadline".into());
        }
    }
    let session = client.session();
    let store = session.store().unwrap();
    eprintln!(
        "snapshot {:?}: epoch {} revision {}, {} keys",
        t.elapsed(),
        store.epoch,
        store.revision,
        store.keys().count()
    );
    let portal = Portal::watch(client.connection())?;
    let appearance = portal.read()?;
    let tokens = exports.tokens(&appearance)?;
    eprintln!(
        "portal {appearance:?} → --nidara-bg {}",
        tokens.colors["--nidara-bg"]
    );
    let page = exports.page("appearance").ok_or("no appearance page")?;
    for group in &page.groups {
        println!(
            "[{}]",
            group.i18n.as_deref().map_or(Ok(""), |k| exports.text(k))?
        );
        for item in &group.items {
            let shown = item.key().map(|k| match (store.key(k), session.shown(k)) {
                (None, _) => "NOT IN SNAPSHOT".to_owned(),
                (Some(key), _) if !key.available => "unavailable".to_owned(),
                (_, v) => format!("{v:?}"),
            });
            let visible = item.visible_when().is_none_or(|p| p.holds(session));
            let sensitive = item.sensitive_when().is_none_or(|p| p.holds(session));
            let what = match item {
                Item::Key { key, .. } => key.clone(),
                Item::Custom { name, .. } => format!("custom {name}"),
                Item::Decoration { name, .. } => format!("decoration {name}"),
            };
            println!(
                "  {what}: {}{}{}",
                shown.unwrap_or_default(),
                if visible { "" } else { " (hidden)" },
                if sensitive { "" } else { " (insensitive)" }
            );
        }
    }
    Ok(())
}
