//! What the manager says with the login screen and with its workers: one JSON object per line.
//!
//! **The login screen** (`Greeter*`) talks over the socket named in its `NIDARA_LOGIN_SOCKET`,
//! which only the login user can open. One login at a time:
//!
//! ```text
//! screen  → {"type":"begin","user":"ana"}
//! manager → {"type":"prompt","echo":false,"text":"Password: "}
//! screen  → {"type":"answer","text":"…"}
//! manager → {"type":"info","text":"…"} / {"type":"error","text":"…"}   (as PAM writes them)
//! manager → {"type":"success","open":false}            or {"type":"failed","reason":"auth",…}
//! screen  → {"type":"start"}
//! ```
//!
//! After `success` the screen says `start` and then ends (its Hyalo unlocks and exits); the
//! manager starts the user's session once the login screen has let go of the screens. `open`
//! says the user already has a session, which `start` switches to (#1195 L3). `cancel` drops
//! the login under way at any point before `start`.
//!
//! **A worker** (`Job`, `ToWorker`, `FromWorker`) talks over the socket it inherits as fd 3.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum FromGreeter {
    Begin { user: String },
    Answer { text: String },
    Cancel,
    Start,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ToGreeter {
    Prompt {
        echo: bool,
        text: String,
    },
    Info {
        text: String,
    },
    Error {
        text: String,
    },
    Success {
        open: bool,
    },
    /// `reason`: `auth` (the answer was refused), `account` (the account may not be used now:
    /// expired, locked, outside its hours), `busy` (a login is already under way) or `error`.
    Failed {
        reason: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Class {
    Greeter,
    User,
}

/// What a worker is for: one session, from the PAM transaction to its end.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub service: String,
    pub user: String,
    pub class: Class,
    pub vt: u32,
    /// Run through `/bin/sh -c`; a user session first reads the login profile.
    pub command: String,
    /// The login screen's session is opened without asking anything.
    pub authenticate: bool,
    /// Added to the session's environment.
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ToWorker {
    Job(Job),
    Answer {
        text: String,
    },
    Cancel,
    /// Authenticated: open the session now (the screens are free).
    Open,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum FromWorker {
    Prompt {
        echo: bool,
        text: String,
    },
    Info {
        text: String,
    },
    Error {
        text: String,
    },
    Authenticated,
    Failed {
        reason: String,
        message: String,
    },
    /// The session's first process is running.
    Started {
        pid: i32,
    },
    /// It has ended, and the PAM session with it.
    Ended {
        status: i32,
    },
}
