// SPDX-License-Identifier: LGPL-3.0-or-later
//! Range controls (#882): a slider and spin buttons, each holding a value the tree clamps and
//! steps — from the keys, the pointer, the model or an assistive technology, the same way. Its
//! look comes from the exported `components.json` range (`RangeStyle`); no defaults here.
use crate::*;
use nk_render::{Canvas, Color};

/// What a range control holds, and how its value is said ("4500 K", "07").
#[derive(Clone, Debug, PartialEq)]
pub struct ValueRange {
    pub min: f32,
    pub max: f32,
    /// The smallest change; every value is `min + n·step`.
    pub step: f32,
    /// Past an end, a step goes round to the other (the hours of a clock); a slider never does.
    pub wrap: bool,
    /// Zero padding of the integer part ("07").
    pub digits: usize,
    pub decimals: usize,
    /// Appended to the number, spacing included (" K").
    pub unit: String,
}
impl ValueRange {
    pub(crate) fn validate(&self) -> Result<()> {
        if ![self.min, self.max, self.step]
            .iter()
            .all(|v| v.is_finite())
            || self.min >= self.max
            || self.step <= 0.
        {
            return Err("invalid value range".into());
        }
        Ok(())
    }
    /// Clamp and snap to the step.
    pub(crate) fn snap(&self, value: f32) -> f32 {
        let steps = ((value.clamp(self.min, self.max) - self.min) / self.step).round();
        (self.min + steps * self.step).min(self.max)
    }
    pub fn text(&self, value: f32) -> String {
        let number = format!("{:.*}", self.decimals, value);
        let (int, frac) = number
            .split_once('.')
            .map_or((number.as_str(), ""), |(a, b)| (a, b));
        let (sign, int) = int.strip_prefix('-').map_or(("", int), |i| ("-", i));
        let int = format!("{sign}{int:0>width$}", width = self.digits);
        if frac.is_empty() {
            format!("{int}{}", self.unit)
        } else {
            format!("{int}.{frac}{}", self.unit)
        }
    }
}
/// The range controls' measurements and colours, resolved by the app from the export.
#[derive(Clone, Copy, Debug)]
pub struct RangeStyle {
    pub slider_width: f32,
    pub slider_track: f32,
    pub slider_thumb_radius: f32,
    pub slider_value_gap: f32,
    pub slider_fill_opacity: f32,
    pub slider_page_steps: f32,
    pub spin_height: f32,
    pub spin_text_width: f32,
    pub spin_button_width: f32,
    pub spin_border: f32,
    pub spin_border_color: Color,
    pub spin_gap: f32,
}
impl RangeStyle {
    fn validate(&self) -> Result<()> {
        let all = [
            self.slider_width,
            self.slider_track,
            self.slider_thumb_radius,
            self.slider_value_gap,
            self.slider_page_steps,
            self.spin_height,
            self.spin_text_width,
            self.spin_button_width,
            self.spin_border,
            self.spin_gap,
        ];
        if !all.iter().all(|v| v.is_finite() && *v >= 0.)
            || !(0. ..=1.).contains(&self.slider_fill_opacity)
            || self.slider_width <= 2. * self.slider_thumb_radius
        {
            return Err("invalid range measurements".into());
        }
        Ok(())
    }
}
/// One line, never wrapped: a value's text is short.
const UNBOUNDED: f32 = 1.0e6;
const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const PAGE_UP: u32 = 0xff55;
const PAGE_DOWN: u32 = 0xff56;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;

