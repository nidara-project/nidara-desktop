// SPDX-License-Identifier: LGPL-3.0-or-later
//! Real exported renderer/layout/decoder/paint; synthetic Config1 session seam, no native claim.
use nk_settings::{
    Value,
    exports::Exports,
    image_load::Budget,
    manifest::{self, Page},
    portal::Appearance,
    render::{Builders, Editor, Host, Rendered},
    session::{ApplyError, Command, Raw, Session},
    styles::Styles,
    wallpaper,
};
use nk_text::{FontSet, ParleyBackend, Point, Size};
use nk_widgets::{Effect, Kind, Tree};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
const KEY: &str = "wallpaper.current";
struct Editing {
    session: Session,
    sent: Vec<Value>,
}
impl Editor for Editing {
    fn session(&self) -> &Session {
        &self.session
    }
    fn apply(&mut self, key: &str, value: Value) -> Result<(), ApplyError> {
        if let Some(Command::Apply { value, .. }) = self.session.apply(key, value)? {
            self.sent.push(value);
        }
        Ok(())
    }
}
struct Fixture {
    exports: Exports,
    styles: Styles,
    tree: Tree,
    editor: Editing,
    rendered: Option<Rendered>,
    text: ParleyBackend,
}
fn picture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/images")
        .join(name)
        .to_str()
        .unwrap()
        .into()
}
fn schema(current: &str, catalogue: &[String]) -> String {
    serde_json::json!({"schemaVersion":1,"keys":{KEY:{"type":"string","writable":true,"available":true,"value":current,"catalogue":catalogue}}}).to_string()
}
fn page() -> Page {
    manifest::parse(&serde_json::json!([{"id":"appearance","kind":"page","label":"settings.appearance.group.wallpaper","groups":[{"items":[{"decoration":"wallpaperPreview"},{"decoration":"wallpaperGallery"}]}]}])).unwrap().remove(0)
}
impl Fixture {
    fn new(current: &str, catalogue: &[String]) -> Self {
        let exports = Exports::load(&Exports::root()).unwrap();
        let appearance = Appearance {
            accent: [0., 136. / 255., 1.],
            dark: true,
            reduce_transparency: false,
            window_background: "opaque".into(),
            reduced_motion: false,
            font: "Inter Variable 11".into(),
            text_scale: 1.,
        };
        let styles = Styles::new(&exports, &appearance).unwrap();
        let mut tree = Tree::new("Settings", styles.metrics, styles.text.clone()).unwrap();
        styles.apply(&mut tree).unwrap();
        let content = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
        let (mut session, _) = Session::start();
        session.handle(Raw::Snapshot(Ok((7, 1, schema(current, catalogue)))));
        let mut f = Self {
            exports,
            styles,
            tree,
            editor: Editing {
                session,
                sent: vec![],
            },
            rendered: None,
            text: ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap(),
        };
        let mut builders = Builders::default();
        wallpaper::register(
            &mut builders,
            Budget {
                encoded_bytes: 4 * 1024 * 1024,
                decoded_bytes: 16 * 1024 * 1024,
            },
        );
        f.rendered = Some(Rendered::build(f.host(), &page(), &mut builders, content, 3).unwrap());
        f.layout();
        f
    }
    fn host(&mut self) -> Host<'_> {
        Host {
            tree: &mut self.tree,
            editor: &mut self.editor,
            exports: &self.exports,
            styles: &self.styles,
            window: None,
            modal: None,
        }
    }
    fn layout(&mut self) {
        self.tree
            .layout(
                Size {
                    width: 420.,
                    height: 500.,
                },
                false,
                &mut self.text,
            )
            .unwrap();
    }
    fn idle(&mut self) {
        let mut r = self.rendered.take().unwrap();
        r.idle(self.host()).unwrap();
        self.rendered = Some(r);
        self.layout();
    }
    fn effect(&mut self, id: u64) {
        let mut r = self.rendered.take().unwrap();
        r.effect(self.host(), Effect::Activated(id)).unwrap();
        self.rendered = Some(r);
    }
    fn raw(&mut self, raw: Raw) {
        let notices = self.editor.session.handle(raw).0;
        let mut r = self.rendered.take().unwrap();
        r.notices(self.host(), &notices).unwrap();
        self.rendered = Some(r);
        self.layout();
    }
    fn options(&self) -> Vec<u64> {
        self.tree
            .semantics()
            .nodes
            .iter()
            .filter(|(_, n)| n.role == nk_a11y::Role::RadioButton)
            .map(|(id, _)| *id)
            .collect()
    }
    fn image(&self) -> u64 {
        *self
            .tree
            .semantics()
            .nodes
            .iter()
            .find(|(_, n)| n.role == nk_a11y::Role::Image)
            .unwrap()
            .0
    }
    fn center(&self) -> [u8; 4] {
        let r = self.tree.node(self.image()).unwrap().bounds();
        let pixels = self
            .tree
            .paint(
                nk_wayland::Frame {
                    width: 420,
                    height: 500,
                    pixel_width: 420,
                    pixel_height: 500,
                    scale: 1.,
                    material: false,
                },
                nk_widgets::Surface::Content,
                self.styles.palette,
            )
            .unwrap();
        let i = ((r.y + r.height / 2.) as usize * 420 + (r.x + r.width / 2.) as usize) * 4;
        pixels[i..i + 4].try_into().unwrap()
    }
    fn until(&mut self, mut condition: impl FnMut(&Self) -> bool) {
        let limit = Instant::now() + Duration::from_secs(4);
        while !condition(self) {
            assert!(
                Instant::now() < limit,
                "decoder did not reach the required observable state"
            );
            self.idle();
            std::thread::yield_now();
        }
    }
}
#[test]
fn real_pixels_canonical_selection_reply_and_catalogue_identity() {
    let red = picture("sample.png");
    let green = picture("sample.jpg");
    let blue = picture("sample.gif");
    let mut f = Fixture::new(&red, &[red.clone(), green.clone(), blue.clone()]);
    let ids = f.options();
    assert_eq!(ids.len(), 3);
    assert!(f.tree.semantics().nodes[&ids[0]].states.checked);
    assert!(f.editor.sent.is_empty());
    f.until(|f| f.center()[2] > 240 && f.center()[1] < 20); // BGRA paint buffer: red channel is byte 2.
    f.effect(ids[0]);
    assert!(f.editor.sent.is_empty(), "same wallpaper must not Apply");
    f.effect(ids[1]);
    assert_eq!(f.editor.sent, vec![Value::Text(green.clone())]);
    f.until(|f| f.center()[1] > 240 && f.center()[2] < 20);
    f.raw(Raw::Reply {
        key: KEY.into(),
        epoch: 7,
        result: Err(ApplyError::Denied("fixture refusal".into())),
    });
    assert!(f.tree.semantics().nodes[&ids[0]].states.checked);
    assert!(
        f.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name.contains("fixture refusal")),
        "canonical reply must retain the visible error"
    );
    f.raw(Raw::Snapshot(Ok((
        7,
        3,
        schema("/elsewhere/unknown.png", &[blue, red, green]),
    ))));
    let semantics = f.tree.semantics();
    assert_eq!(f.options(), ids);
    assert!(
        ids.iter().all(|id| !semantics.nodes[id].states.checked),
        "unknown canonical must not invent a selected wallpaper"
    );
    let strip = *semantics
        .nodes
        .iter()
        .find(|(_, n)| n.children.len() == 3 && n.children.iter().all(|id| ids.contains(id)))
        .unwrap()
        .0;
    assert_eq!(
        semantics.nodes[&strip].children,
        vec![ids[2], ids[0], ids[1]]
    );
    f.tree.set_hidden(strip, true).unwrap();
    f.effect(ids[2]);
    assert_eq!(
        f.editor.sent.len(),
        1,
        "hidden stale activation wrote wallpaper"
    );
    let r = f.rendered.take().unwrap();
    r.unmount(f.host()).unwrap();
}
#[test]
fn empty_gallery_reappears_and_only_showing_images_decode() {
    let red = picture("sample.png");
    let mut f = Fixture::new(&red, &[]);
    assert!(f.options().is_empty());
    assert!(
        !f.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.role == nk_a11y::Role::Panel
                && n.name == "Wallpaper"
                && !n.states.hidden
                && !n.states.offscreen)
    );
    let mut catalogue = vec![
        red.clone(),
        picture("sample.jpg"),
        picture("sample.gif"),
        picture("sample.webp"),
        picture("sample.avif"),
    ];
    let bad = picture("missing-hidden.png");
    catalogue.push(bad.clone());
    f.raw(Raw::Snapshot(Ok((7, 2, schema(&red, &catalogue)))));
    let ids = f.options();
    assert_eq!(ids.len(), 6);
    f.until(|f| f.center()[2] > 240 && f.center()[1] < 20);
    assert!(!f.tree.showing(ids[5]));
    assert!(
        !f.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name.contains("image metadata:"))
    );
    let strip = *f
        .tree
        .semantics()
        .nodes
        .iter()
        .find(|(_, n)| n.children == ids)
        .unwrap()
        .0;
    f.tree.scroll_to(strip, Point { x: 10000., y: 0. }).unwrap();
    assert!(f.tree.showing(ids[5]));
    f.until(|f| {
        f.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name.contains("image metadata:"))
    });
    assert!(
        f.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name.contains(&bad) && !n.states.hidden && !n.states.offscreen)
    );
    assert!(f.editor.sent.is_empty(), "decode error must never Apply");
}

