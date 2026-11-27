//! A session worker: `nidara-login --worker`, one process per session, started by the manager
//! with its socket as fd 3 (#1195).
//!
//! It runs one PAM transaction from start to end:
//!
//! 1. `pam_start` for the job's user and service, with the VT as `PAM_TTY`.
//! 2. For a user: `pam_authenticate`, then `pam_acct_mgmt` (an expired password is changed
//!    there). Each prompt goes to the manager and its answer comes back; info and error
//!    messages go as PAM writes them. Then it says `authenticated` and waits for `open`: the
//!    login screen still holds the screens until then.
//! 3. The logind session's kind into PAM's environment (`XDG_SESSION_TYPE`, `_CLASS`,
//!    `XDG_SEAT`, `XDG_VTNR`), which pam_systemd reads, then `pam_setcred` and
//!    `pam_open_session`.
//! 4. The session's first process, as the user, on the VT, its output to the journal.
//! 5. When it ends: `pam_close_session`, `pam_setcred(DELETE)`, `pam_end`, and `ended`.
//!
//! PAM in a process of its own is what GDM does (gdm-session-worker): a module that crashes,
//! hangs or leaks takes this session's worker down, never the manager.

use std::{
    ffi::CString,
    io::{BufRead, BufReader, Write},
    os::{fd::FromRawFd, unix::net::UnixStream},
};

use crate::{
    pam::{self, Pam},
    proto::{Class, FromWorker, Job, ToWorker},
};

struct Line {
    read: BufReader<UnixStream>,
    write: UnixStream,
}

impl Line {
    fn send(&mut self, msg: &FromWorker) {
        let mut text = serde_json::to_string(msg).unwrap_or_default();
        text.push('\n');
        let _ = self.write.write_all(text.as_bytes());
    }

    fn recv(&mut self) -> Option<ToWorker> {
        let mut line = String::new();
        loop {
            line.clear();
            match self.read.read_line(&mut line) {
                Ok(0) | Err(_) => return None,
                Ok(_) => {}
            }
            let parsed = serde_json::from_str(line.trim()).ok();
            pam::wipe(&mut line);
            if parsed.is_some() {
                return parsed;
            }
        }
    }
}

/// The conversation, over the worker's line to the manager.
struct Talk(std::rc::Rc<std::cell::RefCell<Line>>);

impl pam::Conversation for Talk {
    fn prompt(&mut self, echo: bool, text: &str) -> Option<String> {
        let mut line = self.0.borrow_mut();
        line.send(&FromWorker::Prompt {
            echo,
            text: text.into(),
        });
        match line.recv()? {
            ToWorker::Answer { text } => Some(text),
            _ => None,
        }
    }

    fn info(&mut self, text: &str) {
        self.0
            .borrow_mut()
            .send(&FromWorker::Info { text: text.into() });
    }

    fn error(&mut self, text: &str) {
        self.0
            .borrow_mut()
            .send(&FromWorker::Error { text: text.into() });
    }
}

pub fn run() -> i32 {
    // Safety: the manager gives every worker its end of a socket pair as fd 3.
    let stream = unsafe { UnixStream::from_raw_fd(3) };
    let Ok(write) = stream.try_clone() else {
        return 1;
    };
    let line = std::rc::Rc::new(std::cell::RefCell::new(Line {
        read: BufReader::new(stream),
        write,
    }));
    let Some(ToWorker::Job(job)) = line.borrow_mut().recv() else {
        return 1;
    };
    match session(&job, &line) {
        Ok(status) => {
            line.borrow_mut().send(&FromWorker::Ended { status });
            0
        }
        Err((reason, message)) => {
            line.borrow_mut().send(&FromWorker::Failed {
                reason: reason.into(),
                message,
            });
            1
        }
    }
}

