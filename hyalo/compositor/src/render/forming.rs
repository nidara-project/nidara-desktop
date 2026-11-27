//! Glass FORMS as a window or a menu comes, and dissolves as it goes (#764), the way the kit's
//! panels do (`nk::Appear`, toolkit/VIEW.md §6): the glass forms over the whole motion; what
//! lies on it — text, icons, what is on — comes over the second half of the TIME, so for the
//! first half the glass is seen forming alone, its bend growing; going, what lies on it goes
//! over the first half and the glass dissolves over the whole. What lies on the glass comes in
//! through a lens over each of its panes (snapshot.rs `with_lens`): magnified where it first
//! shows, settling to itself as it arrives.
//!
//! A window's motion keeps its own sizes and curves (wm/motion.rs: the Hyprland session's); a
//! menu (an xdg popup) has the kit's: 220 ms in, eased out, and 150 ms out, eased in, cubic.
//!
//! A menu is formed here, not by its client: its glass lies on its own surface, which comes
//! whole. Its clock starts at its first frame with something in it (`Menu`); going, its last
//! picture and its glass are kept when its app destroys it (`take_closing`) and drawn by its
//! root surface — the window or the layer it hangs from — where it was (`push_closing`).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use smithay::{
    backend::renderer::gles::GlesRenderer,
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Physical, Point, Rectangle, Scale, Size, user_data::UserDataMap},
    wayland::compositor::with_states,
};

use super::{GlassElement, HyaloRenderer, OutputElement, snapshot};

/// A menu's coming and going (the kit's `AppearStyle::POP` timing).
pub const MENU_IN: Duration = Duration::from_millis(220);
pub const MENU_OUT: Duration = Duration::from_millis(150);

/// How far the lens magnifies what lies on the glass when it first shows (`1 + grow`): coming,
/// and going (a lighter one: it is leaving, not arriving). `PINCH` how flat its swell is.
const LENS_IN: f32 = 0.8;
const LENS_OUT: f32 = 0.3;
pub const PINCH: f32 = 2.0;

fn smooth(x: f64) -> f64 {
    let c = x.clamp(0.0, 1.0);
    c * c * (3.0 - 2.0 * c)
}

/// What lies on the glass, `x` (0..1) through the time of a motion: coming, over its second
/// half; going, over its first.
pub fn content(coming: bool, x: f64) -> f64 {
    if coming { smooth((x - 0.5) / 0.5) } else { 1.0 - smooth(x / 0.5) }
}

/// The lens over content shown to `c`: strongest when it first shows, gone when it has.
pub fn lens(coming: bool, c: f64) -> f32 {
    let k = ((1.0 - c) * (1.0 - c)) as f32;
    if coming { LENS_IN * k } else { LENS_OUT * k }
}

/// Frames are wanted until then: a menu is coming or going, or the lock screen is going
/// (unlocking.rs). Read by `Hyalo::step_motions`; a
/// menu's motion lives on its surface, which the motion loop does not walk.
static UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) fn want_frames_until(until: Instant) {
    let mut u = UNTIL.lock().unwrap();
    if u.is_none_or(|x| x < until) {
        *u = Some(until);
    }
}

/// A menu still coming or going at `now`.
pub fn moving(now: Instant) -> bool {
    UNTIL.lock().unwrap().is_some_and(|u| now < u + Duration::from_millis(50))
}

/// A menu that moves (none with reduce motion): its clock, from its first frame with something
/// in it, and where it was last drawn, from its root surface.
#[derive(Debug)]
pub struct Menu {
    animate: bool,
    first: Mutex<Option<Instant>>,
    last: Mutex<Option<Place>>,
}

#[derive(Debug, Clone)]
struct Place {
    root: WlSurface,
    /// From the root surface's location, physical px.
    offset: Point<i32, Physical>,
    scale: Scale<f64>,
}

/// A menu is made: whether it will move.
pub fn begin(surface: &WlSurface, animate: bool) {
    with_states(surface, |s| {
        s.data_map.insert_if_missing_threadsafe(|| Menu { animate, first: Mutex::new(None), last: Mutex::new(None) });
    });
}

/// How far a menu has come, 0..1 of its time; None once it has (or it holds nothing yet, or
/// does not move).
fn coming(surface: &WlSurface, when: Instant) -> Option<f64> {
    if smithay::desktop::utils::bbox_from_surface_tree(surface, (0, 0)).is_empty() {
        return None;
    }
    let first = with_states(surface, |s| {
        let m = s.data_map.get::<Menu>().filter(|m| m.animate)?;
        Some(*m.first.lock().unwrap().get_or_insert(when))
    })?;
    let x = when.saturating_duration_since(first).as_secs_f64() / MENU_IN.as_secs_f64();
    if x >= 1.0 {
        return None;
    }
    want_frames_until(first + MENU_IN);
    Some(x)
}

/// A menu drawn: where, from its root surface (for its going).
fn drawn_at(surface: &WlSurface, root: &WlSurface, offset: Point<i32, Physical>, scale: Scale<f64>) {
    with_states(surface, |s| {
        if let Some(m) = s.data_map.get::<Menu>().filter(|m| m.animate) {
            *m.last.lock().unwrap() = Some(Place { root: root.clone(), offset, scale });
        }
    });
}

