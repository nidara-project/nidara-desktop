// SPDX-License-Identifier: LGPL-3.0-or-later
//! A controlled Dropdown popup using the application's single semantic provider.
use crate::{material::panel::PanelMaterial, styles::Styles};
use nk_a11y::bridge::Bridge;
use nk_text::{ParleyBackend, Point, Size};
use nk_wayland::{Application, Event, Frame, Material, Pane, PopupPlacement, Window};
use nk_widgets::{
    DropdownPopup, Effect, NodeId, PopupSnapshot, Result, Surface, Tree, window::Composition,
};

pub struct Host<'a> {
    pub tree: &'a mut Tree,
    pub window: &'a mut Window,
    pub text: &'a mut ParleyBackend,
    pub styles: &'a Styles,
    pub bridge: &'a Bridge,
    /// Updated to the restored parent publication before returning to its request loop.
    pub revision: &'a mut u64,
    pub panel: Option<&'a PanelMaterial>,
    pub serial: Option<u32>,
    pub poll_interval_ms: u32,
    /// Stage external notices; false cancels before the caller applies them to the Tree.
    pub keep_open: &'a mut dyn FnMut() -> Result<bool>,
}
struct Menu<'a, 'parent> {
    popup: &'a mut DropdownPopup<'parent>,
    text: &'a mut ParleyBackend,
    styles: &'a Styles,
    bridge: &'a Bridge,
    panel: Option<&'a PanelMaterial>,
    material: Option<Material>,
    input: Composition,
    revision: Option<u64>,
    selected: &'a mut Option<usize>,
    keep_open: &'a mut dyn FnMut() -> Result<bool>,
    poll_interval_ms: u32,
}
impl Menu<'_, '_> {
    fn live(&mut self, w: &mut Window) -> Result<bool> {
        self.bridge.check()?;
        if !(self.keep_open)()? {
            *self.selected = None;
            self.popup.invalidate();
            w.close();
            return Ok(false);
        }
        Ok(true)
    }
    fn effect(&mut self, effect: Effect, w: &mut Window) {
        if let Effect::Activated(id) = effect {
            *self.selected = self.popup.index(id);
            w.close();
        }
    }
    fn publish(&mut self, w: &mut Window) -> Result<()> {
        if let Some([x, y, _, _]) = w.popup_geometry() {
            let snapshot = self.popup.snapshot(Point {
                x: x as f32,
                y: y as f32,
            })?;
            self.bridge.update(snapshot.revision, snapshot.tree)?;
            self.revision = Some(snapshot.revision);
            self.popup.menu_mut().acknowledge_semantics();
        }
        Ok(())
    }
    fn layout(&mut self, w: &Window) -> Result<()> {
        let (width, height) = w.size();
        self.popup.menu_mut().layout(
            Size {
                width: width as f32,
                height: height as f32,
            },
            false,
            self.text,
        )?;
        Ok(())
    }
}
impl Application for Menu<'_, '_> {
    fn poll_interval_ms(&self) -> u32 {
        self.poll_interval_ms
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        if !self.live(w)? {
            return Ok(());
        }
        while let Ok((revision, request)) = self.bridge.requests.try_recv() {
            if Some(revision) != self.revision {
                continue;
            }
            if let Ok(effect) = self.popup.request(revision, request) {
                let activated = matches!(effect, Effect::Activated(_));
                self.effect(effect, w);
                if activated {
                    return Ok(());
                }
            }
        }
        self.layout(w)?;
        if self.popup.menu().invalidation().semantics {
            self.publish(w)?;
        }
        if self.popup.menu().invalidation().paint {
            w.redraw();
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        if !self.live(w)? {
            return Ok(());
        }
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        if matches!(event, Event::PopupDone) || matches!(&event, Event::Key(k) if k.sym == 0xff1b) {
            *self.selected = None;
            w.close();
            return Ok(());
        }
        if matches!(event, Event::Configure) {
            let (width, height) = w.size();
            self.material = self
                .panel
                .map(|panel| panel.at(f64::from(width.min(height))))
                .transpose()?;
            if let Some(material) = &mut self.material {
                material.shapes = vec![Pane {
                    x: 0.,
                    y: 0.,
                    width: f64::from(width),
                    height: f64::from(height),
                    radius: f64::from(self.styles.menu.radius),
                    exponent: 2.,
                }];
            }
        }
        let effect = self.input.event(self.popup.menu_mut(), &event)?;
        let activated = matches!(effect, Effect::Activated(_));
        self.effect(effect, w);
        if activated {
            return Ok(());
        }
        self.layout(w)?;
        if matches!(event, Event::Configure) || self.popup.menu().invalidation().semantics {
            self.publish(w)?;
        }
        if self.popup.menu().invalidation().paint {
            w.redraw();
        }
        Ok(())
    }
    fn paint(&mut self, mut frame: Frame) -> Result<Vec<u8>> {
        frame.material &= self.material.is_some();
        self.popup
            .menu()
            .paint(frame, Surface::Content, self.styles.palette)
    }
    fn material(&self) -> Option<Material> {
        self.material.clone()
    }
    fn committed(&mut self, _: u64) {
        self.popup.menu_mut().acknowledge();
    }
}

pub fn show(host: Host<'_>, combo: NodeId) -> Result<Effect> {
    if !(host.keep_open)()? {
        return Ok(Effect::None);
    }
    let r = host.tree.node(combo).ok_or("unknown dropdown")?.bounds();
    if !host.tree.showing(combo) || host.poll_interval_ms == 0 {
        return Err("dropdown trigger is not showing or polling interval is zero".into());
    }
    let mut popup = DropdownPopup::new(host.tree, combo, host.styles.menu.clone())?;
    popup.menu_mut().layout(
        Size {
            width: r.width,
            height: host.window.size().1 as f32,
        },
        false,
        host.text,
    )?;
    let scroll = popup.menu().node(popup.menu().root()).unwrap().children()[0];
    let height = (popup.menu().node(scroll).unwrap().measured().height
        + 2. * host.styles.menu.border)
        .min(host.window.size().1 as f32)
        .ceil() as u32;
    let placement = PopupPlacement {
        anchor: [
            r.x.floor() as i32,
            r.y.floor() as i32,
            r.width.ceil() as i32,
            r.height.ceil() as i32,
        ],
        size: (r.width.ceil() as u32, height),
    };
    let mut selected = None;
    let result = nk_wayland::run_popup(
        Menu {
            popup: &mut popup,
            text: host.text,
            styles: host.styles,
            bridge: host.bridge,
            panel: host.panel,
            material: None,
            input: Default::default(),
            revision: None,
            selected: &mut selected,
            keep_open: host.keep_open,
            poll_interval_ms: host.poll_interval_ms,
        },
        host.window,
        placement,
        host.serial,
    );
    let live = if result.is_ok() {
        (host.keep_open)()
    } else {
        Ok(false)
    };
    if !live.as_ref().is_ok_and(|v| *v) {
        popup.invalidate();
    }
    let effect = popup.finish(if live.as_ref().is_ok_and(|v| *v) {
        selected
    } else {
        None
    });
    let restored = PopupSnapshot::new(host.tree.semantics())?;
    host.bridge.update(restored.revision, restored.tree)?;
    *host.revision = restored.revision;
    host.window.redraw();
    result?;
    live?;
    effect
}

/// Production renderer context. The app delivers `notices` after the modal returns.
pub struct Native {
    pub bridge: Bridge,
    pub font: Option<crate::font_chooser::Configuration>,
    pub revision: u64,
    pub text: ParleyBackend,
    pub panel: Option<PanelMaterial>,
    pub serial: Option<u32>,
    pub poll_interval_ms: u32,
    pub notices: Vec<crate::session::Notice>,
    /// Owns/stages portal/routing/visibility changes without touching the borrowed Tree.
    pub keep_open: Box<dyn FnMut() -> Result<bool>>,
}
impl crate::render::Modal for Native {
    fn font(
        &mut self,
        tree: &mut Tree,
        window: Option<&mut Window>,
        styles: &Styles,
        editor: &mut dyn crate::render::Editor,
        request: crate::font_chooser::Request,
    ) -> Result<Option<crate::font_chooser::Selection>> {
        let window = window.ok_or("font chooser requires its real parent window")?;
        let config = self
            .font
            .as_mut()
            .ok_or("native font configuration missing")?;
        let mut keep_open = || {
            crate::render::stage_modal_notices(editor, &mut self.notices, self.keep_open.as_mut())
        };
        let selected = crate::font_chooser::choose(
            crate::font_chooser::Host {
                tree,
                window,
                fonts: config.fonts.clone(),
                styles,
                bridge: &self.bridge,
                revision: &mut self.revision,
                panel: self.panel.as_ref(),
                operation: request.operation,
                poll_interval_ms: self.poll_interval_ms,
                size: config.size,
                list_height: config.list_height,
                point_range: config.point_range.clone(),
                text_scale: styles.text_scale as f32,
                labels: config.labels.borrowed(&request.title),
                prepare: config.prepare.as_mut(),
                keep_open: &mut keep_open,
            },
            request.launcher,
            request.initial,
        )?;
        if let Some(choice) = &selected
            && !self.text.family_available(&choice.family)
        {
            return Err(format!(
                "font family unavailable to the renderer: {}",
                choice.family
            ));
        }
        Ok(selected)
    }
    fn dropdown(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        styles: &Styles,
        editor: &mut dyn crate::render::Editor,
        combo: NodeId,
    ) -> Result<Effect> {
        let mut keep_open = || {
            crate::render::stage_modal_notices(editor, &mut self.notices, self.keep_open.as_mut())
        };
        show(
            Host {
                tree,
                window,
                text: &mut self.text,
                styles,
                bridge: &self.bridge,
                revision: &mut self.revision,
                panel: self.panel.as_ref(),
                serial: self.serial,
                poll_interval_ms: self.poll_interval_ms,
                keep_open: &mut keep_open,
            },
            combo,
        )
    }
}
