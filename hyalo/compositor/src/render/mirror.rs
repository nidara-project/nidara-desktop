// SPDX-License-Identifier: GPL-3.0-or-later
//! A retained GPU canvas of the logical scene, contained in a physical scanout.
//! Glass is composed in source pixels before scaling, never reimplemented in a client.
use super::{
    HyaloRenderer, OutputElement, Scene,
    snapshot::{Snapshot, SnapshotElement},
};
use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::{
            Bind, Color32F, ContextId, Offscreen, Renderer,
            damage::OutputDamageTracker,
            element::{
                Id, Kind, RenderElementStates,
                solid::{SolidColorBuffer, SolidColorRenderElement},
            },
            gles::{GlesRenderer, GlesTexture},
        },
    },
    output::Output,
    utils::{Rectangle, Transform},
};
use std::cell::RefCell;
struct Canvas {
    source: Output,
    context: ContextId<GlesTexture>,
    picture: Snapshot,
    tracker: OutputDamageTracker,
    scale: f64,
    states: RenderElementStates,
}
#[derive(Default)]
struct Cache {
    canvas: Option<Canvas>,
    error: Option<String>,
}
#[derive(Default)]
struct Stored(RefCell<Cache>);
fn stored(output: &Output) -> &RefCell<Cache> {
    output.user_data().insert_if_missing(Stored::default);
    &output.user_data().get::<Stored>().unwrap().0
}
pub fn reset(output: &Output) {
    if let Some(s) = output.user_data().get::<Stored>() {
        *s.0.borrow_mut() = Cache::default();
    }
}
pub fn ok(output: &Output) -> bool {
    if !crate::mirror::follower(output) {
        return true;
    }
    output
        .user_data()
        .get::<Stored>()
        .is_none_or(|s| s.0.borrow().error.is_none())
}
pub fn states(output: &Output) -> Option<RenderElementStates> {
    if !crate::mirror::follower(output) {
        return None;
    }
    stored(output)
        .borrow()
        .canvas
        .as_ref()
        .map(|c| c.states.clone())
}
fn black_elements<R: HyaloRenderer>(output: &Output) -> Vec<OutputElement<R>> {
    let Some(size) = crate::mirror::physical_size(output) else {
        return Vec::new();
    };
    struct Black(RefCell<SolidColorBuffer>);
    output.user_data().insert_if_missing(|| {
        Black(RefCell::new(SolidColorBuffer::new(
            (size.w, size.h),
            Color32F::new(0.0, 0.0, 0.0, 1.0),
        )))
    });
    let mut b = output.user_data().get::<Black>().unwrap().0.borrow_mut();
    b.resize((size.w, size.h));
    vec![OutputElement::Debug(SolidColorRenderElement::from_buffer(
        &b,
        (0, 0),
        1.0,
        1.0,
        Kind::Unspecified,
    ))]
}
pub fn elements<R: HyaloRenderer>(
    state: &Scene<'_>,
    renderer: &mut R,
    output: &Output,
    cursor: Option<&crate::cursor::CursorImage>,
) -> Vec<OutputElement<R>> {
    let mut out = Vec::new();
    if !state.lock.is_locked() {
        out.extend(crate::display::identify::elements(renderer, output));
    }
    let result = compose(state, renderer.gles(), output, cursor);
    match result {
        Ok(element) => {
            stored(output).borrow_mut().error = None;
            out.push(OutputElement::Snapshot(element));
        }
        Err(error) => {
            let mut cache = stored(output).borrow_mut();
            if cache.error.as_ref() != Some(&error) {
                tracing::warn!(output=%output.name(),%error,"mirror composition failed");
            }
            cache.error = Some(error);
        }
    }
    if state.lock.draws_locked(&crate::mirror::scene(output)) {
        state.lock.note_rendered(output);
    }
    out.extend(black_elements(output));
    out
}
fn compose(
    state: &Scene<'_>,
    gles: &mut GlesRenderer,
    output: &Output,
    cursor: Option<&crate::cursor::CursorImage>,
) -> Result<SnapshotElement, String> {
    let source = crate::mirror::source(output).ok_or("not a mirror target")?;
    let size = crate::mirror::physical_size(&source).ok_or("source has no mode")?;
    let target = crate::mirror::physical_size(output).ok_or("target has no mode")?;
    let map = crate::mirror::Contain::new((size.w, size.h), (target.w, target.h))
        .ok_or("empty mirror viewport")?;
    let scale = source.current_scale().fractional_scale();
    let context = gles.context_id();
    let mut cache = stored(output).borrow_mut();
    if cache.canvas.as_ref().is_none_or(|c| {
        c.source != source || c.context != context || c.picture.size != size || c.scale != scale
    }) {
        let texture: GlesTexture = gles
            .create_buffer(Fourcc::Abgr8888, (size.w, size.h).into())
            .map_err(|e| e.to_string())?;
        cache.canvas = Some(Canvas {
            source: source.clone(),
            context,
            picture: Snapshot {
                texture,
                size,
                frame: Rectangle::from_size(size.to_f64()),
                scale,
                id: Id::new(),
                commit: Default::default(),
            },
            tracker: OutputDamageTracker::new(size, scale, Transform::Normal),
            scale,
            states: Default::default(),
        });
    }
    let c = cache.canvas.as_mut().unwrap();
    let elements = super::scene_elements(state, gles, &source, cursor, false)
        .into_iter()
        .map(|e| match e {
            OutputElement::Glass(g) => OutputElement::Glass(g.measuring_nothing()),
            e => e,
        })
        .collect::<Vec<_>>();
    {
        let mut fb = gles
            .bind(&mut c.picture.texture)
            .map_err(|e| e.to_string())?;
        let result = c
            .tracker
            .render_output(gles, &mut fb, 1, &elements, super::CLEAR_COLOR)
            .map_err(|e| format!("{e:?}"))?;
        // Canvas rendering and subsequent sampling share this GlesRenderer/context.
        // GL orders those commands; waiting for completion here would stall calloop.
        c.states = result.states;
        if result.damage.is_some() {
            let mut commit = c.picture.commit.get();
            commit.increment();
            c.picture.commit.set(commit);
        }
    }
    Ok(SnapshotElement::new(
        &c.picture,
        map.rectangle().to_f64(),
        1.0,
        1.0,
    ))
}
