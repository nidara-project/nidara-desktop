// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};
use zbus::zvariant::Value;

struct PrivateBus(Child);

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn private_bus(name: &str) -> (PrivateBus, String) {
    let endpoint = format!(
        "--address=unix:abstract=nidara-polkit-test-{}-{name}",
        std::process::id()
    );
    let mut bus = PrivateBus(
        Command::new("dbus-daemon")
            .args(["--session", &endpoint, "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut address = String::new();
    BufReader::new(bus.0.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    (bus, address.trim().into())
}

async fn connection(address: &str) -> Connection {
    zbus::connection::Builder::address(address)
        .unwrap()
        .method_timeout(Duration::from_secs(2))
        .build()
        .await
        .unwrap()
}

async fn begin(caller: &Connection, agent: &Connection, cookie: &str) -> zbus::Result<()> {
    let address = agent.unique_name().unwrap().clone();
    let proxy = Proxy::new(
        caller,
        address,
        AGENT,
        "org.freedesktop.PolicyKit1.AuthenticationAgent",
    )
    .await?;
    let details: HashMap<&str, &str> = HashMap::new();
    let identities = vec![("unix-user", HashMap::from([("uid", Value::from(1000_u32))]))];
    proxy
        .call(
            "BeginAuthentication",
            &(
                "org.nidara.test",
                "Test request",
                "",
                details,
                cookie,
                identities,
            ),
        )
        .await
}

#[test]
fn private_bus_checks_the_owner_and_admits_one_request() {
    let (_bus, address) = private_bus("messages");
    let address = address.as_str();
    future::block_on(async {
        let authority = connection(address).await;
        let outsider = connection(address).await;
        authority.request_name(NAME).await.unwrap();
        let shell = connection(address).await;
        let state = Arc::new(Mutex::new(State {
            owner: authority.unique_name().map(ToString::to_string),
            pending: None,
        }));
        let status = Arc::new(Status::default());
        status.update_alert_lock(false);
        let (jobs, pending) = mpsc::channel();
        // SAFETY: getuid has no arguments or preconditions. All fake bus clients
        // have that UID, so this also exercises the unique name check.
        let uid = unsafe { libc::getuid() };
        shell
            .object_server()
            .at(
                AGENT,
                Agent {
                    state: state.clone(),
                    status: status.clone(),
                    uid,
                    jobs,
                },
            )
            .await
            .unwrap();
        let error = begin(&outsider, &shell, "fake").await.unwrap_err();
        assert!(error.to_string().contains("NotAuthorized"), "{error:?}");
        assert!(pending.try_recv().is_err());
        let auth = authority.clone();
        let target = shell.clone();
        let first = std::thread::spawn(move || future::block_on(begin(&auth, &target, "first")));
        let Job(request, reply) = pending.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(request.identities, [1000]);
        assert!(
            begin(&authority, &shell, "second")
                .await
                .unwrap_err()
                .to_string()
                .contains("in progress")
        );
        let proxy = Proxy::new(
            &authority,
            shell.unique_name().unwrap().clone(),
            AGENT,
            "org.freedesktop.PolicyKit1.AuthenticationAgent",
        )
        .await
        .unwrap();
        proxy
            .call::<_, _, ()>("CancelAuthentication", &("not-current",))
            .await
            .unwrap();
        assert!(request.ticket.valid(&status, request.generation));
        proxy
            .call::<_, _, ()>("CancelAuthentication", &("first",))
            .await
            .unwrap();
        assert!(!request.ticket.valid(&status, request.generation));
        reply.try_send(Err(cancelled())).unwrap();
        assert!(
            first
                .join()
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("Cancelled")
        );
    });
}

#[test]
fn other_dialogs_block_polkit_and_lock_retires_pending_tickets() {
    let status = Arc::new(Status::default());
    status.update_alert_lock(false);
    let generation = status.unlocked_generation().unwrap();
    let other = Slot::take(&status, SlotKind::Other).unwrap();
    assert!(Slot::take(&status, SlotKind::Polkit).is_none());
    drop(other);
    let polkit = Slot::take(&status, SlotKind::Polkit).unwrap();
    assert!(Slot::take(&status, SlotKind::Other).is_none());
    drop(polkit);
    assert!(Slot::take(&status, SlotKind::Other).is_some());

    let ticket = Ticket {
        cookie: c"test".to_owned(),
        cancelled: AtomicBool::new(false),
    };
    assert!(ticket.valid(&status, generation));
    status.update_alert_lock(true);
    status.update_alert_lock(false);
    assert!(!ticket.valid(&status, generation));
}

const SESSION: &str = "/org/freedesktop/login1/session/test";

struct Login;

#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl Login {
    fn get_session(&self, id: &str) -> OwnedObjectPath {
        assert_eq!(id, "auto");
        SESSION.try_into().unwrap()
    }
}

struct LogindSession(u32);

#[zbus::interface(name = "org.freedesktop.login1.Session")]
impl LogindSession {
    #[zbus(property)]
    fn user(&self) -> (u32, OwnedObjectPath) {
        (
            self.0,
            "/org/freedesktop/login1/user/test".try_into().unwrap(),
        )
    }

    #[zbus(property)]
    fn r#type(&self) -> &str {
        "wayland"
    }

    #[zbus(property)]
    fn class(&self) -> &str {
        "user"
    }

    #[zbus(property)]
    fn remote(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn id(&self) -> &str {
        "test-session"
    }
}

struct Authority(async_channel::Sender<(&'static str, String)>);

#[zbus::interface(name = "org.freedesktop.PolicyKit1.Authority")]
impl Authority {
    fn register_authentication_agent(
        &self,
        #[zbus(header)] header: Header<'_>,
        subject: (String, HashMap<String, OwnedValue>),
        _locale: String,
        object_path: String,
    ) {
        self.record("register", header, subject, object_path);
    }

    fn unregister_authentication_agent(
        &self,
        #[zbus(header)] header: Header<'_>,
        subject: (String, HashMap<String, OwnedValue>),
        object_path: String,
    ) {
        self.record("unregister", header, subject, object_path);
    }
}

impl Authority {
    fn record(
        &self,
        phase: &'static str,
        header: Header<'_>,
        subject: (String, HashMap<String, OwnedValue>),
        object_path: String,
    ) {
        assert_eq!(subject.0, "unix-session");
        assert_eq!(
            <&str>::try_from(&subject.1["session-id"]).unwrap(),
            "test-session"
        );
        assert_eq!(object_path, AGENT);
        self.0
            .try_send((phase, header.sender().unwrap().to_string()))
            .unwrap();
    }
}

#[test]
fn registration_and_shutdown_share_the_same_system_bus_identity() {
    registration_end("shutdown", false);
}

#[test]
fn losing_the_authority_revokes_its_pending_request() {
    registration_end("owner-loss", true);
}

fn registration_end(bus_name: &str, lose_owner: bool) {
    let (_bus, address) = private_bus(bus_name);
    future::block_on(async {
        let login = connection(&address).await;
        // SAFETY: getuid has no arguments or preconditions.
        let uid = unsafe { libc::getuid() };
        login
            .object_server()
            .at("/org/freedesktop/login1", Login)
            .await
            .unwrap();
        login
            .object_server()
            .at(SESSION, LogindSession(uid))
            .await
            .unwrap();
        login.request_name("org.freedesktop.login1").await.unwrap();
        let authority = connection(&address).await;
        let (calls, recorded) = async_channel::bounded(2);
        authority
            .object_server()
            .at(AUTHORITY, Authority(calls))
            .await
            .unwrap();
        authority.request_name(NAME).await.unwrap();

        let shell = connection(&address).await;
        let caller = shell.unique_name().unwrap().to_string();
        let (jobs, _pending) = mpsc::channel();
        let agent = Agent {
            state: Arc::default(),
            status: Arc::default(),
            uid,
            jobs,
        };
        let (stop, stopped) = async_channel::bounded(1);
        let ticket = Arc::new(Ticket {
            cookie: c"synthetic".to_owned(),
            cancelled: AtomicBool::new(false),
        });
        future::race(
            async {
                future::zip(
                    async { registration(&agent, &shell, &stopped).await.unwrap() },
                    async {
                        assert_eq!(recorded.recv().await.unwrap(), ("register", caller.clone()));
                        agent.state.lock().unwrap().pending = Some(ticket.clone());
                        if lose_owner {
                            authority.release_name(NAME).await.unwrap();
                        } else {
                            stop.close();
                            assert_eq!(recorded.recv().await.unwrap(), ("unregister", caller));
                        }
                    },
                )
                .await;
            },
            async {
                async_io::Timer::after(Duration::from_secs(5)).await;
                panic!("private registration did not complete");
            },
        )
        .await;
        assert!(agent.state.lock().unwrap().owner.is_none());
        assert!(ticket.cancelled.load(Ordering::Acquire));
    });
}
