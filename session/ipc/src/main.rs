// SPDX-License-Identifier: GPL-3.0-or-later
mod applications;
mod native;
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
use zbus::proxy::CacheProperties;

const HELP: &str = "usage: nidara-ipc [--session=ts|rust] [--] <command> [args...]\n       nidara-ipc listActions\n\nOnly NIDARA_SESSION=rust selects native routes; other values select TS compatibility (unknown values warn).\nNo fallback between sessions. Native errors exit 1; bad usage exits 2.";

#[derive(Debug)]
pub struct Fault {
    code: &'static str,
    message: String,
}
impl Fault {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("Invalid", message)
    }
    fn unavailable(message: impl Into<String>) -> Self {
        Self::new("Unavailable", message)
    }
}
impl From<zbus::Error> for Fault {
    fn from(e: zbus::Error) -> Self {
        if let zbus::Error::FDO(e) = e {
            return (*e).into();
        }
        let code = match &e {
            zbus::Error::MethodError(name, _, _) if name.as_str().ends_with(".AccessDenied") => {
                "AccessDenied"
            }
            zbus::Error::MethodError(name, _, _)
                if name.as_str().ends_with(".Invalid")
                    || name.as_str().ends_with(".InvalidArgs") =>
            {
                "Invalid"
            }
            zbus::Error::MethodError(name, _, _)
                if [
                    ".Unavailable",
                    ".NameHasNoOwner",
                    ".ServiceUnknown",
                    ".UnknownInterface",
                    ".UnknownMethod",
                    ".UnknownObject",
                    ".UnknownProperty",
                ]
                .iter()
                .any(|s| name.as_str().ends_with(s)) =>
            {
                "Unavailable"
            }
            _ => "Failed",
        };
        Self::new(code, e.to_string())
    }
}

impl From<zbus::fdo::Error> for Fault {
    fn from(e: zbus::fdo::Error) -> Self {
        use zbus::fdo::Error::*;
        let code = match &e {
            NameHasNoOwner(_) | ServiceUnknown(_) | UnknownInterface(_) | UnknownMethod(_)
            | UnknownObject(_) | UnknownProperty(_) => "Unavailable",
            AccessDenied(_) | AuthFailed(_) => "AccessDenied",
            InvalidArgs(_) => "Invalid",
            ZBus(_) => {
                return match e {
                    ZBus(e) => e.into(),
                    _ => unreachable!(),
                };
            }
            _ => "Failed",
        };
        Self::new(code, e.to_string())
    }
}

pub struct Client {
    bus: std::cell::OnceCell<Connection>,
}
impl Client {
    fn bus(&self) -> Result<&Connection, Fault> {
        if self.bus.get().is_none() {
            let c = zbus::blocking::connection::Builder::session()?
                .method_timeout(Duration::from_secs(15))
                .build()?;
            let _ = self.bus.set(c);
        }
        Ok(self.bus.get().expect("initialized"))
    }
    /// Resolve once to a unique owner. Never activate a service or retry a call on
    /// a replacement owner: an ambiguous timeout may already have had an effect.
    fn proxy(
        &self,
        name: &str,
        path: &'static str,
        interface: &'static str,
    ) -> Result<Proxy<'_>, Fault> {
        let bus = self.bus()?;
        let owner = zbus::blocking::fdo::DBusProxy::new(bus)?
            .get_name_owner(
                name.try_into()
                    .map_err(|e| Fault::invalid(format!("{e}")))?,
            )
            .map_err(Fault::from)?;
        Ok(Proxy::new_owned(
            bus.clone(),
            owner.to_string(),
            path,
            interface,
        )?)
    }
    fn shell(&self) -> Result<nidara_shell_ipc::ShellProxyBlocking<'_>, Fault> {
        let proxy = self.proxy(
            nidara_shell_ipc::NAME,
            nidara_shell_ipc::PATH,
            nidara_shell_ipc::INTERFACE,
        )?;
        Ok(nidara_shell_ipc::ShellProxyBlocking::builder(self.bus()?)
            .destination(proxy.destination().to_owned())?
            .cache_properties(CacheProperties::No)
            .build()?)
    }
}

fn parse(mut args: Vec<String>, env: Option<String>) -> Result<Option<(bool, Vec<String>)>, Fault> {
    if args.first().is_some_and(|s| s == "--help" || s == "-h") {
        return Ok(None);
    }
    let mode = if args.first().is_some_and(|s| s.starts_with("--session=")) {
        args.remove(0)[10..].to_string()
    } else {
        match env.as_deref() {
            Some("rust") => "rust".into(),
            None | Some("ts") => "ts".into(),
            Some(value) => {
                eprintln!("nidara-ipc: unknown NIDARA_SESSION={value:?}; using ts compatibility");
                "ts".into()
            }
        }
    };
    if args.first().is_some_and(|s| s == "--") {
        args.remove(0);
    }
    if args.is_empty() {
        return Err(Fault::invalid(HELP));
    }
    let rust = match mode.as_str() {
        "ts" => false,
        "rust" => true,
        _ => return Err(Fault::invalid("session must be ts or rust")),
    };
    Ok(Some((rust, args)))
}
fn main() -> std::process::ExitCode {
    let (rust, args) = match parse(
        std::env::args().skip(1).collect(),
        std::env::var_os("NIDARA_SESSION").map(|s| s.to_string_lossy().into_owned()),
    ) {
        Ok(None) => {
            println!("{HELP}");
            return 0.into();
        }
        Ok(Some(p)) => p,
        Err(e) => {
            eprintln!("nidara-ipc: {}", e.message);
            return 2.into();
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("IPC runtime");
    let _entered = runtime.enter();
    let client = Client {
        bus: std::cell::OnceCell::new(),
    };
    let result = if rust {
        native::run(&client, &args)
    } else {
        client
            .proxy("org.nidara.Shell", "/org/nidara/Shell", "org.nidara.Shell")
            .and_then(|p| {
                p.call::<_, _, String>("Request", &(args,))
                    .map_err(Into::into)
            })
    };
    match result {
        Ok(s) => {
            println!("{s}");
            0.into()
        }
        Err(e) => {
            eprintln!("nidara-ipc: {}: {}", e.code, e.message);
            1.into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_and_separator_preserve_command_arguments() {
        let a = [
            "--session=rust",
            "--",
            "setConfig",
            "key",
            "value with spaces",
            "-1",
        ];
        let (rust, a) = parse(a.map(str::to_owned).to_vec(), None).unwrap().unwrap();
        assert!(rust);
        assert_eq!(a, ["setConfig", "key", "value with spaces", "-1"]);
        assert!(!parse(vec!["dumpState".into()], None).unwrap().unwrap().0);
        for value in ["", "bad", "Rust", "rust ", "hyalo"] {
            assert!(
                !parse(vec!["dumpState".into()], Some(value.into()))
                    .unwrap()
                    .unwrap()
                    .0
            );
        }
        assert!(
            parse(vec!["dumpState".into()], Some("rust".into()))
                .unwrap()
                .unwrap()
                .0
        );
        assert!(
            parse(
                vec!["--session=bad".into(), "dumpState".into()],
                Some("rust".into())
            )
            .is_err()
        );
        assert!(parse(vec!["--".into()], None).is_err());
    }
}
