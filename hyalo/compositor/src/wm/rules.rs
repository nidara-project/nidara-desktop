//! Window rules (`[rules.NAME]` in hyalo.toml): match a window by app id and title, float it,
//! centre it, send it to a workspace.
//!
//! 🔑 **A rule applies once to a window, the first time it matches** — before the window's
//! first configure, when it is first shown, or later when its app id or title changes. That
//! is the difference from Hyprland's rules (#679 item 13), and the reason for it: a static
//! effect there is matched ONCE, at open, against the name the window was BORN with, while
//! GTK windows (ours among them) take their real app id when they are mapped — a rule naming
//! it never fired, and the shell had to match its About window by title (config/hypr/
//! hyprland.lua, `float-about`). Here a rule that starts matching late still applies; one
//! that stops matching undoes nothing; and one that has applied never applies again, so a
//! window the user unfloats stays where the user put it, however often it renames itself.
//!
//! Matching is a regex SEARCH in each field given (`^…$` for the whole string), every field
//! given must match, and the rules are applied in name order: where two set the same thing,
//! the later name wins.

use std::collections::BTreeMap;

use regex_automata::meta::Regex;

use super::WindowId;
use crate::{Hyalo, config::RuleConfig};

#[derive(Debug, Clone, PartialEq)]
pub enum RuleWorkspace {
    Number(i32),
    Special(String),
}

/// What the rules that matched ask for, merged.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Effects {
    pub float: Option<bool>,
    pub center: bool,
    pub workspace: Option<RuleWorkspace>,
    pub silent: bool,
}

impl Effects {
    pub fn is_empty(&self) -> bool {
        *self == Effects::default()
    }

    /// `later` on top of these.
    fn add(&mut self, later: &Effects) {
        if later.float.is_some() {
            self.float = later.float;
        }
        self.center |= later.center;
        if later.workspace.is_some() {
            self.workspace = later.workspace.clone();
            self.silent = later.silent;
        }
    }
}

#[derive(Debug)]
pub struct Rule {
    pub name: String,
    app_id: Option<Regex>,
    title: Option<Regex>,
    initial_app_id: Option<Regex>,
    initial_title: Option<Regex>,
    pub effects: Effects,
}

/// What a window is called, now and when it was first shown.
pub struct Subject<'a> {
    pub app_id: &'a str,
    pub title: &'a str,
    pub initial_app_id: &'a str,
    pub initial_title: &'a str,
}

impl Rule {
    pub fn matches(&self, s: &Subject) -> bool {
        let ok = |re: &Option<Regex>, text: &str| re.as_ref().is_none_or(|re| re.is_match(text));
        ok(&self.app_id, s.app_id)
            && ok(&self.title, s.title)
            && ok(&self.initial_app_id, s.initial_app_id)
            && ok(&self.initial_title, s.initial_title)
    }
}

/// The enabled rules, checked, in name order.
pub fn compile(cfg: &BTreeMap<String, RuleConfig>) -> Result<Vec<Rule>, String> {
    let mut out = Vec::new();
    for (name, r) in cfg {
        if !r.enabled {
            continue;
        }
        let re = |field: &str, p: &Option<String>| -> Result<Option<Regex>, String> {
            p.as_deref()
                .map(|p| Regex::new(p).map_err(|e| format!("rules.{name}.match.{field}: {e}")))
                .transpose()
        };
        let m = &r.matching;
        let rule = Rule {
            name: name.clone(),
            app_id: re("app_id", &m.app_id)?,
            title: re("title", &m.title)?,
            initial_app_id: re("initial_app_id", &m.initial_app_id)?,
            initial_title: re("initial_title", &m.initial_title)?,
            effects: Effects {
                float: r.float,
                center: r.center,
                workspace: r.workspace.as_deref().map(|w| parse_workspace(name, w)).transpose()?,
                silent: r.silent,
            },
        };
        if rule.app_id.is_none() && rule.title.is_none() && rule.initial_app_id.is_none() && rule.initial_title.is_none() {
            return Err(format!("rules.{name}: matches nothing (give match.app_id, title, initial_app_id or initial_title)"));
        }
        if rule.effects.is_empty() {
            return Err(format!("rules.{name}: does nothing (give float, center or workspace)"));
        }
        if r.silent && r.workspace.is_none() {
            return Err(format!("rules.{name}: silent without a workspace"));
        }
        out.push(rule);
    }
    Ok(out)
}

fn parse_workspace(rule: &str, w: &str) -> Result<RuleWorkspace, String> {
    if let Some(name) = w.strip_prefix("special:") {
        if name.is_empty() {
            return Err(format!("rules.{rule}.workspace: special: needs a name"));
        }
        return Ok(RuleWorkspace::Special(name.into()));
    }
    match w.parse::<i32>() {
        Ok(n) if n > 0 => Ok(RuleWorkspace::Number(n)),
        _ => Err(format!("rules.{rule}.workspace: {w:?} is not a workspace (1, 2… or special:NAME)")),
    }
}

