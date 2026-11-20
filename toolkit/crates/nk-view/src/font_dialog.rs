// SPDX-License-Identifier: LGPL-3.0-or-later
//! A font selection draft hosted by the standard modal dialog.
use crate::{
    Activated, AppWindow, Column, Dialog, DialogAnswer, DialogButton, DialogContent, DialogUpdate,
    DropDown, Entry, FontFace, Key, Label, ListRow, ListSource, ListView, Node, Page, RowInfo,
    SearchEntry, Space, Type, Value, Weight,
};
use nk_text::{FontCatalogue, TextStyle};
use nk_wayland::Window;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FontSize {
    Points(f32),
    Pixels(f32),
}
impl FontSize {
    fn value(self) -> f32 {
        match self {
            Self::Points(size) | Self::Pixels(size) => size,
        }
    }
    fn suffix(self) -> &'static str {
        match self {
            Self::Points(_) => "pt",
            Self::Pixels(_) => "px",
        }
    }
    fn with_value(self, size: f32) -> Self {
        match self {
            Self::Points(_) => Self::Points(size),
            Self::Pixels(_) => Self::Pixels(size),
        }
    }
    /// Logical pixels at the toolkit's 96 DPI. Output scale is applied by the renderer.
    pub fn logical_pixels(self) -> f32 {
        match self {
            Self::Points(size) => size * (96. / 72.),
            Self::Pixels(size) => size,
        }
    }
    fn valid(self) -> bool {
        (1. ..=512.).contains(&self.value())
    }
}

/// The family, face and unit-bearing size returned by the chooser.
#[derive(Clone, Debug, PartialEq)]
pub struct FontChoice {
    pub family: String,
    pub face: FontFace,
    pub size: FontSize,
}
impl FontChoice {
    pub fn new(family: impl Into<String>, size: FontSize) -> Self {
        Self {
            family: family.into(),
            face: FontFace::default(),
            size,
        }
    }
    pub fn face(mut self, face: FontFace) -> Self {
        self.face = face;
        self
    }
    pub fn caption(&self) -> String {
        format!(
            "{}  {}{}",
            self.family,
            self.size.value(),
            self.size.suffix()
        )
    }
    pub(crate) fn text_style(&self, mut style: TextStyle) -> TextStyle {
        style.family.clone_from(&self.family);
        style.weight = self.face.weight;
        style.width = self.face.width;
        style.slant = self.face.slant;
        style.variations.clear();
        style.size = self.size.logical_pixels();
        style
    }
}

/// Localizable strings for a font dialog.
pub struct FontDialogLabels {
    pub title: String,
    pub close: String,
    pub cancel: String,
    pub choose: String,
    pub search: String,
    pub clear_search: String,
    pub family: String,
    pub style: String,
    pub size: String,
    pub no_matches: String,
    pub sample: String,
}
impl Default for FontDialogLabels {
    fn default() -> Self {
        Self {
            title: "Choose a font".into(),
            close: "Close".into(),
            cancel: "Cancel".into(),
            choose: "Choose".into(),
            search: "Search font families".into(),
            clear_search: "Clear search".into(),
            family: "Font family".into(),
            style: "Style".into(),
            size: "Size".into(),
            no_matches: "No matching font families".into(),
            sample: "The quick brown fox jumps over the lazy dog. 0123456789".into(),
        }
    }
}

/// Choose a font using the same collection as the parent window's text backend.
#[must_use]
pub struct FontDialog {
    initial: FontChoice,
    monospace_only: bool,
    labels: FontDialogLabels,
}
impl FontDialog {
    pub fn new(initial: FontChoice) -> Self {
        Self {
            initial,
            monospace_only: false,
            labels: FontDialogLabels::default(),
        }
    }
    pub fn labels(mut self, labels: FontDialogLabels) -> Self {
        self.labels = labels;
        self
    }
    pub fn monospace_only(mut self, on: bool) -> Self {
        self.monospace_only = on;
        self
    }
    /// Return the draft on Choose. Cancel, Escape and window close return `None`.
    /// Size edits accept 1 to 512 in the original unit, including fractional sizes.
    pub fn choose(
        self,
        host: &mut AppWindow,
        window: &mut Window,
        launcher: &Key,
        updates: impl FnMut() -> Result<DialogUpdate, String>,
        parent_page: impl FnMut(&AppWindow) -> Page,
    ) -> Result<Option<FontChoice>, String> {
        let mut draft = Draft::new(self, host.font_catalogue(), updates);
        let spec = Dialog {
            title: draft.labels.title.clone(),
            close_label: draft.labels.close.clone(),
            buttons: draft.responses(),
        };
        let response = host.run_dialog(window, launcher, spec, &mut draft, parent_page)?;
        Ok(draft.answer(response))
    }
}

