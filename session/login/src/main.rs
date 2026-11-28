//! `nidara-login`, Nidara's login manager (#1195 D8): the login screen on logind, replacing
//! greetd. `daemon.rs` is the manager; `worker.rs` is one session's PAM transaction, in a
//! process of its own (`--worker`).

mod bus;
mod config;
mod daemon;
mod language;
mod logind;
mod pam;
mod proto;
mod vt;
mod worker;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--worker") {
        std::process::exit(worker::run());
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("nidara-login — Nidara's login manager (a system service: nidara-login.service)");
        println!(
            "Configuration: {} (NIDARA_LOGIN_CONFIG names another)",
            config::PATH
        );
        return;
    }
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("nidara-login: runs as root, as a system service");
        std::process::exit(1);
    }
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("nidara-login: {err}");
            std::process::exit(1);
        }
    };
    std::process::exit(rt.block_on(daemon::run(config::load())));
}
