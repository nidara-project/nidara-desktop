//! `/etc/nidara/login.toml`: the system's choices about logging in (#1195, the system layer
//! #1123). Every key has a default, and a file that is missing or broken runs on them: a typo
//! must never leave a machine with no login screen.

use serde::Deserialize;

pub const PATH: &str = "/etc/nidara/login.toml";

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// The VT the login screen starts on.
    pub vt: u32,
    /// The system user the login screen runs as.
    pub greeter_user: String,
    /// The login screen: Hyalo in login mode holding the login client.
    pub greeter_command: String,
    /// The session a user gets (#1195 L2: Hyalo only).
    pub session_command: String,
    /// Logs this user in at boot without asking (#1195 L7). Off unless set.
    pub autologin: Option<String>,
    /// The PAM services: the user's login, and the login screen's own session.
    pub service: String,
    pub greeter_service: String,
    /// Automatic login's: it asks nothing (`autologin`).
    pub autologin_service: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            vt: 1,
            greeter_user: "greeter".into(),
            greeter_command: "nidara-hyalo --login -c /usr/lib/nidara/nidara-lock".into(),
            session_command: "/usr/bin/nidara-hyalo-session".into(),
            autologin: None,
            service: "nidara-login".into(),
            greeter_service: "nidara-greeter".into(),
            autologin_service: "nidara-autologin".into(),
        }
    }
}

pub fn load() -> Config {
    let path = std::env::var("NIDARA_LOGIN_CONFIG").unwrap_or_else(|_| PATH.into());
    match std::fs::read_to_string(&path) {
        Ok(text) => match toml::from_str(&text) {
            Ok(c) => c,
            Err(err) => {
                eprintln!("nidara-login: {path} not read, running on the defaults: {err}");
                Config::default()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(err) => {
            eprintln!("nidara-login: {path} not read, running on the defaults: {err}");
            Config::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_with_one_key_keeps_the_other_defaults() {
        let c: Config = toml::from_str("autologin = \"ana\"").unwrap();
        assert_eq!(c.autologin.as_deref(), Some("ana"));
        assert_eq!(c.vt, 1);
        assert_eq!(c.service, "nidara-login");
    }

    #[test]
    fn an_unknown_key_is_an_error_not_a_silent_default() {
        assert!(toml::from_str::<Config>("autologn = \"ana\"").is_err());
    }
}
