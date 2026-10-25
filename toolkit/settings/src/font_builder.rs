// SPDX-License-Identifier: LGPL-3.0-or-later
//! The two controlled Config1 font rows share one builder and the real font chooser.
use crate::{
    Value,
    font_catalog::Operation,
    font_chooser::{Request, Selection},
    manifest::Item,
    render::{Builder, Builders, Built, Cx, Result, failure},
    session::Notice,
};
use nk_widgets::{Effect, Kind, NodeId};

pub fn register(builders: &mut Builders) {
    for name in ["interfaceFont", "monoFont"] {
        builders.register(name, || Box::new(Font::default()));
    }
}
#[derive(Default)]
pub struct Font {
    key: String,
    title: String,
    row: NodeId,
    button: NodeId,
    subtitle: Option<String>,
    error: Option<String>,
    mount: u64,
    alive: bool,
    visible: bool,
    scale: f64,
    line_height: f32,
}
impl Font {
    fn current(&self, cx: &Cx<'_>) -> Result<String> {
        cx.session()
            .shown(&self.key)
            .and_then(Value::as_text)
            .map(str::to_owned)
            .ok_or("font value is not a string".into())
    }
    fn editable(&self, cx: &Cx<'_>) -> bool {
        self.alive
            && self.visible
            && self.mount == cx.mount()
            && cx.session().available()
            && cx.tree.node(self.button).is_some()
            && !cx.tree.is_hidden(self.row)
            && cx
                .tree
                .semantics()
                .nodes
                .get(&self.button)
                .is_some_and(|n| !n.states.disabled && !n.states.hidden)
            && cx
                .session()
                .store()
                .and_then(|s| s.key(&self.key))
                .is_some_and(|k| k.available && k.writable())
    }
    fn show(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        let entry = cx
            .session()
            .store()
            .and_then(|s| s.key(&self.key))
            .ok_or("font key not in snapshot")?
            .clone();
        self.scale = cx.styles.text_scale;
        self.line_height = cx.styles.text.line_height;
        cx.tree.set_disabled(
            self.button,
            !cx.session().available() || !entry.available || !entry.writable(),
        )?;
        if !entry.available {
            return Ok(());
        }
        let value = self.current(cx)?;
        cx.tree.set_name(self.button, &value)?;
        let caption =
            crate::styles::font_style(&value, cx.styles.text_scale, cx.styles.text.line_height)
                .ok();
        cx.tree.set_button_text_style(self.button, caption)?;
        let line = self.error.as_ref().or(self.subtitle.as_ref());
        if let Some(id) = cx.tree.set_subtitle(self.row, line.map(String::as_str))? {
            cx.own(id);
        }
        let description = line.map_or_else(|| value.clone(), |line| format!("{value}\n{line}"));
        cx.tree.set_button_description(self.button, &description)?;
        Ok(())
    }
    fn accept(&mut self, cx: &mut Cx<'_>, selected: Selection) -> Result<()> {
        if !self.editable(cx) {
            return Ok(());
        }
        let value = selected.canonical()?;
        let normalized = Selection::parse(&value)?;
        if Selection::parse(&self.current(cx)?).ok() == Some(normalized) {
            return Ok(());
        }
        self.error = None;
        if let Err(error) = cx.apply(&self.key, Value::Text(value)) {
            self.error = Some(failure(&error));
        }
        self.show(cx)
    }
}
impl Builder for Font {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built> {
        let Item::Custom {
            name,
            i18n: Some(label),
            ..
        } = item
        else {
            return Err("font builder requires a labelled custom item".into());
        };
        let expected = match name.as_str() {
            "interfaceFont" => "appearance.interfaceFont",
            "monoFont" => "appearance.monoFont",
            _ => return Err("unknown font builder".into()),
        };
        if item.key().is_some_and(|key| key != expected) {
            return Err("font builder key disagrees with its manifest name".into());
        }
        let key = expected.to_owned();
        let title = cx.exports.text(label)?;
        self.title = title.to_owned();
        let (row, button) = cx.tree.row(group, title, Kind::Button)?;
        for id in [row, button] {
            cx.own(id);
        }
        self.key = key.clone();
        self.row = row;
        self.button = button;
        self.subtitle = cx
            .exports
            .text(&format!("{label}.desc"))
            .ok()
            .map(str::to_owned);
        self.mount = cx.mount();
        self.alive = true;
        self.visible = true;
        self.show(cx)?;
        Ok(Built {
            rows: vec![row],
            keys: vec![key],
        })
    }
    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()> {
        match notice {
            Notice::Failed { error, .. } => self.error = Some(failure(error)),
            Notice::Changed(_) | Notice::Ready => self.error = None,
            _ => {}
        }
        self.show(cx)
    }
    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        if effect != Effect::Activated(self.button) || !self.editable(cx) {
            return Ok(());
        }
        let result = (|| {
            let initial = Selection::parse(&self.current(cx)?)?;
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let request = loop {
                let current = NEXT.load(std::sync::atomic::Ordering::Relaxed);
                let next = current
                    .checked_add(1)
                    .ok_or("font request token exhausted")?;
                if NEXT
                    .compare_exchange_weak(
                        current,
                        next,
                        std::sync::atomic::Ordering::Relaxed,
                        std::sync::atomic::Ordering::Relaxed,
                    )
                    .is_ok()
                {
                    break current;
                }
            };
            cx.open_font(Request {
                title: self.title.clone(),
                launcher: self.button,
                operation: Operation {
                    mount: self.mount,
                    request,
                },
                initial,
            })
        })();
        match result {
            Ok(Some(choice)) => {
                if let Err(error) = self.accept(cx, choice) {
                    self.error = Some(error);
                }
            }
            Ok(None) => {}
            Err(error) => self.error = Some(error),
        }
        self.show(cx)
    }
    fn idle(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        if self.alive
            && self.mount == cx.mount()
            && (self.scale != cx.styles.text_scale
                || self.line_height != cx.styles.text.line_height)
        {
            self.show(cx)?;
        }
        Ok(())
    }
    fn shown(&mut self, _: &mut Cx<'_>, visible: bool) -> Result<()> {
        self.visible = visible;
        Ok(())
    }
    fn unmount(&mut self, _: &mut Cx<'_>) -> Result<()> {
        self.alive = false;
        Ok(())
    }
}
