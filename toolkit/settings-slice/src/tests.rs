// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use data::{Exports, Services};
use serde_json::json;
use std::collections::HashMap;
use zbus::zvariant::{OwnedValue, Value as Variant};

fn portal(rgb: (f64, f64, f64), scheme: u32, reduce: bool, transparent: bool) -> data::Portal {
    HashMap::from([
        (
            "org.freedesktop.appearance".into(),
            HashMap::from([
                (
                    "accent-color".into(),
                    Variant::from(rgb).try_to_owned().unwrap(),
                ),
                ("color-scheme".into(), OwnedValue::from(scheme)),
            ]),
        ),
        (
            "org.nidara.appearance".into(),
            HashMap::from([
                ("reduce-transparency".into(), OwnedValue::from(reduce)),
                ("window-transparency".into(), OwnedValue::from(transparent)),
            ]),
        ),
    ])
}
fn exports() -> Exports {
    Exports {
        pages: json!([{"id":"appearance","label":"title","icon":"nd-preferences-desktop-theme","groups":[
            {"i18n":"settings.appearance.group.base-style","items":["appearance.darkMode"]},
            {"i18n":"settings.appearance.group.windows","items":[
                {"key":"appearance.windowTransparency","sensitiveWhen":{"key":"accessibility.reduceTransparency","in":["false"]}},
                "appearance.windowBlur","appearance.windowControls"]}]}]),
        strings: json!({"title":"Appearance","settings.appearance.title":"Appearance","settings.appearance.group.base-style":"Base style","settings.appearance.group.windows":"Windows"}),
        english: json!({}),
        colors: json!({"accents":{"blue":"#0088ff"},"sets":[{"accent":"blue","dark":true,"reduceTransparency":false,"windowTransparency":false,"tokens":{
            "--nidara-text":"#ffffff","--nidara-text-secondary":"rgba(255,255,255,0.8)","--nidara-text-disabled":"rgba(255,255,255,0.3)","--nidara-bg":"rgba(22,22,34,0.8)",
            "--nidara-surface":"rgba(255,255,255,0.08)","--nidara-surface-back":"rgba(255,255,255,0.04)","--nidara-surface-raised":"rgba(255,255,255,0.2)",
            "--nidara-state-selected":"rgba(0,136,255,0.22)","--nidara-accent":"#0088ff","--nidara-thumb":"#ffffff"}}]}),
        sizes: json!({"scss":{"space-6":"24px","space-4":"16px","space-2":"8px","fse-title-1":"2em","fse-small":"0.93em"},"ts":{"WINDOW_LAYOUT":{"sidebar":250,"content":800,"openGutter":48,"minHeight":480},"ROW_HEIGHT":{"single":48,"double":72},"RADIUS":{"md":16,"lg":24}}}),
    }
}
fn services() -> Services {
    let mut keys = serde_json::Map::new();
    for (key, value) in
        data::KEYS
            .iter()
            .zip([json!(true), json!(false), json!(false), json!("left")])
    {
        let ui = if value.is_boolean() {
            json!({"title":key,"control":"toggle"})
        } else {
            json!({"title":key,"control":"segmented","options":[{"value":"left","label":"Left"},{"value":"right","label":"Right"}]})
        };
        keys.insert(
            (*key).into(),
            json!({"value":value,"ui":ui,"available":true}),
        );
    }
    keys.insert(
        "appearance.interfaceFont".into(),
        json!({"value":"Noto Sans 11"}),
    );
    keys.insert(
        "appearance.interfaceIconTheme".into(),
        json!({"value":"nidara"}),
    );
    keys.insert(
        "accessibility.reduceTransparency".into(),
        json!({"value":false}),
    );
    Services {
        schema: json!({"schemaVersion":1,"keys":keys}),
        portal: portal((0., 136. / 255., 1.), 1, false, false),
        epoch: 42,
        revision: 1,
    }
}
#[test]
fn every_portal_tuple_selects_exactly_one_set_and_unknowns_are_errors() {
    let mut e = exports();
    let mut sets = vec![];
    for accent in 0..9 {
        for dark in [false, true] {
            for reduce in [false, true] {
                for transparent in [false, true] {
                    sets.push(json!({"accent":accent.to_string(),"dark":dark,"reduceTransparency":reduce,"windowTransparency":transparent,"tokens":{"tuple":[accent,dark,reduce,transparent]}}));
                }
            }
        }
    }
    e.colors = json!({"sets":sets,"accents":(0..9).map(|i|(i.to_string(),json!(format!("#{:02x}88ff",i*20)))).collect::<serde_json::Map<_,_>>()});
    for accent in 0..9 {
        for dark in [false, true] {
            for reduce in [false, true] {
                for transparent in [false, true] {
                    let p = portal(
                        (accent as f64 * 20. / 255., 136. / 255., 1.),
                        if dark { 1 } else { 2 },
                        reduce,
                        transparent,
                    );
                    assert_eq!(
                        e.palette(&p).unwrap()["tuple"],
                        json!([accent, dark, reduce, transparent])
                    );
                }
            }
        }
    }
    assert!(e.palette(&portal((1., 0., 0.), 1, false, false)).is_err());
    assert!(
        e.palette(&portal((0., 136. / 255., 1.), 0, false, false))
            .is_err()
    );
    assert!(e.palette(&HashMap::new()).is_err());
}
#[test]
fn missing_authoritative_value_or_unknown_control_cannot_become_ready() {
    let mut s = services();
    s.schema["keys"][data::KEYS[0]]
        .as_object_mut()
        .unwrap()
        .remove("value");
    assert!(view::View::new(exports(), &s, false).is_err());
    let mut s = services();
    s.schema["keys"][data::KEYS[0]]["ui"]["control"] = json!("invented");
    assert!(view::View::new(exports(), &s, false).is_err());
}
#[test]
fn submitted_pixels_change_under_default_values_control_at_both_scales() {
    let mut fonts = view::Fonts::new();
    for scale in [1., 1.25] {
        let mut base = view::View::new(exports(), &services(), false).unwrap();
        let mut fault = view::View::new(exports(), &services(), true).unwrap();
        let a = base.paint(&mut fonts, 1100, 760, scale, true).unwrap();
        let b = fault.paint(&mut fonts, 1100, 760, scale, true).unwrap();
        assert!(a.full && b.full);
        assert_eq!(a.values, base.evidence);
        assert_eq!(b.values, fault.evidence);
        assert_ne!(a.values, b.values);
        assert_ne!(a.pixels, b.pixels);
        assert_eq!(a.samples.as_object().unwrap().len(), 4);
    }
}
#[test]
fn opaque_fallback_preserves_rgb_and_overlay_alpha() {
    let mut v = view::View::new(exports(), &services(), false).unwrap();
    let mut fonts = view::Fonts::new();
    let a = v.paint(&mut fonts, 1100, 760, 1., false).unwrap();
    assert!(
        a.pixels
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| u32::from_ne_bytes(*p) >> 24 == 255)
    );
    let glass = v.token("--nidara-bg", false).unwrap();
    let solid = v.token("--nidara-bg", true).unwrap();
    assert_eq!(&glass[..3], &solid[..3]);
    assert_eq!(solid[3], 255);
    assert!(v.token("--nidara-state-selected", false).unwrap()[3] < 255);
}
#[test]
fn invalid_font_does_not_silently_resolve_to_a_default() {
    assert!(view::parse_font("Noto Sans NaN").is_err());
    assert!(view::parse_font("Noto Sans 0").is_err());
    let mut f = view::Fonts::new();
    assert!(
        f.text("Hello", "no-such-nidara-font-862", 14., 100., 400.)
            .is_err()
    );
}

