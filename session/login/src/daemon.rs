//! The manager (#1195 D8): root, one per machine, on seat0.
//!
//! - **The login screen** runs as a session of its own: a worker opens a `greeter` logind
//!   session for the login user on the configured VT, and runs Hyalo in login mode in it.
//!   If it ends without anyone logging in, it is started again (with a pause after repeated
//!   failures, so a broken install does not spin).
//! - **A login** is a worker of its own for the user, which runs PAM and passes its
//!   conversation to the login screen over the greeter socket (proto.rs).
//! - **Once authenticated**, the screen says `start` and ends; when the login screen's
//!   session has ended, the screens are free and the worker opens the user's session on the
//!   same VT. That is the handover #1195 L6 measures.
//! - **A user with an open session** is switched to it through logind instead (L3).
//! - **When a user's session ends**, the login screen comes back.
//! - **Automatic login** (L7) starts the configured user's session at boot, once, without the
//!   login screen.

use std::{
    collections::HashMap,
    os::{fd::AsRawFd, unix::fs::PermissionsExt},
    path::PathBuf,
    process::Stdio,
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream, unix::OwnedWriteHalf},
    sync::mpsc,
};

use crate::{
    config::Config,
    proto::{Class, FromGreeter, FromWorker, Job, ToGreeter, ToWorker},
};

const RUN_DIR: &str = "/run/nidara-login";
/// How long the login screen has to let go of the screens after `start`.
const LEAVE_WITHIN: Duration = Duration::from_secs(5);
/// More than this many login screens ending within RESTART_WINDOW means something is broken:
/// the next waits RESTART_PAUSE.
const RESTART_LIMIT: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const RESTART_PAUSE: Duration = Duration::from_secs(10);

type WorkerId = u64;

enum Event {
    Worker(WorkerId, FromWorker),
    WorkerGone(WorkerId),
    Greeter(FromGreeter),
    GreeterGone,
    GreeterConnected(UnixStream),
    /// LEAVE_WITHIN after `start`: the login screen should have ended by now.
    LeaveTimeout(WorkerId),
    /// After RESTART_PAUSE.
    RestartGreeter,
}

struct Worker {
    write: OwnedWriteHalf,
    child: tokio::process::Child,
    /// The session's first process, once started.
    pid: Option<i32>,
}

struct Login {
    worker: WorkerId,
    user: String,
    uid: u32,
    authenticated: bool,
    /// The user's open session, to switch to (L3).
    open: Option<String>,
    /// The screen said `start`: open the session once the login screen has ended.
    starting: bool,
}

struct Manager {
    config: Config,
    tx: mpsc::UnboundedSender<Event>,
    next_id: WorkerId,
    workers: HashMap<WorkerId, Worker>,
    greeter: Option<WorkerId>,
    greeter_uid: u32,
    greeter_out: Option<OwnedWriteHalf>,
    login: Option<Login>,
    /// Users' sessions this manager started, by worker.
    sessions: HashMap<WorkerId, String>,
    greeter_ends: Vec<Instant>,
    bus: Option<zbus::Connection>,
}

pub async fn run(config: Config) -> i32 {
    let Some(greeter_uid) = uid_of(&config.greeter_user) else {
        eprintln!(
            "nidara-login: the login user {:?} does not exist",
            config.greeter_user
        );
        return 1;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let bus = match zbus::Connection::system().await {
        Ok(b) => Some(b),
        Err(err) => {
            eprintln!("nidara-login: no system bus ({err}); open sessions will not be switched to");
            None
        }
    };
    let listener = match listen(greeter_uid) {
        Ok(l) => l,
        Err(err) => {
            eprintln!("nidara-login: the greeter socket: {err}");
            return 1;
        }
    };
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                if tx.send(Event::GreeterConnected(stream)).is_err() {
                    break;
                }
            }
        });
    }
    let mut m = Manager {
        config,
        tx,
        next_id: 0,
        workers: HashMap::new(),
        greeter: None,
        greeter_uid,
        greeter_out: None,
        login: None,
        sessions: HashMap::new(),
        greeter_ends: Vec::new(),
        bus,
    };
    match m.config.autologin.clone() {
        Some(user) => m.autologin(&user),
        None => m.start_greeter(),
    }
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    loop {
        let event = tokio::select! {
            e = rx.recv() => e,
            _ = async { if let Some(t) = term.as_mut() { t.recv().await } else { std::future::pending().await } } => None,
        };
        let Some(event) = event else { break };
        m.handle(event).await;
    }
    // Stopping: the login screen goes. Users' sessions are logind's and stay.
    if let Some(id) = m.greeter {
        m.kill_session(id);
    }
    0
}

