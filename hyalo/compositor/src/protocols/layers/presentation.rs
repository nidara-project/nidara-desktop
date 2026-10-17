//! Layer transforms belong to a displayed frame, not the input dispatch clock.
//! A frame owns its stamp; weak stamps in layers expire when outputs replace it.
//! Retargeting cannot rewrite an already drawn Look, and failed queues never publish it.
use super::*;
use smithay::output::Output;
use std::sync::{Arc, Weak as WeakStamp};

#[derive(Debug, Default)]
pub(super) struct PresentedLook(Vec<(WeakStamp<Instant>, Look)>);
impl PresentedLook {
    pub(super) fn get(&self, frame: &Arc<Instant>) -> Option<Look> {
        self.0
            .iter()
            .find_map(|(stamp, look)| stamp.ptr_eq(&Arc::downgrade(frame)).then_some(*look))
    }
    fn remember(&mut self, stamp: &Arc<Instant>, look: Look) {
        self.0.retain(|(s, _)| s.strong_count() != 0);
        self.0.push((Arc::downgrade(stamp), look));
    }
}

pub struct Frame {
    when: Instant,
    layers: Vec<(Weak<WlSurface>, Weak<NidaraLayerV1>, Look)>,
}
#[derive(Default)]
struct Presentation {
    pending: Option<Frame>,
    shown: Option<Arc<Instant>>,
}

/// Called on the event-loop thread at the frame's render sample. No client can
/// change a layer between building the scene and taking this snapshot.
pub fn sample(scene: &crate::render::Scene<'_>, output: &Output) -> Option<Frame> {
    if LIVE.load(Ordering::Relaxed) == 0 {
        return None;
    }
    let when = scene.when;
    let map = smithay::desktop::layer_map_for_output(output);
    let mut roots = Vec::new();
    if scene.lock.draws_locked(output) {
        if let Some(root) = scene.lock.surface_for(output) {
            roots.push(root.clone());
        }
        roots.extend(
            map.layers_on(smithay::wayland::shell::wlr_layer::Layer::Background)
                .map(|l| l.wl_surface().clone()),
        );
    } else {
        roots.extend(
            scene
                .space
                .elements_for_output(output)
                .filter_map(crate::wm::surface_of),
        );
        roots.extend(map.layers().map(|l| l.wl_surface().clone()));
    }
    let mut visible = std::collections::HashSet::new();
    for root in roots {
        visible.insert(root.id());
        for (popup, _) in smithay::desktop::PopupManager::popups_for_surface(&root) {
            visible.insert(popup.wl_surface().id());
        }
    }
    let layers = LAYERS
        .lock()
        .unwrap()
        .iter()
        .filter_map(|weak| {
            let surface = weak.upgrade().ok()?;
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            if !visible.contains(&root.id()) {
                return None;
            }
            with_states(&surface, |s| {
                let layer = s.data_map.get::<Mutex<Layer>>()?.lock().unwrap();
                layer
                    .alive
                    .then(|| (weak.clone(), layer.resource.downgrade(), layer.look(when)))
            })
        })
        .collect();
    Some(Frame { when, layers })
}