#[test]
fn offscreen_svg_is_not_loaded_and_visible_svg_cache_includes_scale() {
    let mut e = exports();
    for i in 0..30 {
        e.pages.as_array_mut().unwrap().push(
            json!({"id":format!("page-{i}"),"label":"title","icon":"nd-preferences-desktop-theme"}),
        );
    }
    e.pages
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"last-page","label":"title","icon":"nd-nonexistent-offscreen-test"}));
    let mut v = view::View::new(e, &services(), false).unwrap();
    let mut fonts = view::Fonts::new();
    v.paint(&mut fonts, 1100, 760, 1., true).unwrap();
    assert_eq!(v.cached_icons(), 1);
    v.paint(&mut fonts, 1100, 760, 1., true).unwrap();
    assert_eq!(v.cached_icons(), 1);
    v.paint(&mut fonts, 1100, 760, 1.25, true).unwrap();
    assert_eq!(v.cached_icons(), 2);
    v.sidebar_scroll = 48. * 31.;
    assert!(v.paint(&mut fonts, 1100, 760, 1., true).is_err());
}

#[test]
fn settings_data_of_another_version_or_none_is_refused() {
    assert!(data::check_version(Some("1\n")).is_ok());
    assert!(data::check_version(Some("2")).is_err());
    assert!(data::check_version(None).is_err());
}
