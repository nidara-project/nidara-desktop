// SPDX-License-Identifier: LGPL-3.0-or-later
//! The ordinary renderer's Config1 binding and all-or-nothing page admission.
use nk::Activated;
use nk_settings::{
    Value,
    client::Editor,
    exports::Exports,
    manifest,
    session::{ApplyError, Command, Raw, Session},
    view_settings::{Model, ordinary},
};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
struct Fake {
    session: Session,
    sent: Vec<(String, Value)>,
}
impl Editor for Fake {
    fn session(&self) -> &Session {
        &self.session
    }
    fn apply(&mut self, key: &str, value: Value) -> Result<(), ApplyError> {
        if let Some(Command::Apply { key, value, .. }) = self.session.apply(key, value)? {
            self.sent.push((key, value));
        }
        Ok(())
    }
}
fn fixture(release: bool) -> (Fake, Exports, Model) {
    let root = std::env::var_os("NK_SETTINGS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    let mut e = Exports::load(&root).expect("generate settings-data before running Settings tests");
    e.pages=manifest::parse(&json!([
        {"id":"one","kind":"preference","label":"settings.native.application","groups":[{"items":["switch","segment","slider","dropdown"]}]},
        {"id":"two","kind":"preference","label":"settings.native.application","groups":[{"items":["switch"]}]}
    ])).unwrap();
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((7,1,json!({"schemaVersion":1,"keys":{
        "switch":{"type":"boolean","value":false,"available":true,"writable":true,"ui":{"control":"toggle","title":"Toggle"}},
        "segment":{"type":"string","value":"a","available":true,"writable":true,"ui":{"control":"segmented","title":"Segment","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}},
        "slider":{"type":"number","value":0.2,"min":0,"max":1,"available":true,"writable":true,"ui":{"control":"slider","title":"Slider","slider":{"pct":true,"commitOnRelease":release,"debounce":32}}},
        "dropdown":{"type":"string","value":"unknown","available":true,"writable":true,"ui":{"control":"dropdown","title":"Dropdown","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}}
    }}).to_string()))));
    let mut model = Model::default();
    model.reconcile(&e, &session);
    (
        Fake {
            session,
            sent: vec![],
        },
        e,
        model,
    )
}
fn action(name: &str, value: Option<nk::Value>) -> Activated {
    Activated {
        key: "test".into(),
        action: name.into(),
        value,
    }
}
#[test]
fn page_admission_is_recursive_and_does_not_hide_unsupported_items() {
    let (f, e, _) = fixture(false);
    assert!(ordinary(&e.pages[0], &f.session));
    for patch in [
        json!({"custom":"unknown"}),
        json!({"items":[{"custom":"unknown"}]}),
        json!({"items":[{"decoration":"unknown"}]}),
        json!({"items":[{"disclosure":"settings.native.application","items":[{"custom":"unknown"}]}]}),
    ] {
        let pages=manifest::parse(&json!([{"id":"mixed","kind":"preference","label":"settings.native.application","groups":[{"items":["switch"]},patch]}])).unwrap();
        assert!(!ordinary(&pages[0], &f.session));
    }
    let mut p = e.pages[0].clone();
    p.kind = "browser".into();
    assert!(!ordinary(&p, &f.session));
    p.kind = "preference".into();
    p.header = Some("custom".into());
    assert!(!ordinary(&p, &f.session));
    p.header = None;
    p.builder = Some("custom".into());
    assert!(!ordinary(&p, &f.session));
    p.builder = None;
    p.groups[0].items = vec![manifest::Item::Key {
        key: "missing".into(),
        visible_when: None,
        sensitive_when: None,
    }];
    assert!(!ordinary(&p, &f.session));
}
#[test]
fn switch_segment_and_dropdown_use_the_same_session_and_keep_unknown_values() {
    let (mut f, e, mut m) = fixture(false);
    let now = Instant::now();
    m.activate(action("set:switch", None), false, &mut f, &e, now)
        .unwrap();
    m.activate(
        action("set:segment:1", Some(nk::Value::Index(1))),
        false,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    m.activate(
        action("set:dropdown", Some(nk::Value::Index(1))),
        false,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    assert_eq!(
        f.sent,
        vec![
            ("switch".into(), Value::Bool(true)),
            ("segment".into(), Value::Text("b".into())),
            ("dropdown".into(), Value::Text("b".into()))
        ]
    );
}
#[test]
fn release_slider_never_writes_a_drag_and_commits_the_final_scaled_value() {
    let (mut f, e, mut m) = fixture(true);
    let now = Instant::now();
    m.activate(
        action("set:slider", Some(nk::Value::Number(30.))),
        true,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        true,
        &mut f,
        &e,
        now + Duration::from_millis(20),
    )
    .unwrap();
    m.flush(&mut f, &e, now + Duration::from_secs(10)).unwrap();
    assert!(f.sent.is_empty());
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        false,
        &mut f,
        &e,
        now + Duration::from_millis(30),
    )
    .unwrap();
    assert_eq!(f.sent, vec![("slider".into(), Value::Number(0.7))]);
}
#[test]
fn debounce_sends_only_the_latest_value_and_navigation_cancels_held_work() {
    let (mut f, e, mut m) = fixture(false);
    let now = Instant::now();
    for (ms, n) in [(0, 30.), (20, 70.)] {
        m.activate(
            action("set:slider", Some(nk::Value::Number(n))),
            true,
            &mut f,
            &e,
            now + Duration::from_millis(ms),
        )
        .unwrap();
    }
    m.flush(&mut f, &e, now + Duration::from_millis(50))
        .unwrap();
    assert!(f.sent.is_empty());
    m.flush(&mut f, &e, now + Duration::from_millis(53))
        .unwrap();
    assert_eq!(f.sent, vec![("slider".into(), Value::Number(0.7))]);
    let (mut f, e, mut m) = fixture(false);
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        true,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    assert!(
        m.activate(action("page:two", None), false, &mut f, &e, now)
            .unwrap()
    );
    m.flush(&mut f, &e, now + Duration::from_secs(1)).unwrap();
    assert!(f.sent.is_empty());
    assert!(
        m.activate(action(nk::BACK, None), false, &mut f, &e, now)
            .unwrap()
    );
    assert_eq!(m.selected(), Some("one"));
    assert!(
        m.activate(action(nk::FORWARD, None), false, &mut f, &e, now)
            .unwrap()
    );
    assert_eq!(m.selected(), Some("two"));
}
#[test]
fn owner_loss_and_hidden_or_insensitive_rows_never_send_pending_values() {
    let (mut f, mut e, mut m) = fixture(false);
    let now = Instant::now();
    let predicate = manifest::Predicate {
        key: "switch".into(),
        any_of: vec!["true".into()],
    };
    if let manifest::Item::Key { sensitive_when, .. } = &mut e.pages[0].groups[0].items[2] {
        *sensitive_when = Some(predicate);
    }
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        false,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    m.flush(&mut f, &e, now + Duration::from_secs(1)).unwrap();
    assert!(f.sent.is_empty());
    let (mut f, e, mut m) = fixture(false);
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        true,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    let (notices, _) = f.session.handle(Raw::Owner(false));
    m.notices(&notices, &e).unwrap();
    m.flush(&mut f, &e, now + Duration::from_secs(1)).unwrap();
    assert!(f.sent.is_empty());
}
/// #1103 8b: the Region page writes its two keys, and only from that page. A city chosen
/// from the search is its IANA zone; the regional format is an ordinary dropdown.
#[test]
fn the_region_page_writes_the_zone_of_the_city_chosen_and_its_format() {
    let root = std::env::var_os("NK_SETTINGS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    let mut e = Exports::load(&root).expect("generate settings-data before running Settings tests");
    let region = e
        .page("region")
        .expect("the manifest has a Region page")
        .clone();
    e.pages = manifest::parse(&json!([
        {"id":"one","kind":"preference","label":"settings.native.application","groups":[{"items":["switch"]}]}
    ]))
    .unwrap();
    e.pages.push(region);
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((7,1,json!({"schemaVersion":1,"keys":{
        "switch":{"type":"boolean","value":false,"available":true,"writable":true,"ui":{"control":"toggle","title":"Toggle"}},
        "region.timezone":{"type":"string","value":"America/Managua","available":true,"writable":true,
            "catalogue":["America/Managua","Europe/Madrid","US/Pacific"],"ui":{"title":"Change timezone"}},
        "region.language":{"type":"enum","value":"en_US.UTF-8","available":true,"writable":true,
            "values":["en_US.UTF-8","es_ES.UTF-8"],"ui":{"control":"dropdown","title":"Language",
            "options":[{"value":"en_US.UTF-8","label":"en_US.UTF-8"},{"value":"es_ES.UTF-8","label":"es_ES.UTF-8"}]}},
        "region.regionalFormat":{"type":"enum","value":"","available":true,"writable":true,
            "values":["","es_ES.UTF-8"],"ui":{"control":"dropdown","title":"Regional format",
            "options":[{"value":"","label":"Same as language"},{"value":"es_ES.UTF-8","label":"es_ES.UTF-8"}]}}
    }}).to_string()))));
    let mut f = Fake {
        session,
        sent: vec![],
    };
    let mut m = Model::default();
    m.reconcile(&e, &f.session);
    let now = Instant::now();
    let act = |m: &mut Model, f: &mut Fake, name: &str, value: Option<nk::Value>| {
        m.activate(action(name, value), false, f, &e, now).unwrap();
    };
    // From another page, the search's actions write nothing.
    act(
        &mut m,
        &mut f,
        "region:tz-edit",
        Some(nk::Value::Text("madr".into())),
    );
    act(
        &mut m,
        &mut f,
        "region:tz-choose",
        Some(nk::Value::Index(0)),
    );
    assert!(f.sent.is_empty());
    act(&mut m, &mut f, "page:region", None);
    assert_eq!(m.selected(), Some("region"));
    act(
        &mut m,
        &mut f,
        "region:tz-edit",
        Some(nk::Value::Text("madr".into())),
    );
    act(
        &mut m,
        &mut f,
        "region:tz-choose",
        Some(nk::Value::Index(0)),
    );
    act(
        &mut m,
        &mut f,
        "set:region.regionalFormat",
        Some(nk::Value::Index(1)),
    );
    // A key the page does not name is not written from it.
    act(&mut m, &mut f, "set:switch", None);
    assert_eq!(
        f.sent,
        vec![
            (
                "region.timezone".into(),
                Value::Text("Europe/Madrid".into())
            ),
            (
                "region.regionalFormat".into(),
                Value::Text("es_ES.UTF-8".into())
            ),
        ]
    );
    // The page builds with its strings: the zone in force as city and area, the matches
    // of what is typed under the search, and the language row.
    let appearance = nk_platform::portal::Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "tinted".into(),
        reduced_motion: false,
        font: "Inter 11".into(),
        text_scale: 1.,
    };
    let reference =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    let host = nk::AppWindow::new(
        nk::WindowLook::load(&e, &appearance).unwrap(),
        nk::Labels {
            show_sidebar: "Show sidebar".into(),
            hide_sidebar: "Hide sidebar".into(),
            back: "Back".into(),
            forward: "Forward".into(),
        },
        "Settings",
        Box::new(
            nk_text::ParleyBackend::with_system_fonts(std::sync::Arc::new(
                nk_text::FontSet::discover_required().unwrap(),
            ))
            .unwrap(),
        ),
        nk::Glyphs::new(nk_icons::Icons::new("", &[], &reference).unwrap()),
        false,
    );
    act(
        &mut m,
        &mut f,
        "region:tz-edit",
        Some(nk::Value::Text("ma".into())),
    );
    let page = m.page(&host, &f.session, &e).unwrap();
    let text = format!("{:?}", page.content);
    assert!(
        text.contains("Madrid — "),
        "the zone just chosen, as a city under its area"
    );
    assert!(
        text.contains("region/tz/matches"),
        "the matches under the search"
    );
    assert!(!text.contains("Pacific"), "an alias is not offered");
    assert!(
        text.contains("set:region.language"),
        "the ordinary language row"
    );
    assert!(!text.contains("region:lang-apply"));
}

/// #1103 8c: Appearance draws its rows from the kit (swatches, time fields, font buttons)
/// without the wallpaper, which gets its own page, and writes only the keys it names.
#[test]
fn the_appearance_page_writes_its_accent_schedule_and_fonts_and_has_no_wallpaper() {
    let root = std::env::var_os("NK_SETTINGS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    let e = Exports::load(&root).expect("generate settings-data before running Settings tests");
    assert!(
        e.page("appearance").is_some(),
        "the built-in pages have Appearance"
    );
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((7,1,json!({"schemaVersion":1,"keys":{
        "appearance.darkMode":{"type":"boolean","value":true,"available":true,"writable":true,"ui":{"control":"toggle","title":"Dark mode"}},
        "appearance.accent":{"type":"enum","value":"blue","available":true,"writable":true,"values":["blue","teal","green"]},
        "nightlight.enabled":{"type":"boolean","value":false,"available":true,"writable":true,"ui":{"control":"toggle","title":"Night light"}},
        "nightlight.scheduleEnabled":{"type":"boolean","value":true,"available":true,"writable":true,"ui":{"control":"toggle","title":"Automatic"}},
        "nightlight.scheduleFrom":{"type":"string","value":"20:00","available":true,"writable":true},
        "nightlight.scheduleTo":{"type":"string","value":"06:30","available":true,"writable":true},
        "appearance.interfaceFont":{"type":"string","value":"Inter 11","available":true,"writable":true},
        "appearance.monoFont":{"type":"string","value":"JetBrains Mono 10","available":true,"writable":true},
        "wallpaper.transition":{"type":"enum","value":"fade","available":true,"writable":true,"values":["fade","grow"],
            "ui":{"control":"dropdown","title":"Transition","options":[{"value":"fade","label":"Fade"},{"value":"grow","label":"Grow"}]}}
    }}).to_string()))));
    let mut f = Fake {
        session,
        sent: vec![],
    };
    let mut m = Model::default();
    m.reconcile(&e, &f.session);
    let now = Instant::now();
    let act = |m: &mut Model, f: &mut Fake, name: &str, value: Option<nk::Value>| {
        m.activate(action(name, value), false, f, &e, now).unwrap();
    };
    act(&mut m, &mut f, "page:appearance", None);
    assert_eq!(m.selected(), Some("appearance"));
    act(
        &mut m,
        &mut f,
        "appearance:accent",
        Some(nk::Value::Index(2)),
    );
    act(
        &mut m,
        &mut f,
        "appearance:time:nightlight.scheduleFrom",
        Some(nk::Value::Text("21:15".into())),
    );
    act(
        &mut m,
        &mut f,
        "appearance:font:appearance.interfaceFont",
        None,
    );
    let (key, choice) = m
        .take_font_request()
        .expect("the font row asks for its dialog");
    assert_eq!(
        (key.as_str(), choice.family.as_str()),
        ("appearance.interfaceFont", "Inter")
    );
    let bold = choice.face(nk::FontFace {
        name: "Bold".into(),
        weight: 700.,
        ..Default::default()
    });
    m.font_chosen(&key, &bold, &mut f, &e).unwrap();
    // The wallpaper's transition is no longer this page's; a time for another key neither.
    act(
        &mut m,
        &mut f,
        "set:wallpaper.transition",
        Some(nk::Value::Index(1)),
    );
    act(
        &mut m,
        &mut f,
        "appearance:time:wallpaper.transition",
        Some(nk::Value::Text("21:15".into())),
    );
    assert_eq!(
        f.sent,
        vec![
            ("appearance.accent".into(), Value::Text("green".into())),
            (
                "nightlight.scheduleFrom".into(),
                Value::Text("21:15".into())
            ),
            (
                "appearance.interfaceFont".into(),
                Value::Text("Inter Bold 11".into())
            ),
        ]
    );
    // The page builds: the swatches, both times while the schedule is on, both fonts, and
    // nothing of the wallpaper.
    let appearance = nk_platform::portal::Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "tinted".into(),
        reduced_motion: false,
        font: "Inter 11".into(),
        text_scale: 1.,
    };
    let reference =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    let host = nk::AppWindow::new(
        nk::WindowLook::load(&e, &appearance).unwrap(),
        nk::Labels {
            show_sidebar: "s".into(),
            hide_sidebar: "h".into(),
            back: "b".into(),
            forward: "f".into(),
        },
        "Settings",
        Box::new(
            nk_text::ParleyBackend::with_system_fonts(std::sync::Arc::new(
                nk_text::FontSet::discover_required().unwrap(),
            ))
            .unwrap(),
        ),
        nk::Glyphs::new(nk_icons::Icons::new("", &[], &reference).unwrap()),
        false,
    );
    let page = format!("{:?}", m.page(&host, &f.session, &e).unwrap().content);
    for expected in [
        "key/appearance.accent",
        "key/nightlight.scheduleFrom",
        "key/nightlight.scheduleTo",
        "key/appearance.interfaceFont",
        "key/appearance.monoFont",
    ] {
        assert!(page.contains(expected), "{expected}");
    }
    assert!(
        !page.contains("wallpaper"),
        "the wallpaper has its own page"
    );
}

