//! The shell's glass, as the token export states it (`tokens/glass.json`, written by
//! `scripts/export-tokens.mjs` from the kit's own material and installed under
//! `/usr/share/nidara/settings-data/`): what Hyalo needs to paint glass of its OWN — the window
//! controls' capsule (toolkit/PHASE1.md D7) — the same as the shell's. One source for the
//! numbers: never a copy of them here. Without the file (a Hyalo run outside an install, an
//! older one) there is nothing to paint with, and the caller keeps its plain capsule.

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use serde::Deserialize;

use crate::protocols::material::{Glass, ShadowLaw, Tone};

/// Where the export is installed; `HYALO_GLASS_TOKENS` points elsewhere (a test, a checkout).
const DEFAULT_PATH: &str = "/usr/share/nidara/settings-data/tokens/glass.json";
/// How often the file is looked at again: an install replaces it under a running Hyalo.
const RECHECK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
struct File {
    variants: Vec<Variant>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Variant {
    dark: bool,
    reduce_transparency: bool,
    glass: GlassJson,
    pieces: std::collections::BTreeMap<String, Vec<Step>>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct GlassJson {
    refraction: f64,
    lensing: f64,
    rim: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    from_side: f64,
    tone: ToneJson,
    shadow: Option<ShadowJson>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToneJson {
    saturation: f64,
    ceiling: f64,
    lift: f64,
    gain: f64,
    wash: Rgba,
    ambient: f64,
    ambient_lift: f64,
    ambient_gain: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct Rgba {
    r: f64,
    g: f64,
    b: f64,
    a: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShadowJson {
    opacity_small: f64,
    opacity_large: f64,
    blur_small: f64,
    blur_large: f64,
    offset: f64,
}

/// One pane of the shell's glass: the glass, how much it lenses, its tone and its shadow.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pane {
    pub glass: Glass,
    pub lensing: f64,
    pub tone: Tone,
    pub shadow: Option<ShadowLaw>,
}

struct Loaded {
    path: PathBuf,
    checked: Instant,
    modified: Option<SystemTime>,
    file: Option<File>,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn path() -> PathBuf {
    std::env::var_os("HYALO_GLASS_TOKENS").map_or_else(|| DEFAULT_PATH.into(), PathBuf::from)
}

fn read(path: &PathBuf) -> Option<File> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(f) => Some(f),
        Err(e) => {
            tracing::warn!("glass tokens: {} does not parse: {e}", path.display());
            None
        }
    }
}

/// The shell's glass for a pane of kind `piece` (`control`, `panel`, …) whose shorter side is
/// `side` logical px, on the `dark` or light face, with reduce transparency or not. None
/// without the export, or when it has no such piece.
pub fn pane(piece: &str, side: f64, dark: bool, reduce_transparency: bool) -> Option<Pane> {
    let mut loaded = LOADED.lock().unwrap();
    let now = Instant::now();
    let p = path();
    let stale = loaded.as_ref().is_none_or(|l| l.path != p || now.duration_since(l.checked) >= RECHECK);
    if stale {
        let modified = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
        let same = loaded.as_ref().is_some_and(|l| l.path == p && l.modified == modified);
        if same {
            loaded.as_mut().unwrap().checked = now;
        } else {
            *loaded = Some(Loaded { file: read(&p), path: p, checked: now, modified });
        }
    }
    pick(loaded.as_ref()?.file.as_ref()?, piece, side, dark, reduce_transparency)
}

fn pick(file: &File, piece: &str, side: f64, dark: bool, reduce_transparency: bool) -> Option<Pane> {
    let v = file.variants.iter().find(|v| v.dark == dark && v.reduce_transparency == reduce_transparency)?;
    // The export's rule: the last step whose `fromSide` is at most the side rounded to a px.
    let side = side.round();
    let step = v.pieces.get(piece)?.iter().rev().find(|s| s.from_side <= side)?;
    let t = step.tone;
    Some(Pane {
        glass: Glass { refraction: v.glass.refraction, rim: v.glass.rim },
        lensing: v.glass.lensing,
        tone: Tone::new(
            t.saturation, t.ceiling, t.lift, t.gain, [t.wash.r, t.wash.g, t.wash.b, t.wash.a], t.ambient, t.ambient_lift, t.ambient_gain,
        ),
        shadow: step.shadow.map(|s| ShadowLaw {
            opacity: [s.opacity_small, s.opacity_large],
            blur: [s.blur_small, s.blur_large],
            offset: s.offset,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"variants": [
        {"dark": true, "reduceTransparency": false, "glass": {"refraction": 40, "lensing": 0.15, "rim": 0.5},
         "pieces": {"control": [
            {"fromSide": 0, "tone": {"saturation": 1.3, "ceiling": 0.6, "lift": 0.125, "gain": 1.125,
              "wash": {"r": 0, "g": 0, "b": 0, "a": 0}, "ambient": 0.8, "ambientLift": 0.125, "ambientGain": 0.5}},
            {"fromSide": 65, "tone": {"saturation": 1.3, "ceiling": 0.59, "lift": 0.125, "gain": 1.125,
              "wash": {"r": 0, "g": 0, "b": 0, "a": 0}, "ambient": 0.8, "ambientLift": 0.125, "ambientGain": 0.5}}]}},
        {"dark": false, "reduceTransparency": false, "glass": {"refraction": 40, "lensing": 0.15, "rim": 0.5},
         "pieces": {"control": [
            {"fromSide": 0, "tone": {"saturation": 1.1, "ceiling": 1.0, "lift": 0.4, "gain": 1.0,
              "wash": {"r": 1, "g": 1, "b": 1, "a": 0.3}, "ambient": 0, "ambientLift": 0, "ambientGain": 1}}]}}
    ]}"#;

    #[test]
    fn a_pane_takes_its_face_and_the_last_step_its_size_reaches() {
        let f: File = serde_json::from_str(SAMPLE).unwrap();
        let small = pick(&f, "control", 32.0, true, false).unwrap();
        assert_eq!(small.tone.ceiling, 0.6);
        assert_eq!(small.glass.refraction, 40.0);
        assert_eq!(pick(&f, "control", 64.6, true, false).unwrap().tone.ceiling, 0.59, "65 rounded reaches the second step");
        assert_eq!(pick(&f, "control", 32.0, false, false).unwrap().tone.lift, 0.4, "the light face");
        assert!(pick(&f, "control", 32.0, true, true).is_none(), "no such variant");
        assert!(pick(&f, "dock", 32.0, true, false).is_none(), "no such piece");
    }
}
