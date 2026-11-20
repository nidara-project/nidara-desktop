//! A window drawn on its own into a texture of ours — its surfaces, popups, corners, controls or
//! title bar, line and shadow, as the screen shows them — so it can be drawn scaled and faded
//! as ONE picture (wm/motion.rs): a window opening, drawn again every frame of it, and one
//! closing, drawn once as it was when its app destroyed it (its surfaces go right after).
//!
//! What a picture leaves out: the blur behind a translucent window, which samples the screen
//! behind it, and here there is nothing behind it. The glass a client declares
//! (`nidara-material-v1`) lies over the window itself and is kept for a capture (`take`'s
//! `glass`); an opening or closing window is drawn as two pictures instead (render/forming.rs):
//! what lies between its glasses (`take_layers`), with each glass live where it is among them — drawn live and forming as it opens, kept from its last frame and dissolving
//! as it closes. A menu coming or going is pictured alone (`take_surface`), its glass the same.
//!
//! Drawn with the GL renderer underneath (`HyaloRenderer::gles`, the GPU that renders), like a
//! screenshot: on tty the surfaces are imported for it first (`import_surface_tree`), as for a
//! window capture (capture.rs).

use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::{
            Bind, Color32F, Offscreen,
            damage::OutputDamageTracker,
            element::{Element, Id, Kind, RenderElement},
            gles::{GlesRenderer, GlesTexProgram, GlesTexture, Uniform, UniformName, UniformType, UniformValue},
            utils::{CommitCounter, import_surface_tree},
        },
    },
    desktop::{PopupManager, Window},
    utils::{Buffer as BufferCoords, Logical, Physical, Point, Rectangle, Scale, Size, Transform, user_data::UserDataMap},
};

use super::{HyaloRenderer, OutputElement, Scene};

/// A picture of a window.
#[derive(Debug)]
pub struct Snapshot {
    pub texture: GlesTexture,
    /// The texture's size, physical px.
    pub size: Size<i32, Physical>,
    /// Where the window's whole box (its title bar included) is in it, physical px: around
    /// it, room for its shadow.
    pub frame: Rectangle<f64, Physical>,
    /// The scale it was drawn at (its output's).
    pub scale: f64,
    /// Which picture it is, for the damage tracker; its commit moves on every time it is
    /// drawn, since it is drawn faded a little further each frame.
    pub id: Id,
    pub commit: std::cell::Cell<CommitCounter>,
    /// What lies on the glass (`take_layers`, `take_surface`): the glass panes it may lie
    /// on, each its box (x, y, w, h) then its corner radius, texture px — where the lens works.
    pub panels: Vec<[f32; 5]>,
}

/// Room around the box for its line and its shadow, logical px.
fn margin(cfg: &crate::config::WindowsConfig) -> f64 {
    let s = &cfg.shadow;
    let reach = |l: &crate::config::ShadowLook| l.range + l.offset.abs();
    cfg.border.width + reach(&s.active).max(reach(&s.inactive)) + 2.0
}

/// `window` alone at `scale`, as it is now.
/// `glass`: a capture (capture.rs) — the glass the window lays over itself kept (its sidebar,
/// its header's buttons, its controls), and the wallpaper drawn behind it, so its background
/// at any level and its blur come out as on the screen. An opening or closing window's picture leaves it out: there its glass is
/// drawn live, over the screen (render/mod.rs).
pub fn take(gles: &mut GlesRenderer, scene: &Scene<'_>, window: &Window, scale: f64, glass: bool) -> Result<Snapshot, String> {
    let (m, frame, pad, size, mut elements) = drawn(gles, scene, window, scale)?;
    // What samples the screen behind the window goes: the screen is not in this picture. Its
    // own glass lies over the window, whose background and content are drawn first here.
    elements.retain(|e| match e {
        OutputElement::Glass(_) => glass,
        OutputElement::Scrim(_) => false,
        _ => true,
    });
    // A capture: behind the window, the wallpaper of its output where the window lies on it,
    // so a tinted or translucent background is mixed and blurred with it as on the screen —
    // and nothing of the other windows behind it (owner, 2026-11-19).
    if glass
        && let Some(output) = scene.wm.workspaces.get(&m.workspace).and_then(|w| scene.space.outputs().find(|o| o.name() == w.output))
        && let Some(geo) = scene.space.output_geometry(output)
    {
        let at = Point::<f64, Logical>::from((pad - (frame.loc.x - f64::from(geo.loc.x)), pad - (frame.loc.y - f64::from(geo.loc.y))));
        let pixels = geo.size.to_f64().to_physical_precise_round(scale);
        elements.extend(
            super::wallpaper::elements(gles, output, geo.size, pixels, at.to_physical(scale), scene.when, scene.reduce_motion)
                .into_iter()
                .map(OutputElement::Cursor),
        );
    }
    picture(gles, &elements, size, scale, frame, pad, Vec::new())
}

