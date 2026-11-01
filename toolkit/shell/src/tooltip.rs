// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's tooltip (DOCK.md §6): an item's name on a pane of glass beside it, after the
//! pointer rests on it for `DELAY`; moving to the next item while one shows names it at
//! once. A popup of the dock's layer with NO grab: it never takes the pointer, the keyboard
//! or a click, and it gives way to a menu or the chooser (one popup at a time). Its
//! measures are the kit's tooltip's (tooltip.ts): 11 × 6 padding, 13 px text, radius 13.
//! Hyalo paints the glass (the menus' panel material) and its pointer toward the item
//! (bubble.rs); the text is ours.
use crate::popup::Look;
use nk_render::{Canvas, rgba};
use nk_text::{Layout, TextBackend};
use nk_wayland::{Material, Pane, PopupEvent, PopupId, PopupPlacement, PopupSide, Window};
use std::time::{Duration, Instant};

pub const DELAY: Duration = Duration::from_millis(500);
const PAD_X: f64 = 11.;
const PAD_Y: f64 = 6.;
const TEXT: f32 = 13.;
const RADIUS: f64 = 13.;

pub struct Tooltip {
    pub id: PopupId,
    /// The item it names, by key.
    pub anchor: String,
    rect: [i32; 4],
    side: PopupSide,
    /// The text's bubble, and the popup's size: that and its pointer.
    natural: (u32, u32),
    size: (u32, u32),
    layout: Layout,
    /// Where it was placed, and for which anchor: the body and its pointer follow both.
    placed: Option<([i32; 4], [i32; 4])>,
    body: [f64; 4],
    material: Option<Material>,
    dirty: bool,
}

impl Tooltip {
    pub fn open(
        w: &mut Window,
        look: &mut Look,
        text: &str,
        anchor: String,
        rect: [i32; 4],
        side: PopupSide,
    ) -> Result<Self, String> {
        let mut style = look.styles.text.clone();
        style.size = TEXT;
        let layout = look.text.layout(text, &style, 4096.)?;
        let m = layout.measured_size();
        let natural = (
            (m.width as f64 + 2. * PAD_X).ceil() as u32,
            (m.height as f64 + 2. * PAD_Y).ceil() as u32,
        );
        let size = crate::bubble::with_pointer(natural, side);
        let id = w.open_passive_popup(PopupPlacement { anchor: rect, size }, side)?;
        Ok(Self {
            id,
            anchor,
            rect,
            side,
            natural,
            size,
            layout,
            placed: None,
            body: [0., 0., natural.0 as f64, natural.1 as f64],
            material: None,
            dirty: true,
        })
    }

    pub fn follow(
        &mut self,
        w: &mut Window,
        rect: [i32; 4],
        side: PopupSide,
    ) -> Result<(), String> {
        if rect == self.rect && side == self.side {
            return Ok(());
        }
        (self.rect, self.side) = (rect, side);
        self.size = crate::bubble::with_pointer(self.natural, side);
        w.reposition_popup_overlay(
            self.id,
            PopupPlacement {
                anchor: rect,
                size: self.size,
            },
            0,
        )
    }

    pub fn close(self, w: &mut Window) {
        w.close_menu_popup(self.id);
    }

    /// False once the compositor dismissed it.
    pub fn event(&mut self, event: PopupEvent) -> bool {
        match event {
            PopupEvent::Done => false,
            PopupEvent::Configure => {
                self.dirty = true;
                true
            }
            _ => true,
        }
    }

