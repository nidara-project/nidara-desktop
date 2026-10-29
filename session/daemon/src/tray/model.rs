// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
pub const MAX_ITEMS: usize = 256;
pub const MAX_PER_OWNER: usize = 32;
pub const MAX_PIXELS: usize = 512 * 512;
pub const ITEM_BYTES: usize = 4 * 1024 * 1024;
pub const TOTAL_BYTES: usize = 32 * 1024 * 1024;
pub const FIELDS: &[&str] = &[
    "Id",
    "Title",
    "Status",
    "Category",
    "ItemIsMenu",
    "Menu",
    "ToolTip",
    "IconName",
    "IconPixmap",
    "IconThemePath",
    "AttentionIconName",
    "AttentionIconPixmap",
    "OverlayIconName",
    "OverlayIconPixmap",
    "XAyatanaLabel",
    "XAyatanaLabelGuide",
];
pub type Pixmaps = Vec<(i32, i32, Vec<u8>)>;
#[derive(Clone)]
pub struct Item {
    pub handle: String,
    pub generation: u64,
    pub owner: String,
    pub path: String,
    pub interface: String,
    pub registration: String,
    pub watched_name: String,
    pub pid: u32,
    pub ready: bool,
    pub version: u64,
    pub field_versions: BTreeMap<String, u64>,
    pub props: Props,
    pub icons: BTreeMap<String, Pixmaps>,
}
impl Item {
    pub fn bytes(&self) -> usize {
        self.icons.values().flatten().map(|p| p.2.len()).sum()
    }
    pub fn metadata(&self) -> Props {
        let mut p = self.props.clone();
        p.entry("Status".into()).or_insert_with(|| val("Active"));
        p.entry("ItemIsMenu".into()).or_insert_with(|| val(false));
        p.extend([
            ("Handle".into(), val(self.handle.clone())),
            ("Generation".into(), val(self.generation)),
            ("Owner".into(), val(self.owner.clone())),
            ("ObjectPath".into(), val(self.path.clone())),
            ("OwnerPid".into(), val(self.pid)),
            (
                "PreferenceKey".into(),
                val(format!("tray:{}", text(&p, "Id"))),
            ),
            ("MenuAvailable".into(), val(self.menu_path().is_some())),
        ]);
        p
    }
    pub fn menu_path(&self) -> Option<String> {
        let s = text(&self.props, "Menu");
        (s != "/" && Path::try_from(s.as_str()).is_ok()).then_some(s)
    }
    pub fn apply(&mut self, props: Props, other_bytes: usize) {
        for (k, v) in props {
            if !FIELDS.contains(&k.as_str()) {
                continue;
            }
            if k.ends_with("Pixmap") {
                let Ok(raw) = Pixmaps::try_from(v) else {
                    self.icons.remove(&k);
                    continue;
                };
                // Account replacements before reserving bytes. Reject malformed lengths,
                // including extra bytes; SNI is tightly packed ARGB in network order.
                self.icons.remove(&k);
                let mut room = ITEM_BYTES
                    .saturating_sub(self.bytes())
                    .min(TOTAL_BYTES.saturating_sub(other_bytes + self.bytes()));
                let mut clean = Vec::new();
                for (w, h, b) in raw.into_iter().take(16) {
                    if w <= 0 || h <= 0 || w > 512 || h > 512 {
                        continue;
                    }
                    let pixels = w as usize * h as usize;
                    if pixels > MAX_PIXELS {
                        continue;
                    }
                    let n = pixels * 4;
                    if b.len() != n || n > room {
                        continue;
                    }
                    room -= n;
                    clean.push((w, h, b));
                }
                self.icons.insert(k, clean);
            } else if k == "ToolTip" {
                self.props.remove(&k);
                // Do not retain the embedded tooltip pixmap or render sender markup.
                if let Ok((name, _, title, description)) =
                    <(String, Pixmaps, String, String)>::try_from(v)
                {
                    self.props.insert(
                        k,
                        val((bounded(name), bounded(title), bounded(description))),
                    );
                }
            } else if k == "ItemIsMenu" {
                self.props
                    .insert(k, val(bool::try_from(&v).unwrap_or(false)));
            } else {
                let s = text(&HashMap::from([(k.clone(), v)]), &k);
                let s = if k == "IconThemePath"
                    && !s.is_empty()
                    && !std::path::Path::new(&s).is_absolute()
                {
                    String::new()
                } else {
                    bounded(s)
                };
                self.props.insert(k, val(s));
            }
        }
    }
    pub fn icon(&self, kind: &str, size: u32) -> Result<(u32, u32, Vec<u8>), Error> {
        if !(1..=512).contains(&size) {
            return Err(Error::InvalidArgument("size 1..512".into()));
        }
        let key = match kind {
            "normal" => "IconPixmap",
            "attention" => "AttentionIconPixmap",
            "overlay" => "OverlayIconPixmap",
            _ => return Err(Error::InvalidArgument("icon kind".into())),
        };
        let best = self
            .icons
            .get(key)
            .and_then(|p| {
                p.iter().min_by_key(|p| {
                    let side = p.0.max(p.1) as u32;
                    (side < size, side.abs_diff(size))
                })
            })
            .ok_or_else(|| Error::NotFound("no pixmap; resolve IconName in the host".into()))?;
        let mut rgba = best.2.clone();
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel.rotate_left(1);
        }
        Ok((best.0 as u32, best.1 as u32, rgba))
    }
}
pub fn bounded(mut s: String) -> String {
    if s.len() > 4096 {
        let mut at = 4096;
        while !s.is_char_boundary(at) {
            at -= 1;
        }
        s.truncate(at);
    }
    s
}
pub fn fields(signal: &str) -> &'static [&'static str] {
    match signal {
        "NewTitle" => &["Title"],
        "NewIcon" => &["IconName", "IconPixmap", "IconThemePath"],
        "NewAttentionIcon" => &["AttentionIconName", "AttentionIconPixmap"],
        "NewOverlayIcon" => &["OverlayIconName", "OverlayIconPixmap"],
        "NewIconThemePath" => &["IconThemePath"],
        "NewToolTip" => &["ToolTip"],
        "NewStatus" => &["Status"],
        "NewMenu" => &["Menu"],
        "XAyatanaNewLabel" => &["XAyatanaLabel", "XAyatanaLabelGuide"],
        _ => &[],
    }
}

/// Wire-typed SNI defaults, applied only after a successful GetAll omits a field.
pub fn property_default(field: &str) -> OwnedValue {
    match field {
        "ItemIsMenu" => val(false),
        "Status" => val("Active"),
        "Menu" => val(Path::try_from("/").expect("root path")),
        "ToolTip" => val((String::new(), Pixmaps::new(), String::new(), String::new())),
        "IconPixmap" | "AttentionIconPixmap" | "OverlayIconPixmap" => val(Pixmaps::new()),
        _ => val(""),
    }
}
