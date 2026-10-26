// SPDX-License-Identifier: GPL-3.0-or-later
//! One renderer, private requests, no passcodes in snapshots or logs.
use super::{
    Bluetooth, Error, IFACE, PATH,
    bus::{self, Peer, Props},
};
use serde_json::{Value as Json, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, oneshot};
use zbus::{Connection, message::Header, zvariant::OwnedObjectPath as Path};
pub const BLUEZ_PATH: &str = "/org/nidara/Session/BluetoothAgent";
pub const OBEX_PATH: &str = "/org/nidara/Session/ObexAgent";
struct Pending {
    id: u64,
    epoch: u64,
    provider: &'static str,
    device: String,
    kind: String,
    reply: Option<oneshot::Sender<Result<String, String>>>,
}
#[derive(Default)]
struct State {
    ui: Option<String>,
    next: u64,
    pending: Option<Pending>,
}
#[derive(Clone)]
pub struct Broker {
    session: Connection,
    epoch: Arc<AtomicU64>,
    state: Arc<Mutex<State>>,
}
impl Broker {
    pub fn new(session: Connection, epoch: Arc<AtomicU64>) -> Self {
        Self {
            session,
            epoch,
            state: Arc::new(Mutex::new(State::default())),
        }
    }
    pub async fn register(&self, sender: &str) -> Result<(), Error> {
        let mut s = self.state.lock().await;
        if let Some(old) = &s.ui {
            if old == sender {
                return Ok(());
            }
            if bus::alive(&self.session, old).await {
                return Err(Error::Busy("another consent UI is registered".into()));
            }
        }
        if let Some(mut pending) = s.pending.take()
            && let Some(reply) = pending.reply.take()
        {
            let _ = reply.send(Err("ui-lost".into()));
        }
        s.ui = Some(sender.into());
        Ok(())
    }
    pub async fn unregister(&self, sender: &str) -> Result<(), Error> {
        let mut s = self.state.lock().await;
        if s.ui.as_deref() != Some(sender) {
            return Err(Error::Denied("not the registered UI".into()));
        }
        s.ui = None;
        drop(s);
        self.withdraw(None, "ui-lost").await;
        Ok(())
    }
    pub async fn check_devices(&self, objects: &bus::Objects) {
        let missing = {
            let s = self.state.lock().await;
            s.pending.as_ref().is_some_and(|p| {
                p.provider == bus::BLUEZ && bus::object(objects, &p.device, bus::DEVICE).is_err()
            })
        };
        if missing {
            self.withdraw(Some(bus::BLUEZ), "device-removed").await;
        }
    }
    pub async fn removed_transfer(&self, path: &str) {
        let missing = {
            let s = self.state.lock().await;
            s.pending
                .as_ref()
                .is_some_and(|p| p.provider == bus::OBEX && p.device == path)
        };
        if missing {
            self.withdraw(Some(bus::OBEX), "transfer-removed").await;
        }
    }
    pub async fn check_ui(&self) {
        let ui = self.state.lock().await.ui.clone();
        if let Some(ui) = ui
            && !bus::alive(&self.session, &ui).await
        {
            let _ = self.unregister(&ui).await;
        }
    }
    async fn emit(
        &self,
        ui: &str,
        event: &str,
        epoch: u64,
        id: u64,
        metadata: &str,
    ) -> Result<(), Error> {
        self.session
            .emit_signal(Some(ui), PATH, IFACE, event, &(epoch, id, metadata))
            .await?;
        Ok(())
    }
    pub async fn withdraw(&self, provider: Option<&str>, reason: &str) {
        let mut s = self.state.lock().await;
        if !s
            .pending
            .as_ref()
            .is_some_and(|p| provider.is_none_or(|n| n == p.provider))
        {
            return;
        }
        let Some(mut p) = s.pending.take() else {
            return;
        };
        let ui = s.ui.clone();
        drop(s);
        if let Some(reply) = p.reply.take() {
            let _ = reply.send(Err(reason.into()));
        }
        if let Some(ui) = ui {
            let _ = self.emit(&ui, "RequestClosed", p.epoch, p.id, reason).await;
        }
    }
    async fn close(&self, id: u64, reason: &str) {
        let mut s = self.state.lock().await;
        if s.pending.as_ref().is_some_and(|p| p.id == id) {
            let p = s.pending.take().unwrap();
            let ui = s.ui.clone();
            drop(s);
            if let Some(ui) = ui {
                let _ = self.emit(&ui, "RequestClosed", p.epoch, id, reason).await;
            }
        }
    }
    pub async fn close_device(&self, device: &str) {
        let matches = self
            .state
            .lock()
            .await
            .pending
            .as_ref()
            .is_some_and(|p| p.provider == bus::BLUEZ && p.device == device);
        if matches {
            self.withdraw(Some(bus::BLUEZ), "operation-complete").await;
        }
    }
    pub async fn ask(
        &self,
        provider: &'static str,
        device: &str,
        kind: &str,
        metadata: Json,
        deadline: Duration,
    ) -> Result<String, Error> {
        self.check_ui().await;
        let (tx, rx) = oneshot::channel();
        let mut s = self.state.lock().await;
        let ui =
            s.ui.clone()
                .ok_or_else(|| Error::Failed("no consent UI".into()))?;
        if s.pending.is_some() {
            return Err(Error::Busy("another consent request is pending".into()));
        }
        s.next = s.next.wrapping_add(1);
        let id = s.next;
        let epoch = self.epoch.load(Ordering::SeqCst);
        s.pending = Some(Pending {
            id,
            epoch,
            provider,
            device: device.into(),
            kind: kind.into(),
            reply: Some(tx),
        });
        drop(s);
        if self
            .emit(&ui, "Request", epoch, id, &metadata.to_string())
            .await
            .is_err()
        {
            self.withdraw(Some(provider), "ui-unavailable").await;
            return Err(Error::Failed("consent UI unavailable".into()));
        }
        // This task owns cleanup even if the caller's D-Bus operation is dropped.
        let broker = self.clone();
        tokio::spawn(async move {
            let answer = tokio::time::timeout(deadline, rx).await;
            broker.close(id, "finished").await;
            match answer {
                Ok(Ok(Ok(value))) => Ok(value),
                Ok(Ok(Err(_))) | Ok(Err(_)) => {
                    Err(Error::Cancelled("consent rejected or withdrawn".into()))
                }
                Err(_) => Err(Error::TimedOut("consent deadline expired".into())),
            }
        })
        .await
        .map_err(|_| Error::Failed("consent task stopped".into()))?
    }
    pub async fn display(&self, device: &str, kind: &str, metadata: Json) -> Result<(), Error> {
        self.check_ui().await;
        let mut s = self.state.lock().await;
        let ui =
            s.ui.clone()
                .ok_or_else(|| Error::Failed("no pairing UI".into()))?;
        let (epoch, id, new) = if let Some(p) = &s.pending {
            if p.device != device || p.kind != kind || p.reply.is_some() {
                return Err(Error::Busy("another consent request is pending".into()));
            }
            (p.epoch, p.id, false)
        } else {
            s.next = s.next.wrapping_add(1);
            let id = s.next;
            let epoch = self.epoch.load(Ordering::SeqCst);
            s.pending = Some(Pending {
                id,
                epoch,
                provider: bus::BLUEZ,
                device: device.into(),
                kind: kind.into(),
                reply: None,
            });
            (epoch, id, true)
        };
        drop(s);
        self.emit(
            &ui,
            if new { "Request" } else { "RequestUpdated" },
            epoch,
            id,
            &metadata.to_string(),
        )
        .await?;
        if new {
            let this = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(120)).await;
                this.close(id, "timeout").await;
            });
        }
        Ok(())
    }
    pub async fn reply(
        &self,
        sender: &str,
        epoch: u64,
        id: u64,
        accept: bool,
        value: &str,
    ) -> Result<(), Error> {
        let mut s = self.state.lock().await;
        if s.ui.as_deref() != Some(sender) {
            return Err(Error::Denied("not the registered UI".into()));
        }
        let p = s
            .pending
            .as_mut()
            .filter(|p| {
                p.id == id && p.epoch == epoch && epoch == self.epoch.load(Ordering::SeqCst)
            })
            .ok_or_else(|| Error::Conflict("stale request".into()))?;
        if p.reply.is_none() {
            return Err(Error::Invalid(
                "display-only request cannot be answered".into(),
            ));
        }
        if accept && !valid_value(&p.kind, value) {
            return Err(Error::Invalid("invalid consent reply value".into()));
        }
        let tx = p.reply.take().unwrap();
        let _ = tx.send(if accept {
            Ok(value.into())
        } else {
            Err("user-rejected".into())
        });
        Ok(())
    }
    pub async fn cancel(&self, sender: &str, epoch: u64, id: u64) -> Result<Option<String>, Error> {
        let s = self.state.lock().await;
        if s.ui.as_deref() != Some(sender) {
            return Err(Error::Denied("not the registered UI".into()));
        }
        let p = s
            .pending
            .as_ref()
            .filter(|p| p.epoch == epoch && p.id == id)
            .ok_or_else(|| Error::Conflict("stale request".into()))?;
        let display = if p.provider == bus::BLUEZ && p.reply.is_none() {
            Some(p.device.clone())
        } else {
            None
        };
        drop(s);
        self.withdraw(None, "user-cancelled").await;
        Ok(display)
    }
}
fn valid_value(kind: &str, v: &str) -> bool {
    match kind {
        "enter-pin" => (1..=16).contains(&v.chars().count()) && !v.chars().any(char::is_control),
        "enter-passkey" => {
            !v.is_empty()
                && v.len() <= 6
                && v.bytes().all(|c| c.is_ascii_digit())
                && v.parse::<u32>().is_ok_and(|v| v <= 999999)
        }
        _ => v.is_empty(),
    }
}
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.Error")]
pub enum PairError {
    Rejected(String),
    Canceled(String),
    NotAuthorized(String),
}
impl From<Error> for PairError {
    fn from(e: Error) -> Self {
        match e {
            Error::Denied(_) => Self::NotAuthorized("not authorized".into()),
            Error::TimedOut(_) | Error::Cancelled(_) => Self::Canceled("request withdrawn".into()),
            _ => Self::Rejected("request rejected".into()),
        }
    }
}
#[derive(Clone)]
pub struct PairAgent(pub Bluetooth);
impl PairAgent {
    async fn peer(&self, h: &Header<'_>) -> Result<Peer, PairError> {
        let p = Peer::current(&self.0.system, bus::BLUEZ).await?;
        p.authenticate(h)?;
        Ok(p)
    }
    async fn metadata(
        &self,
        p: &Peer,
        path: &Path,
        kind: &str,
    ) -> Result<(Props, Json), PairError> {
        let props = p.props(path, bus::DEVICE).await?;
        let label = bus::text(&props, "Alias");
        let label = if label.is_empty() {
            bus::text(&props, "Name")
        } else {
            label
        };
        let metadata = json!({"kind":kind,"device":path.as_str(),"deviceName":label,"address":bus::text(&props,"Address"),"adapter":bus::text(&props,"Adapter")});
        Ok((props, metadata))
    }
    async fn ask(
        &self,
        p: &Peer,
        path: &Path,
        kind: &str,
        extra: Option<(&str, Json)>,
    ) -> Result<String, PairError> {
        let (_, mut m) = self.metadata(p, path, kind).await?;
        if let Some((k, v)) = extra {
            m[k] = v;
        }
        Ok(self
            .0
            .broker
            .ask(bus::BLUEZ, path, kind, m, Duration::from_secs(120))
            .await?)
    }
}
#[zbus::interface(name = "org.bluez.Agent1")]
impl PairAgent {
    async fn release(&self, #[zbus(header)] h: Header<'_>) -> Result<(), PairError> {
        self.peer(&h).await?;
        self.0.broker.withdraw(Some(bus::BLUEZ), "released").await;
        {
            let mut registration = self.0.registration.lock().await;
            registration.bluez.clear();
            registration.default.clear();
        }
        Ok(())
    }
    async fn cancel(&self, #[zbus(header)] h: Header<'_>) -> Result<(), PairError> {
        self.peer(&h).await?;
        self.0
            .broker
            .withdraw(Some(bus::BLUEZ), "bluez-cancelled")
            .await;
        Ok(())
    }
    async fn request_pin_code(
        &self,
        device: Path,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<String, PairError> {
        let p = self.peer(&h).await?;
        self.ask(&p, &device, "enter-pin", None).await
    }
    async fn request_passkey(
        &self,
        device: Path,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<u32, PairError> {
        let p = self.peer(&h).await?;
        let v = self.ask(&p, &device, "enter-passkey", None).await?;
        v.parse()
            .map_err(|_| PairError::Rejected("invalid passkey".into()))
    }
    async fn request_confirmation(
        &self,
        device: Path,
        passkey: u32,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), PairError> {
        let p = self.peer(&h).await?;
        if passkey > 999999 {
            return Err(PairError::Rejected("invalid passkey".into()));
        }
        self.ask(
            &p,
            &device,
            "confirm",
            Some(("code", json!(format!("{passkey:06}")))),
        )
        .await?;
        Ok(())
    }
    async fn request_authorization(
        &self,
        device: Path,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), PairError> {
        let p = self.peer(&h).await?;
        let (props, _) = self.metadata(&p, &device, "authorize").await?;
        if !bus::flag(&props, "Trusted") {
            self.ask(&p, &device, "authorize", None).await?;
        }
        Ok(())
    }
    async fn authorize_service(
        &self,
        device: Path,
        uuid: String,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), PairError> {
        let p = self.peer(&h).await?;
        // Deliberate exception: FTP has no per-file AuthorizePush consent. This
        // only helps when BlueZ calls us; Trusted can bypass the agent upstream.
        if bus::is_ftp(&uuid) {
            return Err(PairError::Rejected(
                "OBEX FTP is outside the per-file consent policy".into(),
            ));
        }

        let (props, _) = self.metadata(&p, &device, "authorize-service").await?;
        if !bus::flag(&props, "Trusted") && !bus::flag(&props, "Paired") {
            self.ask(
                &p,
                &device,
                "authorize-service",
                Some(("serviceUuid", json!(uuid))),
            )
            .await?;
        }
        Ok(())
    }
    async fn display_pin_code(
        &self,
        device: Path,
        pincode: String,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), PairError> {
        let p = self.peer(&h).await?;
        let (_, mut m) = self.metadata(&p, &device, "display-pin").await?;
        m["code"] = json!(pincode);
        self.0.broker.display(&device, "display-pin", m).await?;
        Ok(())
    }
    async fn display_passkey(
        &self,
        device: Path,
        passkey: u32,
        entered: u16,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), PairError> {
        let p = self.peer(&h).await?;
        if passkey > 999999 || entered > 6 {
            return Err(PairError::Rejected("invalid display progress".into()));
        }
        let (_, mut m) = self.metadata(&p, &device, "display-passkey").await?;
        m["code"] = json!(format!("{passkey:06}"));
        m["entered"] = json!(entered);
        self.0.broker.display(&device, "display-passkey", m).await?;
        Ok(())
    }
}
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.obex.Error")]
pub enum PushError {
    Rejected(String),
    Canceled(String),
    NotAuthorized(String),
}
impl From<Error> for PushError {
    fn from(e: Error) -> Self {
        match e {
            Error::TimedOut(_) | Error::Cancelled(_) => Self::Canceled("request withdrawn".into()),
            Error::Denied(_) => Self::NotAuthorized("not authorized".into()),
            _ => Self::Rejected("request rejected".into()),
        }
    }
}
#[derive(Clone)]
pub struct PushAgent(pub Bluetooth);
#[zbus::interface(name = "org.bluez.obex.Agent1")]
impl PushAgent {
    async fn release(&self, #[zbus(header)] h: Header<'_>) -> Result<(), PushError> {
        let p = Peer::current(&self.0.session, bus::OBEX).await?;
        p.authenticate(&h)?;
        self.0.broker.withdraw(Some(bus::OBEX), "released").await;
        self.0.registration.lock().await.obex.clear();
        Ok(())
    }
    async fn cancel(&self, #[zbus(header)] h: Header<'_>) -> Result<(), PushError> {
        let p = Peer::current(&self.0.session, bus::OBEX).await?;
        p.authenticate(&h)?;
        self.0
            .broker
            .withdraw(Some(bus::OBEX), "obex-cancelled")
            .await;
        Ok(())
    }
    async fn authorize_push(
        &self,
        transfer: Path,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<String, PushError> {
        let p = Peer::current(&self.0.session, bus::OBEX).await?;
        p.authenticate(&h)?;
        match tokio::time::timeout(
            Duration::from_secs(55),
            self.0.authorize_push(&p, &transfer),
        )
        .await
        {
            Ok(result) => Ok(result?),
            Err(_) => {
                self.0
                    .broker
                    .withdraw(Some(bus::OBEX), "authorization-timeout")
                    .await;
                Err(PushError::Canceled("authorization timed out".into()))
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passkeys_are_strict_and_replies_are_typed() {
        for v in ["12x", "-1", "+1", "1000000", "", " 1"] {
            assert!(!valid_value("enter-passkey", v));
        }
        assert!(valid_value("enter-passkey", "000007"));
        assert!(!valid_value("incoming-file", "yes"));
        assert!(valid_value("incoming-file", ""));
        assert!(!valid_value("enter-pin", "\n"));
    }
}
