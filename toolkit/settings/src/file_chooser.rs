// SPDX-License-Identifier: LGPL-3.0-or-later
//! Cancelable portal transport. The mounted builder alone validates and Applies a result.
use futures_lite::{StreamExt, future::race};
use std::{
    collections::HashMap,
    future::Future,
    io::Read,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use zbus::{
    MatchRule, MessageStream, Proxy,
    fdo::DBusProxy,
    message::Type,
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};
type Result<T> = std::result::Result<T, String>;
const PORTAL: &str = "org.freedesktop.portal.Desktop";
const ROOT: &str = "/org/freedesktop/portal/desktop";
const REQUESTS: &str = "/org/freedesktop/portal/desktop/request";
const REQUEST: &str = "org.freedesktop.portal.Request";
static ACTIVE: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Operation {
    pub mount: u64,
    pub request: u64,
}
#[derive(Clone, Debug)]
pub struct Open {
    pub parent: String,
    pub title: String,
    pub images_label: String,
    pub current_folder: Option<PathBuf>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Busy,
    Failed(String),
}
struct Pending {
    operation: Operation,
    cancel: async_channel::Sender<()>,
    reply: mpsc::Receiver<Result<Option<PathBuf>>>,
}
#[derive(Default)]
pub struct Chooser {
    pending: Option<Pending>,
}
impl Chooser {
    pub fn start(
        &mut self,
        connection: &zbus::blocking::Connection,
        operation: Operation,
        open: Open,
    ) -> std::result::Result<(), StartError> {
        if operation.mount == 0
            || operation.request == 0
            || open.title.is_empty()
            || open.images_label.is_empty()
            || (!open.parent.is_empty()
                && (!open.parent.starts_with("wayland:") || open.parent.len() == 8))
        {
            return Err(StartError::Failed("invalid file chooser request".into()));
        }
        let folder = open
            .current_folder
            .as_deref()
            .map(folder_bytes)
            .transpose()
            .map_err(StartError::Failed)?;
        if self.pending.is_some()
            || ACTIVE
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err(StartError::Busy);
        }
        let connection = connection.inner().clone();
        let (cancel, receive) = async_channel::bounded(1);
        let (send, reply) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("wallpaper-chooser".into())
            .spawn(move || {
                struct Lease;
                impl Drop for Lease {
                    fn drop(&mut self) {
                        ACTIVE.store(false, Ordering::Release);
                    }
                }
                let lease = Lease;
                let result = async_io::block_on(run(connection, open, folder, receive));
                drop(lease);
                let _ = send.send(result);
            });
        if let Err(e) = spawned {
            ACTIVE.store(false, Ordering::Release);
            return Err(StartError::Failed(format!("starting chooser worker: {e}")));
        }
        self.pending = Some(Pending {
            operation,
            cancel,
            reply,
        });
        Ok(())
    }
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn poll(&mut self, current: Operation) -> Option<Result<Option<PathBuf>>> {
        let pending = self.pending.as_ref()?;
        if current != pending.operation {
            self.cancel();
            return None;
        }
        let result = match pending.reply.try_recv() {
            Ok(v) => v,
            Err(mpsc::TryRecvError::Empty) => return None,
            Err(mpsc::TryRecvError::Disconnected) => Err("file chooser worker stopped".into()),
        };
        self.pending.take();
        Some(result)
    }
    pub fn cancel(&mut self) {
        if let Some(p) = self.pending.take() {
            let _ = p.cancel.try_send(());
        }
    }
}
impl Drop for Chooser {
    fn drop(&mut self) {
        self.cancel();
    }
}
async fn bounded<T>(future: impl Future<Output = Result<T>>) -> Result<T> {
    race(future, async {
        async_io::Timer::after(Duration::from_secs(3)).await;
        Err("file chooser protocol operation timed out".into())
    })
    .await
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
async fn close(connection: &zbus::Connection, owner: &str, handle: &str) -> Result<()> {
    bounded(async {
        let p = Proxy::new(connection, owner, handle, REQUEST)
            .await
            .map_err(error)?;
        p.call::<_, _, ()>("Close", &()).await.map_err(error)
    })
    .await
}
async fn run(
    connection: zbus::Connection,
    open: Open,
    folder: Option<Vec<u8>>,
    cancel: async_channel::Receiver<()>,
) -> Result<Option<PathBuf>> {
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut random))
        .map_err(error)?;
    let token = format!(
        "nidara_{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")
        .map_err(error)?
        .interface("org.freedesktop.DBus")
        .map_err(error)?
        .member("NameOwnerChanged")
        .map_err(error)?
        .arg(0, PORTAL)
        .map_err(error)?
        .build();
    let mut owners = bounded(async {
        MessageStream::for_match_rule(rule, &connection, Some(8))
            .await
            .map_err(error)
    })
    .await?;
    let bus = bounded(async { DBusProxy::new(&connection).await.map_err(error) }).await?;
    let name = zbus::names::BusName::try_from(PORTAL).map_err(error)?;
    let owner = match bounded(async { bus.get_name_owner(name.clone()).await.map_err(error) }).await
    {
        Ok(owner) => owner,
        Err(_) => {
            bounded(async {
                bus.start_service_by_name(PORTAL.try_into().map_err(error)?, 0)
                    .await
                    .map_err(error)
            })
            .await?;
            bounded(async { bus.get_name_owner(name).await.map_err(error) }).await?
        }
    };
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender(owner.as_str())
        .map_err(error)?
        .interface(REQUEST)
        .map_err(error)?
        .member("Response")
        .map_err(error)?
        .path_namespace(REQUESTS)
        .map_err(error)?
        .build();
    let mut responses = bounded(async {
        MessageStream::for_match_rule(rule, &connection, Some(32))
            .await
            .map_err(error)
    })
    .await?;
    let sender = connection
        .unique_name()
        .ok_or("chooser connection has no unique name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let predicted = format!("{REQUESTS}/{sender}/{token}");
    let filters = vec![(
        open.images_label,
        vec![
            (1u32, "image/jpeg"),
            (1, "image/png"),
            (1, "image/gif"),
            (1, "image/webp"),
            (1, "image/avif"),
        ],
    )];
    let mut options = HashMap::from([
        ("handle_token", Value::from(token.as_str())),
        ("modal", Value::from(true)),
        ("multiple", Value::from(false)),
        ("filters", Value::from(filters)),
    ]);
    if let Some(folder) = folder {
        options.insert("current_folder", Value::from(folder));
    }
    let result = bounded(async {
        let p = Proxy::new(
            &connection,
            owner.as_str(),
            ROOT,
            "org.freedesktop.portal.FileChooser",
        )
        .await
        .map_err(error)?;
        p.call::<_, _, OwnedObjectPath>("OpenFile", &(open.parent, open.title, options))
            .await
            .map_err(error)
    })
    .await;
    let handle = match result {
        Ok(handle) => handle,
        Err(e) => {
            let _ = close(&connection, owner.as_str(), &predicted).await;
            return Err(e);
        }
    };
    if !handle.as_str().starts_with(&format!("{REQUESTS}/")) {
        return Err("file chooser returned an invalid request path".into());
    }
    enum Next {
        Response(Option<zbus::Result<zbus::Message>>),
        Owner(Option<zbus::Result<zbus::Message>>),
        Canceled,
    }
    let mut needs_close = true;
    let result = async {
        loop {
            let next = race(
                race(async { Next::Owner(owners.next().await) }, async {
                    Next::Response(responses.next().await)
                }),
                async {
                    let _ = cancel.recv().await;
                    Next::Canceled
                },
            )
            .await;
            match next {
                Next::Canceled => {
                    needs_close = false;
                    close(&connection, owner.as_str(), handle.as_str()).await?;
                    return Ok(None);
                }
                Next::Owner(Some(Ok(message))) => {
                    let (_, old, new): (String, String, String) =
                        message.body().deserialize().map_err(error)?;
                    if old == owner.as_str() && new != owner.as_str() {
                        return Err("file chooser portal owner changed".into());
                    }
                }
                Next::Response(Some(Ok(message))) => {
                    if message
                        .header()
                        .path()
                        .is_none_or(|path| path.as_str() != handle.as_str())
                    {
                        continue;
                    }
                    let current = bounded(async {
                        bus.get_name_owner(PORTAL.try_into().map_err(error)?)
                            .await
                            .map_err(error)
                    })
                    .await?;
                    if current != owner {
                        return Err(
                            "file chooser portal owner changed before response acceptance".into(),
                        );
                    }
                    let (response, values): (u32, HashMap<String, OwnedValue>) =
                        message.body().deserialize().map_err(error)?;
                    needs_close = false;
                    return match response {
                        1 => Ok(None),
                        0 => {
                            let uris = Vec::<String>::try_from(
                                values
                                    .get("uris")
                                    .ok_or("chooser success has no uris")?
                                    .try_clone()
                                    .map_err(error)?,
                            )
                            .map_err(error)?;
                            if uris.len() != 1 {
                                return Err(
                                    "chooser success must contain exactly one file URI".into()
                                );
                            }
                            file_path(&uris[0]).map(Some)
                        }
                        _ => Err(format!("file chooser ended with response {response}")),
                    };
                }
                Next::Owner(Some(Err(e))) | Next::Response(Some(Err(e))) => return Err(error(e)),
                Next::Owner(None) | Next::Response(None) => {
                    return Err("file chooser signal stream closed".into());
                }
            }
        }
    }
    .await;
    if result.is_err() && needs_close {
        let _ = close(&connection, owner.as_str(), handle.as_str()).await;
    }
    result
}

