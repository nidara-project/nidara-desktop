// SPDX-License-Identifier: LGPL-3.0-or-later
//! Standard xdg-foreign-v2 identifier for an out-of-process portal dialog.
use crate::{Result, Window};
use wayland_client::{Dispatch, Proxy, delegate_noop};
use wayland_protocols::xdg::foreign::zv2::client::{zxdg_exported_v2, zxdg_exporter_v2};
/// Only Unsupported permits a caller to use an empty portal parent_window.
#[derive(Debug, PartialEq, Eq)]
pub enum ForeignParent<'a> {
    Unsupported,
    Pending,
    Ready(&'a str),
}
#[derive(Default)]
enum Handle {
    #[default]
    Pending,
    Ready(String),
    Failed,
}
impl Handle {
    fn accept(&mut self, handle: String) {
        if matches!(self, Self::Pending) {
            *self = if handle.is_empty() {
                Self::Failed
            } else {
                Self::Ready(format!("wayland:{handle}"))
            };
        }
    }
    fn parent(&self) -> Result<ForeignParent<'_>> {
        match self {
            Self::Pending => Ok(ForeignParent::Pending),
            Self::Ready(handle) => Ok(ForeignParent::Ready(handle)),
            Self::Failed => Err("xdg-foreign returned an empty parent handle".into()),
        }
    }
}
#[derive(Default)]
pub(crate) struct Foreign {
    pub(crate) exporter: Option<zxdg_exporter_v2::ZxdgExporterV2>,
    exported: Option<zxdg_exported_v2::ZxdgExportedV2>,
    handle: Handle,
}
impl Foreign {
    pub(crate) fn destroy(&mut self) {
        if let Some(exported) = self.exported.take() {
            exported.destroy();
        }
        if let Some(exporter) = self.exporter.take() {
            exporter.destroy();
        }
        self.handle = Handle::Pending;
    }
}
impl Window {
    /// Poll the portal parent identifier; never roundtrips or blocks the UI.
    pub fn portal_parent(&mut self) -> Result<ForeignParent<'_>> {
        if self.toplevel.is_none() {
            return Err("portal parent requires an xdg toplevel".into());
        }
        let Some(exporter) = &self.foreign.exporter else {
            return Ok(ForeignParent::Unsupported);
        };
        if !self.configured {
            return Ok(ForeignParent::Pending);
        }
        if self.foreign.exported.is_none() {
            let surface = self
                .surface
                .as_ref()
                .ok_or("portal parent surface was destroyed")?;
            self.foreign.exported = Some(exporter.export_toplevel(surface, &self.qh, ()));
        }
        self.foreign.handle.parent()
    }
}
impl Dispatch<zxdg_exported_v2::ZxdgExportedV2, ()> for Window {
    fn event(
        state: &mut Self,
        proxy: &zxdg_exported_v2::ZxdgExportedV2,
        event: zxdg_exported_v2::Event,
        _: &(),
        _: &wayland_client::Connection,
        _: &wayland_client::QueueHandle<Self>,
    ) {
        if state
            .foreign
            .exported
            .as_ref()
            .is_none_or(|current| current.id() != proxy.id())
        {
            return;
        }
        if let zxdg_exported_v2::Event::Handle { handle } = event {
            state.foreign.handle.accept(handle);
        }
    }
}
delegate_noop!(Window: ignore zxdg_exporter_v2::ZxdgExporterV2);
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_is_not_unparented_and_received_handle_is_opaque_and_retained() {
        let mut handle = Handle::default();
        assert_eq!(handle.parent().unwrap(), ForeignParent::Pending);
        handle.accept("opaque/a:b".into());
        assert_eq!(
            handle.parent().unwrap(),
            ForeignParent::Ready("wayland:opaque/a:b")
        );
        handle.accept("later".into());
        assert_eq!(
            handle.parent().unwrap(),
            ForeignParent::Ready("wayland:opaque/a:b")
        );
    }
    #[test]
    fn invalid_handle_stays_an_error_instead_of_empty_parent_fallback() {
        let mut handle = Handle::default();
        handle.accept(String::new());
        assert!(handle.parent().is_err());
        handle.accept("later".into());
        assert!(handle.parent().is_err());
    }
}