#[test]
fn every_wallpaper_variant_requires_its_export_and_unavailable_rows_do_not_write() {
    let mut exports = Exports::load(&Exports::root()).unwrap();
    for dark in [false, true] {
        for reduce_transparency in [false, true] {
            let appearance = Appearance {
                accent: [0., 136. / 255., 1.],
                dark,
                reduce_transparency,
                window_background: "opaque".into(),
                reduced_motion: false,
                font: "Inter Variable 11".into(),
                text_scale: 1.,
            };
            let look = Styles::new(&exports, &appearance).unwrap().wallpaper;
            assert_eq!(look.preview_decode, (640, 360));
            assert_eq!(look.thumbnail_decode, (160, 90));
            assert_eq!(
                look.thumbnails.picture,
                Size {
                    width: 80.,
                    height: 45.
                }
            );
        }
    }
    for variant in exports.components["variants"].as_array_mut().unwrap() {
        variant["wallpaper"]
            .as_object_mut()
            .unwrap()
            .remove("selectedBorder");
    }
    let appearance = Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "opaque".into(),
        reduced_motion: false,
        font: "Inter Variable 11".into(),
        text_scale: 1.,
    };
    assert!(
        Styles::new(&exports, &appearance).is_err(),
        "missing wallpaper token must not become a default"
    );
    let red = picture("sample.png");
    let mut f = Fixture::new(&red, &[red.clone(), picture("sample.jpg")]);
    let ids = f.options();
    f.raw(Raw::Owner(false));
    f.effect(ids[1]);
    assert!(f.editor.sent.is_empty());
    f.raw(Raw::Snapshot(Ok((8,1,serde_json::json!({"schemaVersion":1,"keys":{KEY:{"available":false,"writable":false,"type":"string"}}}).to_string()))));
    f.idle();
    assert!(
        f.options().is_empty(),
        "unavailable gallery must leave the semantic tree"
    );
    f.effect(ids[1]);
    assert!(f.editor.sent.is_empty());
}