fn uid_of(name: &str) -> Option<u32> {
    let c = std::ffi::CString::new(name).ok()?;
    let pw = unsafe { libc::getpwnam(c.as_ptr()) };
    (!pw.is_null()).then(|| unsafe { (*pw).pw_uid })
}

/// The greeter socket, which only the login user may open.
fn listen(greeter_uid: u32) -> std::io::Result<UnixListener> {
    std::fs::create_dir_all(RUN_DIR)?;
    std::fs::set_permissions(RUN_DIR, std::fs::Permissions::from_mode(0o755))?;
    let path = socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    if unsafe { libc::chown(c.as_ptr(), greeter_uid, 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// The system's language and formats (`/etc/locale.conf`, localed's), for the login screen,
/// which has no user's yet. A user's session reads it through /etc/profile, as any login.
fn system_locale() -> Vec<(String, String)> {
    let text = std::fs::read_to_string("/etc/locale.conf").unwrap_or_default();
    parse_locale(&text)
}

fn parse_locale(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| l.trim().split_once('='))
        .filter(|(k, _)| k.starts_with("LANG") || k.starts_with("LC_"))
        .map(|(k, v)| {
            (
                k.trim().to_owned(),
                v.trim().trim_matches('"').trim_matches('\'').to_owned(),
            )
        })
        .collect()
}

/// Starts a worker with its end of a socket pair as fd 3, and gives it its job as the first
/// line. The job is written while the socket is still blocking, before tokio takes it: a
/// non-blocking write on a socket tokio has not yet seen as writable reports WouldBlock.
fn launch(
    program: &std::path::Path,
    args: &[&str],
    job: &Job,
) -> std::io::Result<(tokio::process::Child, UnixStream)> {
    use std::io::Write;
    let (mut ours, theirs) = std::os::unix::net::UnixStream::pair()?;
    let theirs_fd = theirs.as_raw_fd();
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(Stdio::null()).kill_on_drop(false);
    // Safety: between fork and exec only dup2, which is async-signal-safe.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(theirs_fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(theirs);
    let mut text = serde_json::to_string(&ToWorker::Job(job.clone()))?;
    text.push('\n');
    ours.write_all(text.as_bytes())?;
    ours.set_nonblocking(true)?;
    Ok((child, UnixStream::from_std(ours)?))
}

/// Who logged in last: the login screen offers them first. World-readable, as a login name
/// is (the list of users is anyone's to read in /etc/passwd).
const LAST_USER: &str = "/var/lib/nidara-login/last-user";

fn remember(user: &str) {
    let path = std::path::Path::new(LAST_USER);
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("new");
        std::fs::write(&tmp, format!("{user}\n"))?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644))?;
        std::fs::rename(tmp, path)
    };
    if let Err(err) = write() {
        eprintln!("nidara-login: {LAST_USER}: {err}");
    }
}

fn socket_path() -> PathBuf {
    PathBuf::from(RUN_DIR).join("greeter.sock")
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    (rc == 0).then_some(cred.uid)
}

impl Manager {
    async fn handle(&mut self, event: Event) {
        match event {
            Event::GreeterConnected(stream) => self.greeter_connected(stream),
            Event::GreeterGone => {
                self.greeter_out = None;
                // A login the screen can no longer answer for is dropped, unless it already
                // said `start`.
                if self.login.as_ref().is_some_and(|l| !l.starting) {
                    self.drop_login();
                }
            }
            Event::Greeter(msg) => self.on_greeter(msg).await,
            Event::Worker(id, msg) => self.on_worker(id, msg).await,
            Event::WorkerGone(id) => self.worker_gone(id).await,
            Event::LeaveTimeout(greeter) => {
                if self.greeter == Some(greeter) && self.login.as_ref().is_some_and(|l| l.starting)
                {
                    eprintln!(
                        "nidara-login: the login screen did not end after a login; ending it"
                    );
                    self.kill_session(greeter);
                }
            }
            Event::RestartGreeter => {
                if self.greeter.is_none() && self.login.is_none() {
                    self.start_greeter();
                }
            }
        }
    }

