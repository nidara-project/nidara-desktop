// SPDX-License-Identifier: GPL-3.0-or-later
//! One logical desktop scene, projected into physical follower viewports.
use crate::{
    display::model::{Layout, Output as DisplayOutput, Setting, dimensions},
    state::Hyalo,
};
use smithay::{
    output::Output,
    utils::{Logical, Physical, Point, Rectangle, Size},
};
use std::cell::RefCell;

#[derive(Default)]
pub struct State {
    pub groups: Vec<Vec<String>>,
}
#[derive(Default)]
struct Link(RefCell<Option<Output>>);
pub fn source(output: &Output) -> Option<Output> {
    output.user_data().get::<Link>()?.0.borrow().clone()
}
pub fn scene(output: &Output) -> Output {
    source(output).unwrap_or_else(|| output.clone())
}
pub fn follower(output: &Output) -> bool {
    source(output).is_some()
}
fn link(output: &Output, to: Option<Output>) {
    if source(output) != to {
        crate::render::mirror::reset(output);
    }
    output.user_data().insert_if_missing(Link::default);
    *output.user_data().get::<Link>().unwrap().0.borrow_mut() = to;
}
pub fn physical_size(output: &Output) -> Option<Size<i32, Physical>> {
    let mode = output.current_mode()?;
    let size = output.current_transform().transform_size(mode.size);
    Some((size.w, size.h).into())
}
pub fn physical_geometry(output: &Output) -> Option<Rectangle<i32, Logical>> {
    let size = physical_size(output)?
        .to_f64()
        .to_logical(output.current_scale().fractional_scale())
        .to_i32_round();
    Some(Rectangle::from_size(size))
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Contain {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}
impl Contain {
    pub fn new(source: (i32, i32), target: (i32, i32)) -> Option<Self> {
        if source.0 <= 0 || source.1 <= 0 || target.0 <= 0 || target.1 <= 0 {
            return None;
        }
        let scale = (target.0 as f64 / source.0 as f64).min(target.1 as f64 / source.1 as f64);
        let (width, height) = (source.0 as f64 * scale, source.1 as f64 * scale);
        Some(Self {
            x: (target.0 as f64 - width) / 2.0,
            y: (target.1 as f64 - height) / 2.0,
            width,
            height,
            scale,
        })
    }
    /// Bands have no interactive destination, including their far-exclusive edges.
    pub fn inverse(self, x: f64, y: f64) -> Option<(f64, f64)> {
        if !x.is_finite()
            || !y.is_finite()
            || x < self.x
            || y < self.y
            || x >= self.x + self.width
            || y >= self.y + self.height
        {
            return None;
        }
        Some(((x - self.x) / self.scale, (y - self.y) / self.scale))
    }
    pub fn rectangle(self) -> Rectangle<i32, Physical> {
        Rectangle::new(
            (self.x.round() as i32, self.y.round() as i32).into(),
            (self.width.round() as i32, self.height.round() as i32).into(),
        )
    }
}
/// An output-local logical coordinate, as supplied by an associated absolute device.
pub fn input(
    state: &Hyalo,
    output: &Output,
    at: Point<f64, Logical>,
) -> Option<Point<f64, Logical>> {
    let src = scene(output);
    let geo = state.space.output_geometry(&src)?;
    if !follower(output) {
        return Some(geo.loc.to_f64() + at);
    }
    let a = physical_size(&src)?;
    let b = physical_size(output)?;
    let map = Contain::new((a.w, a.h), (b.w, b.h))?;
    let p = map.inverse(
        at.x * output.current_scale().fractional_scale(),
        at.y * output.current_scale().fractional_scale(),
    )?;
    Some(geo.loc.to_f64() + Point::from(p).downscale(src.current_scale().fractional_scale()))
}
pub fn layout_groups(state: &Hyalo, outputs: &[DisplayOutput]) -> Vec<Vec<String>> {
    state
        .mirrors
        .groups
        .iter()
        .filter_map(|g| {
            let ids: Vec<_> = g
                .iter()
                .filter_map(|name| {
                    outputs
                        .iter()
                        .find(|o| &o.connector == name)
                        .map(|o| o.id.clone())
                })
                .collect();
            (ids.len() >= 2).then_some(ids)
        })
        .collect()
}
pub fn install(state: &mut Hyalo, layout: &Layout) -> Result<(), String> {
    let physical = crate::backend::physical_outputs(state);
    // Resolve the complete plan before changing links, so an obsolete id is side-effect free.
    let mut links = Vec::new();
    let mut groups = Vec::new();
    for group in &layout.mirror_groups {
        let names: Vec<_> = group
            .iter()
            .map(|id| {
                state
                    .displays
                    .output_connector(id)
                    .ok_or("mirror output disappeared")
            })
            .collect::<Result<_, _>>()?;
        let first = names.first().ok_or("empty mirror group")?;
        let src = physical
            .iter()
            .find(|o| &o.name() == first)
            .ok_or("mirror source not active")?
            .clone();
        for name in names.iter().skip(1) {
            let target = physical
                .iter()
                .find(|o| &o.name() == name)
                .ok_or("mirror target not active")?;
            links.push((target.clone(), src.clone()));
        }
        groups.push(names);
    }
    for o in &physical {
        link(
            o,
            links
                .iter()
                .find(|(target, _)| target == o)
                .map(|(_, src)| src.clone()),
        );
    }
    state.mirrors.groups = groups;
    if matches!(state.backend, crate::backend::Backend::Tty(_)) {
        crate::backend::tty::mirror_visibility(state);
    }
    crate::outputs::arrange(state);
    Ok(())
}
pub fn requested_size(setting: &Setting, output: &DisplayOutput) -> Result<(i32, i32), String> {
    dimensions(setting, output)?;
    let mode = output
        .modes
        .iter()
        .find(|m| m.id == setting.mode)
        .ok_or("mode is not advertised")?;
    Ok(
        if matches!(
            setting.transform.as_str(),
            "90" | "270" | "flipped-90" | "flipped-270"
        ) {
            (mode.height, mode.width)
        } else {
            (mode.width, mode.height)
        },
    )
}

pub mod probe;
#[cfg(test)]
mod tests;
