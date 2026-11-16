// SPDX-License-Identifier: LGPL-3.0-or-later
//! CPU probe, not a compositor FPS test. Prints one JSON record per sampled owner turn.
//! NK_SETTINGS_DATA=... cargo run -p nk-view --example long-list-cost > costs.jsonl
use nk_platform::{exports::Exports, portal::Appearance};
use nk_text::{FontSet, ParleyBackend};
use nk_view::*;
use std::{
    cell::Cell,
    sync::Arc,
    time::{Duration, Instant},
};
struct Source<'a> {
    types: &'a TypeScale,
    built: Cell<usize>,
    items: Cell<usize>,
}
impl ListSource for Source<'_> {
    fn item(&self, index: usize) -> RowInfo {
        self.items.set(self.items.get() + 1);
        RowInfo {
            key: format!("record-{index}").into(),
            name: format!("Record {}", index + 1),
        }
    }
    fn build(&self, index: usize, key: &Key) -> Node {
        self.built.set(self.built.get() + 1);
        Node::text(
            format!("{}/label", key.0),
            format!("Record {}", index + 1),
            self.types.style(Type::Body, Weight::Regular),
        )
    }
}
fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.
}
fn main() -> Result<(), String> {
    let exports = Exports::load(&Exports::root())?;
    let appearance = Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "translucent".into(),
        reduced_motion: true,
        font: "Noto Sans 11".into(),
        text_scale: 1.,
    };
    let look = WindowLook::load(&exports, &appearance)?;
    let mut backend = ParleyBackend::with_system_fonts(Arc::new(FontSet::discover_required()?))?;
    for scale in [1., 1.25] {
        let mut state = ViewState::new(100);
        state.set_reduced_motion(true);
        state.set_slides(false);
        state.set_profile(true);
        let source = Source {
            types: &look.types,
            built: Cell::new(0),
            items: Cell::new(0),
        };
        let height = look.tokens.row_height;
        let mut selected = 0;
        // Cold start, then independent scroll and selection turns with repeated range boundaries.
        for sample in 0..241 {
            let start = Instant::now();
            let mode = if sample == 0 {
                "cold"
            } else if sample <= 120 {
                "scroll"
            } else {
                "selection"
            };
            if mode == "scroll" {
                state.scroll_region(
                    &LongList::scroll_key(&"records".into()),
                    ScrollBy::Pixels(height * 0.75),
                );
            }
            if mode == "selection" {
                state.request(&"records".into(), false);
                let k = if sample % 30 == 1 {
                    KeyInput::End
                } else if sample % 30 == 2 {
                    KeyInput::Home
                } else {
                    KeyInput::Down
                };
                if let Some(a) = state.key(k)
                    && let Some(Value::Index(i)) = a.value
                {
                    selected = i;
                }
            }
            source.built.set(0);
            source.items.set(0);
            let (mut build, mut expansion, mut layout) =
                (Duration::ZERO, Duration::ZERO, Duration::ZERO);
            let shaped_before = state.text().shaped;
            let mut passes = 0;
            loop {
                let b = Instant::now();
                let node = LongList::new(5000, selected, height).node(
                    "records",
                    "Records",
                    "select",
                    state.window(&LongList::scroll_key(&"records".into())),
                    &source,
                );
                build += b.elapsed();
                state.layout(
                    &node,
                    (960., 576.),
                    scale,
                    look.tokens.with_types(&look.types),
                    &mut backend,
                    Instant::now(),
                );
                if !state.component_errors().is_empty() {
                    return Err(format!("{:?}", state.component_errors()));
                }
                let m = state.layout_metrics();
                expansion += m.expansion;
                layout += m.layout;
                passes += 1;
                let requests = state.take_host_requests();
                if requests.is_empty() {
                    break;
                }
                if passes > 8 {
                    return Err("range failed to converge".into());
                }
            }
            let p = Instant::now();
            let mut canvas =
                nk_render::Canvas::new((960. * scale) as u16, (576. * scale) as u16, scale);
            state.paint(
                &mut canvas,
                look.tokens.with_types(&look.types),
                &mut |_, _| None,
                None,
            )?;
            let bytes = canvas.finish();
            std::hint::black_box(bytes);
            let paint = p.elapsed();
            println!(
                "{}",
                serde_json::json!({"scale":scale,"sample":sample,"mode":mode,"build_ms":ms(build),"expansion_ms":ms(expansion),"layout_ms":ms(layout),"paint_ms":ms(paint),"total_ms":ms(start.elapsed()),"shaped":state.text().shaped-shaped_before,"rows_built":source.built.get(),"metadata":source.items.get(),"nodes":state.placed().len(),"passes":passes})
            );
        }
    }
    Ok(())
}
