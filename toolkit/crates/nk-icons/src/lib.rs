// SPDX-License-Identifier: LGPL-3.0-or-later
//! Interface icons by name (PHASE1.md D2, "icons by name, not by path"): the lookup the shell
//! does in `ui/shell/core/Icons.ts`, for the native toolkit, and each icon as vector shapes.
//!
//! - **Which theme.** The interface icon theme the user chose (`appearance.interfaceIconTheme`)
//!   is used only if it is installed — an `index.theme` under the icon search path, spelled as
//!   the disk spells it — and declares the Nidara icon spec (`X-Nidara-Icon-Spec` > 0). The first
//!   `index.theme` along the path is the one that counts, as GTK finds it.
//! - **Which file.** `<name>-symbolic.svg` in the theme's `Directories`, the one GTK would take
//!   for the size: an exact fixed size first, then a scalable directory whose range holds it,
//!   then the closest. A theme's directory may sit under any base directory of the path.
//! - **A partial theme.** A name the theme has no drawing for — no file, a file that does not
//!   parse, or one that draws nothing (Icons.ts `drawsInk`: resolving is not drawing) — comes
//!   from the reference theme, Nidara's own, which has every name of the spec.
//! - **What comes back.** Shapes (fills and strokes, in the icon's own units) for the renderer
//!   to paint in the ink it is given: a symbolic icon has one colour, the caller's. Nothing is
//!   rasterised here, so an icon is sharp at any scale and needs no cache per scale.
//!
//! Pure: no Wayland, no renderer; `usvg` parses the SVG.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The spec version this toolkit implements (`Icons.ts` `ICON_SPEC_VERSION`). A theme for an
/// older version is still used: the names added since fall back to the reference.
pub const ICON_SPEC_VERSION: u32 = 4;
const SPEC_KEY: &str = "X-Nidara-Icon-Spec";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Segment {
    Move(Point),
    Line(Point),
    Quad(Point, Point),
    Cubic(Point, Point, Point),
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fill {
    pub even_odd: bool,
    pub opacity: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Join {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stroke {
    pub width: f32,
    pub cap: Cap,
    pub join: Join,
    pub miter_limit: f32,
    pub opacity: f32,
}

/// One painted path. Opacities already include every enclosing group's: a symbolic icon's
/// parts do not overlap within one, so multiplying stands in for compositing the group.
#[derive(Clone, Debug, PartialEq)]
pub struct Shape {
    pub segments: Vec<Segment>,
    pub fill: Option<Fill>,
    pub stroke: Option<Stroke>,
    /// The stroke is painted before the fill (`paint-order: stroke`).
    pub stroke_first: bool,
}

/// An icon in its own units (`size`: the SVG's size, its view box mapped onto it).
#[derive(Clone, Debug, PartialEq)]
pub struct Icon {
    pub size: (f32, f32),
    pub shapes: Vec<Shape>,
}

impl Icon {
    pub fn parse(svg: &[u8]) -> Result<Self, String> {
        let tree = usvg::Tree::from_data(svg, &usvg::Options::default())
            .map_err(|e| format!("svg: {e}"))?;
        let mut shapes = Vec::new();
        walk(tree.root(), 1.0, &mut shapes);
        Ok(Self {
            size: (tree.size().width(), tree.size().height()),
            shapes,
        })
    }

    /// Whether painting it would leave any ink: a shape with a path and some opacity.
    pub fn draws_ink(&self) -> bool {
        self.shapes.iter().any(|s| {
            s.segments.len() > 1
                && (s.fill.is_some_and(|f| f.opacity > 0.)
                    || s.stroke.is_some_and(|k| k.opacity > 0. && k.width > 0.))
        })
    }
}

fn walk(group: &usvg::Group, opacity: f32, out: &mut Vec<Shape>) {
    let opacity = opacity * group.opacity().get();
    for node in group.children() {
        match node {
            usvg::Node::Group(g) => walk(g, opacity, out),
            usvg::Node::Path(p) if p.is_visible() => {
                let t = p.abs_transform();
                let map = |mut q: usvg::tiny_skia_path::Point| {
                    t.map_point(&mut q);
                    Point { x: q.x, y: q.y }
                };
                use usvg::tiny_skia_path::PathSegment as S;
                let segments = p
                    .data()
                    .segments()
                    .map(|s| match s {
                        S::MoveTo(a) => Segment::Move(map(a)),
                        S::LineTo(a) => Segment::Line(map(a)),
                        S::QuadTo(a, b) => Segment::Quad(map(a), map(b)),
                        S::CubicTo(a, b, c) => Segment::Cubic(map(a), map(b), map(c)),
                        S::Close => Segment::Close,
                    })
                    .collect();
                // A stroke's width scales with the transform (its mean scale).
                let scale = (t.sx * t.sy - t.kx * t.ky).abs().sqrt();
                out.push(Shape {
                    segments,
                    fill: p.fill().map(|f| Fill {
                        even_odd: f.rule() == usvg::FillRule::EvenOdd,
                        opacity: opacity * f.opacity().get(),
                    }),
                    stroke: p.stroke().map(|k| Stroke {
                        width: k.width().get() * scale,
                        cap: match k.linecap() {
                            usvg::LineCap::Butt => Cap::Butt,
                            usvg::LineCap::Round => Cap::Round,
                            usvg::LineCap::Square => Cap::Square,
                        },
                        join: match k.linejoin() {
                            usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => Join::Miter,
                            usvg::LineJoin::Round => Join::Round,
                            usvg::LineJoin::Bevel => Join::Bevel,
                        },
                        miter_limit: k.miterlimit().get(),
                        opacity: opacity * k.opacity().get(),
                    }),
                    stroke_first: p.paint_order() == usvg::PaintOrder::StrokeAndFill,
                });
            }
            _ => {}
        }
    }
}

/// The icon search path, as GTK builds it: `$XDG_DATA_HOME/icons`, `~/.icons`, then
/// `icons` under each of `$XDG_DATA_DIRS`.
pub fn search_path() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".local/share")));
    let mut path: Vec<PathBuf> = data_home.into_iter().map(|d| d.join("icons")).collect();
    path.extend(home.map(|h| h.join(".icons")));
    let dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    path.extend(
        dirs.split(':')
            .filter(|d| !d.is_empty())
            .map(|d| Path::new(d).join("icons")),
    );
    path
}

