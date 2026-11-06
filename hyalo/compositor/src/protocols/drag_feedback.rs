//! Cursor-only destination intent. The standard data offer still negotiates Copy.
use smithay::{
    input::pointer::CursorIcon,
    reexports::wayland_server::{Client, DataInit, DisplayHandle, New, Resource, WEnum, backend::ClientId,
        protocol::wl_data_device_manager::DndAction},
    utils::Serial,
    wayland::{Dispatch2, GlobalDispatch2},
};
use crate::{Hyalo, protocols::gen_drag_feedback::nidara_drag_feedback_v1::{self, NidaraDragFeedbackV1}};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent { None, Open, Pin }

/// One surface visit, bounded by motion serials (Serial compares across wrap).
/// An enter can be delayed until a source's MIME metadata is ready, so its serial
/// may be later than the first motion onto this surface, but never before it.
pub struct Feedback<T> {
    target: Option<T>,
    first: Option<Serial>,
    last: Option<Serial>,
    action: DndAction,
    hint: Option<(T, Intent)>,
}
impl<T> Default for Feedback<T> {
    fn default() -> Self { Self { target: None, first: None, last: None, action: DndAction::empty(), hint: None } }
}
impl<T: PartialEq> Feedback<T> {
    pub fn motion(&mut self, target: Option<T>, serial: Serial) {
        if self.target != target {
            self.target = target;
            self.first = Some(serial);
            self.hint = None;
            self.action = DndAction::empty();
        }
        self.last = Some(serial);
    }
    pub fn choose(&mut self, action: DndAction) { self.action = action; }
    pub fn clear(&mut self) { *self = Self::default(); }
    pub fn set(&mut self, target: &T, serial: Serial, writer: T, hint: Intent) -> bool {
        if self.target.as_ref() != Some(target) || !self.first.zip(self.last).is_some_and(|(first, last)| serial >= first && serial <= last) {
            return false;
        }
        self.hint = Some((writer, hint));
        true
    }
    pub fn surface_destroyed(&mut self, target: &T) -> bool {
        if self.target.as_ref() == Some(target) { self.clear(); true } else { false }
    }
    pub fn destroyed(&mut self, writer: &T) -> bool {
        if self.hint.as_ref().is_some_and(|(owner, _)| owner == writer) {
            self.hint = None;
            self.action = DndAction::empty();
            true
        } else { false }
    }
    pub fn cursor(&self) -> CursorIcon {
        if self.action == DndAction::Copy {
            match self.hint.as_ref().map(|(_, hint)| hint) {
                Some(Intent::Pin) => CursorIcon::Alias,
                Some(Intent::None) => CursorIcon::Default,
                Some(Intent::Open) | None => CursorIcon::Copy,
            }
        } else if self.action == DndAction::Ask { CursorIcon::ContextMenu }
        else { CursorIcon::Default }
    }
}

