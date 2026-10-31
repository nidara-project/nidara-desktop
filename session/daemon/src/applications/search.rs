// SPDX-License-Identifier: GPL-3.0-or-later
//! Same ranking tiers as app-search.ts; identity never uses fuzzy search.
use super::catalogue::App;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
fn fold(s: &str) -> String {
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}
fn starts(s: &str) -> Vec<bool> {
    let c: Vec<_> = s.chars().collect();
    c.iter()
        .enumerate()
        .map(|(i, x)| {
            x.is_alphanumeric()
                && (i == 0
                    || !c[i - 1].is_alphanumeric()
                    || ((c[i - 1].is_lowercase() || c[i - 1].is_numeric()) && x.is_uppercase()))
        })
        .collect()
}
fn field(q: &str, s: &str, substring: bool, acronym: bool) -> f64 {
    let f = fold(s);
    if f.is_empty() {
        return 0.0;
    }
    let nudge = (f.chars().count().saturating_sub(q.chars().count()).min(99) as f64) / 100.0;
    if f == q {
        return 1000.0;
    }
    if f.starts_with(q) {
        return 900.0 - nudge;
    }
    let chars: Vec<_> = s.chars().collect();
    let boundaries = starts(s);
    for (i, _) in chars.iter().enumerate() {
        if boundaries[i] && fold(&chars[i..].iter().collect::<String>()).starts_with(q) {
            return 800.0 - nudge;
        }
    }
    if q.chars().count() < 2 {
        return 0.0;
    }
    if substring && f.contains(q) {
        return 600.0 - nudge;
    }
    if !acronym {
        return 0.0;
    }
    let folded: Vec<_> = chars.iter().map(|c| fold(&c.to_string())).collect();
    let mut at = None;
    for needle in q.chars() {
        let found = (at.map_or(0, |i| i + 1)..chars.len()).find(|i| {
            folded[*i].starts_with(needle) && (at.is_some_and(|a| *i == a + 1) || boundaries[*i])
        });
        if let Some(i) = found {
            at = Some(i);
        } else {
            return 0.0;
        }
    }
    400.0 - nudge
}
fn tokens(s: &str) -> Vec<String> {
    let mut out = String::new();
    let mut prev = ' ';
    for c in s.chars() {
        if c.is_uppercase() && (prev.is_lowercase() || prev.is_ascii_digit())
            || c.is_ascii_digit() != prev.is_ascii_digit()
        {
            out.push(' ');
        }
        out.push(c);
        prev = c;
    }
    out.split(|c: char| !c.is_alphanumeric())
        .map(fold)
        .filter(|s| {
            !s.is_empty() && !["org", "com", "io", "net", "app", "desktop"].contains(&s.as_str())
        })
        .collect()
}
pub fn score(q: &str, a: &App) -> f64 {
    let q = fold(q.trim());
    if q.is_empty() {
        return 0.0;
    }
    let mut best = field(&q, a.name(), true, true)
        .max(field(&q, a.id.trim_end_matches(".desktop"), false, true) * 0.85);
    best = best.max(field(&q, &a.executable, true, false) * 0.78);
    for keyword in &a.keywords {
        best = best.max(field(&q, keyword, true, false) * 0.65);
    }
    if best > 0.0 {
        return best;
    }
    let wanted = tokens(&q);
    if !wanted.is_empty()
        && [a.name(), a.id.as_str()].iter().any(|s| {
            let t = tokens(s);
            !t.is_empty() && t.iter().all(|x| wanted.contains(x))
        })
    {
        100.0
    } else {
        0.0
    }
}
pub fn rank<'a>(
    q: &str,
    apps: impl Iterator<Item = &'a App>,
    hidden: bool,
    limit: usize,
) -> Vec<&'a App> {
    let mut matches: Vec<_> = apps
        .filter(|a| hidden || a.visible())
        .filter_map(|a| {
            let s = score(q, a);
            (q.trim().is_empty() || s > 0.0).then_some((
                a,
                s + if q.trim().is_empty() {
                    0.0
                } else {
                    a.record["ForegroundScore"].as_f64().unwrap_or(0.0) * 0.45
                },
            ))
        })
        .collect();
    matches.sort_by(|(a, sa), (b, sb)| {
        sb.total_cmp(sa)
            .then_with(|| {
                b.record["ForegroundScore"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a.record["ForegroundScore"].as_f64().unwrap_or(0.0))
            })
            .then_with(|| {
                glib::CollationKey::from(a.name()).cmp(&glib::CollationKey::from(b.name()))
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    matches.into_iter().take(limit).map(|(a, _)| a).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiers_and_unicode() {
        assert_eq!(field("configuracion", "Configuración", true, true), 1000.0);
        assert_eq!(field("fire", "Reddit", true, true), 0.0);
        assert!(field("gwf", "GTK Widget Factory", true, true) > 0.0);
        assert_eq!(field("a", "Calculator", true, true), 0.0);
        assert!(
            field("calc", "Calculator", true, true) > field("calc", "My calculator", true, true)
        );
    }
    #[test]
    fn usage_is_bounded_below_lexical_tiers_and_new_is_not_a_rank() {
        fn app(id: &str, name: &str, score: f64) -> App {
            App {
                id: id.into(),
                generation: 1,
                digest: String::new(),
                source_hash: String::new(),
                exec_hash: String::new(),
                record: serde_json::json!({"Name":name,"Visible":true,"ForegroundScore":score,"IsNew":false}),
                executable: String::new(),
                keywords: vec![],
                icon: String::new(),
            }
        }
        let mut apps = [
            app("A.desktop", "Calc", 0.0),
            app("B.desktop", "Calculator", 1.0),
        ];
        assert_eq!(rank("Calc", apps.iter(), false, 10)[0].id, "A.desktop");
        assert_eq!(rank("", apps.iter(), false, 10)[0].id, "B.desktop");
        apps[0].record["IsNew"] = serde_json::json!(true);
        assert_eq!(rank("", apps.iter(), false, 10)[0].id, "B.desktop");
    }
}
