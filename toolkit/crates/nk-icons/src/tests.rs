// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;

const PLUS: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>"#;
const DOT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><g opacity="0.5"><circle cx="8" cy="8" r="4" fill="black"/></g></svg>"#;
const EMPTY: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M1 1h4" fill="none"/></svg>"#;

/// A scratch icon tree under a temporary directory, removed on drop.
struct Scratch(PathBuf);
impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("nk-icons-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn theme(&self, base: &str, name: &str, spec: Option<u32>) -> PathBuf {
        let dir = self.0.join(base).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let spec = spec
            .map(|s| format!("X-Nidara-Icon-Spec={s}\n"))
            .unwrap_or_default();
        std::fs::write(
            dir.join("index.theme"),
            format!(
                "[Icon Theme]\nName={name}\n{spec}Directories=16x16/actions,scalable/actions\n\n\
                 [16x16/actions]\nSize=16\nType=Fixed\n\n\
                 [scalable/actions]\nSize=24\nMinSize=16\nMaxSize=512\nType=Scalable\n"
            ),
        )
        .unwrap();
        dir
    }
    fn icon(&self, theme: &Path, dir: &str, name: &str, svg: &str) {
        let d = theme.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("{name}-symbolic.svg")), svg).unwrap();
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_stroked_icon_keeps_its_strokes_in_its_units() {
    let icon = Icon::parse(PLUS.as_bytes()).unwrap();
    assert_eq!(icon.size, (24., 24.));
    assert_eq!(icon.shapes.len(), 2);
    let s = &icon.shapes[0];
    assert!(s.fill.is_none());
    let k = s.stroke.unwrap();
    assert_eq!((k.width, k.cap), (2., Cap::Round));
    assert_eq!(s.segments[0], Segment::Move(Point { x: 5., y: 12. }));
    assert!(icon.draws_ink());
}

#[test]
fn a_group_opacity_reaches_its_shapes_and_an_empty_drawing_draws_nothing() {
    let dot = Icon::parse(DOT.as_bytes()).unwrap();
    assert!((dot.shapes[0].fill.unwrap().opacity - 0.5).abs() < 1e-6);
    assert!(!Icon::parse(EMPTY.as_bytes()).unwrap().draws_ink());
}

#[test]
fn the_chosen_theme_then_the_reference_for_what_it_lacks() {
    let s = Scratch::new("fallback");
    let reference = s.theme("ref", "nidara", Some(4));
    s.icon(&reference, "scalable/actions", "nd-a", PLUS);
    s.icon(&reference, "scalable/actions", "nd-b", PLUS);
    s.icon(&reference, "scalable/actions", "nd-c", PLUS);
    let mine = s.theme("user", "mine", Some(4));
    s.icon(&mine, "scalable/actions", "nd-a", DOT);
    s.icon(&mine, "scalable/actions", "nd-c", EMPTY);
    let search = vec![s.0.join("user")];
    let mut icons = Icons::new("mine", &search, &reference).unwrap();
    assert!(icons.theme_in_use());
    assert_eq!(
        icons.get("nd-a", 16).unwrap().size,
        (16., 16.),
        "the theme's own drawing"
    );
    assert_eq!(
        icons.get("nd-b", 16).unwrap().size,
        (24., 24.),
        "missing: the reference"
    );
    assert_eq!(
        icons.get("nd-c", 16).unwrap().size,
        (24., 24.),
        "a hole: the reference"
    );
    assert!(icons.get("nd-none", 16).is_err());
}

#[test]
fn a_theme_without_the_spec_or_misspelt_is_not_used() {
    let s = Scratch::new("spec");
    let reference = s.theme("ref", "nidara", Some(4));
    s.icon(&reference, "scalable/actions", "nd-a", PLUS);
    let plain = s.theme("user", "Plain", None);
    s.icon(&plain, "scalable/actions", "nd-a", DOT);
    let search = vec![s.0.join("user")];
    let mut icons = Icons::new("Plain", &search, &reference).unwrap();
    assert!(!icons.theme_in_use());
    assert_eq!(icons.get("nd-a", 16).unwrap().size, (24., 24.));
    let spec = s.theme("user", "Spec", Some(1));
    s.icon(&spec, "scalable/actions", "nd-a", DOT);
    assert!(
        !Icons::new("spec", &search, &reference)
            .unwrap()
            .theme_in_use()
    );
    assert!(
        Icons::new("Spec", &search, &reference)
            .unwrap()
            .theme_in_use()
    );
}

#[test]
fn the_fixed_size_wins_at_its_size_and_the_scalable_elsewhere() {
    let s = Scratch::new("size");
    let reference = s.theme("ref", "nidara", Some(4));
    s.icon(&reference, "16x16/actions", "nd-a", DOT);
    s.icon(&reference, "scalable/actions", "nd-a", PLUS);
    let mut icons = Icons::new("", &[], &reference).unwrap();
    assert_eq!(icons.get("nd-a", 16).unwrap().size, (16., 16.));
    assert_eq!(icons.get("nd-a", 32).unwrap().size, (24., 24.));
}

#[test]
fn the_first_index_along_the_path_counts_and_every_base_is_searched() {
    let s = Scratch::new("bases");
    let reference = s.theme("ref", "nidara", Some(4));
    s.icon(&reference, "scalable/actions", "nd-a", PLUS);
    // The first base declares no spec: the theme is not used, though the second does.
    let first = s.theme("one", "t", None);
    let second = s.theme("two", "t", Some(4));
    s.icon(&second, "scalable/actions", "nd-a", DOT);
    let _ = first;
    let search = vec![s.0.join("one"), s.0.join("two")];
    assert!(!Icons::new("t", &search, &reference).unwrap().theme_in_use());
    // With the spec first, a drawing under the second base is found.
    std::fs::write(
        s.0.join("one/t/index.theme"),
        std::fs::read_to_string(second.join("index.theme")).unwrap(),
    )
    .unwrap();
    let mut icons = Icons::new("t", &search, &reference).unwrap();
    assert_eq!(icons.get("nd-a", 16).unwrap().size, (16., 16.));
}

/// The reference theme of this repository has every name `Icons.ts` registers, drawn.
#[test]
fn the_repository_reference_draws_every_registered_name() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ui/shell");
    let names = std::fs::read_to_string(root.join("core/Icons.ts")).unwrap();
    let start = names.find("export const ICON_NAMES = [").unwrap();
    let end = start + names[start..].find("] as const").unwrap();
    let names: Vec<&str> = names[start..end].split('"').skip(1).step_by(2).collect();
    assert!(names.len() > 50, "parsed {} names", names.len());
    let mut icons = Icons::new("", &[], &root.join("assets/icons/nidara")).unwrap();
    for name in names {
        icons.get(name, 16).unwrap_or_else(|e| panic!("{e}"));
    }
}
