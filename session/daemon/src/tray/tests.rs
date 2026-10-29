// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
fn item() -> Item {
    Item {
        handle: "h".into(),
        generation: 1,
        owner: ":1.9".into(),
        path: "/item".into(),
        interface: ITEM_IFACES[0].into(),
        registration: String::new(),
        watched_name: String::new(),
        pid: 0,
        ready: true,
        version: 0,
        field_versions: Default::default(),
        props: Default::default(),
        icons: Default::default(),
    }
}
#[test]
fn pixmaps_are_exact_bounded_and_network_order() {
    let mut i = item();
    i.apply(
        HashMap::from([(
            "IconPixmap".into(),
            val(vec![
                (i32::MAX, i32::MAX, vec![0u8]),
                (-1, 1, vec![0]),
                (1, 1, vec![0, 1, 2]),
                (1, 1, vec![128, 10, 20, 30]),
                (1, 1, vec![0, 0, 0, 0, 0]),
            ]),
        )]),
        0,
    );
    assert_eq!(i.icon("normal", 16).unwrap(), (1, 1, vec![10, 20, 30, 128]));
    assert!(i.icon("normal", 0).is_err());
    assert!(i.icon("overlay", 16).is_err());
    i.apply(
        HashMap::from([("IconPixmap".into(), val(vec![(1, 1, vec![255u8; 4])]))]),
        model::TOTAL_BYTES,
    );
    assert!(i.icon("normal", 16).is_err());
    i.apply(
        HashMap::from([
            ("IconThemePath".into(), val("relative/path")),
            ("Title".into(), val("é".repeat(3000))),
        ]),
        0,
    );
    assert_eq!(text(&i.props, "IconThemePath"), "");
    assert_eq!(text(&i.props, "Title").len(), 4096);
    assert!(!bool::try_from(i.metadata().get("ItemIsMenu").unwrap()).unwrap());
}
#[test]
fn snapshots_do_not_contain_sender_pixmaps() {
    let mut i = item();
    i.apply(
        HashMap::from([
            (
                "ToolTip".into(),
                val((
                    "icon",
                    vec![(1i32, 1i32, vec![0u8; 4])],
                    "title",
                    "description",
                )),
            ),
            ("Status".into(), val("Passive")),
            ("Menu".into(), val(Path::try_from("/menu").unwrap())),
        ]),
        0,
    );
    let p = i.metadata();
    assert_eq!(text(&p, "Status"), "Passive");
    assert!(bool::try_from(&p["MenuAvailable"]).unwrap());
    assert_eq!(
        <(String, String, String)>::try_from(p["ToolTip"].clone())
            .unwrap()
            .1,
        "title"
    );
}

#[test]
fn subscriptions_exclude_unrelated_session_traffic() {
    let rules = signal_rules().unwrap();
    let signal = |iface: &str, member: &str| {
        zbus::message::Message::signal("/fixture", iface, member)
            .unwrap()
            .build(&())
            .unwrap()
    };
    let accepts = |m: &zbus::Message| rules.iter().any(|r| r.matches(m).unwrap());
    assert!(!accepts(&signal("org.example.Other", "Changed")));
    assert!(!accepts(&signal("com.canonical.dbusmenu", "Unrelated")));
    let properties = |iface: &str| {
        zbus::message::Message::signal(
            "/fixture",
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
        )
        .unwrap()
        .build(&(iface, Props::new(), Vec::<String>::new()))
        .unwrap()
    };
    assert!(!accepts(&properties("org.mpris.MediaPlayer2.Player")));
    for iface in ITEM_IFACES {
        assert!(accepts(&signal(iface, "NewIcon")));
        assert!(accepts(&properties(iface)));
    }
    for member in ["LayoutUpdated", "ItemsPropertiesUpdated"] {
        assert!(accepts(&signal("com.canonical.dbusmenu", member)));
    }
}
#[test]
fn missing_properties_have_wire_typed_defaults() {
    for field in ["IconPixmap", "AttentionIconPixmap", "OverlayIconPixmap"] {
        assert!(
            model::Pixmaps::try_from(model::property_default(field))
                .unwrap()
                .is_empty()
        );
    }
    let (_, pixmap, title, description) =
        <(String, model::Pixmaps, String, String)>::try_from(model::property_default("ToolTip"))
            .unwrap();
    assert!(pixmap.is_empty() && title.is_empty() && description.is_empty());
    assert_eq!(
        Path::try_from(model::property_default("Menu"))
            .unwrap()
            .as_str(),
        "/"
    );
    assert!(!bool::try_from(model::property_default("ItemIsMenu")).unwrap());
    assert_eq!(
        String::try_from(model::property_default("Status")).unwrap(),
        "Active"
    );
}
