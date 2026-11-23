// SPDX-License-Identifier: LGPL-3.0-or-later
//! The kit's icon grid (#1168): `nk::IconItem`, an icon with its name under it, the whole of
//! it one control, on `nk::Grid`'s square cells; and `panel_layout`, a panel of them under a
//! floating search, sized to its output. Apps (the app grid) is its first surface; a file
//! manager or a dock folder can use it. `toolkit/tokens/icon-grid.json` holds every measure.
use crate::{
    Align, Button, Column, Corner, Image, Key, Label, Node, Overlay, Padding, Slot,
    tokens::IconGridStyle,
};
use nk_text::{Alignment, TextStyle};

/// An icon with its name under it, one control in a square cell. Its parts' keys are
/// `{key}/…`: the icon `{key}/icon` (a themed icon by name, or a slot its surface paints when
/// the name is empty) and, when it is new, the dot `{key}/new` its surface paints in the accent.
#[must_use]
pub struct IconItem<'a> {
    key: Key,
    name: String,
    action: String,
    icon: String,
    style: &'a IconGridStyle,
    base: &'a TextStyle,
    new: bool,
    description: String,
}

impl<'a> IconItem<'a> {
    /// `name` is shown and is its name for readers; `action` is what a press reports.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        style: &'a IconGridStyle,
        base: &'a TextStyle,
    ) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
            action: action.into(),
            icon: String::new(),
            style,
            base,
            new: false,
            description: String::new(),
        }
    }
    /// A themed icon by name, instead of the slot its surface paints.
    pub fn icon(mut self, name: impl Into<String>) -> Self {
        self.icon = name.into();
        self
    }
    /// Newly arrived: a dot by the icon's corner, and `said` for readers ("New").
    pub fn new_mark(mut self, said: impl Into<String>) -> Self {
        self.new = true;
        self.description = said.into();
        self
    }
}

impl From<IconItem<'_>> for Node {
    fn from(i: IconItem<'_>) -> Node {
        let s = i.style;
        let k = |part: &str| format!("{}/{part}", i.key.0);
        let icon: Node = Image::new(k("icon"), i.icon.clone(), s.icon).into();
        let icon = if i.new {
            Overlay::new(k("art"), icon)
                .layer(
                    Align::End,
                    Align::Start,
                    Padding::default(),
                    Slot::new(k("new"), s.dot),
                )
                .into()
        } else {
            icon
        };
        let mut name = i.base.clone();
        name.size = s.name;
        name.weight = s.name_weight;
        name.alignment = Alignment::Center;
        // Struts for the measured distances: from the cell's top to the icon, and to the name.
        let body = Column::new(
            k("col"),
            vec![
                Slot::new(k("top"), s.top).into(),
                icon,
                Slot::new(k("gap"), s.name_gap).into(),
                Label::new(k("name"), i.name.clone(), name)
                    .lines(s.lines)
                    .into(),
            ],
        )
        .align(Align::Center);
        let mut b = Button::with_child(i.key, i.name, i.action, body)
            .corner(Corner::Fixed(s.corner.round() as u32));
        if !i.description.is_empty() {
            b = b.description(i.description);
        }
        b.into()
    }
}

/// Where a panel of icons under a floating search lies on an output, and how many columns
/// and rows it shows: at most the tokens', fewer on a smaller output, never past its edges.
/// The panel is the same on any larger output (owner, #1168).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelLayout {
    pub columns: usize,
    pub rows: usize,
    /// The panel, the search over it, and the grid at rest (its first row under the search).
    pub panel: [f64; 4],
    pub search: [f64; 4],
    pub grid: [f64; 4],
    /// The content's padding inside the panel (top, side, bottom): the grid starts below the
    /// search and inside its rounded ends, and scrolls to the panel's edges.
    pub pad: (f64, f64, f64),
}

pub fn panel_layout(s: &IconGridStyle, output: (f64, f64)) -> PanelLayout {
    let (w, h) = output;
    // The grid sits inside the search's rounded ends.
    let side = s.inset_side + s.search / 2.;
    let top = s.inset_top + s.search + s.below;
    let bottom = s.inset_top;
    let fit = |room: f64| ((room + s.gap) / (s.cell + s.gap)).floor().max(1.) as usize;
    // The panel keeps an inset's margin to the output's edges.
    let columns = s.columns.min(fit(w - 2. * (side + s.inset_side)));
    let rows = s.rows.min(fit(h - top - bottom - 2. * s.inset_top));
    let span = |n: usize| n as f64 * s.cell + (n as f64 - 1.) * s.gap;
    let (gw, gh) = (span(columns), span(rows));
    let (pw, ph) = (gw + 2. * side, top + gh + bottom);
    let (px, py) = (((w - pw) / 2.).round(), ((h - ph) / 2.).round());
    PanelLayout {
        columns,
        rows,
        panel: [px, py, pw, ph],
        search: [px + s.inset_side, py + s.inset_top, gw + s.search, s.search],
        grid: [px + side, py + top, gw, gh],
        pad: (top, side, bottom),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style() -> IconGridStyle {
        crate::tokens::icon_grid_from(
            &serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../tokens/icon-grid.json"
            ))
            .unwrap()["default"],
        )
        .unwrap()
    }

    #[test]
    fn the_panel_is_the_same_on_any_larger_output() {
        let s = style();
        let a = panel_layout(&s, (2560., 1440.));
        let b = panel_layout(&s, (3840., 2160.));
        assert_eq!((a.columns, a.rows), (s.columns, s.rows));
        assert_eq!((a.panel[2], a.panel[3]), (b.panel[2], b.panel[3]));
        assert_eq!(a.panel[0] * 2. + a.panel[2], 2560.);
    }

    #[test]
    fn a_small_output_drops_columns_and_rows_and_keeps_its_edges() {
        let s = style();
        let l = panel_layout(&s, (800., 600.));
        assert!(l.columns < s.columns && l.rows < s.rows);
        assert!(l.panel[0] >= s.inset_side && l.panel[1] >= s.inset_top);
        assert!(l.panel[0] + l.panel[2] <= 800. - s.inset_side);
        assert!(l.panel[1] + l.panel[3] <= 600. - s.inset_top);
    }

    #[test]
    fn the_grid_sits_inside_the_search_ends_and_under_it() {
        let s = style();
        let l = panel_layout(&s, (1920., 1080.));
        // The search's rounded ends hold the grid's edge columns, names included.
        assert_eq!(l.grid[0], l.search[0] + s.search / 2.);
        assert_eq!(l.grid[0] + l.grid[2], l.search[0] + l.search[2] - s.search / 2.);
        assert_eq!(l.grid[1], l.search[1] + l.search[3] + s.below);
    }
}
