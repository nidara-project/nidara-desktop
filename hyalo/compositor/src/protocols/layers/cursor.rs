//! The root keeps text-input focus; its cursor can belong to a moving child.
use super::*;
use smithay::{
    desktop::{PopupKind, PopupManager},
    utils::Rectangle,
    wayland::input_method::PopupSurface,
};

#[derive(Debug, Clone)]
struct Cursor {
    layer: Weak<NidaraLayerV1>,
    surface: Weak<WlSurface>,
    rect: Rectangle<i32, Logical>,
}
/// Outer None is unchanged; Some(None) clears. The last applied value persists
/// through unrelated commits, just like the standard cursor rectangle.
#[derive(Debug, Clone, Default)]
struct CursorState {
    update: Option<Option<Cursor>>,
}
impl Cacheable for CursorState {
    fn commit(&mut self, _: &DisplayHandle) -> Self {
        std::mem::take(self)
    }
    fn merge_into(self, into: &mut Self, _: &DisplayHandle) {
        if self.update.is_some() {
            into.update = self.update;
        }
    }
}

pub(super) fn set(
    resource: &NidaraLayersManagerV1,
    root: &WlSurface,
    layer: Option<NidaraLayerV1>,
    rect: Rectangle<i32, Logical>,
) {
    let invalid = || {
        resource.post_error(
            nidara_layers_manager_v1::Error::InvalidCursor,
            "cursor needs a root, a live layer below it, and a positive rectangle",
        )
    };
    if get_parent(root).is_some() || !root.id().same_client_as(&resource.id()) {
        invalid();
        return;
    }
    let cursor = if let Some(layer) = layer {
        let Some(surface) = layer.data::<LayerData>().and_then(|d| d.0.upgrade().ok()) else {
            invalid();
            return;
        };
        let mut ancestor = surface.clone();
        while let Some(parent) = get_parent(&ancestor) {
            ancestor = parent;
        }
        if ancestor != *root
            || surface == *root
            || !with_states(&surface, is_layer)
            || rect.size.w <= 0
            || rect.size.h <= 0
        {
            invalid();
            return;
        }
        Some(Cursor {
            layer: layer.downgrade(),
            surface: surface.downgrade(),
            rect,
        })
    } else {
        None
    };
    with_states(root, |s| {
        s.cached_state.get::<CursorState>().pending().update = Some(cursor)
    });
}

fn transformed(
    at: Point<f64, Logical>,
    scale: f64,
    rect: Rectangle<i32, Logical>,
) -> Rectangle<i32, Logical> {
    // Round OUTWARD once in logical space. Fractional output scale is applied by
    // the normal popup render path, exactly as for the layer itself.
    let x = (at.x + f64::from(rect.loc.x) * scale).floor() as i32;
    let y = (at.y + f64::from(rect.loc.y) * scale).floor() as i32;
    let right = (at.x + (f64::from(rect.loc.x) + f64::from(rect.size.w)) * scale).ceil() as i32;
    let bottom = (at.y + (f64::from(rect.loc.y) + f64::from(rect.size.h)) * scale).ceil() as i32;
    Rectangle::new(
        (x, y).into(),
        (
            right.saturating_sub(x).max(1),
            bottom.saturating_sub(y).max(1),
        )
            .into(),
    )
}

fn mapped(root: &WlSurface, when: Instant) -> Option<Rectangle<i32, Logical>> {
    let cursor = with_states(root, |s| {
        if !s.cached_state.has::<CursorState>() { return None; }
        s.cached_state.get::<CursorState>().current().update.clone()
    })
    .flatten()?;
    let surface = cursor.surface.upgrade().ok()?;
    let resource = cursor.layer.upgrade().ok()?;
    let alive = with_states(&surface, |s| {
        s.data_map.get::<Mutex<Layer>>().is_some_and(|l| {
            let l = l.lock().unwrap();
            l.alive && l.resource == resource
        })
    });
    if !alive {
        return None;
    }
    let found = std::cell::Cell::new(None);
    let origin = Place {
        at: (0., 0.).into(),
        scale: 1.,
        alpha: 1.,
    };
    with_surface_tree_downward(
        root,
        origin,
        |_, s, parent| match view(s) {
            Some(v) => TraversalAction::DoChildren(place(*parent, s, v.offset, when)),
            None => TraversalAction::SkipChildren,
        },
        |here, s, parent| {
            if here == &surface
                && let Some(v) = view(s)
            {
                let p = place(*parent, s, v.offset, when);
                found.set(Some(transformed(p.at, p.scale, cursor.rect)));
            }
        },
        |_, _, _| found.get().is_none(),
    );
    found.get()
}

struct Source(Mutex<Rectangle<i32, Logical>>);
/// Called only on Smithay's standard text-input updates, never on our mapped
/// updates. Keep the original for clear/destruction instead of mapping it twice.
pub fn remember_input_popup(popup: &PopupSurface) {
    with_states(popup.wl_surface(), |s| {
        let r = popup.text_input_rectangle();
        *s.data_map
            .get_or_insert_threadsafe(|| Source(Mutex::new(r)))
            .0
            .lock()
            .unwrap() = r;
    });
}
/// Before walking popups: sample the SAME presentation instant as their layer.
/// Public PopupSurface API updates both the IME event and shared render/input
/// location; Smithay itself remains unmodified.
pub fn prepare_input_popups(root: &WlSurface, when: Instant) {
    let target = mapped(root, when);
    for (popup, _) in PopupManager::popups_for_surface(root) {
        let PopupKind::InputMethod(mut popup) = popup else {
            continue;
        };
        let source = with_states(popup.wl_surface(), |s| {
            s.data_map.get::<Source>().map(|r| *r.0.lock().unwrap())
        });
        if let Some(rect) = target.or(source)
            && rect != popup.text_input_rectangle()
        {
            popup.set_text_input_rectangle(rect.loc.x, rect.loc.y, rect.size.w, rect.size.h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_uses_presented_anchor_scale_and_rounds_outward() {
        // Position (20,40), scale 1.25 about (40,30): origin (10,32.5).
        let r = transformed(
            (10., 32.5).into(),
            1.25,
            Rectangle::new((32, 24).into(), (2, 12).into()),
        );
        assert_eq!(r, Rectangle::new((50, 62).into(), (3, 16).into()));
        let r = transformed(
            (-0.25, -0.25).into(),
            1.,
            Rectangle::new((0, 0).into(), (1, 1).into()),
        );
        assert_eq!(r, Rectangle::new((-1, -1).into(), (2, 2).into()));
    }
    #[test]
    fn unrelated_commits_keep_the_cursor_and_explicit_clear_wins() {
        let dh = smithay::reexports::wayland_server::Display::<()>::new()
            .unwrap()
            .handle();
        let mut state = CursorState { update: Some(None) };
        CursorState::default().merge_into(&mut state, &dh);
        assert!(matches!(state.update, Some(None)));
        let committed = state.commit(&dh);
        assert!(state.update.is_none() && matches!(committed.update, Some(None)));
    }
}
