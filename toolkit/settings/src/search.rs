// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings owns the index and ordinary results page; the kit owns suggestions.
use crate::{
    exports::Exports,
    manifest::{Item, Page},
    session::Store,
};
use nk_widgets::{Kind, NodeId, Result, Tree};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;
fn normalized(text: &str) -> String {
    text.nfd()
        // Fold common accents without discarding script-specific marks such as dakuten.
        .filter(|c| !matches!(c, '\u{0300}'..='\u{036f}'))
        .flat_map(char::to_lowercase)
        .collect()
}
pub const ALL: u64 = u64::MAX;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    pub page: String,
    pub page_label: String,
    pub label: String,
    pub subtitle: String,
    pub is_page: bool,
}
pub fn find(exports: &Exports, store: Option<&Store>, query: &str) -> Result<Vec<Match>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let words: Vec<_> = query.split_whitespace().map(normalized).collect();
    let mut all = vec![];
    let mut seen = HashSet::new();
    for page in &exports.pages {
        let page_label = exports.text(&page.label)?.to_owned();
        if page.parent.is_none() {
            all.push(Match {
                page: page.id.clone(),
                page_label: page_label.clone(),
                label: page_label.clone(),
                subtitle: String::new(),
                is_page: true,
            });
        }
        fn visit(
            exports: &Exports,
            store: Option<&Store>,
            page: &Page,
            page_label: &str,
            items: &[Item],
            out: &mut Vec<Match>,
            seen: &mut HashSet<(String, String)>,
        ) -> Result<()> {
            for item in items {
                let label = match item {
                    Item::Key { key, .. } => store
                        .and_then(|s| s.key(key))
                        .filter(|k| k.available)
                        .and_then(|k| k.entry["ui"]["title"].as_str())
                        .map(str::to_owned),
                    Item::Custom {
                        i18n: Some(label), ..
                    }
                    | Item::Disclosure { i18n: label, .. } => Some(exports.text(label)?.to_owned()),
                    _ => None,
                };
                if let Some(label) = label
                    && seen.insert((page.id.clone(), label.clone()))
                {
                    let subtitle = item
                        .key()
                        .and_then(|key| store?.key(key)?.entry["ui"]["subtitle"].as_str())
                        .unwrap_or("")
                        .to_owned();
                    out.push(Match {
                        page: page.id.clone(),
                        page_label: page_label.into(),
                        label,
                        subtitle,
                        is_page: false,
                    });
                }
                if let Item::Disclosure {
                    items: children, ..
                } = item
                {
                    visit(exports, store, page, page_label, children, out, seen)?;
                }
            }
            Ok(())
        }
        for group in &page.groups {
            visit(
                exports,
                store,
                page,
                &page_label,
                &group.items,
                &mut all,
                &mut seen,
            )?;
        }
    }
    // Includes builder-owned registry rows which have no individual manifest item.
    if let Some(store) = store {
        for (_, entry) in store.keys().filter(|(_, k)| k.available) {
            let Some(page) = entry.entry["page"].as_str().and_then(|id| exports.page(id)) else {
                continue;
            };
            let Some(label) = entry.entry["ui"]["title"].as_str() else {
                continue;
            };
            if seen.insert((page.id.clone(), label.into())) {
                all.push(Match {
                    page: page.id.clone(),
                    page_label: exports.text(&page.label)?.into(),
                    label: label.into(),
                    subtitle: entry.entry["ui"]["subtitle"].as_str().unwrap_or("").into(),
                    is_page: false,
                });
            }
        }
    }
    all.retain(|m| {
        let text = normalized(&format!("{} {} {}", m.label, m.subtitle, m.page_label));
        words.iter().all(|word| text.contains(word))
    });
    all.sort_by_key(|m| !m.is_page);
    Ok(all)
}
pub fn suggestions(
    matches: &[Match],
    exports: &Exports,
) -> Result<Vec<nk_widgets::suggestions::Suggestion>> {
    let mut values: Vec<_> = matches
        .iter()
        .take(8)
        .enumerate()
        .map(|(at, m)| nk_widgets::suggestions::Suggestion {
            key: at as u64,
            label: m.label.clone(),
            description: if m.is_page {
                String::new()
            } else {
                m.page_label.clone()
            },
        })
        .collect();
    values.push(nk_widgets::suggestions::Suggestion {
        key: ALL,
        label: exports
            .text("settings.search.view-all")?
            .replace("{count}", &matches.len().to_string()),
        description: if matches.is_empty() {
            exports.text("settings.search.no-results")?.into()
        } else {
            String::new()
        },
    });
    Ok(values)
}
pub struct Results {
    pub root: NodeId,
    rows: HashMap<NodeId, String>,
    pub query: String,
}
impl Results {
    pub fn build(
        tree: &mut Tree,
        content: NodeId,
        exports: &Exports,
        query: &str,
        matches: &[Match],
    ) -> Result<Self> {
        let root = tree.group(content, exports.text("settings.search.results")?)?;
        let mut rows = HashMap::new();
        if matches.is_empty() {
            let row = tree.append(root, Kind::Row, "")?;
            tree.append(
                row,
                Kind::Label,
                exports.text("settings.search.no-results")?,
            )?;
        }
        for m in matches {
            let (row, button) = tree.row(root, &m.label, Kind::Button)?;
            tree.set_name(button, &m.page_label)?;
            if !m.subtitle.is_empty() {
                tree.set_subtitle(row, Some(&m.subtitle))?;
            }
            rows.insert(button, m.page.clone());
        }
        Ok(Self {
            root,
            rows,
            query: query.into(),
        })
    }
    pub fn target(&self, id: NodeId) -> Option<&str> {
        self.rows.get(&id).map(String::as_str)
    }
}

#[cfg(test)]
mod normalization_tests {
    use super::normalized;
    #[test]
    fn matches_accents_case_and_decomposed_unicode() {
        assert_eq!(normalized("Configuración"), normalized("CONFIGURACION"));
        assert_eq!(normalized("CAFÉ"), normalized("cafe\u{301}"));
        assert_eq!(normalized("日本語"), "日本語");
    }
    #[test]
    fn preserves_japanese_voicing_and_other_script_marks() {
        assert_ne!(normalized("がめん"), normalized("かめん"));
        assert_eq!(normalized("がめん"), normalized("か\u{3099}めん"));
        assert_ne!(normalized("ぱ"), normalized("は"));
        assert_ne!(normalized("بَ"), normalized("ب"));
    }
}