struct Draft<U> {
    catalogue: Option<Box<dyn FontCatalogue>>,
    families: Vec<String>,
    faces: Vec<FontFace>,
    filtered: Vec<usize>,
    query: String,
    filter_revision: usize,
    family: Option<usize>,
    face: usize,
    size: FontSize,
    size_text: String,
    labels: FontDialogLabels,
    updates: U,
}
impl<U> Draft<U> {
    fn new(dialog: FontDialog, mut catalogue: Option<Box<dyn FontCatalogue>>, updates: U) -> Self {
        let families = catalogue.as_mut().map_or_else(Vec::new, |catalogue| {
            catalogue.family_names(dialog.monospace_only)
        });
        let family = families
            .iter()
            .position(|name| name.eq_ignore_ascii_case(&dialog.initial.family))
            .or_else(|| (!families.is_empty()).then_some(0));
        let size = dialog.initial.size;
        let mut draft = Self {
            filtered: (0..families.len()).collect(),
            catalogue,
            families,
            faces: Vec::new(),
            query: String::new(),
            filter_revision: 0,
            family: None,
            face: 0,
            size,
            size_text: size.value().to_string(),
            labels: dialog.labels,
            updates,
        };
        if let Some(index) = family {
            draft.select_family(index);
            let initial = dialog.initial.face;
            draft.face = draft
                .faces
                .iter()
                .position(|face| {
                    face.weight == initial.weight
                        && face.width == initial.width
                        && face.slant == initial.slant
                })
                .unwrap_or_default();
        }
        draft
    }

    fn select_family(&mut self, index: usize) {
        self.family = Some(index);
        self.faces = self
            .catalogue
            .as_mut()
            .map_or_else(Vec::new, |catalogue| catalogue.faces(&self.families[index]));
        self.face = 0;
    }
    fn filter(&mut self, query: String) {
        let name = query.trim().to_lowercase();
        self.filtered = self
            .families
            .iter()
            .enumerate()
            .filter_map(|(i, family)| family.to_lowercase().contains(&name).then_some(i))
            .collect();
        self.query = query;
        self.filter_revision += 1;
    }
    fn picked_size(&self) -> Option<FontSize> {
        let value = self.size_text.trim().replace(',', ".").parse().ok()?;
        let size = self.size.with_value(value);
        size.valid().then_some(size)
    }
    fn choice(&self) -> Option<FontChoice> {
        let family = self.families.get(self.family?)?;
        let face = self.faces.get(self.face)?.clone();
        Some(FontChoice::new(family, self.picked_size()?).face(face))
    }
    fn responses(&self) -> Vec<DialogButton> {
        vec![
            DialogButton {
                id: "choose".into(),
                label: self.labels.choose.clone(),
                default: true,
                cancel: false,
                destructive: false,
                enabled: self.choice().is_some(),
            },
            DialogButton {
                id: "cancel".into(),
                label: self.labels.cancel.clone(),
                default: false,
                cancel: true,
                destructive: false,
                enabled: true,
            },
        ]
    }
    fn answer(&self, response: DialogAnswer) -> Option<FontChoice> {
        match response {
            DialogAnswer::Button(id) if id == "choose" => self.choice(),
            _ => None,
        }
    }
}

struct Families<'a> {
    all: &'a [String],
    filtered: &'a [usize],
    style: TextStyle,
}
impl ListSource for Families<'_> {
    fn item(&self, index: usize) -> RowInfo {
        let id = self.filtered[index];
        RowInfo {
            key: id.to_string().into(),
            name: self.all[id].clone(),
        }
    }
    fn build(&self, index: usize, key: &Key) -> Node {
        let font = &self.all[self.filtered[index]];
        Label::new(
            format!("{}/name", key.0),
            font,
            TextStyle {
                family: font.clone(),
                ..self.style.clone()
            },
        )
        .lines(1)
        .into()
    }
}

