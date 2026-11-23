// SPDX-License-Identifier: LGPL-3.0-or-later
//! A time of day in one field, hours and minutes as its two parts (AppKit's `NSDatePicker`
//! in its hour-and-minute mode). One Tab stop: Left and Right pick the part, Up and Down
//! step it round the clock, digits type it (two for a part, or one that cannot start a
//! second, "7" for 07). Every change is reported at once as "HH:MM".
use super::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimeField {
    pub hour: u8,
    pub minute: u8,
    pub style: nk_text::TextStyle,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Segment {
    #[default]
    Hour,
    Minute,
}

#[derive(Default)]
struct State {
    segment: Segment,
    /// The first digit typed into the part, waiting for a second.
    typed: Option<u8>,
    /// The time set here until the app's next rebuild shows it.
    set: Option<(u8, u8)>,
}

/// "HH:MM" (24 h) as hours and minutes; None for anything else.
pub fn parse_time(text: &str) -> Option<(u8, u8)> {
    let (h, m) = text.trim().split_once(':')?;
    if h.len() > 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u8, u8) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

fn shown((h, m): (u8, u8)) -> String {
    format!("{h:02}:{m:02}")
}

impl TimeField {
    pub(crate) fn node(
        self,
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
    ) -> Node {
        let key = key.into();
        let mut n = Node::control(
            key.clone(),
            name,
            changed,
            Node::spacer(format!("{}/body", key.0)),
        )
        .role(crate::Role::Field);
        if let Kind::Control(c) = &mut n.kind {
            c.part = Some(Box::new(Part::Time(self)));
        }
        n
    }
    fn state(s: Option<&dyn Any>) -> Option<&State> {
        s?.downcast_ref::<State>()
    }
    fn current(&self, s: Option<&dyn Any>) -> (u8, u8) {
        Self::state(s)
            .and_then(|s| s.set)
            .unwrap_or((self.hour.min(23), self.minute.min(59)))
    }
    fn segment_rect(&self, cx: &Read<'_>) -> Option<Rect> {
        let part = match Self::state(cx.state).map(|s| s.segment).unwrap_or_default() {
            Segment::Hour => "hour",
            Segment::Minute => "minute",
        };
        cx.text(part).map(|(p, _)| p.rect)
    }
    /// The highlight behind the chosen part: its glyphs and a little room either side.
    fn highlight(&self, cx: &Read<'_>) -> Option<Rect> {
        let r = self.segment_rect(cx)?;
        let pad = cx.look.tokens.entry.border * 2.;
        Some([r[0] - pad, r[1], r[2] + 2. * pad, r[3]])
    }
    fn set(&self, cx: &mut Input<'_>, time: (u8, u8)) {
        let before = self.current(cx.state.as_deref());
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.set = Some(time);
        }
        cx.effects.handled = true;
        cx.effects.redraw = true;
        if time != before {
            cx.effects.value = Some(Value::Text(shown(time)));
            cx.effects.activate = true;
        }
    }
    fn choose(&self, cx: &mut Input<'_>, segment: Segment) {
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.segment = segment;
            s.typed = None;
        }
        cx.effects.handled = true;
        cx.effects.redraw = true;
    }
    fn digit(&self, cx: &mut Input<'_>, d: u8) {
        let (h, m) = self.current(cx.state.as_deref());
        let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        let (limit, segment) = match s.segment {
            Segment::Hour => (24, Segment::Hour),
            Segment::Minute => (60, Segment::Minute),
        };
        let (value, done) = match s.typed.take() {
            Some(first) if first * 10 + d < limit => (first * 10 + d, true),
            // A digit no second one can follow ("7" for an hour) is the whole part.
            _ => (d, d * 10 >= limit),
        };
        if !done {
            s.typed = Some(d);
        } else if segment == Segment::Hour {
            s.segment = Segment::Minute;
        }
        let time = match segment {
            Segment::Hour => (value, m),
            Segment::Minute => (h, value),
        };
        self.set(cx, time);
    }
}

