// SPDX-License-Identifier: LGPL-3.0-or-later
//! `--choices`: Claude's controls of #882 — the radio groups and the range controls — above the
//! foundations' content, with fixed data, and the faults `scripts/ci/nk-choices-check.py` proves
//! its assertions with.
use crate::appearance::Appearance;
use nk_a11y::Role;
use nk_widgets::{ChoiceKind, Result, Tree, ValueRange};

/// The accents shown, in the order the current Settings shows them.
const ACCENTS: [&str; 9] = [
    "blue", "teal", "green", "yellow", "orange", "red", "pink", "purple", "slate",
];
pub struct Fixture {
    pub swatches: Vec<u64>,
    pub segments: Vec<u64>,
    pub slider: u64,
    pub spins: Vec<u64>,
}
/// The night light's temperature, as the current Settings shows it.
pub const KELVIN: f32 = 4500.;
fn clock(max: f32) -> ValueRange {
    ValueRange {
        min: 0.,
        max,
        step: 1.,
        wrap: true,
        digits: 2,
        decimals: 0,
        unit: String::new(),
    }
}
pub fn build(tree: &mut Tree, scroll: u64, appearance: &Appearance) -> Result<Fixture> {
    let group = tree.group(scroll, "Choices")?;
    let (_, _, segments) = tree.choices(
        group,
        "Window controls",
        ChoiceKind::Segmented,
        &["Left", "Right", "Hidden"],
        1,
    )?;
    tree.choices(
        group,
        "Dock size",
        ChoiceKind::Segmented,
        &["Small", "Medium", "Large"],
        1,
    )?;
    let names: Vec<String> = ACCENTS
        .iter()
        .map(|a| {
            let mut c = a.chars();
            c.next()
                .map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
        })
        .collect();
    let labels: Vec<&str> = names.iter().map(String::as_str).collect();
    let (_, _, swatches) = tree.choices(group, "Accent colour", ChoiceKind::Swatch, &labels, 0)?;
    for (id, name) in swatches.iter().zip(ACCENTS) {
        let color = appearance
            .accents
            .iter()
            .find(|(n, _)| n == name)
            .ok_or_else(|| format!("accent {name} missing from the export"))?
            .1;
        tree.set_swatch(*id, color)?;
    }
    let night = tree.group(scroll, "Night light")?;
    let (_, slider) = tree.slider(
        night,
        "Temperature",
        ValueRange {
            min: 1000.,
            max: 6500.,
            step: 100.,
            wrap: false,
            digits: 0,
            decimals: 0,
            unit: " K".into(),
        },
        KELVIN,
    )?;
    let (_, _, spins) = tree.fields(
        night,
        "From",
        vec![
            ("From hour", clock(23.), 22.),
            ("From minute", clock(59.), 5.),
        ],
    )?;
    Ok(Fixture {
        swatches,
        segments,
        slider,
        spins,
    })
}
impl Fixture {
    /// The semantic faults: each breaks exactly what its assertion reads, and says so.
    pub fn fault(&self, fault: &str, tree: &mut nk_a11y::Tree) -> bool {
        match fault {
            "two-checked" => {
                for id in &self.segments {
                    tree.nodes.get_mut(id).unwrap().states.checked = true;
                }
                true
            }
            "swatch-name" => {
                tree.nodes.get_mut(&self.swatches[1]).unwrap().name.clear();
                true
            }
            "radio-role" => {
                tree.nodes.get_mut(&self.swatches[0]).unwrap().role = Role::ToggleButton;
                true
            }
            // nk-choices-orca-check.py: the chosen segment not a radio button, the role Orca says.
            "segment-role" => {
                tree.nodes.get_mut(&self.segments[1]).unwrap().role = Role::ToggleButton;
                true
            }
            "slider-value" => {
                let v = tree
                    .nodes
                    .get_mut(&self.slider)
                    .unwrap()
                    .value
                    .as_mut()
                    .unwrap();
                v.text.clear();
                true
            }
            // A Value that does not follow the control: the reader would say the old number.
            "value-stale" => {
                let v = tree
                    .nodes
                    .get_mut(&self.slider)
                    .unwrap()
                    .value
                    .as_mut()
                    .unwrap();
                v.current = KELVIN as f64;
                v.text = format!("{KELVIN} K");
                true
            }
            "spin-name" => {
                tree.nodes.get_mut(&self.spins[0]).unwrap().name.clear();
                true
            }
            // The hour's Value left at its start: Up moves the field, the reader hears nothing new.
            "spin-stale" => {
                let v = tree
                    .nodes
                    .get_mut(&self.spins[0])
                    .unwrap()
                    .value
                    .as_mut()
                    .unwrap();
                v.current = 22.;
                v.text = "22".into();
                true
            }
            _ => false,
        }
    }
}
/// The keys a radio group takes: the arrows, Home, End.
pub fn group_key(sym: u32) -> bool {
    matches!(sym, 0xff50..=0xff54 | 0xff57)
}