/// A window between its glasses (render/forming.rs): what lies in front of each of its glasses,
/// front to back, then what lies behind the last — so a window opening or closing can be drawn
/// with its glass live between them, each glass where it is in the window. One split at its
/// lowest glass is not enough: what a sidebar's glass covers of the window behind it (its main
/// pane's own background) came out in FRONT of that glass, darkening it and hiding what is on
/// it until the window had opened (owner's session, 2026-11-20).
pub struct Layers {
    /// `glass.len() + 1` pictures: [i] what lies in front of glass i and behind glass i − 1
    /// (None: nothing), the last what lies behind every glass.
    pub pictures: Vec<Option<Snapshot>>,
    /// Its glass as it was, texture px — what a closing window's glass is drawn from once its
    /// app has destroyed it.
    pub glass: Vec<super::GlassElement>,
}

impl Layers {
    /// What lies behind all its glass: the window's own picture.
    pub fn under(&self) -> Option<&Snapshot> {
        self.pictures.last().and_then(Option::as_ref)
    }
}

/// `window` in layers between its glasses (`Layers`).
pub fn take_layers(gles: &mut GlesRenderer, scene: &Scene<'_>, window: &Window, scale: f64) -> Result<Layers, String> {
    let (_, frame, pad, size, elements) = drawn(gles, scene, window, scale)?;
    let mut panels = Vec::new();
    let mut glass = Vec::new();
    let mut segments: Vec<Vec<OutputElement<GlesRenderer>>> = vec![Vec::new()];
    for e in elements {
        match e {
            OutputElement::Glass(g) => {
                for (r, radius) in g.shape_boxes() {
                    panels.push([r.loc.x as f32, r.loc.y as f32, r.size.w as f32, r.size.h as f32, radius as f32]);
                }
                glass.push(g);
                segments.push(Vec::new());
            }
            // What samples the screen, or veils it: drawn live, or not at all.
            OutputElement::Scrim(_) | OutputElement::Fade(_) => {}
            e => segments.last_mut().unwrap().push(e),
        }
    }
    let mut pictures = Vec::new();
    for segment in &segments {
        pictures.push(if segment.is_empty() { None } else { Some(picture(gles, segment, size, scale, frame, pad, panels.clone())?) });
    }
    if pictures.last().is_none_or(Option::is_none) {
        return Err("nothing behind the window's glass".into());
    }
    Ok(Layers { pictures, glass })
}