impl<U: FnMut() -> Result<DialogUpdate, String>> DialogContent for Draft<U> {
    fn content(&mut self, host: &AppWindow) -> Node {
        let look = host.look();
        let body = look.types.style(Type::Body, Weight::Regular);
        let rows = Families {
            all: &self.families,
            filtered: &self.filtered,
            style: body.clone(),
        };
        let selected = self
            .family
            .and_then(|chosen| rows.filtered.iter().position(|i| *i == chosen));
        let list_key = Key(format!("font/families/{}", self.filter_revision));
        let viewport = host.scroll_window(&ListView::scroll_key(&list_key));
        let height = 5. * look.tokens.row_height;
        let search = SearchEntry::new(
            "font/search",
            &self.labels.search,
            "font-search",
            &self.query,
            &self.labels.clear_search,
        )
        .placeholder(&self.labels.search);
        let mut content = vec![search.into()];
        if rows.filtered.is_empty() {
            content
                .push(Label::new("font/no-matches", &self.labels.no_matches, body.clone()).into());
        } else {
            content.push(
                ListView::new(
                    list_key,
                    &self.labels.family,
                    "font-family",
                    &rows,
                    rows.filtered.len(),
                    selected.unwrap_or_default(),
                    look.tokens.row_height,
                )
                .selected(selected)
                .window(viewport.or(Some((0., height))))
                .height(height)
                .into(),
            );
        }
        if !self.faces.is_empty() {
            let faces = self.faces.iter().map(|f| f.name.clone()).collect();
            let styles = DropDown::new(
                "font/style",
                &self.labels.style,
                "font-style",
                faces,
                self.face,
            );
            content.push(
                ListRow::new("font/style-row", &self.labels.style, body.clone())
                    .trailing(styles)
                    .into(),
            );
        }
        let size_label = format!("{} ({})", self.labels.size, self.size.suffix());
        let size = Entry::new("font/size", &size_label, "font-size", &self.size_text);
        content.push(
            ListRow::new("font/size-row", size_label, body.clone())
                .trailing(size)
                .into(),
        );
        if let Some(font) = self.choice() {
            content.push(
                Label::new("font/preview", &self.labels.sample, font.text_style(body))
                    .lines(1)
                    .into(),
            );
        }
        Column::new("font", content).gap(Space::S2).into()
    }
    fn activated(&mut self, action: Activated) -> Result<(), String> {
        match (action.action.as_str(), action.value) {
            ("font-search", Some(Value::Text(query))) if query != self.query => self.filter(query),
            ("font-family", Some(Value::Index(index))) => {
                if let Some(&family) = self.filtered.get(index)
                    && Some(family) != self.family
                {
                    self.select_family(family);
                }
            }
            ("font-style", Some(Value::Index(index))) => {
                if index < self.faces.len() {
                    self.face = index;
                }
            }
            ("font-size", Some(Value::Text(text))) => self.size_text = text,
            _ => {}
        }
        Ok(())
    }
    fn buttons(&self) -> Option<Vec<DialogButton>> {
        Some(self.responses())
    }
    fn poll(&mut self) -> Result<DialogUpdate, String> {
        (self.updates)()
    }
}

#[cfg(test)]
#[test]
fn a_font_search_keeps_the_parent_choice_until_confirmation() {
    let initial = FontChoice::new("Sans", FontSize::Pixels(16.));
    struct Catalogue;
    impl FontCatalogue for Catalogue {
        fn family_names(&mut self, _: bool) -> Vec<String> {
            vec!["Serif".into(), "Sans".into()]
        }
        fn faces(&mut self, _: &str) -> Vec<FontFace> {
            vec![FontFace::default()]
        }
    }
    let mut draft = Draft::new(
        FontDialog::new(initial.clone()),
        Some(Box::new(Catalogue)),
        || Ok(DialogUpdate::default()),
    );
    draft
        .activated(Activated {
            key: "font/search".into(),
            action: "font-search".into(),
            value: Some(Value::Text(" sEr ".into())),
        })
        .unwrap();
    assert_eq!(draft.filtered, [0]);
    assert_eq!(draft.choice().as_ref(), Some(&initial));
    draft
        .activated(Activated {
            key: "font/families/1".into(),
            action: "font-family".into(),
            value: Some(Value::Index(0)),
        })
        .unwrap();
    draft
        .activated(Activated {
            key: "font/size".into(),
            action: "font-size".into(),
            value: Some(Value::Text("11,5".into())),
        })
        .unwrap();
    assert!(draft.answer(DialogAnswer::Cancel).is_none());
    assert_eq!(initial.caption(), "Sans  16px");
    let picked = draft.answer(DialogAnswer::Button("choose".into())).unwrap();
    assert_eq!(picked.caption(), "Serif  11.5px");
    assert_eq!(picked.size.logical_pixels(), 11.5);
    assert_eq!(FontSize::Points(12.).logical_pixels(), 16.);
}
