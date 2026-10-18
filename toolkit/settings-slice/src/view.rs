// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{
    Result,
    data::{self, Exports, KEYS, Services},
    timing,
};
use nk_render::{Canvas, rgba};
use nk_text::{Font, GlyphRun, Rect};
use parley::{FontContext, LayoutContext, PositionedLayoutItem, StyleProperty};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};

pub struct Fonts {
    fonts: FontContext,
    layout: LayoutContext<()>,
    data: HashMap<u64, Arc<[u8]>>,
}
impl Fonts {
    pub fn new() -> Self {
        let t = Instant::now();
        let fonts = FontContext {
            collection: parley::fontique::Collection::new(parley::fontique::CollectionOptions {
                shared: false,
                system_fonts: true,
            }),
            source_cache: Default::default(),
        };
        timing("font_collection", t);
        Self {
            fonts,
            layout: LayoutContext::new(),
            data: HashMap::new(),
        }
    }
    pub fn text(
        &mut self,
        text: &str,
        family: &str,
        size: f32,
        width: f32,
        weight: f32,
    ) -> Result<Text> {
        if self.fonts.collection.family_id(family).is_none() {
            return Err(format!("unknown interface font family {family}"));
        }
        let mut b = self.layout.ranged_builder(&mut self.fonts, text, 1., false);
        b.push_default(StyleProperty::FontFamily(parley::FontFamily::Source(
            family.into(),
        )));
        b.push_default(StyleProperty::FontSize(size));
        b.push_default(StyleProperty::FontWeight(parley::FontWeight::new(weight)));
        let mut layout = b.build(text);
        layout.break_all_lines(Some(width.max(1.)));
        let mut runs = vec![];
        for (line, l) in layout.lines().enumerate() {
            for item in l.items() {
                if let PositionedLayoutItem::GlyphRun(g) = item {
                    let r = g.run();
                    runs.push(GlyphRun {
                        font: Font {
                            data: self
                                .data
                                .entry(r.font().data.id())
                                .or_insert_with(|| Arc::from(r.font().data.data()))
                                .clone(),
                            index: r.font().index,
                            variations: r
                                .normalized_coords()
                                .iter()
                                .map(|v| nk_text::Variation {
                                    axis: [0; 4],
                                    normalized: v.to_bits(),
                                })
                                .collect(),
                        },
                        size: r.font_size(),
                        glyphs: g.positioned_glyphs().map(|g| (g.id, g.x, g.y)).collect(),
                        range: r.text_range(),
                        rtl: r.is_rtl(),
                        line,
                        advance: g.advance(),
                    });
                }
            }
        }
        Ok(Text {
            height: layout.height(),
            runs,
        })
    }
}
pub struct Text {
    pub height: f32,
    runs: Vec<GlyphRun>,
}
impl Text {
    fn paint(&self, c: &mut Canvas, x: f32, y: f32, color: [u8; 4]) -> Result<()> {
        for r in &self.runs {
            c.glyph_run(r, (x, y), rgba(color[0], color[1], color[2], color[3]))?;
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Row {
    pub key: String,
    pub value: Value,
    pub control: String,
    pub title: String,
    pub subtitle: String,
    pub options: Vec<(Value, String)>,
    pub enabled: bool,
}
pub struct Page {
    pub title: String,
    pub icon: String,
    pub selected: bool,
}
pub struct View {
    pub exports: Exports,
    pub palette: Value,
    pub pages: Vec<Page>,
    pub groups: Vec<(String, Vec<Row>)>,
    pub family: String,
    pub font_size: f32,
    pub theme: String,
    icons: HashMap<(String, String, u32, u64), resvg::tiny_skia::Pixmap>,
    pub sidebar_scroll: f32,
    pub content_scroll: f32,
    pub content_height: f32,
    pub evidence: Value,
}
impl View {
    pub fn new(exports: Exports, services: &Services, control: bool) -> Result<Self> {
        let palette = exports.palette(&services.portal)?;
        let schema = &services.schema["keys"];
        let get = |k: &str| -> Result<String> { Ok(data::string(&schema[k]["value"])?.into()) };
        let font = get("appearance.interfaceFont")?;
        let (family, size) = parse_font(&font)?;
        let theme = get("appearance.interfaceIconTheme")?;
        if theme.contains('/') || theme.contains("..") {
            return Err("invalid interface icon theme".into());
        }
        let all = exports.pages.as_array().ok_or("manifest is not an array")?;
        let mut pages = vec![];
        for p in all {
            let icon = p
                .get("icon")
                .or_else(|| {
                    all.iter()
                        .find(|q| q["id"] == p["parent"])
                        .and_then(|p| p.get("icon"))
                })
                .ok_or("page without icon or parent icon")?;
            pages.push(Page {
                title: exports.label(&p["label"])?,
                icon: data::string(icon)?.into(),
                selected: p["id"] == "appearance",
            });
        }
        let appearance = all
            .iter()
            .find(|p| p["id"] == "appearance")
            .ok_or("Appearance absent")?;
        let mut groups = vec![];
        let mut evidence = serde_json::Map::new();
        for key in [
            "settings.appearance.group.base-style",
            "settings.appearance.group.windows",
        ] {
            let g = appearance["groups"]
                .as_array()
                .ok_or("missing groups")?
                .iter()
                .find(|g| g["i18n"] == key)
                .ok_or("slice group missing")?;
            let mut rows = vec![];
            for item in g["items"].as_array().ok_or("missing items")? {
                let key =
                    data::string(if item.is_string() { item } else { &item["key"] })?.to_owned();
                if !KEYS.contains(&key.as_str()) {
                    return Err(format!("unexpected slice key {key}"));
                }
                let entry = &schema[&key];
                let ui = &entry["ui"];
                let control_kind = data::string(&ui["control"])?;
                let value = if control {
                    match key.as_str() {
                        "appearance.darkMode" => json!(false),
                        "appearance.windowControls" => json!("right"),
                        "appearance.windowBackground" => json!("opaque"),
                        _ => json!(true),
                    }
                } else {
                    entry
                        .get("value")
                        .ok_or_else(|| format!("Snapshot missing value {key}"))?
                        .clone()
                };
                if control_kind == "toggle" && !value.is_boolean() {
                    return Err(format!("{key}: not boolean"));
                }
                if !["toggle", "segmented"].contains(&control_kind) {
                    return Err(format!("unsupported slice control {control_kind}"));
                }
                let mut options = ui
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|v| Ok((v["value"].clone(), data::string(&v["label"])?.into())))
                            .collect::<Result<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                if control_kind == "segmented" && options.is_empty() {
                    return Err(format!("{key}: segmented without options"));
                }
                if control_kind == "segmented" && !options.iter().any(|(v, _)| *v == value) {
                    options.push((value.clone(), data::string(&value)?.to_owned()));
                }
                let enabled = entry["available"].as_bool().ok_or("missing availability")?
                    && predicate(item.get("sensitiveWhen"), schema)?;
                evidence.insert(key.clone(), value.clone());
                rows.push(Row {
                    key,
                    value,
                    control: control_kind.into(),
                    title: data::string(&ui["title"])?.into(),
                    subtitle: ui
                        .get("subtitle")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    options,
                    enabled,
                });
            }
            groups.push((exports.label(&g["i18n"])?, rows));
        }
        if control {
            eprintln!("CONTROL_APPLIED default-values");
        }
        Ok(Self {
            exports,
            palette,
            pages,
            groups,
            family,
            font_size: size * 96. / 72.,
            theme,
            icons: HashMap::new(),
            sidebar_scroll: 0.,
            content_scroll: 0.,
            content_height: 0.,
            evidence: Value::Object(evidence),
        })
    }

    pub fn refresh(&mut self, services: &Services, control: bool) -> Result<()> {
        let mut next = Self::new(Exports::load()?, services, control)?;
        next.sidebar_scroll = self.sidebar_scroll;
        next.content_scroll = self.content_scroll;
        next.icons = std::mem::take(&mut self.icons);
        *self = next;
        Ok(())
    }
    #[cfg(test)]
    pub fn cached_icons(&self) -> usize {
        self.icons.len()
    }
    pub fn token(&self, name: &str, opaque: bool) -> Result<[u8; 4]> {
        let mut c = data::color(data::string(&self.palette[name])?)?;
        if opaque {
            c[3] = 255;
        }
        Ok(c)
    }
    pub fn dimensions(&self) -> Result<(u32, u32)> {
        Ok((
            (self.exports.number("WINDOW_LAYOUT", "sidebar")?
                + self.exports.number("WINDOW_LAYOUT", "content")?
                + self.exports.number("WINDOW_LAYOUT", "openGutter")?) as u32,
            (self.exports.number("WINDOW_LAYOUT", "minHeight")?
                + self
                    .groups
                    .iter()
                    .map(|(_, rows)| rows.len())
                    .sum::<usize>() as f32
                    * self.exports.number("ROW_HEIGHT", "double")?) as u32,
        ))
    }
    fn icon(&mut self, name: &str, size: u32, scale: f64) -> Result<&resvg::tiny_skia::Pixmap> {
        let key = (name.into(), self.theme.clone(), size, scale.to_bits());
        if !self.icons.contains_key(&key) {
            let t = Instant::now();
            let root =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons");
            let theme = if self.theme.is_empty() {
                "nidara"
            } else {
                &self.theme
            };
            let filename = format!("{name}-symbolic.svg");
            let relative = PathBuf::from("scalable/actions").join(&filename);
            let path = root.join(theme).join(&relative);
            // Same partial-theme fallback as Icons.ts: requested theme first, reference art last.
            let path = if path.exists() {
                path
            } else {
                root.join("nidara").join(relative)
            };
            let svg = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let tree = resvg::usvg::Tree::from_data(&svg, &resvg::usvg::Options::default())
                .map_err(data::err)?;
            let pixels = (size as f64 * scale).ceil() as u32;
            let mut pixmap =
                resvg::tiny_skia::Pixmap::new(pixels, pixels).ok_or("icon size overflow")?;
            resvg::render(
                &tree,
                resvg::tiny_skia::Transform::from_scale(
                    pixels as f32 / tree.size().width(),
                    pixels as f32 / tree.size().height(),
                ),
                &mut pixmap.as_mut(),
            );
            self.icons.insert(key.clone(), pixmap);
            timing("icon_raster", t);
        }
        Ok(&self.icons[&key])
    }
    pub fn paint(
        &mut self,
        fonts: &mut Fonts,
        width: u32,
        height: u32,
        scale: f64,
        glass: bool,
    ) -> Result<Painted> {
        let t = Instant::now();
        let (pw, ph) = (
            (width as f64 * scale).ceil() as u16,
            (height as f64 * scale).ceil() as u16,
        );
        let mut c = Canvas::new(pw, ph, scale);
        let e = &self.exports;
        let pad = e.scss("space-6")?;
        let gap = e.scss("space-4")?;
        let small = e.scss("space-2")?;
        let radius = e.number("RADIUS", "md")?;
        let sidebar = e.number("WINDOW_LAYOUT", "sidebar")?;
        let single = e.number("ROW_HEIGHT", "single")?;
        let ink = self.token("--nidara-text", false)?;
        let muted = self.token("--nidara-text-secondary", false)?;
        let disabled = self.token("--nidara-text-disabled", false)?;
        let bg = self.token("--nidara-bg", !glass)?;
        if !glass {
            c.rect(
                rect(0., 0., width as f32, height as f32),
                rgba(bg[0], bg[1], bg[2], bg[3]),
            );
        }
        let mut icons = vec![];
        c.clip(rect(0., 0., sidebar, height as f32));
        let mut y = pad - self.sidebar_scroll;
        for page in &self.pages {
            if y + single > 0. && y < height as f32 {
                if page.selected {
                    let a = self.token("--nidara-state-selected", false)?;
                    c.rounded_rect(
                        rect(small, y, sidebar - small * 2., single),
                        radius as f64,
                        rgba(a[0], a[1], a[2], a[3]),
                    );
                }
                let text = fonts.text(
                    &page.title,
                    &self.family,
                    self.font_size,
                    sidebar - pad * 2. - single,
                    400.,
                )?;
                text.paint(&mut c, pad + single, y + (single - text.height) / 2., ink)?;
                icons.push((page.icon.clone(), pad, y + (single - gap) / 2., gap as u32));
            }
            y += single;
        }
        c.pop_clip();
        let x = sidebar + pad;
        let w = (width as f32 - x - pad).max(1.);
        c.clip(rect(
            sidebar,
            0.,
            (width as f32 - sidebar).max(1.),
            height as f32,
        ));
        let title = self.exports.label(&json!("settings.appearance.title"))?;
        let heading = fonts.text(
            &title,
            &self.family,
            self.font_size * e.scss("fse-title-1")?,
            w,
            600.,
        )?;
        heading.paint(&mut c, x, pad - self.content_scroll, ink)?;
        let mut y = pad + heading.height + pad - self.content_scroll;
        let mut drawn = serde_json::Map::new();
        let mut samples = serde_json::Map::new();
        for (title, rows) in &self.groups {
            let text = fonts.text(title, &self.family, self.font_size, w, 600.)?;
            text.paint(&mut c, x, y, muted)?;
            y += text.height + small;
            for row in rows {
                let available = (w * 0.56 - gap * 2.).max(1.);
                let title =
                    fonts.text(&row.title, &self.family, self.font_size, available, 400.)?;
                let sub = fonts.text(
                    &row.subtitle,
                    &self.family,
                    self.font_size * e.scss("fse-small")?,
                    available,
                    400.,
                )?;
                let h = (title.height + sub.height + gap * 2.).max(e.number(
                    "ROW_HEIGHT",
                    if row.subtitle.is_empty() {
                        "single"
                    } else {
                        "double"
                    },
                )?);
                // Rows use a surface overlay over the window base. Only the base
                // becomes opaque; forcing this white/black overlay to alpha 1
                // would erase contrast in the fallback.
                let surface = self.token("--nidara-surface", false)?;
                c.rounded_rect(
                    rect(x, y, w, h),
                    radius as f64,
                    rgba(surface[0], surface[1], surface[2], surface[3]),
                );
                title.paint(
                    &mut c,
                    x + gap,
                    y + gap,
                    if row.enabled { ink } else { disabled },
                )?;
                sub.paint(
                    &mut c,
                    x + gap,
                    y + gap + title.height,
                    if row.enabled { muted } else { disabled },
                )?;
                let control_x = x + w * 0.6;
                let control_w = (w * 0.4 - gap).max(1.);
                if row.control == "toggle" {
                    let on = row.value.as_bool().ok_or("toggle value")?;
                    let track = self.token(
                        if on {
                            "--nidara-accent"
                        } else {
                            "--nidara-surface-raised"
                        },
                        false,
                    )?;
                    let knob = self.token("--nidara-thumb", false)?;
                    let th = pad;
                    let tw = pad * 2.;
                    let tx = x + w - gap - tw;
                    let ty = y + (h - th) / 2.;
                    samples.insert(row.key.clone(),json!({"toggle":[((tx+tw/2.) as f64*scale).floor() as u32,((ty+th-1.) as f64*scale).floor() as u32]}));
                    c.rounded_rect(
                        rect(tx, ty, tw, th),
                        (th / 2.) as f64,
                        rgba(track[0], track[1], track[2], track[3]),
                    );
                    c.rounded_rect(
                        rect(
                            tx + if on { tw - th + small / 2. } else { small / 2. },
                            ty + small / 2.,
                            th - small,
                            th - small,
                        ),
                        (th / 2.) as f64,
                        rgba(knob[0], knob[1], knob[2], knob[3]),
                    );
                } else {
                    let mut points = vec![];
                    for (i, (v, label)) in row.options.iter().enumerate() {
                        let sw = control_w / row.options.len() as f32;
                        let tx = control_x + i as f32 * sw;
                        points.push(json!({"value":v,"point":[((tx+sw/2.) as f64*scale).floor() as u32,((y+gap+1.) as f64*scale).floor() as u32]}));
                        let fill = self.token(
                            if *v == row.value {
                                "--nidara-state-selected"
                            } else {
                                "--nidara-surface-back"
                            },
                            false,
                        )?;
                        c.rounded_rect(
                            rect(tx, y + gap, sw, h - gap * 2.),
                            small as f64,
                            rgba(fill[0], fill[1], fill[2], fill[3]),
                        );
                        let t = fonts.text(
                            label,
                            &self.family,
                            self.font_size,
                            sw - small * 2.,
                            400.,
                        )?;
                        t.paint(
                            &mut c,
                            tx + small,
                            y + (h - t.height) / 2.,
                            if row.enabled { ink } else { disabled },
                        )?;
                    }
                    samples.insert(row.key.clone(), json!({"segments":points}));
                }
                if y >= 0. && y + h <= height as f32 {
                    drawn.insert(row.key.clone(), row.value.clone());
                }
                y += h + small;
            }
            y += pad;
        }
        c.pop_clip();
        self.content_height = y + self.content_scroll;
        timing("first_layout", t);
        let t = Instant::now();
        let mut pixels = c.finish();
        // Force the final buffer opaque too: raster edge rounding may otherwise
        // leave alpha 254 even over an opaque base. RGB already includes that base.
        if !glass {
            for pixel in pixels.as_chunks_mut::<4>().0 {
                let n = u32::from_ne_bytes(*pixel) | 0xff000000;
                pixel.copy_from_slice(&n.to_ne_bytes());
            }
        }
        let mut masks = vec![];
        for (name, x, y, size) in icons {
            let pixmap = self.icon(&name, size, scale)?;
            blend_icon(
                &mut pixels,
                pw as usize,
                ph as usize,
                pixmap,
                (x as f64 * scale).round() as i32,
                (y as f64 * scale).round() as i32,
                ink,
            );
            masks.push(name);
        }
        timing("first_paint", t);
        Ok(Painted {
            pixels,
            values: Value::Object(drawn),
            icons: masks,
            samples: Value::Object(samples),
            full: KEYS.iter().all(|k| self.evidence.get(*k).is_some()) && y <= height as f32 + pad,
        })
    }
}
pub struct Painted {
    pub pixels: Vec<u8>,
    pub values: Value,
    pub icons: Vec<String>,
    pub samples: Value,
    pub full: bool,
}
fn predicate(p: Option<&Value>, schema: &Value) -> Result<bool> {
    let Some(p) = p else { return Ok(true) };
    let key = data::string(&p["key"])?;
    let v = schema[key].get("value").ok_or("predicate missing value")?;
    let s = if let Some(s) = v.as_str() {
        s.into()
    } else {
        v.to_string()
    };
    Ok(p["in"]
        .as_array()
        .ok_or("bad predicate")?
        .iter()
        .any(|v| v == &s))
}
pub fn parse_font(s: &str) -> Result<(String, f32)> {
    let (family, size) = s
        .rsplit_once(' ')
        .ok_or("interface font must be Family Size")?;
    let size: f32 = size.parse().map_err(data::err)?;
    if family.is_empty() || !size.is_finite() || size <= 0. {
        return Err("invalid interface font".into());
    }
    Ok((family.into(), size))
}
fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}
fn blend_icon(
    dst: &mut [u8],
    w: usize,
    h: usize,
    src: &resvg::tiny_skia::Pixmap,
    x: i32,
    y: i32,
    ink: [u8; 4],
) {
    for sy in 0..src.height() as i32 {
        for sx in 0..src.width() as i32 {
            let (dx, dy) = (x + sx, y + sy);
            if dx < 0 || dy < 0 || dx >= w as i32 || dy >= h as i32 {
                continue;
            }
            let a = src.pixel(sx as u32, sy as u32).unwrap().alpha() as u32 * ink[3] as u32 / 255;
            let i = (dy as usize * w + dx as usize) * 4;
            let old = u32::from_ne_bytes(dst[i..i + 4].try_into().unwrap());
            let mix = |s: u8, d: u32| (s as u32 * a + d * (255 - a) + 127) / 255;
            let p = ((a + ((old >> 24) * (255 - a) + 127) / 255) << 24)
                | (mix(ink[0], (old >> 16) & 255) << 16)
                | (mix(ink[1], (old >> 8) & 255) << 8)
                | mix(ink[2], old & 255);
            dst[i..i + 4].copy_from_slice(&p.to_ne_bytes());
        }
    }
}
