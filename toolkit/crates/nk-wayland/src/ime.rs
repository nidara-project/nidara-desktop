// SPDX-License-Identifier: LGPL-3.0-or-later
//! Wire state is separate from Editor: nk-wayland has no text-engine dependency.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextInput {
    pub focused: bool,
    pub password: bool,
    pub text: String,
    pub cursor: usize,
    pub anchor: usize,
    pub rect: [i32; 4],
}
#[derive(Clone, Debug, Default)]
pub struct ImeBatch {
    pub preedit: Option<(String, i32, i32)>,
    pub commit: Option<String>,
    pub delete: Option<(u32, u32)>,
    pub serial: u32,
}
/// v3 caps surrounding text to 4000 bytes. Preserve both selection endpoints and
/// UTF-8 boundaries. If the selection itself cannot fit, omit surrounding text.
pub fn surrounding(s: &TextInput) -> Option<(String, i32, i32)> {
    if s.password || !s.text.is_char_boundary(s.cursor) || !s.text.is_char_boundary(s.anchor) {
        return None;
    }
    let low = s.cursor.min(s.anchor);
    let high = s.cursor.max(s.anchor);
    if high - low > 4000 {
        return None;
    }
    let mut start = low.saturating_sub((4000 - (high - low)) / 2);
    while !s.text.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + 4000).min(s.text.len());
    while !s.text.is_char_boundary(end) {
        end -= 1;
    }
    Some((
        s.text[start..end].into(),
        (s.cursor - start) as i32,
        (s.anchor - start) as i32,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn surrounding_is_bounded_utf8_and_never_a_password() {
        let mut s = TextInput {
            text: "語".repeat(3000),
            cursor: 4500,
            anchor: 4602,
            ..Default::default()
        };
        let (text, c, a) = surrounding(&s).unwrap();
        assert!(text.len() <= 4000);
        assert_eq!(&text[c as usize..a as usize], "語".repeat(34));
        s.password = true;
        assert!(surrounding(&s).is_none());
        s.password = false;
        s.cursor = 1;
        assert!(surrounding(&s).is_none());
    }
}
