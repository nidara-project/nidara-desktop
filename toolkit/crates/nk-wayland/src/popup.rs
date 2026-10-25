// SPDX-License-Identifier: LGPL-3.0-or-later
//! Standard xdg-shell popups on the parent's connection; no layer protocol involved.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PopupPlacement {
    /// Parent window-geometry coordinates: x, y, width, height.
    pub anchor: [i32; 4],
    pub size: (u32, u32),
}

impl PopupPlacement {
    pub fn validate(self) -> Result<()> {
        let [x, y, width, height] = self.anchor;
        if width <= 0
            || height <= 0
            || x.checked_add(width).is_none()
            || y.checked_add(height).is_none()
            || self.size.0 == 0
            || self.size.1 == 0
            || self.size.0 > i32::MAX as u32
            || self.size.1 > i32::MAX as u32
        {
            return Err("invalid popup placement".into());
        }
        Ok(())
    }

    pub(super) fn apply(self, positioner: &xdg_positioner::XdgPositioner) -> Result<()> {
        self.validate()?;
        let [x, y, width, height] = self.anchor;
        positioner.set_size(self.size.0 as i32, self.size.1 as i32);
        positioner.set_anchor_rect(x, y, width, height);
        positioner.set_anchor(xdg_positioner::Anchor::BottomLeft);
        positioner.set_gravity(xdg_positioner::Gravity::BottomRight);
        positioner.set_constraint_adjustment(
            xdg_positioner::ConstraintAdjustment::FlipY
                | xdg_positioner::ConstraintAdjustment::SlideX
                | xdg_positioner::ConstraintAdjustment::SlideY
                | xdg_positioner::ConstraintAdjustment::ResizeY,
        );
        Ok(())
    }
}

/// Run a popup until selection/cancellation closes it or the compositor dismisses it.
/// The optional serial must come from the initiating physical input event.
pub fn run_popup(
    app: impl Application,
    parent: &mut Window,
    placement: PopupPlacement,
    grab_serial: Option<u32>,
) -> Result<()> {
    placement.validate()?;
    let last_serial = run_inner(
        app,
        Options {
            material: true,
            map: true,
            app_id: parent.app_id,
            title: "",
            size: placement.size,
            require_material: None,
        },
        Instant::now(),
        Some(parent),
        Some((placement, grab_serial)),
    )?;
    parent.ignore_input_before = Some(last_serial);
    parent.keyboard.reset();
    Ok(())
}

/// xdg_popup.configure is pending until its matching xdg_surface.configure.
#[derive(Default)]
pub(super) struct Geometry {
    pending: Option<[i32; 4]>,
    pub(super) current: Option<[i32; 4]>,
}
impl Geometry {
    pub(super) fn stage(&mut self, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
        if width <= 0 || height <= 0 {
            return Err("invalid popup configure size".into());
        }
        self.pending = Some([x, y, width, height]);
        Ok(())
    }
    pub(super) fn commit(&mut self) {
        if let Some(geometry) = self.pending.take() {
            self.current = Some(geometry);
        }
    }
}

impl Window {
    /// Latest acknowledged popup rectangle in parent window-geometry logical coordinates.
    /// None for toplevels and before the first popup configure acknowledgement.
    pub fn popup_geometry(&self) -> Option<[i32; 4]> {
        self.popup_geometry.current
    }

    /// Reposition this popup with an acknowledgement token. Older xdg-shell versions
    /// fail explicitly; they cannot implement the version-3 reposition request.
    pub fn reposition_popup(&mut self, placement: PopupPlacement, token: u32) -> Result<()> {
        placement.validate()?;
        let popup = self.popup.as_ref().ok_or("not a popup window")?;
        if popup.version() < 3 {
            return Err("xdg_popup.reposition requires xdg-shell version 3".into());
        }
        let positioner = self.positioner.as_ref().ok_or("popup has no positioner")?;
        placement.apply(positioner)?;
        popup.reposition(positioner, token);
        Ok(())
    }
}

impl Dispatch<xdg_popup::XdgPopup, ()> for Window {
    fn event(
        w: &mut Self,
        _: &xdg_popup::XdgPopup,
        event: xdg_popup::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            xdg_popup::Event::Configure {
                x,
                y,
                width,
                height,
            } => match w.popup_geometry.stage(x, y, width, height) {
                Ok(()) => w.pending_size = Some((width as u32, height as u32)),
                Err(error) => w.events.push(Event::Error(error)),
            },
            xdg_popup::Event::PopupDone => {
                w.closed = true;
                w.events.push(Event::PopupDone);
            }
            xdg_popup::Event::Repositioned { token } => {
                w.events.push(Event::PopupRepositioned(token));
            }
            _ => {}
        }
    }
}

delegate_noop!(Window: ignore xdg_positioner::XdgPositioner);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn popup_geometry_is_atomic_with_surface_configure_and_keeps_signed_actual_origin() {
        let mut geometry = Geometry::default();
        assert_eq!(geometry.current, None);
        geometry.stage(-40, -180, 200, 120).unwrap();
        assert_eq!(geometry.current, None);
        geometry.commit();
        assert_eq!(geometry.current, Some([-40, -180, 200, 120]));
        geometry.stage(31, 77, 190, 110).unwrap();
        assert_eq!(geometry.current, Some([-40, -180, 200, 120]));
        assert!(geometry.stage(99, 88, 0, 90).is_err());
        geometry.commit();
        assert_eq!(geometry.current, Some([31, 77, 190, 110]));
        geometry.commit();
        assert_eq!(geometry.current, Some([31, 77, 190, 110]));
    }
    #[test]
    fn positioner_requires_a_nonempty_anchor_and_size_without_integer_overflow() {
        let valid = PopupPlacement {
            anchor: [-20, 10, 80, 30],
            size: (240, 180),
        };
        valid.validate().unwrap();
        for anchor in [[0, 0, 0, 30], [0, 0, 80, -1], [i32::MAX, 0, 1, 1]] {
            assert!(PopupPlacement { anchor, ..valid }.validate().is_err());
        }
        for size in [(0, 180), (240, 0), (u32::MAX, 180)] {
            assert!(PopupPlacement { size, ..valid }.validate().is_err());
        }
    }
}
