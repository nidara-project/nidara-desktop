//! `nidara-hyalo msg …`: the IPC from a shell script. Prints Hyalo's reply as JSON.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
};

use super::Request;

const HELP: &str = r#"
nidara-hyalo msg <request>        talk to the running Hyalo (prints JSON)

  version
  outputs
  output <NAME> [enabled=on|off] [mode=WxH[@HZ]] [scale=S] [transform=T] [position=X,Y] [vrr=on|off]
  power on|off [NAME]             switch outputs on or off (DPMS); no NAME = all
  screenshot PATH [NAME]          a PNG of one output (no NAME = the first)
  windows                         every window: id, app id, title, workspace, state, box
  workspaces                      every workspace: id, output, mode, shown
  layers                          the layer surfaces (bar, dock, panels), bottom first
  cursor                          where the pointer is
  do <command…>                   a window-manager command, as in a binding:
                                    workspace 3 · focus-window ID · move-to-workspace 2 [ID]
                                    toggle-floating [ID] · fullscreen [ID] · close-window [ID]
                                    set-workspace-mode 3 tiling · spawn CMD …
                                  (every command: hyalo/compositor/src/wm/actions.rs)
  reload                          re-read the configuration
  config                          the configuration in force (the three layers merged)
  settings '<json>'               persist and apply a change in the settings layer, as a
                                    JSON merge patch: '{"input":{"keyboard":{"numlock":true}}}'
                                    (null removes a key; your hyalo.toml still wins)
  events                          stream events, one JSON object per line
  quit                            end the session
  raw '<json>'                    send a request as written

The socket is $HYALO_SOCKET, or derived from $WAYLAND_DISPLAY.
"#;

pub fn main(args: &[String]) -> i32 {
    let request = match parse(args) {
        Ok(Some(r)) => r,
        Ok(None) => {
            println!("{}", HELP.trim());
            return 0;
        }
        Err(e) => {
            eprintln!("nidara-hyalo msg: {e}\n\n{}", HELP.trim());
            return 2;
        }
    };
    let path = match std::env::var_os("HYALO_SOCKET") {
        Some(p) => std::path::PathBuf::from(p),
        None => match std::env::var("WAYLAND_DISPLAY") {
            Ok(d) => super::socket_path(&d),
            Err(_) => {
                eprintln!("nidara-hyalo msg: neither HYALO_SOCKET nor WAYLAND_DISPLAY is set");
                return 1;
            }
        },
    };
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("nidara-hyalo msg: cannot reach Hyalo at {}: {e}", path.display());
            return 1;
        }
    };
    let stream_events = request.contains("\"event_stream\"");
    if writeln!(stream, "{request}").is_err() {
        eprintln!("nidara-hyalo msg: Hyalo closed the connection");
        return 1;
    }
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return if stream_events { 0 } else { 1 },
            Ok(_) => {
                print!("{line}");
                let _ = std::io::stdout().flush();
                if !stream_events {
                    return if line.starts_with("{\"error\"") { 1 } else { 0 };
                }
            }
        }
    }
}

fn on_off(v: &str) -> Result<bool, String> {
    match v {
        "on" | "true" | "1" | "yes" => Ok(true),
        "off" | "false" | "0" | "no" => Ok(false),
        _ => Err(format!("expected on or off, got {v:?}")),
    }
}

/// The request as the JSON line to send; `None` for help.
fn parse(args: &[String]) -> Result<Option<String>, String> {
    let Some(verb) = args.first() else { return Ok(None) };
    let req = match verb.as_str() {
        "-h" | "--help" | "help" => return Ok(None),
        "raw" => return args.get(1).cloned().map(Some).ok_or_else(|| "raw needs a JSON request".into()),
        "version" => Request::Version,
        "outputs" => Request::Outputs,
        "windows" => Request::Windows,
        "workspaces" => Request::Workspaces,
        "layers" => Request::Layers,
        "cursor" => Request::CursorPosition,
        "lock" => Request::Lock,
        "idle" => Request::Idle,
        "night-light" => {
            let arg = args.get(1).ok_or("night-light needs a temperature in kelvin, or `off`")?;
            let temperature = if arg == "off" { None } else { Some(arg.parse::<u32>().map_err(|e| format!("night-light: {e}"))?) };
            Request::NightLight { temperature }
        }
        "do" => {
            let command = args[1..].join(" ");
            // Checked here too, so a typo is said before anything is sent.
            command.parse::<crate::wm::actions::Action>()?;
            Request::Do { command }
        }
        "reload" => Request::ReloadConfig,
        "config" => Request::Config,
        "settings" => {
            let text = args.get(1).ok_or("settings needs a JSON object")?;
            let patch: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("settings: {e}"))?;
            Request::Settings { patch }
        }
        "quit" => Request::Quit,
        "events" => Request::EventStream,
        "screenshot" => {
            let path = args.get(1).ok_or("screenshot needs a path")?;
            // Hyalo writes the file; a relative path would land in ITS working directory.
            let path = std::path::absolute(path).map_err(|e| e.to_string())?;
            Request::Screenshot { path: path.to_string_lossy().into(), output: args.get(2).cloned() }
        }
        "power" => {
            let on = on_off(args.get(1).ok_or("power needs on or off")?)?;
            Request::OutputPower { name: args.get(2).cloned(), on }
        }
        "output" => {
            let name = args.get(1).ok_or("output needs a name")?.clone();
            let (mut enabled, mut mode, mut scale, mut transform, mut position, mut vrr) =
                (None, None, None, None, None, None);
            for kv in &args[2..] {
                let (k, v) = kv.split_once('=').ok_or_else(|| format!("expected key=value, got {kv:?}"))?;
                match k {
                    "enabled" => enabled = Some(on_off(v)?),
                    "mode" => mode = Some(v.to_string()),
                    "scale" => scale = Some(v.parse::<f64>().map_err(|_| format!("bad scale {v:?}"))?),
                    "transform" => transform = Some(v.to_string()),
                    "position" => {
                        let (x, y) = v.split_once(',').ok_or("position is X,Y")?;
                        position = Some((
                            x.parse().map_err(|_| "bad position x")?,
                            y.parse().map_err(|_| "bad position y")?,
                        ));
                    }
                    "vrr" => vrr = Some(on_off(v)?),
                    _ => return Err(format!("unknown setting {k:?}")),
                }
            }
            Request::SetOutput { name, enabled, mode, scale, transform, position, vrr }
        }
        other => return Err(format!("unknown request {other:?}")),
    };
    serde_json::to_string(&req).map(Some).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Option<String>, String> {
        parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn output_settings_become_one_request() {
        let r = p(&["output", "DP-1", "scale=1.25", "mode=2560x1440@143.9", "position=0,0", "vrr=on"])
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&r).unwrap();
        assert_eq!(v["request"], "set_output");
        assert_eq!(v["name"], "DP-1");
        assert_eq!(v["scale"], 1.25);
        assert_eq!(v["position"], serde_json::json!([0, 0]));
        assert_eq!(v["vrr"], true);
        assert!(v["enabled"].is_null(), "an unset field stays unset");
    }

    #[test]
    fn mistakes_are_refused() {
        assert!(p(&["output", "DP-1", "scael=2"]).is_err());
        assert!(p(&["power", "maybe"]).is_err());
        assert!(p(&["frobnicate"]).is_err());
        assert_eq!(p(&[]).unwrap(), None);
    }
}