type Failure = (&'static str, String);

fn session(job: &Job, line: &std::rc::Rc<std::cell::RefCell<Line>>) -> Result<i32, Failure> {
    let user = User::named(&job.user).ok_or(("auth", String::new()))?;
    let mut pam = Pam::start(&job.service, &job.user, Box::new(Talk(line.clone())))
        .map_err(|e| ("error", e))?;
    let tty = format!("/dev/tty{}", job.vt);
    pam.set_tty(&tty)
        .map_err(|rc| ("error", pam.strerror(rc)))?;

    if job.authenticate
        && let Err(rc) = pam.authenticate()
    {
        return Err(refusal(&pam, rc));
    }
    if let Err(rc) = pam.account() {
        return Err(refusal(&pam, rc));
    }
    if job.authenticate {
        line.borrow_mut().send(&FromWorker::Authenticated);
        match line.borrow_mut().recv() {
            Some(ToWorker::Open) => {}
            _ => return Err(("error", "cancelled".into())),
        }
    }

    let class = match job.class {
        Class::Greeter => "greeter",
        Class::User => "user",
    };
    let vt = job.vt.to_string();
    for (k, v) in [
        ("XDG_SESSION_TYPE", "wayland"),
        ("XDG_SESSION_CLASS", class),
        ("XDG_SEAT", "seat0"),
        ("XDG_VTNR", vt.as_str()),
    ] {
        pam.putenv(k, v).map_err(|rc| ("error", pam.strerror(rc)))?;
    }
    if job.class == Class::User {
        pam.putenv("XDG_SESSION_DESKTOP", "nidara")
            .map_err(|rc| ("error", pam.strerror(rc)))?;
    }
    pam.open_session()
        .map_err(|rc| ("error", pam.strerror(rc)))?;

    let mut env: Vec<(String, String)> = vec![
        ("HOME".into(), user.home.clone()),
        ("USER".into(), job.user.clone()),
        ("LOGNAME".into(), job.user.clone()),
        ("SHELL".into(), user.shell.clone()),
        (
            "PATH".into(),
            "/usr/local/sbin:/usr/local/bin:/usr/bin".into(),
        ),
        ("XDG_SEAT".into(), "seat0".into()),
        ("XDG_VTNR".into(), vt.clone()),
        ("XDG_SESSION_TYPE".into(), "wayland".into()),
        ("XDG_SESSION_CLASS".into(), class.into()),
    ];
    env.extend(job.env.iter().cloned());
    for (k, v) in pam.env() {
        env.retain(|(k2, _)| *k2 != k);
        env.push((k, v));
    }

    let tag = match job.class {
        Class::Greeter => "nidara-greeter",
        Class::User => "nidara-session",
    };
    let pid = spawn(&user, &tty, tag, &script(job), &env).map_err(|e| ("error", e))?;
    line.borrow_mut().send(&FromWorker::Started { pid });
    let status = wait(pid);
    pam.close_session();
    Ok(status)
}

/// What the session runs: a user's session reads the login profile first, as a login shell
/// does; the login screen does not.
fn script(job: &Job) -> String {
    match job.class {
        Class::User => format!(
            "[ -f /etc/profile ] && . /etc/profile; [ -f \"$HOME/.profile\" ] && . \"$HOME/.profile\"; exec {}",
            job.command
        ),
        Class::Greeter => format!("exec {}", job.command),
    }
}

/// A refusal, as the login screen tells it apart (#1195): the answer was wrong, or the account
/// may not be used now.
fn refusal(pam: &Pam, rc: i32) -> Failure {
    let reason = match rc {
        pam::AUTH_ERR | pam::USER_UNKNOWN | pam::MAXTRIES => "auth",
        pam::ACCT_EXPIRED | pam::PERM_DENIED | pam::AUTHTOK_EXPIRED | pam::NEW_AUTHTOK_REQD => {
            "account"
        }
        _ => "error",
    };
    // A refused answer says nothing more than that: PAM's own words would tell an unknown
    // user ("") from a wrong password ("Authentication failure").
    let message = if reason == "auth" {
        String::new()
    } else {
        pam.strerror(rc)
    };
    (reason, message)
}

struct User {
    uid: libc::uid_t,
    gid: libc::gid_t,
    home: String,
    shell: String,
    name: CString,
}

impl User {
    fn named(name: &str) -> Option<Self> {
        let cname = CString::new(name).ok()?;
        let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = vec![0 as libc::c_char; 16384];
        let mut out = std::ptr::null_mut();
        let rc = unsafe {
            libc::getpwnam_r(
                cname.as_ptr(),
                &mut pw,
                buf.as_mut_ptr(),
                buf.len(),
                &mut out,
            )
        };
        if rc != 0 || out.is_null() {
            return None;
        }
        let s = |p: *const libc::c_char| {
            unsafe { std::ffi::CStr::from_ptr(p) }
                .to_string_lossy()
                .into_owned()
        };
        Some(Self {
            uid: pw.pw_uid,
            gid: pw.pw_gid,
            home: s(pw.pw_dir),
            shell: s(pw.pw_shell),
            name: cname,
        })
    }
}

/// The session's first process: a session leader with the VT as its terminal, as the user,
/// its output to the journal under `tag`.
fn spawn(
    user: &User,
    tty: &str,
    tag: &str,
    script: &str,
    env: &[(String, String)],
) -> Result<i32, String> {
    let c = |s: &str| CString::new(s).map_err(|_| format!("NUL in {s:?}"));
    let tty_c = c(tty)?;
    let home = c(&user.home)?;
    let journal = std::path::Path::new("/usr/bin/systemd-cat").exists();
    let argv: Vec<CString> = if journal {
        ["systemd-cat", "-t", tag, "--", "/bin/sh", "-c", script]
            .iter()
            .map(|s| c(s))
            .collect::<Result<_, _>>()?
    } else {
        ["/bin/sh", "-c", script]
            .iter()
            .map(|s| c(s))
            .collect::<Result<_, _>>()?
    };
    let prog = if journal {
        c("/usr/bin/systemd-cat")?
    } else {
        c("/bin/sh")?
    };
    let envp: Vec<CString> = env
        .iter()
        .map(|(k, v)| c(&format!("{k}={v}")))
        .collect::<Result<_, _>>()?;
    let mut argv_p: Vec<*const libc::c_char> = argv.iter().map(|s| s.as_ptr()).collect();
    argv_p.push(std::ptr::null());
    let mut envp_p: Vec<*const libc::c_char> = envp.iter().map(|s| s.as_ptr()).collect();
    envp_p.push(std::ptr::null());

    // Safety: the worker has one thread, and the child calls only async-signal-safe functions
    // on memory prepared above before it execs.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(format!("fork: {}", std::io::Error::last_os_error()));
    }
    if pid == 0 {
        unsafe {
            libc::setsid();
            let fd = libc::open(tty_c.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
            if fd >= 0 {
                libc::ioctl(fd, libc::TIOCSCTTY, 1);
                libc::dup2(fd, 0);
                libc::dup2(fd, 1);
                libc::dup2(fd, 2);
                if fd > 2 {
                    libc::close(fd);
                }
            }
            libc::close(3);
            if libc::initgroups(user.name.as_ptr(), user.gid) != 0
                || libc::setgid(user.gid) != 0
                || libc::setuid(user.uid) != 0
                || libc::getuid() != user.uid
            {
                libc::_exit(126);
            }
            if libc::chdir(home.as_ptr()) != 0 {
                libc::chdir(c"/".as_ptr());
            }
            libc::execve(prog.as_ptr(), argv_p.as_ptr(), envp_p.as_ptr());
            libc::_exit(127);
        }
    }
    Ok(pid)
}

fn wait(pid: i32) -> i32 {
    let mut status = 0;
    loop {
        let rc = unsafe { libc::waitpid(pid, &mut status, 0) };
        if rc == pid {
            return if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                128 + libc::WTERMSIG(status)
            };
        }
        if rc < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return -1;
        }
    }
}
