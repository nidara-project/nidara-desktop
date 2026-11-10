// SPDX-License-Identifier: LGPL-3.0-or-later
//! One card component for banners and the future notification history.
use crate::{notifications::Banner, popup::Look};
use nk_a11y::{Action, Bounds, Node, Role, Tree};
use nk_render::{Canvas, Color, ImageFit};
use nk_text::{Rect, TextStyle};
use nk_wayland::Pane;
use std::{collections::HashMap, sync::Arc};
use unicode_segmentation::UnicodeSegmentation;
pub const WIDTH: f64 = crate::cclayout::GRID_WIDTH;
pub const RADIUS: f64 = crate::cc::SQUARE_RADIUS;
const BASE: u64 = 1 << 60;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Body,
    Close,
    Action(String),
    More,
}
#[derive(Clone, Debug)]
pub struct Card {
    pub banner: Banner,
    pub age: Option<String>,
    pub rect: [f64; 4],
    pub buttons: Vec<(Target, String, [f64; 4])>,
}
/// The caller's output scale also belongs in every raster request.
pub struct Artwork<'a> {
    pub theme: &'a str,
    pub catalogue: &'a HashMap<String, crate::model::App>,
    pub namespace: &'a str,
    pub scale: f64,
}
impl Artwork<'_> {
    fn pixels(&self, logical: u32) -> u32 {
        (f64::from(logical) * self.scale).ceil().clamp(1., 1024.) as u32
    }
}
pub fn right_edge(
    width: f64,
    height: u32,
    prefs: &crate::prefs::Prefs,
    slots: &[crate::geometry::Slot],
) -> f64 {
    use crate::geometry as g;
    let mut edge = width - g::SCREEN_GAP;
    if prefs.position == g::Position::Right && !prefs.auto_hide && !slots.is_empty() {
        let mut l = g::layout(
            slots,
            prefs.icon_size,
            prefs.position,
            (width.max(1.) as u32, height),
            g::BAR_RESERVATION,
        );
        if prefs.magnification {
            l = g::envelope(
                l,
                slots,
                prefs.max_icon_size,
                (width.max(1.) as u32, height),
                g::BAR_RESERVATION,
            );
        }
        edge -= l.size.0 as f64 + g::SCREEN_GAP;
    }
    edge
}
pub fn layout(
    banners: &[Banner],
    right: f64,
    height: u32,
    pages: &HashMap<u64, usize>,
) -> Vec<Card> {
    let width = WIDTH.min((right - 4.).max(1.));
    let mut y = crate::barmodel::TOP + crate::barmodel::CAPSULE_H + crate::cc::HANG;
    let available = (height as f64 - y - 4. - banners.len().saturating_sub(1) as f64 * 16.).max(1.);
    let cap = available / banners.len().max(1) as f64;
    banners
        .iter()
        .map(|b| {
            let actions: Vec<_> = b
                .notice
                .actions
                .iter()
                .filter(|a| a.id != "default")
                .collect();
            let error_h = if b.error.is_empty() { 0. } else { 28. };
            let h = ((if actions.is_empty() { 112_f64 } else { 152_f64 }) + error_h).min(cap);
            let rect = [right - width, y, width, h];
            let mut buttons = vec![(
                Target::Close,
                "Close notification".into(),
                [right - 36., y + 8., 28., 28.],
            )];
            if !actions.is_empty() {
                let count = if actions.len() > 3 { 3 } else { actions.len() };
                let page = pages.get(&b.instance).copied().unwrap_or(0);
                let first = if actions.len() > 3 {
                    (page * 2) % actions.len()
                } else {
                    0
                };
                let room = (width - 32.) / count as f64;
                for i in 0..count {
                    let (target, label) = if actions.len() > 3 && i == 2 {
                        (Target::More, "More actions…".into())
                    } else {
                        let a = actions[(first + i) % actions.len()];
                        (Target::Action(a.id.clone()), a.label.clone())
                    };
                    buttons.push((
                        target,
                        label,
                        [
                            rect[0] + 16. + i as f64 * room,
                            y + h - 40. - error_h,
                            room - 4.,
                            28.,
                        ],
                    ));
                }
            }
            y += h + 16.;
            Card {
                banner: b.clone(),
                age: None,
                rect,
                buttons,
            }
        })
        .collect()
}
impl Card {
    pub fn translate(&mut self, x: f64, y: f64) {
        self.rect[0] += x;
        self.rect[1] += y;
        for (_, _, r) in &mut self.buttons {
            r[0] += x;
            r[1] += y;
        }
    }

