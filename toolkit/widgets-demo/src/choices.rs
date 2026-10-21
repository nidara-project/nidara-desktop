// SPDX-License-Identifier: LGPL-3.0-or-later
//! `--choices`: the radio groups (#882) above the foundations' content, with fixed data, and
//! the faults `scripts/ci/nk-choices-check.py` proves its assertions with.
use crate::appearance::Appearance;
use nk_a11y::Role;
use nk_widgets::{ChoiceKind, Result, Tree};

/// The accents shown, in the order the current Settings shows them.
const ACCENTS: [&str; 9] = [
    "blue", "teal", "green", "yellow", "orange", "red", "pink", "purple", "slate",
];
pub struct Fixture {
    pub swatches: Vec<u64>,
    pub segments: Vec<u64>,
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
    Ok(Fixture { swatches, segments })
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
            _ => false,
        }
    }
}
/// The keys a radio group takes: the arrows, Home, End.
pub fn group_key(sym: u32) -> bool {
    matches!(sym, 0xff50..=0xff54 | 0xff57)
}