/// A menu, coming (`push_menu` in its place) — the glass forming, its content through the lens
/// — or, done, as it is (false: the caller draws it). Either way it is noted where it was.
#[allow(clippy::too_many_arguments)]
pub fn push_menu<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    surface: &WlSurface,
    root: &WlSurface,
    root_at: Point<i32, Physical>,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: Size<i32, Physical>,
    when: Instant,
) -> bool {
    drawn_at(surface, root, location - root_at, scale);
    let Some(x) = coming(surface, when) else { return false };
    let Ok(picture) = snapshot::take_surface(renderer.gles(), surface, scale.x, when) else { return false };
    let formed = 1.0 - (1.0 - x).powi(3);
    let c = content(true, x);
    let frame = Rectangle::new(location.to_f64(), picture.size.to_f64());
    let program = snapshot::lens_program(renderer.gles());
    out.push(OutputElement::Snapshot(
        snapshot::SnapshotElement::new(&picture, frame, 1.0, c).with_lens(program, &picture.panels, picture.size, lens(true, c), PINCH),
    ));
    let glass = GlassElement::for_surface(surface, location, scale, output_size, when);
    let veils = super::scrim::scrims_for(surface, location, scale, when);
    with_states(surface, |states| {
        out.extend(glass.into_iter().map(|g| OutputElement::Glass(g.forming(formed as f32, &states.data_map))));
        if let Some(e) = super::scrim::ScrimElement::new(&states.data_map, veils, output_size) {
            out.push(OutputElement::Scrim(e.forming(formed, &states.data_map)));
        }
    });
    true
}

/// A menu going: its last picture and its glass, kept on its root surface.
struct Going {
    picture: snapshot::Snapshot,
    glass: Vec<GlassElement>,
    offset: Point<i32, Physical>,
    start: Instant,
    memo: Arc<UserDataMap>,
}

#[derive(Default)]
struct Goings(Mutex<Vec<Going>>);

/// Its app destroyed a menu: what it showed last, kept for its going. Nothing when it does not
/// move, or was never drawn.
pub fn take_closing(gles: &mut GlesRenderer, surface: &WlSurface, now: Instant) {
    let Some(place) = with_states(surface, |s| s.data_map.get::<Menu>().and_then(|m| m.last.lock().unwrap().clone())) else {
        return;
    };
    let picture = match snapshot::take_surface(gles, surface, place.scale.x, now) {
        Ok(p) => p,
        Err(err) => {
            tracing::debug!(%err, "no picture of a menu going");
            return;
        }
    };
    let glass = GlassElement::for_surface(surface, Point::from((0, 0)), place.scale, picture.size, now);
    with_states(&place.root, |s| {
        s.data_map.insert_if_missing_threadsafe(Goings::default);
        let mut goings = s.data_map.get::<Goings>().unwrap().0.lock().unwrap();
        goings.push(Going { picture, glass, offset: place.offset, start: now, memo: Default::default() });
    });
    want_frames_until(now + MENU_OUT);
}

/// The menus of `root` going, in front of everything it draws: what lies on their glass goes
/// first, through the lens, and their glass dissolves.
pub fn push_closing<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    root: &WlSurface,
    root_at: Point<i32, Physical>,
    when: Instant,
) {
    let program = snapshot::lens_program(renderer.gles());
    with_states(root, |s| {
        let Some(goings) = s.data_map.get::<Goings>() else { return };
        let mut goings = goings.0.lock().unwrap();
        goings.retain(|g| when.saturating_duration_since(g.start) < MENU_OUT);
        for g in goings.iter() {
            let x = when.saturating_duration_since(g.start).as_secs_f64() / MENU_OUT.as_secs_f64();
            let formed = 1.0 - x.powi(3);
            let c = content(false, x);
            let at = root_at + g.offset;
            let frame = Rectangle::new(at.to_f64(), g.picture.size.to_f64());
            out.push(OutputElement::Snapshot(
                snapshot::SnapshotElement::new(&g.picture, frame, 1.0, c).with_lens(program.clone(), &g.picture.panels, g.picture.size, lens(false, c), PINCH),
            ));
            for glass in &g.glass {
                out.push(OutputElement::Glass(glass.mapped(at.to_f64(), (1.0, 1.0)).forming(formed as f32, &g.memo)));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_lies_on_the_glass_comes_over_the_second_half_and_goes_over_the_first() {
        assert_eq!(content(true, 0.5), 0.0);
        assert!(content(true, 0.75) > 0.0 && content(true, 0.75) < 1.0);
        assert_eq!(content(true, 1.0), 1.0);
        assert_eq!(content(false, 0.0), 1.0);
        assert_eq!(content(false, 0.5), 0.0);
    }

    #[test]
    fn the_lens_lets_go_as_the_content_arrives() {
        assert_eq!(lens(true, 0.0), LENS_IN);
        assert_eq!(lens(true, 1.0), 0.0);
        assert!(lens(false, 0.0) < lens(true, 0.0));
    }
}
