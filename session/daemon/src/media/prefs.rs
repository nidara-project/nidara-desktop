// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gio::prelude::*;
pub fn watch(m: Media) {
    let (tx, mut rx) = tokio::sync::watch::channel((true, true));
    std::thread::spawn(move || {
        let ctx = glib::MainContext::new();
        let _ = ctx.with_thread_default(|| {
            let schema = gio::SettingsSchemaSource::default()
                .and_then(|s| s.lookup("org.nidara.media", true));
            if let Some(schema) = schema {
                let settings =
                    gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
                let read = |s: &gio::Settings| {
                    (
                        s.boolean("lock-screen-controls"),
                        s.boolean("pause-on-headphones-disconnect"),
                    )
                };
                let updates = tx.clone();
                settings.connect_changed(None, move |s, _| {
                    let _ = updates.send(read(s));
                });
                let _ = tx.send(read(&settings));
                glib::MainLoop::new(Some(&ctx), false).run();
            }
        });
    });
    tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let value = *rx.borrow_and_update();
            let _g = m.updates.lock().await;
            *m.prefs.write().unwrap() = value;
            let _ = bus::publish(&m).await;
        }
    });
}
pub async fn icon(desktop: String, bus: String, identity: String) -> String {
    tokio::task::spawn_blocking(move || {
        let tail = bus
            .strip_prefix("org.mpris.MediaPlayer2.")
            .unwrap_or_default();
        let candidates = [
            desktop.clone(),
            desktop.to_lowercase(),
            tail.into(),
            tail.split('.').next().unwrap_or_default().into(),
        ];
        let apps = gio::AppInfo::all();
        for id in candidates {
            if !id.is_empty()
                && let Some(app) = apps.iter().find(|a| {
                    a.id().is_some_and(|s| {
                        s == format!("{}.desktop", id.trim_end_matches(".desktop"))
                    })
                })
                && let Some(icon) = app.icon().and_then(|i| i.to_string())
            {
                return icon.to_string();
            }
        }
        let matches = apps
            .iter()
            .filter(|a| !identity.is_empty() && a.display_name().eq_ignore_ascii_case(&identity))
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return matches[0]
                .icon()
                .and_then(|i| i.to_string())
                .map(|s| s.to_string())
                .unwrap_or_default();
        }
        String::new()
    })
    .await
    .unwrap_or_default()
}
