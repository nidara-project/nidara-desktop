// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{Font, Result, Variation};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FontFile {
    pub family: String,
    pub path: PathBuf,
    pub index: u32,
}
#[derive(Clone, Debug)]
pub struct FontSet {
    pub files: Vec<FontFile>,
    pub variable_family: String,
    data: BTreeMap<PathBuf, Arc<[u8]>>,
}
impl FontSet {
    pub fn discover_required() -> Result<Self> {
        let mut files = Vec::new();
        for family in [
            "Noto Sans",
            "Noto Sans Arabic",
            "Noto Sans Hebrew",
            "Noto Sans Devanagari",
            "Noto Sans CJK JP",
            "Noto Sans CJK SC",
            "Noto Sans CJK KR",
            "Noto Color Emoji",
        ] {
            files.push(find(family)?);
        }
        let mut variable = None;
        for family in ["Inter Variable", "Inter"] {
            if let Ok(font) = find(family) {
                let bytes = std::fs::read(&font.path).map_err(|e| e.to_string())?;
                if ttf_parser::Face::parse(&bytes, font.index & 0xffff)
                    .ok()
                    .is_some_and(|face| {
                        face.variation_axes()
                            .into_iter()
                            .any(|a| a.tag.to_bytes() == *b"wght")
                    })
                {
                    variable = Some(font);
                    break;
                }
            }
        }
        let variable = variable.ok_or("required variable font missing: install Inter Variable (Arch inter-font) / fonts-inter-variable (Ubuntu)")?;
        let variable_family = variable.family.clone();
        files.push(variable);
        Self::from_files(files, variable_family)
    }
    pub fn from_files(files: Vec<FontFile>, variable_family: String) -> Result<Self> {
        let mut data = BTreeMap::new();
        for file in &files {
            if !data.contains_key(&file.path) {
                let bytes = std::fs::read(&file.path).map_err(|e| {
                    format!(
                        "required font {} ({}): {e}",
                        file.family,
                        file.path.display()
                    )
                })?;
                data.insert(file.path.clone(), Arc::from(bytes));
            }
        }
        if files.is_empty() {
            return Err("font set is empty".into());
        }
        Ok(Self {
            files,
            variable_family,
            data,
        })
    }
    pub fn font_files(&self) -> impl Iterator<Item = (&Path, &Arc<[u8]>)> {
        self.data
            .iter()
            .map(|(path, bytes)| (path.as_path(), bytes))
    }
    pub fn families(&self, primary: &str) -> Vec<String> {
        let mut names = vec![primary.to_string()];
        for font in &self.files {
            if !names.contains(&font.family) {
                names.push(font.family.clone());
            }
        }
        names
    }
    #[cfg(feature = "parley")]
    pub(crate) fn resolve_bytes(&self, bytes: &[u8], index: u32, coords: &[i16]) -> Result<Font> {
        let data = self
            .data
            .values()
            .find(|data| std::ptr::eq(data.as_ref(), bytes) || data.as_ref() == bytes)
            .ok_or("Parley used font bytes outside the shared font set")?
            .clone();
        Ok(font(data, index, coords))
    }
}
fn font(data: Arc<[u8]>, index: u32, coords: &[i16]) -> Font {
    let variations = ttf_parser::Face::parse(&data, index)
        .ok()
        .map(|face| {
            face.variation_axes()
                .into_iter()
                .enumerate()
                .map(|(i, axis)| Variation {
                    axis: axis.tag.to_bytes(),
                    normalized: coords.get(i).copied().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Font {
        data,
        index,
        variations,
    }
}
fn find(family: &str) -> Result<FontFile> {
    let output = Command::new("fc-match")
        .args(["-f", "%{family}\n%{file}\n%{index}\n", family])
        .output()
        .map_err(|e| format!("font preflight needs fontconfig/fc-match: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let actual = lines.next().unwrap_or("");
    if !output.status.success()
        || !actual
            .split(',')
            .any(|name| name.trim().eq_ignore_ascii_case(family))
    {
        return Err(format!(
            "required font family missing: {family} (fontconfig substituted {actual}); install Noto core, CJK and colour emoji fonts"
        ));
    }
    let path = PathBuf::from(lines.next().ok_or("fc-match omitted the font path")?);
    let index = lines
        .next()
        .unwrap_or("0")
        .parse()
        .map_err(|e| format!("invalid font index: {e}"))?;
    Ok(FontFile {
        family: family.into(),
        path,
        index,
    })
}
