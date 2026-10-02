//! Hyalo — the Nidara desktop's Wayland compositor, on Smithay (#680).
//!
//!     nidara-hyalo                 a session: DRM/KMS on the current seat (from a VT / greetd)
//!     nidara-hyalo --winit         a window inside the current compositor (development)
//!     nidara-hyalo --session       the session entry's way: also runs the config's autostart
//!     nidara-hyalo -c CMD          also run CMD once the socket is up
//!     nidara-hyalo msg …           talk to the running compositor (see `msg --help`)

mod activation;
mod backend;
mod binds;
mod capture;
mod config;
mod control;
mod crash;
mod cursor;
mod handlers;
mod input;
mod idle;
mod ipc;
mod lock;
mod logind;
mod night_light;
mod outputs;
mod protocols;
mod render;
mod sandbox;
mod screenshot;
mod shell;
mod shortcuts;
mod state;
mod wm;

use smithay::reexports::{calloop::EventLoop, wayland_server::Display};

pub use state::Hyalo;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("msg") {
        std::process::exit(ipc::client::main(&args[1..]));
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", USAGE.trim());
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("nidara-hyalo {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    init_logging();
    crash::install_panic_hook();

    let winit = match args.iter().find(|a| *a == "--winit" || *a == "--tty").map(String::as_str) {
        Some("--winit") => true,
        Some(_) => false,
        // Inside another compositor or X: a window. On a bare VT: the session.
        None => std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_some(),
    };
    let command = args
        .iter()
        .position(|a| a == "-c" || a == "--command")
        .and_then(|i| args.get(i + 1).cloned());
    let session = args.iter().any(|a| a == "--session");

    if let Err(err) = run(winit, session, command) {
        tracing::error!("{err}");
        crash::write_report(&format!("startup failed: {err}"));
        std::process::exit(1);
    }
}

const USAGE: &str = r#"
nidara-hyalo — the Nidara desktop's compositor

  nidara-hyalo [--tty | --winit] [--session] [-c COMMAND]
  nidara-hyalo msg <request> [args]     (nidara-hyalo msg --help)

  --tty      run on the hardware: DRM/KMS, libinput, libseat (what the session does)
  --winit    run in a window of the current compositor (development)
  --session  a real session: run the config's autostart (uwsm finalize, the shell…)
  -c CMD     run CMD once Hyalo is up

Configuration: /usr/share/nidara/hyalo/hyalo.toml, then ~/.config/nidara/hyalo.toml on top.
"#;

fn run(winit: bool, session: bool, command: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut event_loop: EventLoop<Hyalo> = EventLoop::try_new()?;
    let display: Display<Hyalo> = Display::new()?;
    let loop_handle = event_loop.handle();

    let config = match config::load() {
        Ok(c) => c,
        Err(err) => {
            // A broken file must not cost the session: run on the defaults, say so loudly.
            tracing::error!("configuration not loaded, using the defaults: {err}");
            config::Config::default()
        }
    };

    if winit {
        let (backend, source) = backend::winit::WinitBackend::new()?;
        let mut state = Hyalo::new(
            display,
            loop_handle.clone(),
            event_loop.get_signal(),
            backend::Backend::Winit(backend),
            config,
        );
        backend::winit::init(&mut state, &loop_handle, source)?;
        control::init(&mut event_loop);
        start(&mut state, session, command);
        event_loop.run(None, &mut state, |state| state.after_dispatch())?;
    } else {
        let backend = backend::tty::TtyBackend::new()?;
        let mut state = Hyalo::new(
            display,
            loop_handle.clone(),
            event_loop.get_signal(),
            backend::Backend::Tty(backend),
            config,
        );
        backend::tty::init(&mut state)?;
        control::init(&mut event_loop);
        start(&mut state, session, command);
        event_loop.run(None, &mut state, |state| state.after_dispatch())?;
    }
    tracing::info!("Hyalo stopped");
    Ok(())
}

/// Once the backend is up: the environment children inherit, IPC, the config watcher, and
/// the commands that start the desktop.
fn start(state: &mut Hyalo, session: bool, command: Option<String>) {
    // Safety: still single-threaded here; nothing else reads the environment concurrently.
    unsafe {
        std::env::set_var("WAYLAND_DISPLAY", &state.socket_name);
        std::env::set_var("XDG_SESSION_TYPE", "wayland");
        std::env::remove_var("DISPLAY");
    }
    tracing::info!(socket = ?state.socket_name, "listening");
    ipc::server::start(state);
    config::watch(state);
    // A real session listens to logind and serves org.freedesktop.ScreenSaver, and may suspend
    // when idle; a development Hyalo does none of that (logind.rs, idle.rs).
    if session {
        state.idle.session = true;
        logind::start(state);
    }
    state.idle_rearm();
    // Only a session runs the autostart: `uwsm finalize` from a development window would
    // export this compositor's socket into the live session's services.
    if session {
        for cmd in state.config.autostart.clone() {
            spawn(&cmd);
        }
    } else if !state.config.autostart.is_empty() {
        tracing::info!("not a session (--session): autostart skipped");
    }
    if let Some(cmd) = command {
        spawn(&cmd);
    }
}

pub fn spawn(cmd: &str) {
    tracing::info!(%cmd, "spawn");
    match std::process::Command::new("sh").arg("-c").arg(cmd).spawn() {
        // Waited for, off the event loop: a child nobody waits for stays a zombie once it
        // exits. nidara-lock refuses to start while a process of its name exists (`pgrep -x`),
        // and the first lock's zombie refused every lock after it (owner-caught 2026-10-02).
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(err) => tracing::warn!(%cmd, ?err, "could not spawn"),
    }
}

fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,smithay=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).init();
}

impl Hyalo {
    /// After each round of the event loop: tidy up and send what clients are owed.
    fn after_dispatch(&mut self) {
        self.restore_keyboard_focus();
        self.broadcast_wm_changes();
        self.space.refresh();
        self.popups.cleanup();
        let _ = self.display_handle.flush_clients();
    }
}
