// SPDX-License-Identifier: LGPL-3.0-or-later
//! Dialog samples use the public host; the app owns only its draft and responses.
use super::*;
use nk_view::{
    Alert, Dialog, DialogAnswer, DialogButton, DialogContent, DialogUpdate, Key, ListSource,
    LongList, Node, RowInfo, Space, Type, Value, Weight,
};
fn button(id: &str, label: &str, default: bool, cancel: bool, destructive: bool) -> DialogButton {
    DialogButton {
        id: id.into(),
        label: label.into(),
        default,
        cancel,
        destructive,
        enabled: true,
    }
}
fn appearance(portal: &Portal, exports: &Exports) -> Result<DialogUpdate> {
    Ok(if portal.changed() {
        let a = portal.read()?;
        DialogUpdate {
            appearance: Some((WindowLook::load(exports, &a)?, a.reduced_motion)),
            ..Default::default()
        }
    } else {
        DialogUpdate::default()
    })
}
struct Rows<'a>(&'a nk_view::TypeScale);
impl ListSource for Rows<'_> {
    fn item(&self, index: usize) -> RowInfo {
        RowInfo {
            key: format!("choice-{index}").into(),
            name: format!("Choice {}", index + 1),
        }
    }
    fn build(&self, index: usize, key: &Key) -> Node {
        Node::text(
            format!("{}/label", key.0),
            format!("Choice {}", index + 1),
            self.0.style(Type::Body, Weight::Regular),
        )
    }
}
struct Draft<'a> {
    portal: &'a Portal,
    exports: &'a Exports,
    text: String,
    selected: usize,
    opened: u32,
}
impl DialogContent for Draft<'_> {
    fn content(&mut self, host: &AppWindow) -> Node {
        let look = host.look();
        let source = Rows(&look.types);
        let mut list = LongList::new(5000, self.selected, look.tokens.row_height);
        list.activate = Some("draft-open".into());
        Node::column(
            "draft/content",
            vec![
                nk_view::components::EditableField::new(self.text.clone()).node(
                    "draft/name",
                    "Name",
                    "draft-name",
                ),
                list.node(
                    "draft/list",
                    "Dialog choices",
                    "draft-select",
                    host.scroll_window(&LongList::scroll_key(&"draft/list".into())),
                    &source,
                )
                .height(look.tokens.row_height * 4.),
                Node::text(
                    "draft/opened",
                    format!("Rows opened: {}", self.opened),
                    look.types.style(Type::Small, Weight::Regular),
                ),
            ],
        )
        .gap(Space::S3)
    }
    fn activated(&mut self, a: Activated) -> Result<()> {
        match (a.action.as_str(), a.value) {
            ("draft-name", Some(Value::Text(text))) => self.text = text,
            ("draft-select", Some(Value::Index(index))) => self.selected = index,
            ("draft-open", _) => self.opened += 1,
            _ => {}
        }
        Ok(())
    }
    fn poll(&mut self) -> Result<DialogUpdate> {
        appearance(self.portal, self.exports)
    }
}
impl Gallery {
    pub(super) fn open_modal(
        &mut self,
        window: &mut Window,
        launcher: Key,
        kind: &str,
    ) -> Result<()> {
        let (model, catalogue, colors, at, history_len) = (
            &self.model,
            &self.catalogue,
            &self.colors,
            self.at,
            self.history.len(),
        );
        let parent = |host: &AppWindow| Self::page(host, model, catalogue, colors, at, history_len);
        let cancel = button("cancel", "Cancel", false, true, false);
        let result = match kind {
            "dialog-open" => {
                let mut draft = Draft {
                    portal: &self.portal,
                    exports: &self.exports,
                    text: "Nidara".into(),
                    selected: 0,
                    opened: 0,
                };
                self.window.run_dialog(
                    window,
                    &launcher,
                    Dialog {
                        title: "Edit sample".into(),
                        close_label: "Close".into(),
                        buttons: vec![button("save", "Save", true, false, false), cancel],
                    },
                    &mut draft,
                    parent,
                )
            }
            "alert-open" => self.window.run_alert(
                window,
                &launcher,
                Alert {
                    title: "Continue?".into(),
                    message: "Continue with this sample?".into(),
                    detail: Some("The parent stays unavailable until this alert closes.".into()),
                    buttons: vec![button("continue", "Continue", true, false, false), cancel],
                },
                || appearance(&self.portal, &self.exports),
                parent,
            ),
            "alert-delete" => self.window.run_alert(
                window,
                &launcher,
                Alert {
                    title: "Delete sample?".into(),
                    message: "Delete this sample?".into(),
                    detail: Some("This is a gallery response; no files are deleted.".into()),
                    buttons: vec![button("delete", "Delete", false, false, true), cancel],
                },
                || appearance(&self.portal, &self.exports),
                parent,
            ),
            "dialog-invalid" => {
                let mut draft = Draft {
                    portal: &self.portal,
                    exports: &self.exports,
                    text: "Invalid".into(),
                    selected: 0,
                    opened: 0,
                };
                self.window.run_dialog(
                    window,
                    &launcher,
                    Dialog {
                        title: "Invalid response".into(),
                        close_label: "Close".into(),
                        buttons: vec![button("delete", "Delete", true, false, true), cancel],
                    },
                    &mut draft,
                    parent,
                )
            }
            _ => return Err("unknown dialog sample".into()),
        };
        self.model.modal_result = match result {
            Ok(DialogAnswer::Button(id)) => id,
            Ok(DialogAnswer::Cancel) => "cancel".into(),
            Err(error) if kind == "dialog-invalid" => format!("Rejected: {error}"),
            Err(error) => return Err(error),
        };
        self.model.modal_answers += 1;
        eprintln!("DIALOG_RESULT {}", self.model.modal_result);
        self.rebuild();
        let (model, catalogue, colors, at, history_len) = (
            &self.model,
            &self.catalogue,
            &self.colors,
            self.at,
            self.history.len(),
        );
        self.window.commit(window, |host| {
            Self::page(host, model, catalogue, colors, at, history_len)
        })
    }
}