#[derive(Clone, Debug, PartialEq)]
struct Directory {
    path: String,
    size: u32,
    min: u32,
    max: u32,
    threshold: u32,
    kind: DirKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirKind {
    Fixed,
    Scalable,
    Threshold,
}

impl Directory {
    /// The Icon Theme Specification's `DirectoryMatchesSize`.
    fn matches(&self, size: u32) -> bool {
        match self.kind {
            DirKind::Fixed => self.size == size,
            DirKind::Scalable => (self.min..=self.max).contains(&size),
            DirKind::Threshold => (self.size.saturating_sub(self.threshold)
                ..=self.size + self.threshold)
                .contains(&size),
        }
    }

    /// The specification's `DirectorySizeDistance`.
    fn distance(&self, size: u32) -> u32 {
        let (lo, hi) = match self.kind {
            DirKind::Fixed => (self.size, self.size),
            DirKind::Scalable => (self.min, self.max),
            DirKind::Threshold => (
                self.size.saturating_sub(self.threshold),
                self.size + self.threshold,
            ),
        };
        if size < lo {
            lo - size
        } else {
            size.saturating_sub(hi)
        }
    }
}

/// One installed theme: its name, the base directories it is under, its `index.theme`.
#[derive(Clone, Debug)]
struct Theme {
    bases: Vec<PathBuf>,
    directories: Vec<Directory>,
    spec: u32,
}

impl Theme {
    /// The theme as GTK finds it on `search`: the first `index.theme` counts; every base
    /// directory holding a directory of that name is searched.
    fn find(name: &str, search: &[PathBuf]) -> Option<Self> {
        if name.is_empty() || name.contains('/') {
            return None;
        }
        let index = search
            .iter()
            .map(|d| d.join(name).join("index.theme"))
            .find(|p| p.is_file())?;
        let text = std::fs::read_to_string(&index).ok()?;
        let (directories, spec) = parse_index(&text);
        let bases = search
            .iter()
            .map(|d| d.join(name))
            .filter(|d| d.is_dir())
            .collect();
        Some(Self {
            bases,
            directories,
            spec,
        })
    }

