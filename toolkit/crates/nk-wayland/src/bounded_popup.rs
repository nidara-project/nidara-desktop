// SPDX-License-Identifier: LGPL-3.0-or-later
//! Explicit host hints supplement (never replace) compositor popup constraints.
use super::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupSide {
    Below,
    Right,
}
#[derive(Clone, Copy, Debug)]
pub struct MenuPopupPlacement {
    pub placement: PopupPlacement,
    /// Logical immediate-parent coordinates; None leaves sizing to the compositor.
    pub workarea: Option<[i32; 4]>,
    pub side: PopupSide,
    /// None creates the root; Some must identify the active menu popup.
    pub parent: Option<PopupId>,
    /// Physical initiating serial only. Accessibility may omit a grab.
    pub grab_serial: Option<u32>,
}
impl MenuPopupPlacement {
    pub fn constrained(self) -> Result<PopupPlacement> {
        self.placement.validate()?;
        let mut p = self.placement;
        if let Some([x, y, w, h]) = self.workarea {
            if w <= 0 || h <= 0 || x.checked_add(w).is_none() || y.checked_add(h).is_none() {
                return Err("invalid popup workarea hint".into());
            }
            p.size = (p.size.0.min(w as u32), p.size.1.min(h as u32));
        }
        Ok(p)
    }
}

struct Barrier(u32);
impl Window {
    /// A protocol-ordering barrier, not a frame/presentation acknowledgement.
    /// Applications keep servicing the normal queue until ProtocolBarrier(token).
    pub fn protocol_barrier(&self, token: u32) -> Result<()> {
        self.connection.display().sync(&self.qh, Barrier(token));
        self.connection.flush().map_err(err)?;
        Ok(())
    }
}
impl Dispatch<wl_callback::WlCallback, Barrier> for Window {
    fn event(
        w: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        barrier: &Barrier,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        w.events.push(Event::ProtocolBarrier(barrier.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hints_bound_both_dimensions_without_inventing_an_origin() {
        let p = MenuPopupPlacement {
            placement: PopupPlacement {
                anchor: [-200, 20, 50, 30],
                size: (900, 2000),
            },
            workarea: Some([-500, -100, 640, 400]),
            side: PopupSide::Below,
            parent: None,
            grab_serial: None,
        };
        assert_eq!(
            p.constrained().unwrap(),
            PopupPlacement {
                size: (640, 400),
                ..p.placement
            }
        );
        assert_eq!(
            MenuPopupPlacement {
                workarea: None,
                ..p
            }
            .constrained()
            .unwrap(),
            p.placement
        );
        for bad in [[0, 0, 0, 10], [0, 0, 10, -1], [i32::MAX, 0, 10, 10]] {
            assert!(
                MenuPopupPlacement {
                    workarea: Some(bad),
                    ..p
                }
                .constrained()
                .is_err()
            );
        }
    }
}
