// SPDX-License-Identifier: LGPL-3.0-or-later
//! Dialog samples use the public host; the app owns only its draft and responses.
use super::*;
use nk::{
    Alert, Dialog, DialogAnswer, DialogButton, DialogContent, DialogUpdate, Key, ListSource, Node,
    RowInfo, Space, Type, Value, Weight,
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
struct Rows<'a>(&'a nk::TypeScale);
impl ListSource for Rows<'_> {
    fn item(&self, index: usize) -> RowInfo {
        RowInfo {
            key: format!("choice-{index}").into(),
            name: format!("Choice {}", index + 1),
        }
    }
    fn build(&self, index: usize, key: &Key) -> Node {
        nk::Label::new(
            format!("{}/label", key.0),
            format!("Choice {}", index + 1),
            self.0.style(Type::Body, Weight::Regular),
        )
        .into()
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
        nk::Column::new(
            "draft/content",
            vec![
                nk::Entry::new("draft/name", "Name", "draft-name", self.text.clone()).into(),
                nk::ListView::new(
                    "draft/list",
                    "Dialog choices",
                    "draft-select",
                    &source,
                    5000,
                    self.selected,
                    look.tokens.row_height,
                )
                .window(host.scroll_window(&nk::ListView::scroll_key(&"draft/list".into())))
                .activate("draft-open")
                .height(look.tokens.row_height * 4.)
                .into(),
                nk::Label::new(
                    "draft/opened",
                    format!("Rows opened: {}", self.opened),
                    look.types.style(Type::Small, Weight::Regular),
                )
                .into(),
            ],
        )
        .gap(Space::S3)
        .into()
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
        let mut font_choice = None;
        let result = match kind {
            "font-open" => {
                font_choice = nk::FontDialog::new(model.font.clone()).choose(
                    &mut self.window,
                    window,
                    &launcher,
                    || appearance(&self.portal, &self.exports),
                    parent,
                )?;
                Ok(match &font_choice {
                    Some(font) => DialogAnswer::Button(font.caption()),
                    None => DialogAnswer::Cancel,
                })
            }
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
                    buttons: vec![
                        button("delete", "Delete", false, false, true),
                        button("keep", "Keep", false, false, false),
                    ],
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
        if let Some(font) = font_choice {
            self.model.font = font;
        }
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

struct SystemSample<'a> {
    portal: &'a Portal,
    exports: &'a Exports,
    name: Option<String>,
}

impl DialogContent for SystemSample<'_> {
    fn content(&mut self, _: &AppWindow) -> Node {
        match &self.name {
            Some(name) => {
                nk::Entry::new("system-sample/name", "Name", "sample-name", name.clone()).into()
            }
            None => nk::Spacer::new("system-sample/no-detail").into(),
        }
    }

    fn activated(&mut self, action: Activated) -> Result<()> {
        if action.action == "sample-name"
            && let Some(Value::Text(name)) = action.value
        {
            self.name = Some(name);
        }
        Ok(())
    }

    fn poll(&mut self) -> Result<DialogUpdate> {
        appearance(self.portal, self.exports)
    }
}

fn system_sample(alert: bool) -> Result<DialogAnswer> {
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let portal = Portal::watch(&bus)?;
    let exports = Exports::load(&Exports::root())?;
    let a = portal.read()?;
    let title = if alert {
        "System alert sample"
    } else {
        "System dialog sample"
    };
    let host = AppWindow::new(
        WindowLook::load(&exports, &a)?,
        Labels {
            show_sidebar: String::new(),
            hide_sidebar: String::new(),
            back: String::new(),
            forward: String::new(),
        },
        title,
        Box::new(ParleyBackend::with_system_fonts(Arc::new(
            FontSet::discover_required()?,
        ))?),
        Glyphs::new(icons()?),
        a.reduced_motion,
    );
    let options = Options {
        material: true,
        map: true,
        app_id: "nidara-kit-gallery",
        title,
        size: (440, 385),
        require_material: None,
    };
    let mut model = SystemSample {
        portal: &portal,
        exports: &exports,
        name: (!alert).then(String::new),
    };
    let buttons = vec![
        button("cancel", "Cancel", false, true, false),
        button("continue", "Continue", true, false, false),
    ];
    if alert {
        Alert {
            title: title.into(),
            message: "Continue with this sample?".into(),
            detail: None,
            buttons,
        }
        .run_parentless(host, options, None, &mut model)
    } else {
        Dialog {
            title: title.into(),
            close_label: "Close".into(),
            buttons,
        }
        .run_parentless(host, options, None, &mut model)
    }
}

impl Gallery {
    pub(super) fn open_system_dialog(&mut self, alert: bool) {
        if self.system_dialog.is_some() {
            return;
        }
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = send.send(system_sample(alert).map_err(|error| error.to_string()));
        });
        self.system_dialog = Some(receive);
    }

    pub(super) fn poll_system_dialog(&mut self) {
        use std::sync::mpsc::TryRecvError;
        let Some(receive) = &self.system_dialog else {
            return;
        };
        self.model.modal_result = match receive.try_recv() {
            Ok(Ok(DialogAnswer::Button(id))) => id,
            Ok(Ok(DialogAnswer::Cancel)) => "cancel".into(),
            Ok(Err(error)) => error,
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => "Sample closed".into(),
        };
        self.system_dialog = None;
        self.rebuild();
    }
}
