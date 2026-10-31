// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded desktop launch parsing. Never interprets a shell or expands caller text.
use super::{
    Error,
    catalogue::{self, App},
};
use glib::KeyFile;
use serde_json::json;
use std::path::PathBuf;
const GROUP: &str = "Desktop Entry";
pub struct Desktop {
    pub key: KeyFile,
    pub path: PathBuf,
    pub id: String,
}
impl Desktop {
    pub fn load(app: &App) -> Result<Self, Error> {
        let path = PathBuf::from(app.record["DesktopPath"].as_str().unwrap_or_default());
        let bytes = catalogue::bounded(&path, 256 * 1024).map_err(Error::Failed)?;
        if catalogue::hash(&bytes) != app.source_hash {
            return Err(Error::Stale("desktop file changed; refresh first".into()));
        }
        let key = KeyFile::new();
        key.load_from_data(
            std::str::from_utf8(&bytes).map_err(|_| Error::Invalid("desktop encoding".into()))?,
            glib::KeyFileFlags::KEEP_COMMENTS | glib::KeyFileFlags::KEEP_TRANSLATIONS,
        )
        .map_err(|_| Error::Invalid("desktop syntax".into()))?;
        if key.boolean(GROUP, "Hidden").unwrap_or(false)
            || key.string(GROUP, "Type").ok().as_deref() != Some("Application")
        {
            return Err(Error::Stale("desktop is no longer an application".into()));
        }
        let try_exec = key.string(GROUP, "TryExec").unwrap_or_default();
        if !try_exec.is_empty() && glib::find_program_in_path(&try_exec).is_none() {
            return Err(Error::Unavailable("TryExec unavailable".into()));
        }
        Ok(Self {
            key,
            path,
            id: app.id.clone(),
        })
    }
    pub fn string(&self, key: &str) -> String {
        self.key.string(GROUP, key).unwrap_or_default().to_string()
    }
    pub fn flag(&self, key: &str) -> bool {
        self.key.boolean(GROUP, key).unwrap_or(false)
    }
    pub fn actions(&self) -> Vec<String> {
        catalogue::strv(&self.key, GROUP, "Actions")
    }
    pub fn new_action(&self) -> Option<String> {
        self.actions()
            .into_iter()
            .find(|a| a.eq_ignore_ascii_case("new-window") || a == "NewWindow")
    }
    pub fn new_window(&self) -> &'static str {
        if self.flag("SingleMainWindow") {
            "unsupported"
        } else if self.new_action().is_some() {
            "declared-action"
        } else if self.flag("DBusActivatable") {
            "unsupported"
        } else {
            "relaunch"
        }
    }
    pub fn argv(&self, action: Option<&str>, uris: &[String]) -> Result<Vec<Vec<String>>, Error> {
        let group = action
            .map(|a| format!("Desktop Action {a}"))
            .unwrap_or_else(|| GROUP.into());
        let command = self
            .key
            .string(&group, "Exec")
            .map_err(|_| Error::Unsupported("desktop/action has no Exec".into()))?;
        let words = tokenize(&command)?;
        let file_codes = words
            .iter()
            .flat_map(|(s, _)| codes(s))
            .filter(|c| ['f', 'F', 'u', 'U'].contains(c))
            .collect::<Vec<_>>();
        if file_codes.len() > 1 {
            return Err(Error::Invalid("multiple desktop file fields".into()));
        }
        if !uris.is_empty() && file_codes.is_empty() {
            return Err(Error::Unsupported("app does not accept files/URIs".into()));
        }
        let field = file_codes.first().copied();
        let schemes = catalogue::strv(&self.key, GROUP, "MimeType");
        for uri in uris {
            glib::Uri::parse(uri, glib::UriFlags::NONE)
                .map_err(|_| Error::Invalid("invalid URI".into()))?;
            if matches!(field, Some('f' | 'F')) {
                local_file(uri)?;
            } else if !supports_uri(uri, &schemes) {
                return Err(Error::Unsupported(
                    "URI scheme is not declared by this app".into(),
                ));
            }
        }
        let name = self
            .key
            .locale_string(GROUP, "Name", None)
            .unwrap_or_default()
            .to_string();
        let icon = self.string("Icon");
        let batches: Vec<&[String]> = if matches!(field, Some('f' | 'u')) && !uris.is_empty() {
            uris.chunks(1).collect()
        } else {
            vec![uris]
        };
        batches
            .into_iter()
            .map(|batch| {
                let mut argv = Vec::new();
                for (word, quoted) in &words {
                    let fields = codes(word);
                    if *quoted && fields.iter().any(|c| *c != '%') {
                        return Err(Error::Invalid(
                            "field code in quoted desktop argument".into(),
                        ));
                    }
                    if ["%f", "%F", "%u", "%U"].contains(&word.as_str()) {
                        for uri in batch {
                            argv.push(if word.contains('f') || word.contains('F') {
                                local_file(uri)?
                                    .to_str()
                                    .ok_or_else(|| {
                                        Error::Unsupported("non-UTF-8 local filename".into())
                                    })?
                                    .to_owned()
                            } else {
                                uri.clone()
                            });
                        }
                    } else if word == "%i" {
                        if !icon.is_empty() {
                            argv.extend(["--icon".into(), icon.clone()]);
                        }
                    } else {
                        let mut out = String::new();
                        let mut chars = word.chars();
                        while let Some(c) = chars.next() {
                            if c != '%' {
                                out.push(c);
                                continue;
                            }
                            match chars.next() {
                                Some('%') => out.push('%'),
                                Some('c') => out.push_str(&name),
                                Some('k') => out.push_str(self.path.to_str().ok_or_else(|| {
                                    Error::Unsupported("non-UTF-8 desktop path".into())
                                })?),
                                Some('d' | 'D' | 'n' | 'N' | 'v' | 'm') => {}
                                Some('f' | 'F' | 'u' | 'U' | 'i') => {
                                    return Err(Error::Invalid(
                                        "file/icon field must be a separate argument".into(),
                                    ));
                                }
                                _ => {
                                    return Err(Error::Invalid(
                                        "unknown desktop field code".into(),
                                    ));
                                }
                            }
                        }
                        if !out.is_empty() || word.is_empty() {
                            argv.push(out);
                        }
                    }
                }
                if argv.is_empty() || argv[0].contains('=') || argv[0].is_empty() {
                    return Err(Error::Invalid("invalid desktop executable".into()));
                }
                let program = glib::find_program_in_path(&argv[0])
                    .ok_or_else(|| Error::NotFound("desktop executable not found".into()))?;
                argv[0] = program
                    .to_str()
                    .ok_or_else(|| Error::Unsupported("non-UTF-8 executable path".into()))?
                    .to_owned();
                Ok(argv)
            })
            .collect()
    }
    pub fn cwd(&self) -> Result<PathBuf, Error> {
        let p = self.string("Path");
        let p = if p.is_empty() {
            catalogue::home()
        } else {
            PathBuf::from(p)
        };
        if !p.is_absolute() || !p.is_dir() {
            return Err(Error::Invalid(
                "desktop working directory unavailable".into(),
            ));
        }
        Ok(p)
    }
}
fn codes(s: &str) -> Vec<char> {
    let mut v = vec![];
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            v.push(chars.next().unwrap_or('\0'));
        }
    }
    v
}
/// Desktop quoting, not shell grammar. General key-file escapes were decoded by GLib.
fn tokenize(s: &str) -> Result<Vec<(String, bool)>, Error> {
    if s.len() > 64 * 1024 || s.contains('\0') {
        return Err(Error::Invalid("Exec budget/encoding".into()));
    }
    let mut v = vec![];
    let mut word = String::new();
    let (mut quote, mut had_quote, mut used) = (false, false, false);
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quote = !quote;
                had_quote = true;
                used = true;
            }
            '\\' => {
                let n = chars
                    .next()
                    .ok_or_else(|| Error::Invalid("trailing Exec escape".into()))?;
                if quote && !['"', '`', '$', '\\'].contains(&n) {
                    word.push('\\');
                }
                word.push(n);
                used = true;
            }
            ' ' | '\t' if !quote => {
                if used {
                    v.push((std::mem::take(&mut word), had_quote));
                    had_quote = false;
                    used = false;
                }
            }
            '\n' | '\r' => return Err(Error::Invalid("Exec newline".into())),
            '\'' | '`' | '$' | '>' | '<' | '~' | '|' | '&' | ';' | '*' | '?' | '#' | '(' | ')'
                if !quote =>
            {
                return Err(Error::Invalid("unquoted reserved Exec character".into()));
            }
            _ => {
                word.push(c);
                used = true;
            }
        }
    }
    if quote {
        return Err(Error::Invalid("unclosed Exec quote".into()));
    }
    if used {
        v.push((word, had_quote));
    }
    if v.is_empty() || v.len() > 1024 {
        return Err(Error::Invalid("Exec argument budget".into()));
    }
    Ok(v)
}
pub fn supports_uri(uri: &str, mimes: &[String]) -> bool {
    let Ok(uri_value) = glib::Uri::parse(uri, glib::UriFlags::NONE) else {
        return false;
    };
    let scheme = uri_value.scheme().to_ascii_lowercase();
    if scheme == "trash" {
        return uri == "trash:///" && mimes.iter().any(|m| m == "inode/directory");
    }
    scheme == "file"
        || mimes
            .iter()
            .any(|m| m == &format!("x-scheme-handler/{scheme}"))
}
pub fn local_file(uri: &str) -> Result<PathBuf, Error> {
    let (p, h) = glib::filename_from_uri(uri)
        .map_err(|_| Error::Unsupported("requires local file URI".into()))?;
    if !p.is_absolute() || h.is_some_and(|s| s != "localhost") {
        return Err(Error::Unsupported("requires local file URI".into()));
    }
    Ok(p)
}
/// No Debug implementation: request tokens and URIs must not enter diagnostics.
#[derive(Clone)]
pub struct Request {
    pub mode: String,
    pub action: String,
    pub uris: Vec<String>,
    pub token: String,
    pub nonce: String,
}
impl Request {
    pub fn parse(mut r: super::Dict, directory: bool) -> Result<Self, Error> {
        if r.len() > 5
            || r.keys().any(|k| {
                !if directory {
                    ["ActivationToken", "RequestId"].contains(&k.as_str())
                } else {
                    ["Mode", "Action", "Uris", "ActivationToken", "RequestId"].contains(&k.as_str())
                }
            })
        {
            return Err(Error::Invalid("unknown launch request key".into()));
        }
        fn string(r: &mut super::Dict, k: &str) -> Result<String, Error> {
            r.remove(k)
                .map(|v| {
                    String::try_from(v)
                        .map_err(|_| Error::Invalid("launch key must be string".into()))
                })
                .transpose()
                .map(Option::unwrap_or_default)
        }
        let mode = string(&mut r, "Mode")?;
        let mode = if mode.is_empty() {
            "activate".into()
        } else {
            mode
        };
        if !["activate", "new-window", "action", "open"].contains(&mode.as_str()) {
            return Err(Error::Invalid("unknown launch mode".into()));
        }
        let action = string(&mut r, "Action")?;
        let token = string(&mut r, "ActivationToken")?;
        let nonce = string(&mut r, "RequestId")?;
        let uris = r
            .remove("Uris")
            .map(|v| {
                Vec::<String>::try_from(v)
                    .map_err(|_| Error::Invalid("Uris must be string array".into()))
            })
            .transpose()?
            .unwrap_or_default();
        if action.len() > 1024
            || token.len() > 8192
            || nonce.len() > 128
            || [&action, &token, &nonce].iter().any(|s| s.contains('\0'))
            || uris.len() > 128
            || uris.iter().map(String::len).sum::<usize>() > 256 * 1024
        {
            return Err(Error::Invalid("launch request budget".into()));
        }
        if (mode == "action") != !action.is_empty() || (mode == "open") != !uris.is_empty() {
            return Err(Error::Invalid(
                "Action/Uris do not match launch mode".into(),
            ));
        }
        for u in &uris {
            if u.contains('\0') || glib::Uri::parse(u, glib::UriFlags::NONE).is_err() {
                return Err(Error::Invalid("Uris must be absolute valid URIs".into()));
            }
        }
        Ok(Self {
            mode,
            action,
            uris,
            token,
            nonce,
        })
    }
    pub fn fingerprint(&self, id: &str, generation: u64) -> String {
        catalogue::hash(
            json!([
                id,
                generation,
                self.mode,
                self.action,
                self.uris,
                self.token
            ])
            .to_string()
            .as_bytes(),
        )
    }
}
/// Resolve terminal preference without running a helper or inheriting its cgroup.
pub fn terminal(apps: &std::collections::BTreeMap<String, App>) -> Result<Vec<String>, Error> {
    let config = super::autostart::config_home();
    let mut names = vec![];
    for desktop in std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty() && !d.contains('/'))
    {
        names.push(format!("{}-xdg-terminals.list", desktop.to_lowercase()));
    }
    names.push("xdg-terminals.list".into());
    let dirs = std::iter::once(config).chain(
        std::env::var("XDG_CONFIG_DIRS")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "/etc/xdg".into())
            .split(':')
            .filter(|p| p.starts_with('/'))
            .map(PathBuf::from)
            .collect::<Vec<_>>(),
    );
    let mut candidates = vec![];
    let mut excluded = std::collections::BTreeSet::new();
    for dir in dirs {
        for name in &names {
            if let Ok(bytes) = catalogue::bounded(&dir.join(name), 64 * 1024) {
                for line in String::from_utf8_lossy(&bytes)
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty() && !l.starts_with('#'))
                {
                    if let Some(id) = line.strip_prefix('-') {
                        excluded.insert(id.to_owned());
                    } else if !line.contains(':') {
                        candidates.push(line.trim_start_matches('+').to_owned());
                    }
                }
            }
        }
    }
    candidates.extend(apps.keys().cloned());
    for id in candidates {
        if excluded.contains(&id) {
            continue;
        }
        let Some(app) = apps.get(&id) else { continue };
        let Ok(d) = Desktop::load(app) else { continue };
        if !catalogue::strv(&d.key, GROUP, "Categories")
            .iter()
            .any(|s| s == "TerminalEmulator")
        {
            continue;
        }
        let Ok(mut argv) = d.argv(None, &[]).and_then(|v| {
            v.into_iter()
                .next()
                .ok_or_else(|| Error::Unsupported("terminal Exec missing".into()))
        }) else {
            continue;
        };
        let arg = [
            "TerminalArgExec",
            "X-TerminalArgExec",
            "ExecArg",
            "X-ExecArg",
        ]
        .iter()
        .find_map(|k| d.key.string(GROUP, k).ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "-e".into());
        if !arg.is_empty() {
            argv.push(arg);
        }
        return Ok(argv);
    }
    Err(Error::Unavailable(
        "no supported terminal emulator preference".into(),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting_and_literal_fields() {
        assert_eq!(
            tokenize(r#"/bin/echo "a b" "\\$x" %% %U"#).unwrap().len(),
            5
        );
        assert!(tokenize("echo ;rm").is_err());
        assert!(tokenize("echo \"no").is_err());
        assert_eq!(codes("%%f %U"), vec!['%', 'U']);
    }
    #[test]
    fn fit_request_schema() {
        let mut d = super::super::Dict::new();
        d.insert("Unknown".into(), true.into());
        assert!(Request::parse(d, false).is_err());
    }
}
#[cfg(test)]
mod expansion_tests {
    use super::*;
    fn desktop(exec: &str) -> Desktop {
        let key = KeyFile::new();
        key.set_string(GROUP, "Type", "Application");
        key.set_string(GROUP, "Exec", exec);
        key.set_string(GROUP, "Name", "Name %U with space");
        key.set_string(GROUP, "Icon", "some-icon");
        key.set_string(GROUP, "MimeType", "x-scheme-handler/https;");
        Desktop {
            key,
            path: PathBuf::from("/some path/Test.desktop"),
            id: "Test.desktop".into(),
        }
    }
    #[test]
    fn fields_expand_once_and_do_not_interpret_text() {
        let d = desktop("/usr/bin/echo %c %k %i %% \"${HOME};literal\"");
        let a = d.argv(None, &[]).unwrap();
        assert_eq!(
            &a[0][1..],
            [
                "Name %U with space",
                "/some path/Test.desktop",
                "--icon",
                "some-icon",
                "%",
                "${HOME};literal"
            ]
        );
    }
    #[test]
    fn file_fields_multiplicity_uri_fidelity_and_rejection() {
        let uris = vec!["file:///tmp/a%20b".into(), "file:///tmp/%25U".into()];
        let d = desktop("/usr/bin/echo %f");
        let a = d.argv(None, &uris).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0][1], "/tmp/a b");
        assert_eq!(a[1][1], "/tmp/%U");
        let d = desktop("/usr/bin/echo %F");
        assert_eq!(
            &d.argv(None, &uris).unwrap()[0][1..],
            ["/tmp/a b", "/tmp/%U"]
        );
        assert!(d.argv(None, &["https://example.invalid/".into()]).is_err());
        let d = desktop("/usr/bin/echo %U");
        let u = vec!["https://example.invalid/a%20b?q=%25U".into()];
        assert_eq!(d.argv(None, &u).unwrap()[0][1], u[0]);
        assert!(d.argv(None, &["strange://host/".into()]).is_err());
    }
    #[test]
    fn invalid_fields_and_undefined_quoting_fail_closed() {
        for exec in [
            "/usr/bin/echo %Z",
            "/usr/bin/echo %f %U",
            "/usr/bin/echo \"%U\"",
            "/usr/bin/echo prefix%F",
            "/usr/bin/echo %",
        ] {
            assert!(desktop(exec).argv(None, &[]).is_err(), "{exec}");
        }
        assert!(
            desktop("/usr/bin/echo")
                .argv(None, &["file:///tmp/a".into()])
                .is_err()
        );
    }
}
