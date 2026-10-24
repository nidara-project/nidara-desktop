// SPDX-License-Identifier: LGPL-3.0-or-later
//! Mounted wallpaper chooser. The transport never writes; guarded completion uses Cx.apply.
use crate::{
    Value,
    file_chooser::{Chooser, Open, Operation, StartError},
    manifest::Item,
    render::{Builder, Builders, Built, Cx, Result, failure},
    session::Notice,
};
use nk_widgets::{Effect, Kind, NodeId};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
const KEY: &str = "wallpaper.current";
pub fn register(builders: &mut Builders) {
    builders.register("wallpaperPicker", || Box::new(Picker::default()));
}
struct Pending {
    operation: Operation,
    epoch: u64,
    value: String,
}
#[derive(Default)]
pub struct Picker {
    row: NodeId,
    button: NodeId,
    mount: u64,
    alive: bool,
    visible: bool,
    subtitle: Option<String>,
    error: Option<String>,
    pending: Option<Pending>,
    chooser: Chooser,
}
impl Picker {
    fn current(&self, cx: &Cx<'_>) -> Result<String> {
        cx.session()
            .shown(KEY)
            .and_then(Value::as_text)
            .map(str::to_owned)
            .ok_or("wallpaper.current has no string value".into())
    }
    fn eligible(&self, cx: &Cx<'_>) -> bool {
        self.alive
            && self.visible
            && self.mount == cx.mount()
            && cx.session().available()
            && cx.tree.node(self.button).is_some()
            && cx
                .tree
                .semantics()
                .nodes
                .get(&self.row)
                .is_some_and(|n| !n.states.disabled && !n.states.hidden)
            && cx
                .session()
                .store()
                .and_then(|s| s.key(KEY))
                .is_some_and(|k| k.available && k.writable())
    }
    fn valid(&self, cx: &Cx<'_>) -> bool {
        self.eligible(cx)
            && self.pending.as_ref().is_some_and(|p| {
                cx.session().store().is_some_and(|s| s.epoch == p.epoch)
                    && self.current(cx).ok().as_ref() == Some(&p.value)
            })
    }
    fn show(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        let line = self.error.as_ref().or(self.subtitle.as_ref());
        if let Some(id) = cx.tree.set_subtitle(self.row, line.map(String::as_str))? {
            cx.own(id);
        }
        let current = cx
            .session()
            .shown(KEY)
            .and_then(Value::as_text)
            .unwrap_or("");
        let description =
            line.map_or_else(|| current.to_owned(), |line| format!("{current}\n{line}"));
        cx.tree.set_button_description(self.button, &description)
    }
    fn retire(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        self.pending = None;
        self.chooser.cancel();
        if cx.tree.node(self.button).is_some() {
            cx.tree.set_disabled(self.button, false)?;
        }
        Ok(())
    }
    fn finish(
        &mut self,
        cx: &mut Cx<'_>,
        operation: Operation,
        result: Result<Option<PathBuf>>,
    ) -> Result<()> {
        if self
            .pending
            .as_ref()
            .is_none_or(|p| p.operation != operation)
        {
            return Ok(());
        }
        let valid = self.valid(cx);
        self.retire(cx)?;
        if !valid {
            return Ok(());
        }
        match result {
            Ok(Some(path)) => {
                let Some(selected) = path.to_str() else {
                    self.error = Some("selected wallpaper path is not UTF-8".into());
                    self.show(cx)?;
                    if self.eligible(cx) {
                        cx.focus_if_shown(self.button);
                    }
                    return Ok(());
                };
                if !path.is_absolute() {
                    self.error = Some("selected wallpaper path is not absolute".into());
                } else if self.current(cx)? != selected {
                    self.error = None;
                    self.error = cx
                        .apply(KEY, Value::Text(selected.into()))
                        .err()
                        .map(|e| failure(&e));
                }
            }
            Ok(None) => {}
            Err(error) => self.error = Some(error),
        }
        self.show(cx)?;
        if self.eligible(cx) {
            cx.focus_if_shown(self.button);
        }
        Ok(())
    }
}
impl Builder for Picker {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built> {
        let Item::Custom {
            name,
            i18n: Some(label),
            ..
        } = item
        else {
            return Err("wallpaper picker needs its labelled custom item".into());
        };
        if name != "wallpaperPicker" || item.key().is_some_and(|key| key != KEY) {
            return Err("wallpaper picker key/name mismatch".into());
        }
        let _ = cx
            .session()
            .store()
            .and_then(|s| s.key(KEY))
            .ok_or("wallpaper.current absent from snapshot")?;
        let (row, button) = cx.tree.row(group, cx.exports.text(label)?, Kind::Button)?;
        self.row = row;
        self.button = button;
        self.mount = cx.mount();
        self.alive = true;
        self.visible = true;
        self.subtitle = cx
            .exports
            .text(&format!("{label}.desc"))
            .ok()
            .map(str::to_owned);
        cx.tree
            .set_name(button, cx.exports.text("settings.appearance.browse")?)?;
        cx.own(row);
        cx.own(button);
        self.show(cx)?;
        Ok(Built {
            rows: vec![row],
            keys: vec![KEY.into()],
        })
    }
    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()> {
        self.retire(cx)?;
        match notice {
            Notice::Failed { error, .. } => self.error = Some(failure(error)),
            Notice::Ready | Notice::Changed(_) => self.error = None,
            _ => {}
        }
        self.show(cx)
    }
    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        if effect != Effect::Activated(self.button)
            || self.pending.is_some()
            || !self.eligible(cx)
            || cx
                .tree
                .semantics()
                .nodes
                .get(&self.button)
                .is_none_or(|n| n.states.disabled)
        {
            return Ok(());
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let request = loop {
            let current = NEXT.load(Ordering::Relaxed);
            let next = current
                .checked_add(1)
                .ok_or("wallpaper operation token exhausted")?;
            if NEXT
                .compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                break current;
            }
        };
        self.pending = Some(Pending {
            operation: Operation {
                mount: self.mount,
                request,
            },
            epoch: cx
                .session()
                .store()
                .ok_or("missing wallpaper snapshot")?
                .epoch,
            value: self.current(cx)?,
        });
        cx.tree.set_disabled(self.button, true)?;
        self.show(cx)
    }
    fn idle(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        let Some(operation) = self.pending.as_ref().map(|p| p.operation) else {
            return Ok(());
        };
        if !self.valid(cx) {
            return self.retire(cx);
        }
        if !self.chooser.pending() {
            let open = (|| -> Result<Option<Open>> {
                let window = cx
                    .window
                    .as_deref_mut()
                    .ok_or("wallpaper picker needs its real parent Window")?;
                let parent = match window.portal_parent()? {
                    nk_wayland::ForeignParent::Pending => return Ok(None),
                    nk_wayland::ForeignParent::Unsupported => String::new(),
                    nk_wayland::ForeignParent::Ready(handle) => handle.to_owned(),
                };
                Ok(Some(Open {
                    parent,
                    title: cx
                        .exports
                        .text("settings.appearance.dialog.wallpaper")?
                        .into(),
                    images_label: cx.exports.text("settings.appearance.filter.images")?.into(),
                    current_folder: std::env::var_os("HOME")
                        .map(PathBuf::from)
                        .filter(|p| p.is_absolute()),
                }))
            })();
            match open {
                Ok(None) => return Ok(()),
                Err(error) => return self.finish(cx, operation, Err(error)),
                Ok(Some(open)) => {
                    let Some(connection) = cx.connection() else {
                        return self.finish(
                            cx,
                            operation,
                            Err("wallpaper picker needs the Config1 connection".into()),
                        );
                    };
                    match self.chooser.start(connection, operation, open) {
                        Ok(()) => {}
                        Err(StartError::Busy) => return Ok(()),
                        Err(StartError::Failed(e)) => return self.finish(cx, operation, Err(e)),
                    }
                }
            }
        }
        if let Some(result) = self.chooser.poll(operation) {
            self.finish(cx, operation, result)?;
        }
        Ok(())
    }
    fn external_modal_active(&self) -> bool {
        self.pending.is_some()
    }
    fn shown(&mut self, cx: &mut Cx<'_>, visible: bool) -> Result<()> {
        self.visible = visible;
        if !visible {
            self.retire(cx)?;
        }
        Ok(())
    }
    fn unmount(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        self.alive = false;
        self.retire(cx)
    }
}

#[cfg(test)]
mod tests;
