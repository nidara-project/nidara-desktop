// SPDX-License-Identifier: LGPL-3.0-or-later
//! The standard modal hint and restricted dispatch of a nested dialog's parent.
use super::*;
pub(super) use wayland_protocols::xdg::dialog::v1::client::{
    xdg_dialog_v1::XdgDialogV1, xdg_wm_dialog_v1::XdgWmDialogV1,
};

/// Keep protocol/configure/presentation alive without letting a modal parent act.
fn parent_event(event: &Event) -> bool {
    matches!(
        event,
        Event::Configure
            | Event::PreferredScale(_)
            | Event::Closed
            | Event::CloseRequested
            | Event::Focus(false)
            | Event::ControlsLayout(_)
            | Event::FrameDone
            | Event::Presented { .. }
            | Event::ProtocolBarrier(_)
    )
}
pub(super) fn pump_parent(parent: &mut Window, adapter: &mut dyn Application) -> Result<()> {
    let queue = parent
        .protocol_queue
        .upgrade()
        .ok_or("modal parent's event queue retired")?;
    queue.borrow_mut().dispatch_pending(parent).map_err(err)?;
    for event in std::mem::take(&mut parent.events) {
        if let Event::Error(error) = event {
            return Err(error);
        }
        if parent_event(&event) {
            let closed = matches!(event, Event::Closed | Event::CloseRequested);
            adapter.event(event, parent)?;
            parent.closed |= closed;
        }
    }
    if !parent.closed {
        adapter.idle(parent)?;
        parent.paint(adapter)?;
        if !parent.dirty && (parent.cursor_pending || parent.layers.iter().any(|l| l.pending)) {
            parent.commit()?;
        }
    }
    Ok(())
}

delegate_noop!(Window: ignore XdgWmDialogV1);
delegate_noop!(Window: ignore XdgDialogV1);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modal_parent_keeps_protocol_progress_and_refuses_focus_input() {
        assert!(parent_event(&Event::Configure));
        assert!(parent_event(&Event::FrameDone));
        assert!(parent_event(&Event::Focus(false)));
        assert!(parent_event(&Event::Closed));
        assert!(parent_event(&Event::CloseRequested));
        for event in [
            Event::Focus(true),
            Event::Motion(3., 4.),
            Event::PointerLeave,
            Event::Scroll(ScrollAmount::pixels(1.)),
            Event::Button {
                button: 0x110,
                pressed: true,
                serial: 3,
                time: 4,
                modifiers: Default::default(),
            },
            Event::Paste("text".into()),
        ] {
            assert!(!parent_event(&event));
        }
    }
}