impl Component for TimeField {
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let (h, m) = self.current(cx.state);
        Node::row(
            cx.key("parts"),
            vec![
                Node::text(cx.key("hour"), format!("{h:02}"), self.style.clone()),
                Node::text(cx.key("colon"), ":", self.style.clone()),
                Node::text(cx.key("minute"), format!("{m:02}"), self.style.clone()),
            ],
        )
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let s = &look.tokens.entry;
        FrameSpec {
            inset: (s.padding_x + s.border, s.border),
            least: (0., s.min_height),
            body: BodyPlacement::NaturalCentered,
        }
    }
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        Some(FocusOutline::rounded(
            cx.rect,
            cx.look.tokens.entry.radius.min(cx.rect[3] / 2.),
        ))
    }
    fn reconcile(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.set = None;
        }
    }
    fn blur(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.typed = None;
        }
    }
    fn value(&self, state: Option<&dyn Any>) -> Option<Value> {
        Some(Value::Text(shown(self.current(state))))
    }
    fn press(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        cx.effects.focus = true;
        cx.effects.handled = true;
        let minute = cx
            .context
            .and_then(|read| read.text("minute").map(|(p, _)| p.rect[0]));
        let segment = match minute {
            // Left of the minutes' first glyph (the colon included) is the hour.
            Some(x) if at.0 >= x - cx.context.map_or(0., |r| r.look.tokens.entry.border) => {
                Segment::Minute
            }
            _ => Segment::Hour,
        };
        self.choose(cx, segment);
    }
    fn release(&self, _cx: &mut Input<'_>, _at: (f64, f64)) {}
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        use crate::KeyInput::*;
        let segment = Self::state(cx.state.as_deref())
            .map(|s| s.segment)
            .unwrap_or_default();
        let step: i16 = match key {
            Left => return self.choose(cx, Segment::Hour),
            Right => return self.choose(cx, Segment::Minute),
            Up => 1,
            Down => -1,
            _ => return,
        };
        cx.effects.keyboard_focus = true;
        let (h, m) = self.current(cx.state.as_deref());
        let turn = |v: u8, n: i16| (v as i16 + step).rem_euclid(n) as u8;
        let time = match segment {
            Segment::Hour => (turn(h, 24), m),
            Segment::Minute => (h, turn(m, 60)),
        };
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.typed = None;
        }
        self.set(cx, time);
    }
    fn key_event(&self, cx: &mut Input<'_>, key: &nk_wayland::Key) {
        if key.ctrl || key.alt {
            return;
        }
        let mut chars = key.text.chars();
        if let (Some(c), None) = (chars.next(), chars.next())
            && let Some(d) = c.to_digit(10)
        {
            cx.effects.keyboard_focus = true;
            self.digit(cx, d as u8);
        }
    }
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        let text = match request {
            Request::SetText(t) | Request::Set(Value::Text(t)) => t,
            Request::Activate => return,
            _ => return,
        };
        if let Some(time) = parse_time(&text) {
            self.set(cx, time);
        }
    }
    fn semantics(&self, cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        let text = shown(self.current(cx.state));
        let end = text.len();
        let (caret, anchor) = match Self::state(cx.state).map(|s| s.segment).unwrap_or_default() {
            Segment::Hour => (0, 2),
            Segment::Minute => (3, 5),
        };
        n.role = nk_a11y::Role::TextInput;
        n.actions = vec![nk_a11y::Action::Focus, nk_a11y::Action::SetText];
        n.text = Some(nk_a11y::TextInfo {
            caret,
            anchor,
            words: vec![0..2, 3..5],
            lines: std::iter::once(0..end).collect(),
            geometry: None,
            text,
        });
    }
    fn content_ink(&self, cx: &Read<'_>, at: Rect, ink: Color) -> Color {
        let chosen = self.segment_rect(cx);
        if cx.focused && chosen.is_some_and(|r| (r[0] - at[0]).abs() < 0.5) {
            cx.look.tokens.entry.selection_text
        } else {
            ink
        }
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        super::editable::chrome(cx);
        if cx.read.focused
            && let Some(r) = self.highlight(&cx.read)
        {
            let t = &cx.look.tokens.entry;
            cx.canvas.clip(rect(&cx.visible));
            cx.canvas.rounded_rect(
                rect(&r),
                (t.radius / 2.).min(r[3] / 4.),
                cx.ink(t.selection),
            );
            cx.canvas.pop_clip();
        }
    }
}