/// Settings → Top bar on AppWindow (#1103 8e): the window title's switch, the system menu's
/// icon back to the mark, a tray icon hidden and shown, and the Clock subpage's three keys,
/// each written only from the page that shows it.
#[test]
fn the_top_bar_page_writes_its_items_tray_and_clock() {
    let root = std::env::var_os("NK_SETTINGS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    let e = Exports::load(&root).expect("generate settings-data before running Settings tests");
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((7,1,json!({"schemaVersion":1,"keys":{
        "bar.appTitle":{"type":"boolean","value":true,"available":true,"writable":true,"ui":{"i18n":"settings.bar.app-title"}},
        "bar.launcherIcon":{"type":"string","value":"/home/a/mark.png","available":true,"writable":true},
        "bar.trayHidden":{"type":"list","value":["steam"],"available":true,"writable":true,"values":["nm-applet","steam"],
            "ui":{"items":[{"value":"nm-applet","title":"Network","icon":"nm-device-wireless"},{"value":"steam","title":"Steam","icon":"/home/a/steam.png"}]}},
        "region.timeFormat":{"type":"enum","value":"24h","available":true,"writable":true,"values":["24h","12h"],
            "ui":{"control":"dropdown","title":"Time format","options":[{"value":"24h","label":"24"},{"value":"12h","label":"12"}]}},
        "region.dateFormat":{"type":"enum","value":"short","available":true,"writable":true,"values":["none","short"],
            "ui":{"control":"dropdown","title":"Date format","options":[{"value":"none","label":"None"},{"value":"short","label":"Short"}]}},
        "region.showSeconds":{"type":"boolean","value":false,"available":true,"writable":true,"ui":{"control":"toggle","title":"Seconds"}}
    }}).to_string()))));
    let mut f = Fake {
        session,
        sent: vec![],
    };
    let mut m = Model::default();
    m.reconcile(&e, &f.session);
    let now = Instant::now();
    let act = |m: &mut Model, f: &mut Fake, name: &str, value: Option<nk::Value>| {
        m.activate(action(name, value), false, f, &e, now).unwrap();
    };
    // The clock's keys are not the Top bar page's own: only its subpage writes them.
    act(&mut m, &mut f, "page:bar", None);
    assert_eq!(m.selected(), Some("bar"));
    act(&mut m, &mut f, "set:region.showSeconds", None);
    act(&mut m, &mut f, "bar:appTitle", None);
    act(&mut m, &mut f, "bar:icon:default", None);
    act(&mut m, &mut f, "bar:tray:nm-applet", None);
    act(&mut m, &mut f, "bar:tray:steam", None);
    act(&mut m, &mut f, "bar:tray:not-offered", None);
    act(&mut m, &mut f, "bar:icon:change", None);
    assert!(m.take_icon_request(), "Change icon opens the chooser");
    m.icon_chosen(std::path::Path::new("/home/a/new.svg"), &mut f, &e)
        .unwrap();
    act(&mut m, &mut f, "page:bar/clock", None);
    assert_eq!(m.selected(), Some("bar/clock"));
    act(&mut m, &mut f, "set:region.showSeconds", None);
    act(
        &mut m,
        &mut f,
        "set:region.dateFormat",
        Some(nk::Value::Index(0)),
    );
    // And the bar's own keys are not the subpage's.
    act(&mut m, &mut f, "bar:appTitle", None);
    assert_eq!(
        f.sent,
        vec![
            ("bar.appTitle".into(), Value::Bool(false)),
            ("bar.launcherIcon".into(), Value::Text("nidara".into())),
            (
                "bar.trayHidden".into(),
                Value::List(vec!["nm-applet".into(), "steam".into()])
            ),
            ("region.showSeconds".into(), Value::Bool(true)),
            ("region.dateFormat".into(), Value::Text("none".into())),
        ]
    );
    // A key's next value waits for Config1's answer to the first; the page reads it.
    assert_eq!(
        f.session.shown("bar.trayHidden"),
        Some(&Value::List(vec!["nm-applet".into()]))
    );
    assert_eq!(
        f.session.shown("bar.launcherIcon"),
        Some(&Value::Text("/home/a/new.svg".into()))
    );
    // Both build: the Top bar's rows and the tray apps, then the subpage's preview and keys.
    let appearance = nk_platform::portal::Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "tinted".into(),
        reduced_motion: false,
        font: "Inter 11".into(),
        text_scale: 1.,
    };
    let reference =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    let host = nk::AppWindow::new(
        nk::WindowLook::load(&e, &appearance).unwrap(),
        nk::Labels {
            show_sidebar: "s".into(),
            hide_sidebar: "h".into(),
            back: "b".into(),
            forward: "f".into(),
        },
        "Settings",
        Box::new(
            nk_text::ParleyBackend::with_system_fonts(std::sync::Arc::new(
                nk_text::FontSet::discover_required().unwrap(),
            ))
            .unwrap(),
        ),
        nk::Glyphs::new(nk_icons::Icons::new("", &[], &reference).unwrap()),
        false,
    );
    let clock = m.page(&host, &f.session, &e).unwrap();
    let text = format!("{:?}", clock.content);
    for expected in [
        "bar/clock/preview",
        "key/region.dateFormat",
        "key/region.timeFormat",
        "key/region.showSeconds",
    ] {
        assert!(text.contains(expected), "{expected}");
    }
    assert_eq!(clock.title, e.text("settings.bar.item.clock").unwrap());
    act(&mut m, &mut f, nk::BACK, None);
    let bar = format!("{:?}", m.page(&host, &f.session, &e).unwrap().content);
    for expected in [
        "bar/row/clock",
        "bar/row/control-center",
        "key/bar.appTitle",
        "bar/row/system-menu",
        "bar/picture//home/a/new.svg",
        "bar/tray/nm-applet",
        "bar/picture//home/a/steam.png",
    ] {
        assert!(bar.contains(expected), "{expected}");
    }
}