/// The window drawn as at `place`, its elements front to back, with its box and the room
/// around it.
#[allow(clippy::type_complexity)]
fn drawn<'s>(
    gles: &mut GlesRenderer,
    scene: &'s Scene<'_>,
    window: &Window,
    scale: f64,
) -> Result<(&'s crate::wm::Managed, Rectangle<f64, Logical>, f64, Size<i32, Physical>, Vec<OutputElement<GlesRenderer>>), String> {
    let m = scene.wm.by_window(window).ok_or("not a window of ours")?;
    let surface = crate::wm::surface_of(window).ok_or("no surface yet")?;
    import_surface_tree(gles, &surface).map_err(|e| format!("{e:?}"))?;
    for (popup, _) in PopupManager::popups_for_surface(&surface) {
        import_surface_tree(gles, popup.wl_surface()).map_err(|e| format!("{e:?}"))?;
    }
    let frame = m.frame().to_f64();
    let pad = margin(scene.windows);
    let logical: Size<f64, Logical> = (frame.size.w + 2.0 * pad, frame.size.h + 2.0 * pad).into();
    let size = logical.to_physical_precise_round(scale);
    if size.w <= 0 || size.h <= 0 {
        return Err("an empty window".into());
    }
    let mut elements: Vec<OutputElement<GlesRenderer>> = Vec::new();
    let place = crate::wm::minimize::Placement { origin: (pad, pad).into(), scale: 1.0 };
    super::push_window(&mut elements, gles, scene, window, Some(place), Point::from((0, 0)), Scale::from(scale), size);
    Ok((m, frame, pad, size, elements))
}

/// `elements` drawn into a texture of `size`.
fn picture(
    gles: &mut GlesRenderer,
    elements: &[OutputElement<GlesRenderer>],
    size: Size<i32, Physical>,
    scale: f64,
    frame: Rectangle<f64, Logical>,
    pad: f64,
    panels: Vec<[f32; 5]>,
) -> Result<Snapshot, String> {
    let mut texture: GlesTexture = gles.create_buffer(Fourcc::Abgr8888, (size.w, size.h).into()).map_err(|e| e.to_string())?;
    let mut tracker = OutputDamageTracker::new(size, scale, Transform::Normal);
    {
        let mut fb = gles.bind(&mut texture).map_err(|e| e.to_string())?;
        tracker
            .render_output(gles, &mut fb, 0, elements, Color32F::new(0.0, 0.0, 0.0, 0.0))
            .map_err(|e| format!("{e:?}"))?;
    }
    let frame = Rectangle::new(Point::<f64, Logical>::from((pad, pad)).to_physical(scale), frame.size.to_physical(scale));
    Ok(Snapshot { texture, size, frame, scale, id: Id::new(), commit: Default::default(), panels })
}

