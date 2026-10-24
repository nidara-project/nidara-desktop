// SPDX-License-Identifier: LGPL-3.0-or-later
//! Manifest wallpaper decorations over the authoritative Config1 catalogue.
use crate::{
    Value,
    exports::{Exports, Tokens},
    image_load::{Budget, Load, Operation, Request, StartError},
    manifest::Item,
    render::{Builder, Builders, Built, Cx, Result, failure},
    session::Notice,
    styles::{colour, number},
};
use nk_render::ImageFit;
use nk_text::Size;
use nk_widgets::{Effect, ImageStyle, Kind, NodeId, ThumbnailStyle};
use std::{collections::BTreeSet, path::PathBuf};
const KEY: &str = "wallpaper.current";
#[derive(Clone, Copy)]
pub struct Look {
    pub preview: Size,
    pub preview_image: ImageStyle,
    pub thumbnails: ThumbnailStyle,
    pub preview_decode: (u16, u16),
    pub thumbnail_decode: (u16, u16),
}
impl Look {
    pub(crate) fn load(exports: &Exports, tokens: &Tokens<'_>) -> Result<Self> {
        let w = &tokens.components["wallpaper"];
        let n = |k| -> Result<f32> {
            let v = number(&w[k])?;
            if v.is_finite() && v > 0. {
                Ok(v)
            } else {
                Err(format!("invalid wallpaper {k}"))
            }
        };
        let c = |k| {
            colour(
                tokens,
                w[k].as_str()
                    .ok_or_else(|| format!("missing wallpaper {k}"))?,
            )
        };
        let radius = |k| {
            number(
                &exports.statics["ts"]["RADIUS"]
                    [w[k].as_str().ok_or("missing wallpaper radius")?],
            )
        };
        let image = |radius, border_width| -> Result<ImageStyle> {
            Ok(ImageStyle {
                fit: ImageFit::Cover,
                radius,
                border_width,
                border: c("pictureBorderColor")?,
                background: c("background")?,
            })
        };
        let decode = |a, b| -> Result<(u16, u16)> {
            let a = n(a)?;
            let b = n(b)?;
            if a.fract() != 0. || b.fract() != 0. || a > u16::MAX as f32 || b > u16::MAX as f32 {
                return Err("invalid wallpaper decode size".into());
            }
            Ok((a as u16, b as u16))
        };
        let r = radius("thumbnailRadius")?;
        let inner = r - n("thumbnailInnerInset")?;
        if inner < 0. {
            return Err("negative wallpaper picture radius".into());
        }
        Ok(Self {
            preview: Size {
                width: n("previewWidth")?,
                height: n("previewHeight")?,
            },
            preview_image: image(radius("previewRadius")?, n("previewBorder")?)?,
            thumbnails: ThumbnailStyle {
                picture: Size {
                    width: n("thumbnailWidth")?,
                    height: n("thumbnailHeight")?,
                },
                image: image(inner, n("pictureBorder")?)?,
                padding: n("padding")?,
                border: n("thumbnailBorder")?,
                radius: r,
                gap: n("gap")?,
                background: c("background")?,
                idle_border: c("idleBorder")?,
                hover_border: c("hoverBorder")?,
                selected_border: c("selectedBorder")?,
            },
            preview_decode: decode("previewDecodeWidth", "previewDecodeHeight")?,
            thumbnail_decode: decode("thumbnailDecodeWidth", "thumbnailDecodeHeight")?,
        })
    }
}
/// Host memory policy; no decode occurs at registration/build time.
pub fn register(builders: &mut Builders, budget: Budget) {
    builders.register("wallpaperPreview", move || {
        Box::new(Wallpaper::new(false, budget))
    });
    builders.register("wallpaperGallery", move || {
        Box::new(Wallpaper::new(true, budget))
    });
}
struct Picture {
    id: NodeId,
    path: String,
    load: Load,
    operation: Operation,
    done: bool,
}
struct Wallpaper {
    gallery: bool,
    budget: Budget,
    root: NodeId,
    error_row: NodeId,
    error_text: NodeId,
    pictures: Vec<Picture>,
    request: u64,
    error: Option<String>,
    shown: bool,
    current: String,
}
impl Wallpaper {
    fn new(gallery: bool, budget: Budget) -> Self {
        Self {
            gallery,
            budget,
            root: 0,
            error_row: 0,
            error_text: 0,
            pictures: Vec::new(),
            request: 0,
            error: None,
            shown: true,
            current: String::new(),
        }
    }
    fn picture(&mut self, id: NodeId, path: String, mount: u64) -> Result<Picture> {
        self.request = self
            .request
            .checked_add(1)
            .ok_or("wallpaper request exhausted")?;
        Ok(Picture {
            id,
            path,
            load: Load::default(),
            operation: Operation {
                mount,
                request: self.request,
            },
            done: false,
        })
    }
    fn reconcile(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        let entry = cx
            .session()
            .store()
            .and_then(|s| s.key(KEY))
            .ok_or("wallpaper.current absent from snapshot")?;
        if !entry.available {
            self.cancel();
            return Ok(());
        }
        let current = cx
            .session()
            .shown(KEY)
            .and_then(Value::as_text)
            .unwrap_or("")
            .to_owned();
        let desired: Vec<String> = if self.gallery {
            let mut seen = BTreeSet::new();
            entry.entry["catalogue"]
                .as_array()
                .ok_or("wallpaper catalogue missing")?
                .iter()
                .map(|p| {
                    let p = p.as_str().ok_or("wallpaper catalogue path is not text")?;
                    if !PathBuf::from(p).is_absolute() || !seen.insert(p.to_owned()) {
                        return Err("invalid or duplicate wallpaper catalogue path".to_owned());
                    }
                    Ok(p.to_owned())
                })
                .collect::<Result<_>>()?
        } else {
            vec![current.clone()]
        };
        if self.gallery {
            for i in (0..self.pictures.len()).rev() {
                if !desired.contains(&self.pictures[i].path) {
                    let p = self.pictures.remove(i);
                    cx.remove(p.id)?;
                }
            }
            for path in &desired {
                if !self.pictures.iter().any(|p| &p.path == path) {
                    let id = cx.tree.thumbnail_option(self.root, path, false)?;
                    cx.own(id);
                    let p = self.picture(id, path.clone(), cx.mount())?;
                    self.pictures.push(p);
                }
            }
            let order = desired
                .iter()
                .map(|path| self.pictures.iter().find(|p| &p.path == path).unwrap().id)
                .collect::<Vec<_>>();
            cx.tree.reorder_thumbnails(self.root, &order)?;
            let selected = self
                .pictures
                .iter()
                .find(|p| p.path == current)
                .map(|p| p.id);
            cx.tree.set_thumbnail_selected(self.root, selected)?;
            cx.tree
                .set_thumbnail_style(self.root, cx.styles.wallpaper.thumbnails)?;
        } else {
            cx.tree
                .set_image_style(self.root, cx.styles.wallpaper.preview_image)?;
            cx.tree
                .set_image_size(self.root, cx.styles.wallpaper.preview)?;
            if self.pictures.first().is_none_or(|p| p.path != current) {
                self.pictures.clear();
                cx.tree.set_image(self.root, None)?;
                let p = self.picture(self.root, current.clone(), cx.mount())?;
                self.pictures.push(p);
            }
            let title = cx.exports.text("settings.appearance.group.wallpaper")?;
            cx.tree.set_name(self.root, format!("{title}: {current}"))?;
        }
        self.current = current;
        Ok(())
    }
    fn error(&mut self, cx: &mut Cx<'_>, error: Option<String>) -> Result<()> {
        self.error = error;
        cx.tree
            .set_name(self.error_text, self.error.as_deref().unwrap_or(""))
    }
    fn cancel(&mut self) {
        for p in &mut self.pictures {
            p.load.cancel();
        }
    }
}
impl Builder for Wallpaper {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, _item: &Item) -> Result<Built> {
        let title = cx.exports.text("settings.appearance.group.wallpaper")?;
        self.root = if self.gallery {
            cx.tree
                .thumbnail_strip(group, title, cx.styles.wallpaper.thumbnails)?
        } else {
            cx.tree.image(
                group,
                title,
                cx.styles.wallpaper.preview,
                cx.styles.wallpaper.preview_image,
            )?
        };
        self.error_row = cx.tree.append(group, Kind::Row, "")?;
        self.error_text = cx.tree.append(self.error_row, Kind::Label, "")?;
        cx.own(self.error_text);
        cx.own(self.root);
        cx.own(self.error_row);
        self.reconcile(cx)?;
        Ok(Built {
            rows: vec![self.root, self.error_row],
            keys: vec![KEY.into()],
        })
    }
    fn row_visible(&self, row: NodeId) -> bool {
        if row == self.error_row {
            self.error.is_some()
        } else {
            !self.gallery || !self.pictures.is_empty()
        }
    }
    fn shown(&mut self, _cx: &mut Cx<'_>, shown: bool) -> Result<()> {
        self.shown = shown;
        if !shown {
            self.cancel();
        }
        Ok(())
    }
    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()> {
        self.reconcile(cx)?;
        let error = if let Notice::Failed { error, .. } = notice {
            Some(failure(error))
        } else {
            None
        };
        self.error(cx, error)?;
        if !cx.session().available() {
            self.cancel();
        }
        Ok(())
    }
    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        let Effect::Activated(id) = effect else {
            return Ok(());
        };
        if !self.gallery || !self.shown || !cx.session().available() || cx.tree.is_hidden(id) {
            return Ok(());
        }
        let Some(p) = self.pictures.iter().find(|p| p.id == id) else {
            return Ok(());
        };
        let value = Value::Text(p.path.clone());
        if cx.session().shown(KEY) == Some(&value) {
            return Ok(());
        }
        let allowed = cx
            .session()
            .store()
            .and_then(|s| s.key(KEY))
            .is_some_and(|k| k.available && k.writable())
            && cx
                .tree
                .semantics()
                .nodes
                .get(&id)
                .is_some_and(|n| !n.states.disabled && !n.states.hidden);
        if !allowed {
            return Ok(());
        }
        let error = cx.apply(KEY, value).err().map(|e| failure(&e));
        self.reconcile(cx)?;
        self.error(cx, error)
    }
    fn idle(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        if !self.shown || !cx.session().available() {
            self.cancel();
            return Ok(());
        }
        if cx
            .session()
            .shown(KEY)
            .and_then(Value::as_text)
            .unwrap_or("")
            != self.current
        {
            self.reconcile(cx)?;
        }
        let look = cx.styles.wallpaper;
        let size = if self.gallery {
            look.thumbnail_decode
        } else {
            look.preview_decode
        };
        let mut error = None;
        for p in &mut self.pictures {
            if cx.tree.node(p.id).is_none() || !cx.tree.showing(p.id) {
                p.load.cancel();
                continue;
            }
            if let Some(result) = p.load.poll(p.operation) {
                p.done = true;
                match result {
                    Ok(raster) => cx.tree.set_image(p.id, Some(raster))?,
                    Err(e) => error = Some(format!("{}: {e}", p.path)),
                }
            }
            if !p.done && !p.load.pending() && !p.path.is_empty() {
                match p.load.start(
                    p.operation,
                    Request {
                        path: PathBuf::from(&p.path),
                        size,
                        fit: ImageFit::Cover,
                        budget: self.budget,
                    },
                ) {
                    Ok(()) | Err(StartError::Busy) => {}
                    Err(StartError::Failed(e)) => {
                        p.done = true;
                        error = Some(format!("{}: {e}", p.path));
                    }
                }
            }
        }
        if error.is_some() {
            self.error(cx, error)?;
        }
        Ok(())
    }
    fn unmount(&mut self, _cx: &mut Cx<'_>) -> Result<()> {
        self.cancel();
        self.pictures.clear();
        Ok(())
    }
}