impl Hyalo {
    /// The effects of the rules that match `id` now and have not applied to it yet. `apply`
    /// marks them applied; without it this only looks (the first configure, before the
    /// window is shown, asks what the rules will want).
    pub(super) fn new_rule_effects(&mut self, id: WindowId, apply: bool) -> Effects {
        let Some(m) = self.wm.get(id) else { return Effects::default() };
        let (app_id, title) = (super::app_id(&m.window), super::title(&m.window));
        // Before it is shown, what it is called now is what it was first called.
        let (initial_app_id, initial_title) =
            if m.mapped { (m.initial_app_id.as_str(), m.initial_title.as_str()) } else { (app_id.as_str(), title.as_str()) };
        let subject = Subject { app_id: &app_id, title: &title, initial_app_id, initial_title };
        let mut fx = Effects::default();
        let mut names = Vec::new();
        for rule in &self.rules {
            if !m.rules_applied.contains(&rule.name) && rule.matches(&subject) {
                fx.add(&rule.effects);
                names.push(rule.name.clone());
            }
        }
        if apply && !names.is_empty() {
            tracing::debug!(id, %app_id, %title, rules = ?names, "window rules apply");
            self.wm.get_mut(id).unwrap().rules_applied.extend(names);
        }
        fx
    }

    /// The workspace a rule names, created on `output` if it does not exist yet.
    pub(super) fn rule_workspace(&mut self, w: &RuleWorkspace, output: &str) -> i32 {
        match w {
            RuleWorkspace::Number(n) => {
                self.ensure_workspace(*n, output);
                *n
            }
            RuleWorkspace::Special(name) => self.ensure_special(name, output),
        }
    }

    /// A shown window renamed itself (app id or title): the rules that match it now for the
    /// first time apply, as they would have had it opened with this name.
    pub fn apply_late_rules(&mut self, id: WindowId) {
        if !self.wm.get(id).is_some_and(|m| m.mapped) {
            return;
        }
        let fx = self.new_rule_effects(id, true);
        if fx.is_empty() {
            return;
        }
        if let Some(w) = &fx.workspace {
            let output = self.focused_output().map(|o| o.name()).unwrap_or_default();
            let ws = self.rule_workspace(w, &output);
            self.move_to_workspace(id, ws, !fx.silent);
        }
        if let Some(f) = fx.float {
            self.set_floating(id, f);
        }
        if fx.center && self.wm.get(id).is_some_and(|m| m.floating) {
            let _ = self.center(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(toml_text: &str) -> Result<Vec<Rule>, String> {
        #[derive(serde::Deserialize)]
        struct T {
            rules: BTreeMap<String, RuleConfig>,
        }
        compile(&toml::from_str::<T>(toml_text).map_err(|e| e.to_string())?.rules)
    }

    fn subject<'a>(app_id: &'a str, title: &'a str) -> Subject<'a> {
        Subject { app_id, title, initial_app_id: "org.nidara.desktop", initial_title: title }
    }

    #[test]
    fn a_rule_matches_every_field_it_gives() {
        let r = rules(r#"
            [rules.about]
            match = { app_id = "^nidara-about$" }
            float = true
            center = true
            [rules.born]
            match = { initial_app_id = "^org\\.nidara\\.desktop$", title = "^About" }
            workspace = "special:about"
            silent = true
        "#)
        .unwrap();
        assert!(r[0].matches(&subject("nidara-about", "About Nidara")));
        assert!(!r[0].matches(&subject("nidara-about-x", "About Nidara")), "anchored: the whole string");
        assert!(r[1].matches(&subject("anything", "About Nidara")));
        assert!(!r[1].matches(&subject("anything", "Settings")), "every field given must match");
        assert_eq!(r[1].effects.workspace, Some(RuleWorkspace::Special("about".into())));
    }

    #[test]
    fn later_names_win() {
        let r = rules(r#"
            [rules.a]
            match = { app_id = "x" }
            float = true
            workspace = "2"
            [rules.b]
            match = { app_id = "x" }
            float = false
            center = true
        "#)
        .unwrap();
        let mut fx = Effects::default();
        for rule in &r {
            fx.add(&rule.effects);
        }
        assert_eq!(fx, Effects { float: Some(false), center: true, workspace: Some(RuleWorkspace::Number(2)), silent: false });
    }

    #[test]
    fn bad_rules_are_refused_and_disabled_ones_skipped() {
        assert!(rules("[rules.a]\nfloat = true\n").is_err(), "matches nothing");
        assert!(rules("[rules.a]\nmatch = { app_id = \"x\" }\n").is_err(), "does nothing");
        assert!(rules("[rules.a]\nmatch = { app_id = \"(\" }\nfloat = true\n").is_err(), "bad regex");
        assert!(rules("[rules.a]\nmatch = { app_id = \"x\" }\nworkspace = \"0\"\n").is_err());
        assert!(rules("[rules.a]\nmatch = { app_id = \"x\" }\nfloat = true\nsilent = true\n").is_err());
        assert!(rules("[rules.a]\nmatch = { app_id = \"x\" }\nfloat = true\nbogus = 1\n").is_err(), "unknown key");
        let r = rules("[rules.a]\nenabled = false\nmatch = { app_id = \"x\" }\nfloat = true\n").unwrap();
        assert!(r.is_empty());
    }
}