fn folder_bytes(path: &Path) -> Result<Vec<u8>> {
    let bytes = path.as_os_str().as_bytes();
    if !path.is_absolute() || bytes.contains(&0) {
        return Err("invalid file chooser current folder".into());
    }
    let mut bytes = bytes.to_vec();
    bytes.push(0);
    Ok(bytes)
}

fn file_path(uri: &str) -> Result<PathBuf> {
    let rest = uri
        .strip_prefix("file://")
        .ok_or("chooser URI is not local file://")?;
    let path = rest
        .strip_prefix("localhost/")
        .map(|p| format!("/{p}"))
        .unwrap_or_else(|| rest.to_owned());
    if !path.starts_with('/') || path.contains(['?', '#']) {
        return Err("chooser URI has a remote authority/query/fragment".into());
    }
    let bytes = path.as_bytes();
    let mut decoded = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3).ok_or("truncated file URI escape")?;
            let text = std::str::from_utf8(hex).map_err(error)?;
            decoded.push(u8::from_str_radix(text, 16).map_err(error)?);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    if decoded.contains(&0) {
        return Err("chooser URI contains NUL".into());
    }
    let path = PathBuf::from(String::from_utf8(decoded).map_err(error)?);
    if !path.is_absolute() {
        return Err("chooser URI is not absolute".into());
    }
    Ok(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_folder_uses_filesystem_bytes_and_a_single_terminator() {
        use std::os::unix::ffi::OsStringExt;
        let path = PathBuf::from(std::ffi::OsString::from_vec(
            b"/home/non-utf8-\xff".to_vec(),
        ));
        assert_eq!(folder_bytes(&path).unwrap(), b"/home/non-utf8-\xff\0");
        assert!(folder_bytes(Path::new("relative")).is_err());
        assert!(folder_bytes(Path::new("/a\0b")).is_err());
    }
    #[test]
    fn completed_result_cannot_cross_a_mount_and_cancel_retires_pending() {
        let (send, reply) = mpsc::channel();
        send.send(Ok(Some(PathBuf::from("/selected.png")))).unwrap();
        let (cancel, _) = async_channel::bounded(1);
        let mut chooser = Chooser {
            pending: Some(Pending {
                operation: Operation {
                    mount: 1,
                    request: 2,
                },
                cancel,
                reply,
            }),
        };
        assert_eq!(
            chooser.poll(Operation {
                mount: 2,
                request: 2
            }),
            None,
            "completed chooser result crossed mounts"
        );
        assert!(!chooser.pending());
    }
    #[test]
    fn local_uri_decoding_does_not_reinterpret_encoded_path_bytes_as_uri_syntax() {
        assert_eq!(
            file_path("file:///home/a/Picture%20%23%3F.png").unwrap(),
            PathBuf::from("/home/a/Picture #?.png")
        );
        assert_eq!(
            file_path("file://localhost/home/a/%E6%97%A5.png").unwrap(),
            PathBuf::from("/home/a/日.png")
        );
        for uri in [
            "https://example.com/a",
            "file://remote/home/a",
            "file:///a?x",
            "file:///a#x",
            "file:///a%00",
            "file:///a%ff",
            "file:///a%",
            "file://relative",
        ] {
            assert!(file_path(uri).is_err(), "{uri}");
        }
    }
}
