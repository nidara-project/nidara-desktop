// SPDX-License-Identifier: LGPL-3.0-or-later
//! A row's second line, a group's footer and the disclosure row (#915), with no compositor:
//! where they sit, what AT-SPI says of them, the keyboard and pointer, and their pixels.
use nk_a11y::Role;
use nk_render::rgba;
use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_widgets::{Command, Effect, Kind, Metrics, Palette, RowTextStyle, Surface, Tree};
use std::sync::Arc;

const DIM: (u8, u8, u8) = (150, 150, 150);

fn style() -> RowTextStyle {
    RowTextStyle {
        subtitle_scale: 0.93,
        subtitle: rgba(DIM.0, DIM.1, DIM.2, 255),
        footer_scale: 0.86,
        footer: rgba(DIM.0, DIM.1, DIM.2, 255),
        footer_gap: 8.,
        disclosure_icon_size: 16.,
        disclosure_open: "nd-pan-down".into(),
        disclosure_closed: "nd-pan-end".into(),
    }
}

struct Fixture {
    tree: Tree,
    text: ParleyBackend,
    group: u64,
    row: u64,
    switch: u64,
    disclosure: u64,
    after: u64,
}

fn fixture(with_style: bool) -> Fixture {
    let text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let mut tree = Tree::new(
        "Window",
        Metrics {
            sidebar: 0.,
            content: 600.,
            form_width: 600.,
            content_floor: 280.,
            titlebar: 48.,
            padding: 8.,
            gap: 4.,
            row: 48.,
            control: 24.,
            switch_width: 44.,
            radius: 8.,
            group_radius: 12.,
            focus_width: 2.,
            highlight_inset: 4.,
            hover_opacity: 0.08,
            separator_width: 1.,
        },
        TextStyle {
            size: 14.,
            ..Default::default()
        },
    )
    .unwrap();
    if with_style {
        tree.set_row_text_style(style()).unwrap();
    }
    let grey = |v| rgba(v, v, v, 255);
    tree.set_switch_style(nk_widgets::SwitchStyle {
        border: 1.,
        border_color: grey(90),
        checked_border_color: grey(0),
        track: grey(40),
        checked: grey(200),
        thumb: grey(255),
        thumb_margin: 3.,
        disabled_opacity: 0.45,
    })
    .unwrap();
    let reference = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &reference).unwrap());
    let root = tree.root();
    tree.append(root, Kind::TitleBar, "Title").unwrap();
    let scroll = tree.append(root, Kind::Scroll, "Content").unwrap();
    let group = tree.group(scroll, "Night light").unwrap();
    let (row, switch) = tree
        .row(group, "Night light", Kind::Switch { checked: false })
        .unwrap();
    let disclosure = tree.disclosure(group, "Advanced", true).unwrap();
    let (after, _) = tree
        .row(group, "Schedule", Kind::Switch { checked: true })
        .unwrap();
    Fixture {
        tree,
        text,
        group,
        row,
        switch,
        disclosure,
        after,
    }
}

fn layout(f: &mut Fixture) -> Result<(), String> {
    f.tree.layout(
        Size {
            width: 600.,
            height: 400.,
        },
        true,
        &mut f.text,
    )
}

fn child(t: &Tree, parent: u64, kind: Kind) -> Option<u64> {
    t.node(parent)?
        .children()
        .iter()
        .copied()
        .find(|c| t.node(*c).unwrap().kind() == kind)
}

#[test]
fn the_second_line_sits_under_the_label_and_describes_the_control() {
    let mut f = fixture(true);
    layout(&mut f).unwrap();
    let alone = f.tree.node(f.row).unwrap().bounds();
    f.tree
        .set_subtitle(f.row, Some("Warmer colours at night"))
        .unwrap();
    layout(&mut f).unwrap();
    let label = child(&f.tree, f.row, Kind::Label).unwrap();
    let sub = child(&f.tree, f.row, Kind::Subtitle).unwrap();
    let (l, s, r) = (
        f.tree.node(label).unwrap().bounds(),
        f.tree.node(sub).unwrap().bounds(),
        f.tree.node(f.row).unwrap().bounds(),
    );
    assert!(
        (s.y - (l.y + l.height)).abs() < 0.01,
        "stacked: {l:?} {s:?}"
    );
    assert!((l.x - s.x).abs() < 0.01, "one left edge");
    // The block is centred in the row, and smaller text than the label.
    let block = l.height + s.height;
    assert!((l.y - (r.y + (r.height - block) / 2.)).abs() < 0.01);
    assert!(s.height < l.height);
    assert!(r.height >= alone.height);
    let sem = f.tree.semantics();
    assert_eq!(sem.nodes[&f.switch].description, "Warmer colours at night");
    assert_eq!(sem.nodes[&f.row].description, "Warmer colours at night");
    assert_eq!(
        sem.nodes[&f.switch].name, "Night light",
        "the label still names it"
    );
    // Removed: gone from the tree and the description.
    f.tree.set_subtitle(f.row, None).unwrap();
    layout(&mut f).unwrap();
    assert!(child(&f.tree, f.row, Kind::Subtitle).is_none());
    assert_eq!(f.tree.semantics().nodes[&f.switch].description, "");
}

