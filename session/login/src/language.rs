//! The language chosen on the login screen (#1195 L4): it becomes the person's.
//!
//! The screen is an unprivileged client, so what it names is checked here before anything is
//! done with it: it must be a locale the system has generated (`locale -a`), spelled as
//! locale.conf spells it. Then, as GDM does, it goes to AccountsService (the system's record
//! of the person's language), and the session starts in it, told to keep it
//! (`NIDARA_LOGIN_LANGUAGE`): the session's own daemon makes it the person's desktop
//! language (#1197), the one setting Settings → Language & region shows.

use zbus::{Connection, zvariant::OwnedObjectPath};

/// `lang` when the system has it, as locale.conf spells it.
pub fn checked(lang: &str) -> Option<String> {
    let listed = std::process::Command::new("locale")
        .arg("-a")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())?;
    let want = spelled(lang);
    listed
        .lines()
        .map(|l| spelled(l.trim()))
        .find(|l| *l == want && l.contains('.') && !l.starts_with("C.") && l != "POSIX")
}

fn spelled(l: &str) -> String {
    match l.rsplit_once('.') {
        Some((name, enc))
            if enc.eq_ignore_ascii_case("utf8") || enc.eq_ignore_ascii_case("utf-8") =>
        {
            format!("{name}.UTF-8")
        }
        _ => l.to_owned(),
    }
}

/// What the session starts with: the locale, gettext's list (`es_ES`), and the word to keep it.
pub fn env(lang: &str) -> Vec<(String, String)> {
    let (locale, modifier) = lang.split_once('@').unwrap_or((lang, ""));
    let name = locale.split_once('.').map_or(locale, |(name, _)| name);
    let language = if modifier.is_empty() {
        name.to_owned()
    } else {
        format!("{name}@{modifier}")
    };
    vec![
        ("LANG".into(), lang.into()),
        ("LANGUAGE".into(), language),
        ("NIDARA_LOGIN_LANGUAGE".into(), lang.into()),
    ]
}

/// AccountsService's `SetLanguage` for `user`: root may, without asking.
pub async fn record(bus: &Connection, user: &str, lang: &str) -> zbus::Result<()> {
    const DEST: &str = "org.freedesktop.Accounts";
    let accounts = zbus::Proxy::new(bus, DEST, "/org/freedesktop/Accounts", DEST).await?;
    let path: OwnedObjectPath = accounts.call("FindUserByName", &(user,)).await?;
    let person = zbus::Proxy::new(bus, DEST, path, "org.freedesktop.Accounts.User").await?;
    person.call::<_, _, ()>("SetLanguage", &(lang,)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_gets_the_locale_and_gettexts_list() {
        let env = env("es_ES.UTF-8");
        assert_eq!(env[0], ("LANG".into(), "es_ES.UTF-8".into()));
        assert_eq!(env[1], ("LANGUAGE".into(), "es_ES".into()));
        assert_eq!(env[2].0, "NIDARA_LOGIN_LANGUAGE");
        assert_eq!(super::env("sr_RS.UTF-8@latin")[1].1, "sr_RS@latin");
    }

    #[test]
    fn a_locale_is_spelled_as_locale_conf_spells_it() {
        assert_eq!(spelled("es_ES.utf8"), "es_ES.UTF-8");
        assert_eq!(spelled("es_ES.UTF-8"), "es_ES.UTF-8");
    }
}