    pub fn pane(&self) -> Pane {
        Pane {
            x: self.rect[0],
            y: self.rect[1],
            width: self.rect[2],
            height: self.rect[3],
            radius: RADIUS.min(self.rect[3] / 2.),
            exponent: 2.,
            pointer: None,
        }
    }
    pub fn hit(&self, p: (f64, f64)) -> Option<Target> {
        if !inside(self.rect, p) {
            return None;
        }
        Some(
            self.buttons
                .iter()
                .find(|(_, _, r)| inside(*r, p))
                .map(|(t, _, _)| t.clone())
                .unwrap_or(Target::Body),
        )
    }
    pub fn node_id(&self) -> u64 {
        BASE + self.banner.instance * 64
    }
    pub fn target_for(&self, id: u64) -> Option<Target> {
        let base = self.node_id();
        if id == base {
            Some(Target::Body)
        } else {
            self.buttons
                .get(id.checked_sub(base + 1)? as usize)
                .map(|(t, _, _)| t.clone())
        }
    }
    pub fn semantics(&self, tree: &mut Tree) {
        let b = &self.banner;
        let mut n = Node::new(
            self.node_id(),
            if self.age.is_some() {
                Role::Panel
            } else if b.notice.critical() {
                Role::Alert
            } else {
                Role::Notification
            },
            format!("{}: {}", b.notice.app_name, b.notice.summary),
        );
        n.description = if b.error.is_empty() {
            b.notice.body.clone()
        } else {
            format!("{} {}", b.notice.body, b.error)
        };
        if let Some(age) = &self.age {
            n.description = format!("{} {age}", n.description);
        }
        n.actions = vec![Action::Activate, Action::Focus];
        n.bounds = bounds(self.rect);
        for (i, (_, label, r)) in self.buttons.iter().enumerate() {
            let id = n.id + 1 + i as u64;
            let mut button = Node::new(id, Role::Button, label);
            button.actions = vec![Action::Activate, Action::Focus];
            button.bounds = bounds(*r);
            n.children.push(id);
            tree.nodes.insert(id, button);
        }
        tree.nodes.get_mut(&tree.root).unwrap().children.push(n.id);
        tree.nodes.insert(n.id, n);
    }
    pub fn paint(
        &self,
        c: &mut Canvas,
        look: &mut Look,
        material: bool,
        art: &Artwork<'_>,
    ) -> nk_wayland::Result<()> {
        let b = &self.banner;
        let r = self.rect;
        c.clip_rounded_rect(rect(r), RADIUS.min(r[3] / 2.));
        if !material {
            c.rounded_rect(rect(r), RADIUS, look.style.row.background);
        }
        let image = b.notice.hint("image-path");
        let thumbnail = if image.is_empty() {
            b.notice.hint("image_path")
        } else {
            image
        };
        let thumb = asset_image(art.namespace, b, thumbnail, art.pixels(64));
        let text_x = r[0] + 72.;
        let room = (r[2] - 88. - if thumb.is_some() { 68. } else { 0. }).max(1.);
        if let Some(asset) = app_asset(art, b) {
            c.image(
                &asset.raster,
                rect([r[0] + 16., r[1] + 24., 44., 44.]),
                ImageFit::Contain,
            );
        }
        if let Some(asset) = thumb {
            let bounds = rect([r[0] + r[2] - 80., r[1] + 40., 64., 64.]);
            c.clip_rounded_rect(bounds, 64. * crate::geometry::ICON_CORNER);
            c.image(&asset.raster, bounds, ImageFit::Contain);
            c.pop_clip();
        }
        let style = TextStyle {
            size: 13.,
            line_height: 1.35,
            ..look.styles.text.clone()
        };
        text(
            c,
            look,
            &b.notice.app_name,
            &TextStyle {
                size: 11.,
                ..style.clone()
            },
            [
                text_x,
                r[1] + 12.,
                room - if self.age.is_some() { 80. } else { 20. },
                16.,
            ],
            1,
            0.65,
        )?;
        if let Some(age) = &self.age {
            text(
                c,
                look,
                age,
                &TextStyle {
                    size: 11.,
                    ..style.clone()
                },
                [r[0] + r[2] - 100., r[1] + 12., 60., 16.],
                1,
                0.65,
            )?;
        }
        text(
            c,
            look,
            &b.notice.summary,
            &TextStyle {
                weight: 700.,
                ..style.clone()
            },
            [text_x, r[1] + 31., room, 20.],
            1,
            1.,
        )?;
        let body_bottom = self
            .buttons
            .iter()
            .filter(|(t, _, _)| *t != Target::Close)
            .map(|(_, _, r)| r[1] - 8.)
            .fold(
                r[1] + r[3] - if b.error.is_empty() { 8. } else { 28. },
                f64::min,
            );
        text(
            c,
            look,
            &b.notice.body,
            &style,
            [
                text_x,
                r[1] + 54.,
                room,
                (body_bottom - r[1] - 54.).clamp(1., 40.),
            ],
            2,
            0.85,
        )?;
        for (t, label, br) in &self.buttons {
            if *t == Target::Close {
                text(
                    c,
                    look,
                    "×",
                    &TextStyle {
                        size: 18.,
                        ..style.clone()
                    },
                    *br,
                    1,
                    0.65,
                )?;
            } else {
                c.rounded_rect(rect(*br), 14., ink(0.08));
                text(
                    c,
                    look,
                    label,
                    &style,
                    [br[0] + 8., br[1] + 5., (br[2] - 16.).max(1.), 20.],
                    1,
                    1.,
                )?;
            }
        }
        if !b.error.is_empty() {
            text(
                c,
                look,
                &b.error,
                &style,
                [r[0] + 16., r[1] + r[3] - 28., r[2] - 32., 20.],
                1,
                1.,
            )?;
        }
        c.pop_clip();
        Ok(())
    }
}
fn asset_image(
    namespace: &str,
    b: &Banner,
    path: &str,
    side: u32,
) -> Option<Arc<crate::icon_memory::Asset>> {
    if path.is_empty() {
        return None;
    }
    let path = path
        .strip_prefix("file://")
        .and_then(|_| glib::filename_from_uri(path).ok().map(|(p, _)| p))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    if !std::path::Path::new(&path).is_absolute() {
        return None;
    }
    let m = crate::icon_memory::global()?;
    let key = crate::icon_memory::Key::Image {
        namespace: format!("{namespace}:{}", b.instance),
        generation: b.content,
        path,
        side,
    };
    m.request(key.clone());
    m.get(&key)
}
/// The app that sent a notice: its `desktop-entry` hint, as given or with `.desktop` added
/// (catalogue ids carry the suffix, and a reverse-DNS name may itself end in `.desktop`, as
/// `org.telegram.desktop` does, so the hint is never trimmed), else the one app whose name
/// or declared icon matches.
fn sender_app<'a>(
    apps: &'a HashMap<String, crate::model::App>,
    b: &Banner,
) -> Option<&'a crate::model::App> {
    let hint = b.notice.hint("desktop-entry");
    let direct = (!hint.is_empty())
        .then(|| {
            apps.get(hint)
                .or_else(|| apps.get(&format!("{hint}.desktop")))
        })
        .flatten();
    let mut matches = apps.values().filter(|a| {
        a.name.eq_ignore_ascii_case(&b.notice.app_name)
            || !b.notice.app_icon.is_empty() && a.raw_icon == b.notice.app_icon
    });
    let candidate = matches.next();
    let unique = if matches.next().is_none() {
        candidate
    } else {
        None
    };
    direct.or(unique)
}
/// The icon a notice names for itself: its `app_icon`, or else an icon NAME in its image hint.
/// The spec lets `image-path` be either; a name there is the notice's icon, not a picture to
/// show beside the text (Pamac sends `system-software-install-symbolic`, with a desktop entry
/// that is only an autostart one).
fn sender_icon(b: &Banner) -> &str {
    if !b.notice.app_icon.is_empty() {
        return &b.notice.app_icon;
    }
    let image = match b.notice.hint("image-path") {
        "" => b.notice.hint("image_path"),
        image => image,
    };
    if std::path::Path::new(image).is_absolute() || image.contains("://") {
        ""
    } else {
        image
    }
}
/// The art of a sender no app or icon names: the information glyph, as the TS card had it.
const UNKNOWN_SENDER: &str = "nd-dialog-information-symbolic";
fn app_asset(art: &Artwork<'_>, b: &Banner) -> Option<Arc<crate::icon_memory::Asset>> {
    let theme = art.theme;
    let apps = art.catalogue;
    let namespace = art.namespace;
    let side = art.pixels(44);
    let m = crate::icon_memory::global()?;
    if let Some(app) = sender_app(apps, b)
        && let Some(key) = m.current_app(&app.id, 44, art.scale)
    {
        m.request(key.clone());
        if let Some(asset) = m.get(&key) {
            return Some(asset);
        }
        if !m.unavailable(&key) {
            return None;
        }
    }
    let name = sender_icon(b);
    if (std::path::Path::new(name).is_absolute() || name.starts_with("file://"))
        && let Some(a) = asset_image(namespace, b, name, side)
    {
        return Some(a);
    }
    if !std::path::Path::new(name).is_absolute()
        && !name.starts_with("file://")
        && !matches!(
            name,
            "" | "application-x-executable"
                | "application-default-icon"
                | "dialog-information"
                | "dialog-information-symbolic"
                | "image-missing"
                | "text-x-generic"
                | "audio-x-generic"
                | "video-x-generic"
                | "preferences-system-details-symbolic"
                | "preferences-system-symbolic"
                | "unknown"
        )
    {
        let key = m.named(theme, name, vec![], side, false);
        m.request(key.clone());
        if let Some(a) = m.get(&key) {
            return Some(a);
        }
        if !m.unavailable(&key) {
            return None;
        }
    }
    let reference = crate::paths::icon_reference();
    let extra = reference
        .parent()
        .map(|p| vec![p.to_path_buf()])
        .unwrap_or_default();
    let fallback_theme = reference
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("nidara");
    let key = m.named(fallback_theme, UNKNOWN_SENDER, extra, side, true);
    m.request(key.clone());
    m.get(&key)
}
pub(crate) fn text(
    c: &mut Canvas,
    look: &mut Look,
    s: &str,
    style: &TextStyle,
    r: [f64; 4],
    lines: usize,
    alpha: f32,
) -> nk_wayland::Result<()> {
    let s = s.replace(['\r', '\n'], " ");
    let graphemes: Vec<_> = s
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()))
        .collect();
    let fits = |look: &mut Look, s: &str| {
        crate::cc::lay_out(look, s, style, r[2].max(1.) as f32)
            .ok()
            .filter(|l| {
                l.lines().len() <= lines
                    && l.measured_size().height <= r[3] as f32
                    && l.measured_size().width <= r[2] as f32 + 0.5
            })
    };
    let mut out = s.clone();
    if fits(look, &out).is_none() {
        let (mut lo, mut hi) = (0, graphemes.len().saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            let candidate = format!("{}…", s[..graphemes[mid]].trim_end());
            if fits(look, &candidate).is_some() {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        out = format!("{}…", s[..graphemes[lo]].trim_end());
    }
    c.clip(rect(r));
    if let Ok(layout) = crate::cc::lay_out(look, &out, style, r[2].max(1.) as f32) {
        c.layout(&layout, (r[0] as f32, r[1] as f32), ink(alpha))?;
    }
    c.pop_clip();
    Ok(())
}
pub fn inside(r: [f64; 4], p: (f64, f64)) -> bool {
    p.0 >= r[0] && p.1 >= r[1] && p.0 < r[0] + r[2] && p.1 < r[1] + r[3]
}
fn rect(r: [f64; 4]) -> Rect {
    Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}
fn bounds(r: [f64; 4]) -> Bounds {
    Bounds {
        x: r[0],
        y: r[1],
        width: r[2],
        height: r[3],
    }
}
fn ink(a: f32) -> Color {
    Color::new([1., 1., 1., a])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn banner(id: u32) -> Banner {
        Banner {notice:crate::notifications::Notice::parse(&serde_json::json!({"id":id,"summary":"A card","hints":{"urgency":2},"actions":(0..8).map(|n|serde_json::json!({"id":format!("key{n}"),"label":format!("action{n}")})).collect::<Vec<_>>()} ).to_string()).unwrap(),instance:id as u64,content:1,output:"a".into(),deadline:None,hovered:false,error:String::new()}
    }
    #[test]
    fn an_icon_name_in_the_image_hint_is_the_notices_icon() {
        let icon = |extra: serde_json::Value| {
            let mut n = serde_json::json!({"id": 1, "summary": "A card"});
            n.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let mut b = banner(1);
            b.notice = crate::notifications::Notice::parse(&n.to_string()).unwrap();
            sender_icon(&b).to_string()
        };
        let pamac =
            serde_json::json!({"hints": {"image-path": "system-software-install-symbolic"}});
        assert_eq!(icon(pamac), "system-software-install-symbolic");
        let old = serde_json::json!({"hints": {"image_path": "update-notifier"}});
        assert_eq!(icon(old), "update-notifier");
        // A picture is not an icon; an app_icon comes first.
        let photo = serde_json::json!({"hints": {"image-path": "/tmp/a/icon.png"}});
        assert_eq!(icon(photo), "");
        let uri = serde_json::json!({"hints": {"image-path": "file:///tmp/a/icon.png"}});
        assert_eq!(icon(uri), "");
        let both = serde_json::json!({"app_icon": "firefox", "hints": {"image-path": "x"}});
        assert_eq!(icon(both), "firefox");
    }
    #[test]
    fn a_desktop_entry_hint_finds_its_app_even_when_its_name_ends_in_desktop() {
        let app = |id: &str, name: &str| {
            (
                id.to_string(),
                crate::model::App {
                    id: id.into(),
                    name: name.into(),
                    ..Default::default()
                },
            )
        };
        let apps = HashMap::from([
            app("org.telegram.desktop.desktop", "Telegram"),
            app("org.telegram.desktop.extra.desktop", "Other"),
            app("firefox.desktop", "Firefox"),
        ]);
        let sent = |hint: &str, name: &str| {
            let mut b = banner(1);
            b.notice = crate::notifications::Notice::parse(
                &serde_json::json!({"id": 1, "app_name": name, "hints": {"desktop-entry": hint}})
                    .to_string(),
            )
            .unwrap();
            sender_app(&apps, &b).map(|a| a.id.clone())
        };
        assert_eq!(
            sent("org.telegram.desktop", "Telegram Desktop").as_deref(),
            Some("org.telegram.desktop.desktop")
        );
        assert_eq!(
            sent("firefox.desktop", "").as_deref(),
            Some("firefox.desktop")
        );
        assert_eq!(sent("firefox", "").as_deref(), Some("firefox.desktop"));
        assert_eq!(sent("", "Firefox").as_deref(), Some("firefox.desktop"));
        assert_eq!(sent("org.manjaro.pamac.tray", "Package Manager"), None);
    }
    #[test]
    fn an_unknown_sender_is_drawn_with_the_information_glyph_that_ships() {
        let theme = crate::paths::icon_reference();
        assert!(
            theme
                .join(format!("scalable/actions/{UNKNOWN_SENDER}.svg"))
                .is_file(),
            "{UNKNOWN_SENDER} is not in {theme:?}"
        );
    }
    #[test]
    fn error_has_its_own_row_and_reader_description() {
        let mut b = banner(1);
        b.error = "Could not activate. Try again.".into();
        let cards = layout(&[b], 1276., 720, &HashMap::new());
        let c = &cards[0];
        let error_top = c.rect[1] + c.rect[3] - 28.;
        assert!(
            c.buttons
                .iter()
                .filter(|(t, _, _)| *t != Target::Close)
                .all(|(_, _, r)| r[1] + r[3] < error_top)
        );
        let mut tree = Tree {
            root: 1,
            nodes: std::collections::BTreeMap::from([(1, Node::new(1, Role::Window, "test"))]),
        };
        c.semantics(&mut tree);
        assert!(tree.nodes[&c.node_id()].description.contains("Try again"));
    }
    #[test]
    fn right_dock_avoidance_is_shared_and_input_gaps_are_empty() {
        let mut p = crate::prefs::Prefs::default();
        let slots = vec![crate::geometry::Slot::Icon; 4];
        let bottom = right_edge(1280., 720, &p, &slots);
        p.position = crate::geometry::Position::Right;
        let right = right_edge(1280., 720, &p, &slots);
        assert!(right < bottom - 64.);
        p.auto_hide = true;
        assert_eq!(right_edge(1280., 720, &p, &slots), bottom);
        let cards = layout(&[banner(1), banner(2)], right, 720, &HashMap::new());
        assert_eq!(cards[0].rect[2], WIDTH);
        let y = cards[0].rect[1] + cards[0].rect[3] + 8.;
        assert!(cards.iter().all(|c| c.hit((right - 80., y)).is_none()));
        assert!(
            cards[0]
                .hit((right - 80., cards[0].rect[1] + 60.))
                .is_some()
        );
    }
    #[test]
    fn every_declared_action_is_reachable_and_critical_semantics_are_stable() {
        let b = banner(7);
        let mut reached = std::collections::HashSet::new();
        for page in 0..4 {
            let pages = HashMap::from([(b.instance, page)]);
            let cards = layout(std::slice::from_ref(&b), 1276., 720, &pages);
            for (t, _, _) in &cards[0].buttons {
                if let Target::Action(k) = t {
                    reached.insert(k.clone());
                }
            }
            let mut root = Node::new(1, Role::Window, "test");
            root.children = vec![];
            let mut tree = Tree {
                root: 1,
                nodes: std::collections::BTreeMap::from([(1, root)]),
            };
            cards[0].semantics(&mut tree);
            let n = &tree.nodes[&cards[0].node_id()];
            assert_eq!(n.role, Role::Alert);
            assert!(n.name.contains("A card"));
            assert_eq!(n.children.len(), 4);
        }
        assert_eq!(reached.len(), 8);
    }
}
