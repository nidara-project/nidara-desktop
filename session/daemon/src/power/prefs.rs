// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gio::prelude::*;
pub fn watch(power: Power) {
    let (tx, mut rx) = tokio::sync::watch::channel(Preferences::default());
    std::thread::spawn(move || {
        let ctx = glib::MainContext::new();
        let _ = ctx.with_thread_default(|| {
            let Some(schema) = gio::SettingsSchemaSource::default()
                .and_then(|s| s.lookup("org.nidara.power", true))
            else {
                return;
            };
            let settings = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
            let read = |s: &gio::Settings| Preferences {
                automatic_saver: s.boolean("automatic-saver"),
                show_percentage: s.boolean("show-percentage"),
                power_button: s.string("power-button-action").to_string(),
                lid_battery: s.string("lid-action-on-battery").to_string(),
                lid_ac: s.string("lid-action-on-ac").to_string(),
            };
            let changes = tx.clone();
            settings.connect_changed(None, move |s, _| {
                let _ = changes.send(read(s));
            });
            let _ = tx.send(read(&settings));
            glib::MainLoop::new(Some(&ctx), false).run();
        });
    });
    tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let prefs = rx.borrow_and_update().clone();
            *power.prefs.write().unwrap() = prefs;
            if let Err(e) = power.refresh().await {
                power.failure("preferences", ROOT, &e).await;
            }
        }
    });
}
