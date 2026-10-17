// SPDX-License-Identifier: LGPL-3.0-or-later
//! App-supplied geometry; no shaping, fonts or platform-coordinate assumptions.
use crate::{Bounds, Result};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq)]
pub struct TextSpan {
    pub range: Range<usize>,
    pub bounds: Bounds,
    pub caret: Bounds,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TextGeometry {
    /// Ordered, contiguous UTF-8 cluster spans, covering the committed text.
    pub spans: Vec<TextSpan>,
    pub end_caret: Bounds,
}
impl TextGeometry {
    pub(crate) fn validate(&self, text: &str) -> Result<()> {
        let mut end = 0;
        for span in &self.spans {
            if span.range.start != end
                || span.range.end <= end
                || !text.is_char_boundary(span.range.end)
            {
                return Err("text geometry must partition UTF-8 text into ordered clusters".into());
            }
            validate(span.bounds)?;
            validate(span.caret)?;
            end = span.range.end;
        }
        if end != text.len() {
            return Err("text geometry does not cover the text".into());
        }
        validate(self.end_caret)
    }
    /// Byte range, already validated against its TextInfo by the provider.
    pub(crate) fn extents(&self, range: Range<usize>, len: usize) -> Result<Bounds> {
        if range.start == range.end {
            return if range.start == len {
                Ok(self.end_caret)
            } else {
                self.spans
                    .iter()
                    .find(|s| s.range.contains(&range.start))
                    .map(|s| s.caret)
                    .ok_or_else(|| "missing text caret geometry".into())
            };
        }
        self.spans
            .iter()
            .filter(|s| s.range.end > range.start && s.range.start < range.end)
            .map(|s| s.bounds)
            .reduce(union)
            .ok_or_else(|| "missing text range geometry".into())
    }
}
fn validate(b: Bounds) -> Result<()> {
    if [b.x, b.y, b.width, b.height, b.x + b.width, b.y + b.height]
        .iter()
        .all(|v| v.is_finite())
        && b.width >= 0.
        && b.height >= 0.
    {
        Ok(())
    } else {
        Err("invalid text geometry rectangle".into())
    }
}
fn union(a: Bounds, b: Bounds) -> Bounds {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Bounds {
        x,
        y,
        width: (a.x + a.width).max(b.x + b.width) - x,
        height: (a.y + a.height).max(b.y + b.height) - y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_stale_partial_and_nonfinite_geometry() {
        let b = Bounds {
            x: 1.,
            y: 2.,
            width: 3.,
            height: 4.,
        };
        let mut g = TextGeometry {
            spans: vec![TextSpan {
                range: 0..3,
                bounds: b,
                caret: b,
            }],
            end_caret: b,
        };
        assert!(g.validate("日").is_ok());
        assert!(g.validate("日本").is_err());
        g.spans[0].range = 0..1;
        assert!(g.validate("日").is_err());
        g.spans[0].range = 0..3;
        g.spans[0].bounds.x = f64::NAN;
        assert!(g.validate("日").is_err());
        assert!(
            TextGeometry {
                spans: vec![],
                end_caret: b
            }
            .validate("")
            .is_ok()
        );
    }
}