/// A picture drawn on screen: its window's box at `frame` (output physical px) scaled about
/// its middle by `k`, faded to `alpha`.
#[derive(Debug)]
pub struct SnapshotElement {
    id: Id,
    commit: CommitCounter,
    texture: GlesTexture,
    size: Size<i32, Physical>,
    geometry: Rectangle<i32, Physical>,
    alpha: f32,
    lens: Option<(GlesTexProgram, Vec<Uniform<'static>>)>,
}

/// A picture of `surface`'s tree alone (a menu), its glass left out — the glass is drawn live,
/// forming — and its glass shapes as the lens's panels.
pub fn take_surface(
    gles: &mut GlesRenderer,
    surface: &smithay::reexports::wayland_server::protocol::wl_surface::WlSurface,
    scale: f64,
    when: std::time::Instant,
) -> Result<Snapshot, String> {
    import_surface_tree(gles, surface).map_err(|e| format!("{e:?}"))?;
    let bbox = smithay::desktop::utils::bbox_from_surface_tree(surface, (0, 0));
    let size = bbox.size.to_f64().to_physical_precise_round(scale);
    if size.w <= 0 || size.h <= 0 {
        return Err("an empty surface".into());
    }
    let mut texture: GlesTexture = gles.create_buffer(Fourcc::Abgr8888, (size.w, size.h).into()).map_err(|e| e.to_string())?;
    let elements: Vec<smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement<GlesRenderer>> =
        smithay::backend::renderer::element::surface::render_elements_from_surface_tree(
            gles,
            surface,
            Point::from((0, 0)),
            Scale::from(scale),
            1.0,
            Kind::Unspecified,
        );
    let mut tracker = OutputDamageTracker::new(size, scale, Transform::Normal);
    {
        let mut fb = gles.bind(&mut texture).map_err(|e| e.to_string())?;
        tracker
            .render_output(gles, &mut fb, 0, &elements, Color32F::new(0.0, 0.0, 0.0, 0.0))
            .map_err(|e| format!("{e:?}"))?;
    }
    let mut panels = Vec::new();
    for g in super::GlassElement::for_surface(surface, Point::from((0, 0)), Scale::from(scale), size, when) {
        for (r, radius) in g.shape_boxes() {
            panels.push([r.loc.x as f32, r.loc.y as f32, r.size.w as f32, r.size.h as f32, radius as f32]);
        }
    }
    let frame = Rectangle::from_size(size.to_f64());
    Ok(Snapshot { texture, size, frame, scale, id: Id::new(), commit: Default::default(), panels })
}

/// Where a point of `snapshot` lands on screen when it is drawn at `frame` scaled by
/// `k` (as `SnapshotElement::new` places it): `loc + q × f`.
pub fn placement(snapshot: &Snapshot, frame: Rectangle<f64, Physical>, k: f64) -> (Point<f64, Physical>, (f64, f64)) {
    let fx = frame.size.w / snapshot.frame.size.w.max(1.0) * k;
    let fy = frame.size.h / snapshot.frame.size.h.max(1.0) * k;
    let centre = frame.loc + frame.size.to_point().downscale(2.0);
    let box_centre = snapshot.frame.loc + snapshot.frame.size.to_point().downscale(2.0);
    (Point::from((centre.x - box_centre.x * fx, centre.y - box_centre.y * fy)), (fx, fy))
}

impl SnapshotElement {
    pub fn new(
        snapshot: &Snapshot,
        frame: Rectangle<f64, Physical>,
        k: f64,
        alpha: f64,
    ) -> Self {
        // The picture's box lands on `frame` scaled about its middle: a point `q` of the
        // picture goes to `centre + (q − box centre) × k × (frame / box)`.
        let fx = frame.size.w / snapshot.frame.size.w.max(1.0) * k;
        let fy = frame.size.h / snapshot.frame.size.h.max(1.0) * k;
        let centre = frame.loc + frame.size.to_point().downscale(2.0);
        let box_centre = snapshot.frame.loc + snapshot.frame.size.to_point().downscale(2.0);
        let loc = Point::<f64, Physical>::from((centre.x - box_centre.x * fx, centre.y - box_centre.y * fy));
        let size = Size::<f64, Physical>::from((snapshot.size.w as f64 * fx, snapshot.size.h as f64 * fy));
        let geometry = Rectangle::new(loc.to_i32_round(), size.to_i32_round());
        let mut commit = snapshot.commit.get();
        commit.increment();
        snapshot.commit.set(commit);
        Self {
            id: snapshot.id.clone(),
            commit,
            texture: snapshot.texture.clone(),
            size: snapshot.size,
            geometry,
            alpha: alpha.clamp(0.0, 1.0) as f32,
            lens: None,
        }
    }