    /// The file GTK would take for `file` at `size`, if the theme has one.
    fn lookup(&self, file: &str, size: u32) -> Option<PathBuf> {
        let candidates = |dir: &Directory| {
            self.bases
                .iter()
                .map(move |b| b.join(&dir.path).join(file))
                .find(|p| p.is_file())
        };
        if let Some(p) = self
            .directories
            .iter()
            .filter(|d| d.matches(size))
            .find_map(candidates)
        {
            return Some(p);
        }
        let mut best: Option<(u32, PathBuf)> = None;
        for dir in &self.directories {
            if let Some(p) = candidates(dir) {
                let d = dir.distance(size);
                if best.as_ref().is_none_or(|(b, _)| d < *b) {
                    best = Some((d, p));
                }
            }
        }
        best.map(|(_, p)| p)
    }
}

/// `index.theme`: the `Directories` of `[Icon Theme]` with their sections, and the spec version.
fn parse_index(text: &str) -> (Vec<Directory>, u32) {
    let mut sections: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current = String::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = name.to_owned();
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            sections
                .entry(current.clone())
                .or_default()
                .insert(k.trim().to_owned(), v.trim().to_owned());
        }
    }
    let theme = sections.get("Icon Theme");
    let spec = theme
        .and_then(|t| t.get(SPEC_KEY))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .map_or(0, |v| v as u32);
    let directories = theme
        .and_then(|t| t.get("Directories"))
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .filter_map(|d| {
                    let s = sections.get(d)?;
                    let num = |k: &str| s.get(k).and_then(|v| v.parse::<u32>().ok());
                    let size = num("Size")?;
                    Some(Directory {
                        path: d.to_owned(),
                        size,
                        min: num("MinSize").unwrap_or(size),
                        max: num("MaxSize").unwrap_or(size),
                        threshold: num("Threshold").unwrap_or(2),
                        kind: match s.get("Type").map(String::as_str) {
                            Some("Fixed") => DirKind::Fixed,
                            Some("Scalable") => DirKind::Scalable,
                            _ => DirKind::Threshold,
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (directories, spec)
}

/// Icons by name under one interface theme, falling back to the reference theme; cached.
pub struct Icons {
    theme: Option<Theme>,
    reference: Theme,
    cache: HashMap<(String, u32), Arc<Icon>>,
}

impl Icons {
    /// `theme`: the interface icon theme's name (empty: none, the reference alone);
    /// `reference`: the reference theme's directory (Nidara's own, every name of the spec).
    /// A theme not installed, or not declaring the spec, is not used — the reference is.
    pub fn new(theme: &str, search: &[PathBuf], reference: &Path) -> Result<Self, String> {
        let parent = reference
            .parent()
            .ok_or("reference theme has no parent directory")?
            .to_path_buf();
        let name = reference
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("reference theme has no name")?;
        let reference = Theme::find(name, &[parent])
            .ok_or_else(|| format!("no reference icon theme at {}", reference.display()))?;
        Ok(Self {
            theme: Theme::find(theme, search).filter(|t| t.spec > 0),
            reference,
            cache: HashMap::new(),
        })
    }

    /// Whether the chosen theme is in use (installed and declaring the spec).
    pub fn theme_in_use(&self) -> bool {
        self.theme.is_some()
    }

    /// `name` (an `nd-` name, without `-symbolic`) for a `size` px icon.
    pub fn get(&mut self, name: &str, size: u32) -> Result<Arc<Icon>, String> {
        let key = (name.to_owned(), size);
        if let Some(icon) = self.cache.get(&key) {
            return Ok(icon.clone());
        }
        let file = format!("{name}-symbolic.svg");
        let load = |p: PathBuf| -> Option<Icon> {
            Icon::parse(&std::fs::read(p).ok()?)
                .ok()
                .filter(Icon::draws_ink)
        };
        let icon = self
            .theme
            .as_ref()
            .and_then(|t| t.lookup(&file, size))
            .and_then(load)
            .or_else(|| self.reference.lookup(&file, size).and_then(load))
            .ok_or_else(|| format!("no drawing for icon {name}"))?;
        let icon = Arc::new(icon);
        self.cache.insert(key, icon.clone());
        Ok(icon)
    }
}

#[cfg(test)]
mod tests;