pub fn queued(output: &Output, frame: Option<Frame>) {
    if frame.is_none() && output.user_data().get::<Mutex<Presentation>>().is_none() {
        return;
    }
    output
        .user_data()
        .get_or_insert_threadsafe(|| Mutex::new(Presentation::default()))
        .lock()
        .unwrap()
        .pending = frame;
}
pub fn discard(output: &Output) {
    if let Some(p) = output.user_data().get::<Mutex<Presentation>>() {
        p.lock().unwrap().pending = None;
    }
}
pub fn presented(output: &Output) {
    let Some(p) = output.user_data().get::<Mutex<Presentation>>() else {
        return;
    };
    let mut p = p.lock().unwrap();
    let Some(frame) = p.pending.take() else { return };
    // Drop this output's old stamp BEFORE pruning weak stamps in the layers.
    let stamp = Arc::new(frame.when);
    p.shown = Some(stamp.clone());
    if std::env::var_os("HYALO_CONTROL").is_some() {
        eprintln!(
            "LAYER_PRESENT output={} sampled={:?} delivered={:?}",
            output.name(),
            frame.when,
            Instant::now()
        );
    }
    for (weak, resource, look) in frame.layers {
        let (Ok(surface), Ok(resource)) = (weak.upgrade(), resource.upgrade()) else {
            continue;
        };
        with_states(&surface, |s| {
            let Some(layer) = s.data_map.get::<Mutex<Layer>>() else {
                return;
            };
            let mut layer = layer.lock().unwrap();
            if layer.alive && layer.resource == resource {
                layer.shown.remember(&stamp, look);
            }
        });
    }
}
pub fn shown_frame(output: &Output) -> Option<Arc<Instant>> {
    output
        .user_data()
        .get::<Mutex<Presentation>>()?
        .lock()
        .unwrap()
        .shown
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn look(x: f64) -> Look {
        Look {
            position: Some([x, 40.]),
            scale: 1.,
            anchor: [0., 0.],
            opacity: 1.,
        }
    }
    #[test]
    fn input_keeps_the_drawn_transform_when_dispatch_is_late_or_target_changes() {
        let start = Instant::now();
        let when = start + Duration::from_millis(870);
        let late = start + Duration::from_millis(1230);
        let stamp = Arc::new(when);
        let mut motion = Prop::new(20.);
        motion.set(300., Some(Curve::bezier(0., 0., 1., 1., 2000).unwrap()), start, 0.5);
        let drawn = motion.presented(when).0;
        let mut shown = PresentedLook::default();
        shown.remember(&stamp, look(drawn));
        let click = drawn + 40.;
        assert!(click >= drawn && click < drawn + 80.);
        // Re-interpolating at dispatch would miss that visible centre entirely.
        assert!(click < motion.presented(late).0);
        motion.set(20., Some(Curve::spring(1., 30., 4., 0.).unwrap()), late, 0.5);
        assert_eq!(shown.get(&stamp), Some(look(drawn)));
        assert_eq!(shown.get(&Arc::new(late)), None);
    }
    #[test]
    fn outputs_keep_independent_frames_and_old_stamps_are_reclaimed() {
        let a = Arc::new(Instant::now());
        // Equal clock values on two outputs must still name different frames.
        let b = Arc::new(*a);
        let c = Arc::new(*b + Duration::from_millis(16));
        let mut shown = PresentedLook::default();
        shown.remember(&a, look(20.));
        shown.remember(&b, look(30.));
        assert_eq!(shown.get(&a), Some(look(20.)));
        assert_eq!(shown.get(&b), Some(look(30.)));
        drop(a);
        shown.remember(&c, look(40.));
        assert_eq!(shown.0.len(), 2);
        assert_eq!(shown.get(&b), Some(look(30.)));
        assert_eq!(shown.get(&c), Some(look(40.)));
    }
    #[test]
    fn queued_or_failed_frames_do_not_move_input_ahead_of_presentation() {
        let output = Output::new(
            "test".into(),
            smithay::output::PhysicalProperties {
                size: (0, 0).into(),
                subpixel: smithay::output::Subpixel::Unknown,
                make: "test".into(),
                model: "test".into(),
                serial_number: String::new(),
            },
        );
        let first = Instant::now();
        let next = first + Duration::from_millis(400);
        assert_eq!(shown_frame(&output).as_deref().copied(), None);
        queued(
            &output,
            Some(Frame {
                when: first,
                layers: vec![],
            }),
        );
        assert_eq!(shown_frame(&output).as_deref().copied(), None);
        presented(&output);
        assert_eq!(shown_frame(&output).as_deref().copied(), Some(first));
        queued(
            &output,
            Some(Frame {
                when: next,
                layers: vec![],
            }),
        );
        assert_eq!(shown_frame(&output).as_deref().copied(), Some(first));
        discard(&output);
        presented(&output);
        assert_eq!(shown_frame(&output).as_deref().copied(), Some(first));
        queued(
            &output,
            Some(Frame {
                when: next,
                layers: vec![],
            }),
        );
        presented(&output);
        assert_eq!(shown_frame(&output).as_deref().copied(), Some(next));
    }
}