    fn greeter_connected(&mut self, stream: UnixStream) {
        if peer_uid(&stream) != Some(self.greeter_uid) {
            eprintln!("nidara-login: a connection from someone other than the login user, refused");
            return;
        }
        // One screen at a time: a new connection replaces the old (a relaunched client).
        self.drop_login();
        let (read, write) = stream.into_split();
        self.greeter_out = Some(write);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(mut line)) = lines.next_line().await {
                let msg = serde_json::from_str::<FromGreeter>(line.trim());
                crate::pam::wipe(&mut line);
                match msg {
                    Ok(msg) => {
                        if tx.send(Event::Greeter(msg)).is_err() {
                            return;
                        }
                    }
                    Err(err) => {
                        eprintln!("nidara-login: the screen sent something unreadable: {err}")
                    }
                }
            }
            let _ = tx.send(Event::GreeterGone);
        });
    }

    async fn send_greeter(&mut self, msg: ToGreeter) {
        let Some(out) = self.greeter_out.as_mut() else {
            return;
        };
        let mut text = serde_json::to_string(&msg).unwrap_or_default();
        text.push('\n');
        if out.write_all(text.as_bytes()).await.is_err() {
            self.greeter_out = None;
        }
    }

    async fn on_greeter(&mut self, msg: FromGreeter) {
        match msg {
            FromGreeter::Begin { user } => {
                self.drop_login();
                let Some(uid) = uid_of(&user) else {
                    // Said like a wrong password: the screen does not learn who exists by typing.
                    self.send_greeter(ToGreeter::Failed {
                        reason: "auth".into(),
                        message: String::new(),
                    })
                    .await;
                    return;
                };
                let job = Job {
                    service: self.config.service.clone(),
                    user: user.clone(),
                    class: Class::User,
                    vt: self.config.vt,
                    command: self.config.session_command.clone(),
                    authenticate: true,
                    env: Vec::new(),
                };
                match self.spawn_worker(job) {
                    Ok(worker) => {
                        self.login = Some(Login {
                            worker,
                            user,
                            uid,
                            authenticated: false,
                            open: None,
                            starting: false,
                        })
                    }
                    Err(err) => {
                        eprintln!("nidara-login: no worker: {err}");
                        self.send_greeter(ToGreeter::Failed {
                            reason: "error".into(),
                            message: String::new(),
                        })
                        .await;
                    }
                }
            }
            FromGreeter::Answer { mut text } => {
                if let Some(l) = &self.login {
                    let id = l.worker;
                    self.send_worker(
                        id,
                        &ToWorker::Answer {
                            text: std::mem::take(&mut text),
                        },
                    )
                    .await;
                }
                crate::pam::wipe(&mut text);
            }
            FromGreeter::Cancel => self.drop_login(),
            FromGreeter::Start => {
                let Some(login) = self.login.as_mut().filter(|l| l.authenticated) else {
                    return;
                };
                login.starting = true;
                if self.greeter.is_none() {
                    self.open_login().await;
                    return;
                }
                // The screen ends itself; if it has not let go in time, it is ended.
                let tx = self.tx.clone();
                if let Some(g) = self.greeter {
                    tokio::spawn(async move {
                        tokio::time::sleep(LEAVE_WITHIN).await;
                        let _ = tx.send(Event::LeaveTimeout(g));
                    });
                }
            }
        }
    }

    async fn on_worker(&mut self, id: WorkerId, msg: FromWorker) {
        let is_login = self.login.as_ref().is_some_and(|l| l.worker == id);
        match msg {
            FromWorker::Prompt { echo, text } if is_login => {
                self.send_greeter(ToGreeter::Prompt { echo, text }).await
            }
            FromWorker::Info { text } if is_login => {
                self.send_greeter(ToGreeter::Info { text }).await
            }
            FromWorker::Error { text } if is_login => {
                self.send_greeter(ToGreeter::Error { text }).await
            }
            FromWorker::Authenticated if is_login => {
                let uid = self.login.as_ref().map(|l| l.uid).unwrap_or(u32::MAX);
                let open = match &self.bus {
                    Some(bus) => crate::logind::open_session(bus, uid).await,
                    None => None,
                };
                if let Some(l) = self.login.as_mut() {
                    l.authenticated = true;
                    l.open = open.clone();
                }
                self.send_greeter(ToGreeter::Success {
                    open: open.is_some(),
                })
                .await;
            }
            FromWorker::Failed { reason, message } => {
                if is_login {
                    self.login = None;
                    self.send_greeter(ToGreeter::Failed { reason, message })
                        .await;
                } else {
                    eprintln!("nidara-login: a session could not start ({reason}): {message}");
                }
            }
            FromWorker::Started { pid } => {
                if let Some(w) = self.workers.get_mut(&id) {
                    w.pid = Some(pid);
                }
            }
            FromWorker::Ended { status } if self.greeter != Some(id) => {
                eprintln!("nidara-login: a session ended ({status})");
            }
            _ => {}
        }
    }

    async fn worker_gone(&mut self, id: WorkerId) {
        if let Some(mut w) = self.workers.remove(&id) {
            let _ = w.child.wait().await;
        }
        if self.greeter == Some(id) {
            self.greeter = None;
            self.greeter_out = None;
            if self.login.as_ref().is_some_and(|l| l.starting) {
                // After a switch to an open session (L3) the login screen stays away: nothing
                // starts it again until a session ends.
                self.open_login().await;
            } else {
                self.drop_login();
                self.greeter_ended();
            }
            return;
        }
        if self.login.as_ref().is_some_and(|l| l.worker == id) {
            self.login = None;
            self.send_greeter(ToGreeter::Failed {
                reason: "error".into(),
                message: String::new(),
            })
            .await;
            return;
        }
        if let Some(user) = self.sessions.remove(&id) {
            eprintln!("nidara-login: {user}'s session ended");
            if self.greeter.is_none() && self.login.is_none() {
                self.start_greeter();
            }
        }
    }

    /// The login screen ended with no login: it comes back, after a pause if it keeps ending.
    fn greeter_ended(&mut self) {
        let now = Instant::now();
        self.greeter_ends
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        self.greeter_ends.push(now);
        if self.greeter_ends.len() > RESTART_LIMIT {
            eprintln!(
                "nidara-login: the login screen keeps ending; trying again in {RESTART_PAUSE:?}"
            );
            let tx = self.tx.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RESTART_PAUSE).await;
                let _ = tx.send(Event::RestartGreeter);
            });
            self.greeter_ends.clear();
            return;
        }
        self.start_greeter();
    }

    /// The login screen has let go of the screens: the user's session opens, or (L3) the one
    /// they already have comes to the front. Never before: a session brought forward while
    /// the login screen's Hyalo still holds the GPU finds it busy on its first frames (the
    /// owner's live test, 2026-11-28: the session came back frozen).
    async fn open_login(&mut self) {
        let Some(login) = self.login.take() else {
            return;
        };
        remember(&login.user);
        if let Some(open) = login.open {
            // This login's worker has nothing to open.
            self.kill_session(login.worker);
            let switched = match &self.bus {
                Some(bus) => crate::logind::activate(bus, &open).await,
                None => Err(zbus::Error::Failure("no system bus".into())),
            };
            match switched {
                Ok(()) => {}
                Err(err) => {
                    // The login screen comes back: better than a dead VT.
                    eprintln!("nidara-login: switching to session {open}: {err}");
                    self.start_greeter();
                }
            }
            return;
        }
        self.sessions.insert(login.worker, login.user);
        self.send_worker(login.worker, &ToWorker::Open).await;
    }

    fn drop_login(&mut self) {
        if let Some(l) = self.login.take() {
            self.kill_session(l.worker);
        }
    }

    fn start_greeter(&mut self) {
        if self.greeter.is_some() {
            return;
        }
        if let Err(err) = crate::vt::activate(self.config.vt) {
            eprintln!("nidara-login: VT {}: {err}", self.config.vt);
        }
        let job = Job {
            service: self.config.greeter_service.clone(),
            user: self.config.greeter_user.clone(),
            class: Class::Greeter,
            vt: self.config.vt,
            command: self.config.greeter_command.clone(),
            authenticate: false,
            env: {
                let mut env = system_locale();
                env.push((
                    "NIDARA_LOGIN_SOCKET".into(),
                    socket_path().to_string_lossy().into_owned(),
                ));
                env
            },
        };
        match self.spawn_worker(job) {
            Ok(id) => self.greeter = Some(id),
            Err(err) => {
                eprintln!(
                    "nidara-login: the login screen could not start ({err}); trying again in {RESTART_PAUSE:?}"
                );
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(RESTART_PAUSE).await;
                    let _ = tx.send(Event::RestartGreeter);
                });
            }
        }
    }

    fn autologin(&mut self, user: &str) {
        if let Err(err) = crate::vt::activate(self.config.vt) {
            eprintln!("nidara-login: VT {}: {err}", self.config.vt);
        }
        let job = Job {
            service: self.config.autologin_service.clone(),
            user: user.into(),
            class: Class::User,
            vt: self.config.vt,
            command: self.config.session_command.clone(),
            authenticate: false,
            env: Vec::new(),
        };
        match self.spawn_worker(job) {
            Ok(id) => {
                self.sessions.insert(id, user.into());
            }
            Err(err) => {
                eprintln!("nidara-login: automatic login failed ({err}); the login screen instead");
                self.start_greeter();
            }
        }
    }

    fn spawn_worker(&mut self, job: Job) -> std::io::Result<WorkerId> {
        let exe = std::env::current_exe()?;
        let (child, stream) = launch(&exe, &["--worker"], &job)?;
        let (read, write) = stream.into_split();
        let id = self.next_id;
        self.next_id += 1;
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(msg) = serde_json::from_str::<FromWorker>(line.trim())
                    && tx.send(Event::Worker(id, msg)).is_err()
                {
                    return;
                }
            }
            let _ = tx.send(Event::WorkerGone(id));
        });
        self.workers.insert(
            id,
            Worker {
                write,
                child,
                pid: None,
            },
        );
        Ok(id)
    }

    async fn send_worker(&mut self, id: WorkerId, msg: &ToWorker) {
        let Some(w) = self.workers.get_mut(&id) else {
            return;
        };
        let mut text = serde_json::to_string(msg).unwrap_or_default();
        text.push('\n');
        let _ = w.write.write_all(text.as_bytes()).await;
        crate::pam::wipe(&mut text);
    }

    /// Ends a worker's session: its first process if it has started, the worker otherwise.
    fn kill_session(&mut self, id: WorkerId) {
        let Some(w) = self.workers.get_mut(&id) else {
            return;
        };
        match w.pid {
            Some(pid) => unsafe {
                libc::kill(pid, libc::SIGTERM);
            },
            None => {
                let _ = w.child.start_kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// The job reaches the worker on fd 3 as its first line (the live test of 2026-11-28 found
    /// it never left: a non-blocking write before tokio had polled the socket).
    #[tokio::test]
    async fn a_worker_reads_its_job_on_fd_3() {
        use tokio::io::AsyncBufReadExt;
        let job = crate::proto::Job {
            service: "s".into(),
            user: "u".into(),
            class: crate::proto::Class::User,
            vt: 8,
            command: "true".into(),
            authenticate: true,
            env: Vec::new(),
        };
        // The "worker" echoes its first line back on fd 3.
        let (mut child, stream) = super::launch(
            std::path::Path::new("/bin/sh"),
            &["-c", "head -n1 <&3 >&3"],
            &job,
        )
        .unwrap();
        let mut lines = tokio::io::BufReader::new(stream).lines();
        let line = lines.next_line().await.unwrap().unwrap();
        assert!(
            line.contains(r#""type":"job""#) && line.contains(r#""vt":8"#),
            "{line}"
        );
        child.wait().await.unwrap();
    }

    #[test]
    fn locale_conf_gives_the_language_and_formats_only() {
        let env =
            super::parse_locale("# comment\nLANG=\"es_ES.UTF-8\"\nLC_TIME=en_GB.UTF-8\nFOO=bar\n");
        assert_eq!(
            env,
            vec![
                ("LANG".into(), "es_ES.UTF-8".into()),
                ("LC_TIME".into(), "en_GB.UTF-8".into())
            ]
        );
    }
}
