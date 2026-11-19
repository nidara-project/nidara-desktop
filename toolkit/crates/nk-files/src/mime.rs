// SPDX-License-Identifier: LGPL-3.0-or-later
use glob::{MatchOptions, Pattern};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

/// Portal filter rules are alternatives: (0, glob) or (1, MIME).
#[derive(Clone, Debug)]
pub struct Filter {
    pub name: String,
    rules: Vec<Rule>,
}

#[derive(Clone, Debug)]
enum Rule {
    Glob(Pattern),
    Mime(String),
}

impl Filter {
    pub fn new(name: impl Into<String>, rules: &[(u32, String)]) -> Result<Self, String> {
        let rules = rules
            .iter()
            .map(|(kind, rule)| match kind {
                0 => Pattern::new(rule)
                    .map(Rule::Glob)
                    .map_err(|err| err.to_string()),
                1 if rule.contains('/') => Ok(Rule::Mime(rule.to_ascii_lowercase())),
                _ => Err(format!("invalid file filter ({kind}, {rule:?})")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if rules.is_empty() {
            return Err("a file filter needs a rule".into());
        }
        Ok(Self {
            name: name.into(),
            rules,
        })
    }

    pub(crate) fn matches(&self, name: &str, mime: &str) -> bool {
        self.rules.iter().any(|rule| match rule {
            Rule::Glob(pattern) => pattern.matches(name),
            Rule::Mime(expected) => {
                expected.eq_ignore_ascii_case(mime)
                    || expected.strip_suffix("/*").is_some_and(|media| {
                        mime.split_once('/')
                            .is_some_and(|(actual, _)| media.eq_ignore_ascii_case(actual))
                    })
            }
        })
    }
}

#[derive(Default, Debug)]
pub struct MimeDb {
    globs: Vec<MimeGlob>,
    icons: HashMap<String, String>,
}

#[derive(Debug)]
struct MimeGlob {
    pattern: Pattern,
    kind: String,
    weight: u32,
    case_sensitive: bool,
}

impl MimeDb {
    /// MIME roots in priority order (user data first). Empty/missing databases are valid.
    pub fn load(roots: impl IntoIterator<Item = impl AsRef<Path>>) -> Self {
        let mut db = Self::default();
        let mut suppressed = HashSet::new();
        for root in roots {
            let root = root.as_ref();
            let globs = fs::read_to_string(root.join("globs2")).unwrap_or_default();
            let mut delete_lower = HashSet::new();
            for line in globs.lines().filter(|line| !line.starts_with('#')) {
                let mut fields = line.splitn(4, ':');
                let (Some(weight), Some(kind), Some(pattern)) =
                    (fields.next(), fields.next(), fields.next())
                else {
                    continue;
                };
                if suppressed.contains(kind) {
                    continue;
                }
                if pattern == "__NOGLOBS__" {
                    delete_lower.insert(kind.to_owned());
                    continue;
                }
                if let (Ok(weight), Ok(pattern)) = (weight.parse(), Pattern::new(pattern)) {
                    db.globs.push(MimeGlob {
                        pattern,
                        kind: kind.to_owned(),
                        weight,
                        case_sensitive: fields
                            .next()
                            .is_some_and(|flags| flags.split(',').any(|f| f == "cs")),
                    });
                }
            }
            suppressed.extend(delete_lower);
            let icons = fs::read_to_string(root.join("generic-icons")).unwrap_or_default();
            for (kind, icon) in icons.lines().filter_map(|line| line.split_once(':')) {
                db.icons
                    .entry(kind.to_owned())
                    .or_insert_with(|| icon.to_owned());
            }
        }
        db.globs.sort_by_key(|rule| {
            (
                std::cmp::Reverse(rule.weight),
                std::cmp::Reverse(rule.pattern.as_str().len()),
            )
        });
        db
    }

    pub(crate) fn guess(&self, name: &str) -> &str {
        self.globs
            .iter()
            .find(|rule| {
                rule.pattern.matches_with(
                    name,
                    MatchOptions {
                        case_sensitive: rule.case_sensitive,
                        ..Default::default()
                    },
                )
            })
            .map_or("application/octet-stream", |rule| &rule.kind)
    }

    pub(crate) fn icon(&self, mime: &str) -> String {
        if mime == "inode/directory" {
            return "folder".into();
        }
        self.icons.get(mime).cloned().unwrap_or_else(|| {
            let media = mime
                .split_once('/')
                .map_or("application", |(media, _)| media);
            match media {
                "application" => "text-x-generic".into(),
                media => format!("{media}-x-generic"),
            }
        })
    }
}