pub struct DragGlobal;
pub fn init(dh: &DisplayHandle) { dh.create_global::<Hyalo, NidaraDragFeedbackV1, _>(1, DragGlobal); }
impl GlobalDispatch2<NidaraDragFeedbackV1, Hyalo> for DragGlobal {
    fn bind(&self, _state: &mut Hyalo, _dh: &DisplayHandle, _client: &Client,
        resource: New<NidaraDragFeedbackV1>, data_init: &mut DataInit<'_, Hyalo>) {
        data_init.init(resource, DragGlobal);
    }
    fn can_view(&self, client: &Client) -> bool { crate::sandbox::unrestricted(client) }
}
impl Dispatch2<NidaraDragFeedbackV1, Hyalo> for DragGlobal {
    fn request(&self, state: &mut Hyalo, client: &Client, resource: &NidaraDragFeedbackV1,
        request: nidara_drag_feedback_v1::Request, _dh: &DisplayHandle, _data_init: &mut DataInit<'_, Hyalo>) {
        if let nidara_drag_feedback_v1::Request::SetFeedback { surface, serial, intent: WEnum::Value(intent) } = request {
            if state.dnd_started.is_none() || surface.client().is_none_or(|owner| owner.id() != client.id()) { return; }
            let hint = match intent {
                nidara_drag_feedback_v1::Intent::None => Intent::None,
                nidara_drag_feedback_v1::Intent::Open => Intent::Open,
                nidara_drag_feedback_v1::Intent::Pin => Intent::Pin,
            };
            if state.dnd_feedback.set(&surface.id(), serial.into(), resource.id(), hint) {
                state.cursor_status = state.dnd_cursor();
                tracing::debug!(?hint, cursor = ?state.cursor_status, "drag destination feedback");
                state.wm.chrome_cursor = true;
                state.queue_redraw(None);
            }
        }
    }
    fn destroyed(&self, state: &mut Hyalo, _client: ClientId, resource: &NidaraDragFeedbackV1) {
        if state.dnd_feedback.destroyed(&resource.id()) {
            state.cursor_status = state.dnd_cursor();
            state.queue_redraw(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_intent_changes_only_the_cursor_and_never_the_negotiated_copy() {
        let mut f = Feedback::default();
        f.motion(Some(1), 10.into());
        f.choose(DndAction::Copy);
        assert_eq!(f.cursor(), CursorIcon::Copy, "old clients/compositors use the standard cursor");
        for (hint, cursor) in [(Intent::Pin, CursorIcon::Alias), (Intent::Open, CursorIcon::Copy), (Intent::None, CursorIcon::Default)] {
            assert!(f.set(&1, 10.into(), 20, hint));
            assert_eq!(f.cursor(), cursor);
            assert_eq!(f.action, DndAction::Copy);
        }
        assert!(f.set(&1, 10.into(), 20, Intent::Pin));
        f.choose(DndAction::empty());
        assert_eq!(f.cursor(), CursorIcon::Default, "a hint alone accepts nothing");
        f.choose(DndAction::Ask);
        assert_eq!(f.cursor(), CursorIcon::ContextMenu);
        f.choose(DndAction::Move);
        assert_eq!(f.cursor(), CursorIcon::Default);
    }
    #[test]
    fn leaving_dropping_cancelling_or_destroying_the_writer_clears_alias() {
        let mut f = Feedback::default();
        f.motion(Some(1), 10.into());
        f.choose(DndAction::Copy);
        assert!(f.set(&1, 10.into(), 20, Intent::Pin));
        f.motion(None, 11.into());
        assert_eq!(f.cursor(), CursorIcon::Default);
        assert!(!f.set(&1, 10.into(), 20, Intent::Pin));
        f.motion(Some(1), 12.into());
        f.choose(DndAction::Copy);
        assert!(!f.set(&1, 10.into(), 20, Intent::Pin), "old visit cannot affect reentry");
        assert!(!f.set(&2, 12.into(), 20, Intent::Pin), "other surface cannot change this target");
        assert!(!f.set(&1, 13.into(), 20, Intent::Pin), "future serial cannot be guessed");
        assert!(f.set(&1, 12.into(), 20, Intent::Pin));
        assert!(!f.destroyed(&21));
        assert_eq!(f.cursor(), CursorIcon::Alias);
        assert!(f.destroyed(&20));
        assert_eq!(f.cursor(), CursorIcon::Default);
        f.choose(DndAction::Copy);
        assert!(f.set(&1, 12.into(), 20, Intent::Pin));
        assert!(!f.surface_destroyed(&2));
        assert_eq!(f.cursor(), CursorIcon::Alias);
        assert!(f.surface_destroyed(&1));
        assert_eq!(f.cursor(), CursorIcon::Default);
        f.motion(Some(1), 13.into());
        f.choose(DndAction::Copy);
        assert!(f.set(&1, 13.into(), 20, Intent::Pin));
        f.clear(); // the same cleanup called on drop and cancellation
        assert_eq!(f.cursor(), CursorIcon::Default);
        assert!(!f.set(&1, 12.into(), 20, Intent::Pin));
    }
    #[test]
    fn delayed_enter_and_wrapped_serials_still_belong_to_the_current_visit() {
        let mut f = Feedback::default();
        f.motion(Some(1), (u32::MAX - 1).into());
        f.motion(Some(1), 2.into());
        assert!(f.set(&1, 1.into(), 20, Intent::Pin));
        assert!(!f.set(&1, (u32::MAX - 2).into(), 20, Intent::Pin));
    }
}