#[test]
fn the_footer_is_under_the_card_after_every_row_and_hides() {
    let mut f = fixture(true);
    let footer = f
        .tree
        .set_footer(f.group, Some("Follows the sunset"))
        .unwrap()
        .unwrap();
    // A row added after the footer still goes above it.
    let (late, _) = f
        .tree
        .row(f.group, "Late", Kind::Switch { checked: false })
        .unwrap();
    // (set_footer keeps itself last only when called; call it again as a renderer would.)
    f.tree
        .set_footer(f.group, Some("Follows the sunset"))
        .unwrap();
    layout(&mut f).unwrap();
    let b = |id| f.tree.node(id).unwrap().bounds();
    assert!(b(footer).y >= b(late).y + b(late).height + 8. - 0.01);
    let palette = palette();
    let frame = frame();
    let px = f.tree.paint(frame, Surface::Content, palette).unwrap();
    // Between the last row and the footer: the window, not the card.
    let gap_y = b(footer).y - 4.;
    let x = b(late).x + 2.;
    assert_eq!(
        pixel(&px, x, gap_y),
        (20, 20, 20),
        "the card stops above its footer"
    );
    assert_eq!(
        pixel(&px, x, b(late).y + 2.),
        (50, 50, 50),
        "the card holds the rows"
    );
    let group = b(f.group);
    f.tree.set_hidden(footer, true).unwrap();
    layout(&mut f).unwrap();
    assert!(f.tree.node(f.group).unwrap().bounds().height < group.height);
    assert!(
        !f.tree.semantics().nodes[&f.group]
            .children
            .contains(&footer)
    );
}

#[test]
fn a_disclosure_flips_by_key_and_pointer_and_says_it_is_expandable() {
    let mut f = fixture(true);
    layout(&mut f).unwrap();
    let d = f.disclosure;
    let sem = f.tree.semantics();
    let n = &sem.nodes[&d];
    assert_eq!(n.role, Role::ToggleButton);
    assert_eq!(n.name, "Advanced");
    assert!(n.states.expandable && n.states.expanded);
    let target = f.tree.target(d);
    assert_eq!(
        f.tree.dispatch(target, Command::Activate).unwrap(),
        Effect::Activated(d)
    );
    assert_eq!(f.tree.expanded(d), Some(false));
    assert!(!f.tree.semantics().nodes[&d].states.expanded);
    // A click on its label, not only on the chevron, flips it.
    let label = child(&f.tree, d, Kind::Label).unwrap();
    let l = f.tree.node(label).unwrap().bounds();
    let p = Point {
        x: l.x + 2.,
        y: l.y + l.height / 2.,
    };
    f.tree.pointer_press(p).unwrap();
    assert_eq!(f.tree.pointer_release(p).unwrap(), Effect::Activated(d));
    assert_eq!(f.tree.expanded(d), Some(true));
    // The model sets it without activating.
    f.tree.set_expanded(d, false).unwrap();
    assert_eq!(f.tree.expanded(d), Some(false));
    // In the Tab order between the rows around it.
    let order = f.tree.focus_order();
    let at = |id| order.iter().position(|o| *o == id).unwrap();
    let after = child(&f.tree, f.after, Kind::Switch { checked: true }).unwrap();
    assert!(at(f.switch) < at(d) && at(d) < at(after));
}

#[test]
fn the_chevron_points_down_open_and_ahead_closed() {
    let mut f = fixture(true);
    layout(&mut f).unwrap();
    let r = f.tree.node(f.disclosure).unwrap().bounds();
    let box_x = r.x + r.width - 8. - 16.;
    let inked = |px: &[u8]| {
        let mut rows = vec![0u32; 16];
        let mut cols = vec![0u32; 16];
        let top = (r.y + (r.height - 16.) / 2.) as u32;
        for y in 0..16 {
            for x in 0..16 {
                if pixel(px, box_x + x as f32, (top + y) as f32).0 > 100 {
                    rows[y as usize] += 1;
                    cols[x as usize] += 1;
                }
            }
        }
        (rows, cols)
    };
    let open = f.tree.paint(frame(), Surface::Content, palette()).unwrap();
    f.tree.set_expanded(f.disclosure, false).unwrap();
    layout(&mut f).unwrap();
    let closed = f.tree.paint(frame(), Surface::Content, palette()).unwrap();
    let (rows_open, cols_open) = inked(&open);
    let (rows_closed, cols_closed) = inked(&closed);
    // A downward chevron spans more columns than rows; one pointing ahead, the reverse.
    let span = |v: &[u32]| v.iter().filter(|n| **n > 0).count();
    assert!(
        span(&cols_open) > span(&rows_open),
        "{rows_open:?} {cols_open:?}"
    );
    assert!(
        span(&rows_closed) > span(&cols_closed),
        "{rows_closed:?} {cols_closed:?}"
    );
}

#[test]
fn row_texts_need_their_style() {
    let mut f = fixture(false);
    f.tree.set_subtitle(f.row, Some("x")).unwrap();
    assert!(layout(&mut f).unwrap_err().contains("row text style"));
    let mut bad = style();
    bad.disclosure_open.clear();
    assert!(f.tree.set_row_text_style(bad).is_err());
    assert!(
        f.tree.set_subtitle(f.group, Some("x")).is_err(),
        "a subtitle on a group"
    );
    assert!(
        f.tree.set_footer(f.row, Some("x")).is_err(),
        "a footer on a row"
    );
}

fn palette() -> Palette {
    let c = |v| rgba(v, v, v, 255);
    Palette {
        background: c(20),
        surface: c(50),
        text: c(255),
        disabled: c(120),
        selected: c(60),
        accent: rgba(0, 100, 255, 255),
        track: c(40),
        thumb: c(255),
        focus: rgba(0, 100, 255, 255),
        separator: c(90),
    }
}

fn frame() -> nk_wayland::Frame {
    nk_wayland::Frame {
        width: 600,
        height: 400,
        pixel_width: 600,
        pixel_height: 400,
        scale: 1.,
        material: false,
    }
}

fn pixel(pixels: &[u8], x: f32, y: f32) -> (u8, u8, u8) {
    let at = ((y as u32 * 600 + x as u32) * 4) as usize;
    (pixels[at + 2], pixels[at + 1], pixels[at])
}