    /// Drawn through a lens over each of the picture's glass panels — magnified by
    /// `1 + grow`, more toward the panel's edges by `pinch` (a pincushion); 0 and 0 = as it is.
    pub fn with_lens(mut self, program: Option<GlesTexProgram>, panels: &[[f32; 5]], px: Size<i32, Physical>, grow: f32, pinch: f32) -> Self {
        let Some(program) = program else { return self };
        if panels.is_empty() || grow <= 0.0 {
            return self;
        }
        let mut m = vec![0.0f32; 16 * LENS_MAT];
        for (i, r) in panels.iter().take(2 * LENS_MAT).enumerate() {
            m[i * 8..i * 8 + 5].copy_from_slice(r);
        }
        let uniforms = vec![
            Uniform::new("panels", UniformValue::Matrix4x4 { matrices: m.chunks(16).map(|c| c.try_into().unwrap()).collect(), transpose: false }),
            Uniform::new("panel_count", panels.len().min(2 * LENS_MAT) as f32),
            Uniform::new("px", (px.w as f32, px.h as f32)),
            Uniform::new("grow", grow),
            Uniform::new("pinch", pinch),
        ];
        self.lens = Some((program, uniforms));
        self
    }
}

const LENS_MAT: usize = 8;
const FS_LENS: &str = r#"#version 100

//_DEFINES_

#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif

precision highp float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif

uniform float alpha;
varying vec2 v_coords;

#if defined(DEBUG_FLAGS)
uniform float tint;
#endif

uniform mat4 panels[8];  // two glass shapes a matrix: its box (px), then its corner radius
uniform float panel_count;
uniform vec2 px;          // the picture's size, px
uniform float grow;
uniform float pinch;

// Signed distance to a rounded box of half size `h` and corner `r`: < 0 inside.
float sd_box(vec2 d, vec2 h, float r) {
    vec2 q = abs(d) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
    vec2 p = v_coords * px;
    // The smallest glass shape holding this point is the glass it lies on.
    vec4 best = vec4(0.0);
    float radius = 0.0;
    float area = 1e12;
    for (int i = 0; i < 16; i++) {
        if (float(i) >= panel_count) break;
        mat4 m = panels[i / 2];
        bool second = i - (i / 2) * 2 == 1;
        vec4 b = second ? m[2] : m[0];
        float r = second ? m[3].x : m[1].x;
        vec2 h = b.zw * 0.5;
        if (sd_box(p - (b.xy + h), h, min(r, min(h.x, h.y))) < 0.0 && b.z * b.w < area) {
            best = b;
            radius = r;
            area = b.z * b.w;
        }
    }
    vec2 s = p;
    if (area < 1e11) {
        // A bubble: its rim — the glass's own edge — stays where it is, its middle swells by
        // `grow`; what lies near the rim is pressed against it. `pinch` = how flat the swell is.
        vec2 h = best.zw * 0.5;
        vec2 c = best.xy + h;
        float sd = sd_box(p - c, h, min(radius, min(h.x, h.y)));
        float k = clamp(1.0 + sd / min(h.x, h.y), 0.0, 1.0);
        float m = 1.0 / (1.0 + grow);
        s = c + (p - c) * mix(m, 1.0, pow(k, pinch));
    }
    s = s / px;
#if defined(NO_ALPHA)
    vec4 color = vec4(texture2D(tex, s).rgb, 1.0);
#else
    vec4 color = texture2D(tex, s);
#endif
    color = color * alpha;
#if defined(DEBUG_FLAGS)
    if (tint == 1.0)
        color = vec4(0.0, 0.2, 0.0, 0.2) + color * 0.8;
#endif
    gl_FragColor = color;
}
"#;

struct LensProgram(Option<GlesTexProgram>);

/// The lens shader, compiled once per GL context.
pub fn lens_program(gles: &mut GlesRenderer) -> Option<GlesTexProgram> {
    if let Some(p) = gles.egl_context().user_data().get::<LensProgram>() {
        return p.0.clone();
    }
    let compiled = gles
        .compile_custom_texture_shader(
            FS_LENS,
            &[
                UniformName::new("panels", UniformType::Matrix4x4),
                UniformName::new("panel_count", UniformType::_1f),
                UniformName::new("px", UniformType::_2f),
                UniformName::new("grow", UniformType::_1f),
                UniformName::new("pinch", UniformType::_1f),
            ],
        )
        .map_err(|err| tracing::error!(?err, "the lens shader did not compile"))
        .ok();
    gles.egl_context().user_data().insert_if_missing(|| LensProgram(compiled.clone()));
    compiled
}

impl Element for SnapshotElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        self.commit
    }

    fn src(&self) -> Rectangle<f64, BufferCoords> {
        Rectangle::from_size((self.size.w as f64, self.size.h as f64).into())
    }

    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.geometry
    }

    fn alpha(&self) -> f32 {
        self.alpha
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl<R: HyaloRenderer> RenderElement<R> for SnapshotElement {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        _cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        R::gles_frame(frame)
            .render_texture_from_to(
                &self.texture,
                src,
                dst,
                damage,
                opaque_regions,
                Transform::Normal,
                self.alpha,
                self.lens.as_ref().map(|l| &l.0),
                self.lens.as_ref().map_or(&[][..], |l| &l.1[..]),
            )
            .map_err(R::from_gles_error)
    }
}