impl Tree {
    /// A row whose control is a slider over `range`, at `value`.
    pub fn slider(
        &mut self,
        group: NodeId,
        label: &str,
        range: ValueRange,
        value: f32,
    ) -> Result<(NodeId, NodeId)> {
        range.validate()?;
        let row = self.append(group, Kind::Row, "")?;
        self.append(row, Kind::Label, label)?;
        let value = range.snap(value);
        let id = self.append(row, Kind::Slider { value }, label)?;
        self.nodes.get_mut(&id).unwrap().range = Some(range);
        Ok((row, id))
    }
    /// A row whose control is a set of spin buttons (the time fields: hour and minute), each
    /// with its own name ("From hour"), its range and its value.
    pub fn fields(
        &mut self,
        group: NodeId,
        label: &str,
        spins: Vec<(&str, ValueRange, f32)>,
    ) -> Result<(NodeId, NodeId, Vec<NodeId>)> {
        if spins.is_empty() {
            return Err("fields need at least one spin button".into());
        }
        let row = self.append(group, Kind::Row, "")?;
        self.append(row, Kind::Label, label)?;
        let fields = self.append(row, Kind::Fields, label)?;
        let mut ids = vec![];
        for (name, range, value) in spins {
            range.validate()?;
            let value = range.snap(value);
            let id = self.append(fields, Kind::Spin { value }, name)?;
            self.nodes.get_mut(&id).unwrap().range = Some(range);
            ids.push(id);
        }
        Ok((row, fields, ids))
    }
    pub fn set_range_style(&mut self, style: RangeStyle) -> Result<()> {
        style.validate()?;
        self.range_style = Some(style);
        let ids: Vec<_> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                matches!(
                    n.kind,
                    Kind::Slider { .. } | Kind::Spin { .. } | Kind::Fields
                )
            })
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let n = self.nodes.get_mut(&id).unwrap();
            n.layout = None;
            n.constraint = 0.;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub fn value(&self, id: NodeId) -> Option<f32> {
        match self.nodes.get(&id)?.kind {
            Kind::Slider { value } | Kind::Spin { value } => Some(value),
            _ => None,
        }
    }
    /// Set a range control's value, clamped and stepped; true when it changed. The model's
    /// updates, the keys, the pointer and assistive technologies all come here.
    pub fn set_value(&mut self, id: NodeId, value: f32) -> Result<bool> {
        if !value.is_finite() {
            return Err("non-finite value".into());
        }
        let n = self.nodes.get_mut(&id).ok_or("unknown range control")?;
        let range = n.range.as_ref().ok_or("widget is not a range control")?;
        let value = range.snap(value);
        let kind = match n.kind {
            Kind::Slider { .. } => Kind::Slider { value },
            Kind::Spin { .. } => Kind::Spin { value },
            _ => return Err("widget is not a range control".into()),
        };
        if n.kind == kind {
            return Ok(false);
        }
        n.kind = kind;
        // Its value's text is retained in its layout: measured again, it keeps its width.
        n.layout = None;
        n.constraint = 0.;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(true)
    }
    /// A value asked by an assistive technology (AT-SPI `Value.CurrentValue`): like a key, on an
    /// available control of this generation only.
    pub fn request_value(&mut self, target: Target, value: f32) -> Result<Effect> {
        if target.generation != self.generation
            || !self.available(target.id)
            || self.nodes[&target.id].range.is_none()
        {
            return Err("stale, hidden, disabled or non-range target".into());
        }
        Ok(if self.set_value(target.id, value)? {
            Effect::Changed(target.id)
        } else {
            Effect::None
        })
    }
    /// Step from the current value by `steps`, wrapping where the range wraps.
    fn step_by(&mut self, id: NodeId, steps: f32) -> Result<bool> {
        let value = self.value(id).unwrap();
        let range = self.nodes[&id].range.clone().unwrap();
        let mut next = value + steps * range.step;
        if range.wrap {
            let span = range.max - range.min + range.step;
            next = range.min + (next - range.min).rem_euclid(span);
        }
        self.set_value(id, next)
    }
    pub(crate) fn range_key(&mut self, id: NodeId, sym: u32) -> Result<Option<Effect>> {
        let Some(range) = self.nodes[&id].range.clone() else {
            return Ok(None);
        };
        let page = self.range_style.map_or(10., |s| s.slider_page_steps);
        let slider = matches!(self.nodes[&id].kind, Kind::Slider { .. });
        let changed = match sym {
            RIGHT if slider => self.step_by(id, 1.)?,
            LEFT if slider => self.step_by(id, -1.)?,
            UP => self.step_by(id, 1.)?,
            DOWN => self.step_by(id, -1.)?,
            PAGE_UP => self.step_by(id, page)?,
            PAGE_DOWN => self.step_by(id, -page)?,
            HOME => self.set_value(id, range.min)?,
            END => self.set_value(id, range.max)?,
            _ => return Ok(None),
        };
        Ok(Some(if changed {
            Effect::Changed(id)
        } else {
            Effect::None
        }))
    }
    /// The slider's track, in window coordinates: its ends are where the thumb's centre stops.
    fn slider_track(&self, id: NodeId) -> Option<(f32, f32, f32)> {
        let s = self.range_style?;
        let r = self.nodes[&id].bounds;
        let x0 = r.x + s.slider_thumb_radius;
        Some((
            x0,
            r.x + s.slider_width - s.slider_thumb_radius,
            r.y + r.height / 2.,
        ))
    }
    /// A press, or a drag captured by a slider, puts its value under the pointer.
    pub fn range_drag(&mut self, p: Point) -> Result<Option<NodeId>> {
        let Some(id) = self.capture else {
            return Ok(None);
        };
        if !matches!(self.nodes[&id].kind, Kind::Slider { .. }) || self.capture_space.is_some() {
            return Ok(None);
        }
        let (x0, x1, _) = self
            .slider_track(id)
            .ok_or("slider without its range style")?;
        let range = self.nodes[&id].range.clone().unwrap();
        let f = ((p.x - x0) / (x1 - x0)).clamp(0., 1.);
        Ok(self
            .set_value(id, range.min + f * (range.max - range.min))?
            .then_some(id))
    }
    /// A click released on a spin button's minus or plus steps it.
    pub(crate) fn range_release(&mut self, id: NodeId, p: Point) -> Result<Option<Effect>> {
        match self.nodes[&id].kind {
            Kind::Slider { .. } => Ok(Some(Effect::None)),
            Kind::Spin { .. } => {
                let s = self.range_style.ok_or("spin without its range style")?;
                let r = self.nodes[&id].bounds;
                let plus = r.x + r.width - s.spin_button_width;
                let minus = plus - s.spin_button_width;
                let steps = if p.x >= plus {
                    1.
                } else if p.x >= minus {
                    -1.
                } else {
                    return Ok(Some(Effect::None));
                };
                Ok(Some(if self.step_by(id, steps)? {
                    Effect::Changed(id)
                } else {
                    Effect::None
                }))
            }
            _ => Ok(None),
        }
    }
    pub(crate) fn measure_range(
        &mut self,
        id: NodeId,
        backend: &mut impl TextBackend,
    ) -> Result<Size> {
        let s = self
            .range_style
            .ok_or("range control measured before its range style was set")?;
        let style = self.style.clone();
        let kind = self.nodes[&id].kind;
        if kind == Kind::Fields {
            let mut width: f32 = 0.;
            let mut height: f32 = 0.;
            let children = self.nodes[&id].children.clone();
            let visible: Vec<_> = children.iter().filter(|c| !self.is_hidden(**c)).collect();
            for c in &visible {
                let size = self.measure_range(**c, backend)?;
                width += size.width;
                height = height.max(size.height);
            }
            // Between two fields: a gap, the colon, a gap.
            width += (visible.len().max(1) - 1) as f32 * (2. * s.spin_gap + s.spin_border.max(2.));
            let size = Size { width, height };
            self.nodes.get_mut(&id).unwrap().measured = size;
            return Ok(size);
        }
        let range = self.nodes[&id].range.clone().unwrap();
        let value = self.value(id).unwrap();
        // The text's room: the widest the value can be, so a change never moves the row.
        let widest = [range.min, range.max]
            .iter()
            .map(|v| {
                backend
                    .layout(&range.text(*v), &style, UNBOUNDED)
                    .map(|l| l.measured_size())
            })
            .collect::<Result<Vec<_>>>()?;
        let room = widest.iter().map(|s| s.width).fold(0., f32::max);
        let text_height = widest.iter().map(|s| s.height).fold(0., f32::max);
        let layout = backend.layout(&range.text(value), &style, UNBOUNDED)?;
        let size = match kind {
            Kind::Slider { .. } => Size {
                width: s.slider_width + s.slider_value_gap + room,
                height: self
                    .metrics
                    .control
                    .max(2. * s.slider_thumb_radius)
                    .max(text_height),
            },
            _ => Size {
                width: s.spin_text_width.max(room) + 2. * s.spin_button_width + 2. * s.spin_border,
                height: s.spin_height.max(text_height + 2. * s.spin_border),
            },
        };
        let n = self.nodes.get_mut(&id).unwrap();
        n.layout = Some(layout);
        n.measured = size;
        Ok(size)
    }
    pub(crate) fn place_fields(&mut self, id: NodeId, r: Rect) {
        let s = self.range_style.unwrap();
        let mut x = r.x;
        for c in self.nodes[&id].children.clone() {
            if self.is_hidden(c) {
                continue;
            }
            let m = self.nodes[&c].measured;
            self.nodes.get_mut(&c).unwrap().bounds = Rect {
                x,
                y: r.y + (r.height - m.height) / 2.,
                width: m.width,
                height: m.height,
            };
            x += m.width + 2. * s.spin_gap + s.spin_border.max(2.);
        }
    }
    /// The focus/hover silhouette: the slider's thumb, a spin button's box.
    pub(crate) fn range_shape(&self, id: NodeId) -> (Rect, f32) {
        let r = self.nodes[&id].bounds;
        match (self.nodes[&id].kind, self.range_style) {
            (Kind::Slider { value }, Some(s)) => {
                let range = self.nodes[&id].range.as_ref().unwrap();
                let (x0, x1, cy) = self.slider_track(id).unwrap();
                let f = (value - range.min) / (range.max - range.min);
                let rad = s.slider_thumb_radius;
                (
                    Rect {
                        x: x0 + f * (x1 - x0) - rad,
                        y: cy - rad,
                        width: 2. * rad,
                        height: 2. * rad,
                    },
                    rad,
                )
            }
            _ => (r, self.metrics.radius),
        }
    }
    /// The control's own pixels; its value's text, hover and keyboard ring are the generic ones.
    pub(crate) fn paint_range(
        &self,
        id: NodeId,
        r: Rect,
        origin: Point,
        canvas: &mut Canvas,
        palette: Palette,
    ) -> Result<()> {
        let Some(s) = self.range_style else {
            return Ok(());
        };
        let n = &self.nodes[&id];
        let ink = if self.available(id) {
            palette.text
        } else {
            palette.disabled
        };
        match n.kind {
            Kind::Slider { .. } => {
                let (thumb, rad) = self.range_shape(id);
                let thumb = Rect {
                    x: thumb.x - origin.x,
                    y: thumb.y - origin.y,
                    ..thumb
                };
                let cy = thumb.y + rad;
                let left = r.x + s.slider_thumb_radius;
                let right = r.x + s.slider_width - s.slider_thumb_radius;
                let t = s.slider_track;
                let track = Rect {
                    x: left - t / 2.,
                    y: cy - t / 2.,
                    width: right - left + t,
                    height: t,
                };
                canvas.rounded_rect(track, (t / 2.) as f64, palette.track);
                let mut fill = palette.accent;
                fill.components[3] *= s.slider_fill_opacity;
                if !self.available(id) {
                    fill = palette.disabled;
                }
                canvas.rounded_rect(
                    Rect {
                        width: thumb.x + rad - track.x,
                        ..track
                    },
                    (t / 2.) as f64,
                    fill,
                );
                // The thumb, drawn a pixel inside its hit circle, as the kit does.
                let inner = Rect {
                    x: thumb.x + 1.,
                    y: thumb.y + 1.,
                    width: thumb.width - 2.,
                    height: thumb.height - 2.,
                };
                canvas.rounded_rect(inner, (rad - 1.) as f64, palette.thumb);
                if let Some(layout) = &n.layout {
                    let size = layout.measured_size();
                    canvas.layout(
                        layout,
                        (
                            r.x + r.width - size.width,
                            r.y + (r.height - size.height) / 2.,
                        ),
                        ink,
                    )?;
                }
            }
            Kind::Spin { .. } => {
                let radius = self.metrics.radius as f64;
                canvas.rounded_rect(r, radius, palette.surface);
                canvas.rounded_ring(r, radius, s.spin_border as f64, s.spin_border_color);
                let b = s.spin_button_width;
                let text_room = r.width - 2. * b;
                if let Some(layout) = &n.layout {
                    let size = layout.measured_size();
                    canvas.layout(
                        layout,
                        (
                            r.x + (text_room - size.width) / 2.,
                            r.y + (r.height - size.height) / 2.,
                        ),
                        ink,
                    )?;
                }
                // The minus and the plus, drawn: a bar, and a bar crossed.
                let mut glyph = ink;
                glyph.components[3] *= 0.7;
                let arm = (b * 0.4).min(r.height * 0.3);
                let w = 1.5;
                for (i, cross) in [(0., false), (1., true)] {
                    let cx = r.x + text_room + b * (i + 0.5);
                    let cy = r.y + r.height / 2.;
                    canvas.rect(
                        Rect {
                            x: cx - arm / 2.,
                            y: cy - w / 2.,
                            width: arm,
                            height: w,
                        },
                        glyph,
                    );
                    if cross {
                        canvas.rect(
                            Rect {
                                x: cx - w / 2.,
                                y: cy - arm / 2.,
                                width: w,
                                height: arm,
                            },
                            glyph,
                        );
                    }
                }
            }
            Kind::Fields => {
                // The colon between two fields: two dots of the ink.
                let children: Vec<_> = n
                    .children
                    .iter()
                    .filter(|c| !self.is_hidden(**c))
                    .map(|c| self.nodes[c].bounds)
                    .collect();
                for pair in children.windows(2) {
                    let x = (pair[0].x + pair[0].width + pair[1].x) / 2. - origin.x;
                    let cy = pair[0].y - origin.y + pair[0].height / 2.;
                    let d = s.spin_border.max(2.);
                    for dy in [-d * 1.5, d * 1.5] {
                        canvas.rounded_rect(
                            Rect {
                                x: x - d / 2.,
                                y: cy + dy - d / 2.,
                                width: d,
                                height: d,
                            },
                            (d / 2.) as f64,
                            ink,
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}