    pub fn sync(&mut self, w: &mut Window, look: &Look) -> Result<(), String> {
        let Some(geometry) = w.popup_overlay_geometry(self.id) else {
            return Ok(());
        };
        if self.placed != Some((geometry, self.rect)) {
            self.placed = Some((geometry, self.rect));
            let (width, height) = (geometry[2].max(1) as f64, geometry[3].max(1) as f64);
            let pane = crate::bubble::place(geometry, self.rect, RADIUS, 2.).unwrap_or((
                [0., 0., width, height],
                Pane {
                    x: 0.,
                    y: 0.,
                    width,
                    height,
                    radius: RADIUS.min(width.min(height) / 2.),
                    exponent: 2.,
                    pointer: None,
                },
            ));
            self.body = pane.0;
            self.material = look
                .panel
                .as_ref()
                .and_then(|p| p.at(pane.1.width.min(pane.1.height)).ok())
                .map(|mut m| {
                    m.shapes = vec![pane.1];
                    m
                });
            self.dirty = true;
        }
        if !self.dirty {
            return Ok(());
        }
        let Some(frame) = w.popup_overlay_frame(self.id)? else {
            return Ok(());
        };
        let mut c = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        let [bx, by, width, height] = self.body;
        if self.material.is_none() || !frame.material {
            // No compositor glass: an opaque bubble of our own, without its pointer (D5).
            c.rounded_rect(
                nk_text::Rect {
                    x: bx as f32,
                    y: by as f32,
                    width: width as f32,
                    height: height as f32,
                },
                RADIUS.min(width.min(height) / 2.),
                rgba(40, 40, 44, 240),
            );
        }
        let m = self.layout.measured_size();
        let origin = (
            (bx + (width - m.width as f64) / 2.) as f32,
            (by + (height - m.height as f64) / 2.) as f32,
        );
        // The shell's dark skin: white text (the kit's `.nidara-tooltip.dark`).
        c.layout(&self.layout, origin, rgba(255, 255, 255, 255))?;
        if w.paint_popup_overlay(self.id, frame, &c.finish(), self.material.as_ref())? {
            self.dirty = false;
        }
        Ok(())
    }
}

/// Where the pointer rests and whether its tooltip may show: the dwell before the first,
/// none again on an item that was pressed until the pointer moves to another one.
#[derive(Default)]
pub struct Hover {
    key: Option<String>,
    since: Option<Instant>,
    quiet: bool,
    /// A tooltip showed on the previous item: the next one shows at once.
    warm: bool,
}

impl Hover {
    /// The pointer is over `key` (None: over no item). True when it changed item.
    pub fn over(&mut self, key: Option<&str>, now: Instant) -> bool {
        if self.key.as_deref() == key {
            return false;
        }
        self.key = key.map(str::to_string);
        self.since = key.map(|_| now);
        self.quiet = false;
        if key.is_none() {
            self.warm = false;
        }
        true
    }
    /// A press: no tooltip on this item any more, and none warm.
    pub fn press(&mut self) {
        (self.quiet, self.warm) = (true, false);
    }
    pub fn shown(&mut self) {
        self.warm = true;
    }
    /// The item whose tooltip is due now, if any.
    pub fn due(&self, now: Instant) -> Option<&str> {
        let since = self.since?;
        (!self.quiet && (self.warm || now.saturating_duration_since(since) >= DELAY))
            .then_some(self.key.as_deref()?)
    }
    /// How long until `due` may say yes, while it is waiting.
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        let since = self.since?;
        (!self.quiet && !self.warm)
            .then(|| DELAY.saturating_sub(now.saturating_duration_since(since)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rest_shows_it_the_next_item_at_once_a_press_silences() {
        let mut h = Hover::default();
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        assert!(h.over(Some("a"), t));
        assert_eq!(h.due(ms(499)), None);
        assert_eq!(h.wait(ms(100)), Some(Duration::from_millis(400)));
        assert_eq!(h.due(ms(500)), Some("a"));
        h.shown();
        // Moving within the item changes nothing; to the next item: at once.
        assert!(!h.over(Some("a"), ms(600)));
        assert!(h.over(Some("b"), ms(700)));
        assert_eq!(h.due(ms(700)), Some("b"));
        // A press: none here, none warm for the next.
        h.press();
        assert_eq!(h.due(ms(2000)), None);
        h.over(Some("c"), ms(2100));
        assert_eq!(h.due(ms(2100)), None);
        assert_eq!(h.due(ms(2600)), Some("c"));
        // Off the items: cold again.
        h.shown();
        h.over(None, ms(2700));
        assert_eq!(h.due(ms(9000)), None);
        h.over(Some("a"), ms(9000));
        assert_eq!(h.due(ms(9000)), None);
    }
}
