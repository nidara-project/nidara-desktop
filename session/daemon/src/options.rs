// SPDX-License-Identifier: GPL-3.0-or-later
//! No arguments starts the complete Rust session. Explicit flags select a subset
//! for private test buses and deliberately limited invocations.
const SERVICES: &[&str] = &[
    "--config",
    "--applications",
    "--network",
    "--bluetooth",
    "--audio",
    "--media",
    "--tray",
    "--power",
];

pub struct Options(Vec<String>);
impl Options {
    pub fn parse(args: Vec<String>) -> Result<Self, String> {
        if args.is_empty() {
            return Ok(Self(SERVICES.iter().map(|s| (*s).into()).collect()));
        }
        for arg in &args {
            if !SERVICES.contains(&arg.as_str())
                && ![
                    "--network-read-only",
                    "--bluetooth-read-only",
                    "--power-read-only",
                    "--notifications-only",
                ]
                .contains(&arg.as_str())
            {
                return Err(format!(
                    "unknown option {arg:?}; no arguments enables all services; explicit service flags select only those services"
                ));
            }
        }
        if args.iter().any(|a| a == "--notifications-only") && args.len() != 1 {
            return Err("--notifications-only cannot be combined with service flags".into());
        }
        Ok(Self(args))
    }
    pub fn has(&self, flag: &str) -> bool {
        self.0.iter().any(|a| a == flag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_session_enables_every_service() {
        let o = Options::parse(vec![]).unwrap();
        for flag in SERVICES {
            assert!(o.has(flag), "{flag}");
        }
        assert!(!o.has("--network-read-only"));
    }
    #[test]
    fn explicit_selection_keeps_private_harnesses_isolated() {
        let o = Options::parse(vec!["--config".into(), "--network-read-only".into()]).unwrap();
        assert!(o.has("--config"));
        assert!(o.has("--network-read-only"));
        assert!(!o.has("--network"));
        for flag in ["--audio", "--bluetooth", "--tray", "--power"] {
            assert!(!o.has(flag));
        }
        let o = Options::parse(vec!["--notifications-only".into()]).unwrap();
        for flag in SERVICES {
            assert!(!o.has(flag));
        }
    }
    #[test]
    fn typo_cannot_accidentally_enable_system_services() {
        assert!(Options::parse(vec!["--netwrok".into()]).is_err());
        assert!(Options::parse(vec!["--notifications-only".into(), "--audio".into()]).is_err());
    }
}
