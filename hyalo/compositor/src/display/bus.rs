// SPDX-License-Identifier: GPL-3.0-or-later
//! Blocking D-Bus runs on its own threads. Only typed commands cross into calloop.
use super::{Command, Event, model::*};
use smithay::reexports::calloop::channel::Sender;
use std::{
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Display1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    StaleState(String),
    InvalidLayout(String),
    Unsupported(String),
    Busy(String),
    PermissionDenied(String),
    Expired(String),
    ApplyFailed(String),
    PersistenceFailed(String),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone)]
struct Display {
    tx: Sender<Event>,
    snapshot: Arc<Mutex<Snapshot>>,
}
impl Display {
    fn request(&self, header: zbus::message::Header<'_>, command: Command) -> Result<Pending> {
        let owner = header
            .sender()
            .ok_or_else(|| Error::PermissionDenied("missing sender".into()))?
            .to_string();
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .send(Event::Command {
                owner,
                command,
                reply: tx,
                expires: Instant::now() + Duration::from_secs(7),
            })
            .map_err(|_| Error::ApplyFailed("compositor stopped".into()))?;
        rx.recv_timeout(Duration::from_secs(8))
            .map_err(|_| Error::ApplyFailed("compositor did not complete request".into()))?
    }
}
#[zbus::interface(name = "org.nidara.Display1")]
impl Display {
    #[zbus(signal)]
    async fn changed(emitter: &zbus::object_server::SignalEmitter<'_>, epoch: u64, revision: u64) -> zbus::Result<()>;

    /// Policy effects may come only from the current session daemon, not arbitrary clients.
    async fn set_lid_state(
        &self,
        generation: u64,
        sequence: u64,
        closed: bool,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<()> {
        let proxy = zbus::fdo::DBusProxy::new(connection).await?;
        let name = zbus::names::BusName::try_from("org.nidara.Session").unwrap();
        let owner = proxy
            .get_name_owner(name)
            .await
            .map_err(|_| Error::PermissionDenied("session daemon unavailable".into()))?;
        if header.sender().map(|s| s.as_str()) != Some(owner.as_str()) {
            return Err(Error::PermissionDenied("not the session daemon".into()));
        }
        self.request(
            header,
            Command::LidState {
                generation,
                sequence,
                closed,
            },
        )
        .map(|_| ())
    }
    fn get_state(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }
    fn validate(&self, epoch: u64, revision: u64, layout: Layout) -> Result<Layout> {
        let s = self.snapshot.lock().unwrap();
        if s.epoch != epoch || s.revision != revision {
            return Err(Error::StaleState("reread snapshot".into()));
        }
        super::model::validate(layout, &s.outputs).map_err(Error::InvalidLayout)
    }
    fn preview(
        &self,
        epoch: u64,
        revision: u64,
        layout: Layout,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<Pending> {
        self.request(
            header,
            Command::Preview {
                epoch,
                revision,
                layout,
            },
        )
    }
    fn confirm(&self, token: String, #[zbus(header)] header: zbus::message::Header<'_>) -> Result<()> {
        self.request(header, Command::Confirm(token)).map(|_| ())
    }
    fn cancel(&self, token: String, #[zbus(header)] header: zbus::message::Header<'_>) -> Result<()> {
        self.request(header, Command::Cancel(token)).map(|_| ())
    }
    fn identify(&self, epoch: u64, revision: u64, #[zbus(header)] header: zbus::message::Header<'_>) -> Result<()> {
        self.request(header, Command::Identify { epoch, revision }).map(|_| ())
    }
}
pub fn serve(tx: Sender<Event>, snapshot: Arc<Mutex<Snapshot>>, signals: mpsc::Receiver<()>) {
    let display = Display {
        tx: tx.clone(),
        snapshot: snapshot.clone(),
    };
    let connection = match zbus::blocking::connection::Builder::session()
        .and_then(|b| b.name("org.nidara.Display"))
        .and_then(|b| b.serve_at("/org/nidara/Display", display))
        .and_then(|b| b.build())
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(%e, "Display1 not served");
            return;
        }
    };
    let signal_conn = connection.clone();
    std::thread::spawn(move || {
        let mut last = 0;
        while signals.recv().is_ok() {
            let (epoch, revision) = {
                let s = snapshot.lock().unwrap();
                (s.epoch, s.revision)
            };
            if revision != last {
                if signal_conn
                    .emit_signal(
                        None::<&str>,
                        "/org/nidara/Display",
                        "org.nidara.Display1",
                        "Changed",
                        &(epoch, revision),
                    )
                    .is_err()
                {
                    break;
                }
                last = revision;
            }
        }
    });
    let Ok(proxy) = zbus::blocking::fdo::DBusProxy::new(&connection) else {
        return;
    };
    let Ok(changes) = proxy.receive_name_owner_changed() else {
        return;
    };
    for change in changes {
        let Ok(args) = change.args() else { continue };
        if args.new_owner().is_none() {
            let _ = tx.send(Event::OwnerLost(args.name().to_string()));
        }
    }
}
