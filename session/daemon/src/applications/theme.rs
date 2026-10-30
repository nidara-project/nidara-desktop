// SPDX-License-Identifier: GPL-3.0-or-later
//! Portal icon-theme events. Never activates a portal or polls an absent owner.
use super::store::Handle;
use futures_util::{StreamExt, stream::SelectAll};
use std::time::Duration;
use zbus::{Connection, MatchRule, MessageStream, message::Type, zvariant::OwnedValue};
const NAME: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.Settings";
const NAMESPACE: &str = "org.gnome.desktop.interface";
async fn set(store: &Handle, theme: String) {
    let _ = store
        .call(move |s| {
            if s.theme != theme {
                s.theme = theme;
                s.icons_changed();
            }
            Ok(())
        })
        .await;
}
async fn read(conn: &Connection, owner: &str, store: &Handle) {
    let theme = tokio::time::timeout(Duration::from_secs(1), async {
        if owner.is_empty() {
            return None;
        }
        let p = zbus::Proxy::new(conn, owner, PATH, IFACE).await.ok()?;
        let v = p
            .call::<_, _, OwnedValue>("ReadOne", &(NAMESPACE, "icon-theme"))
            .await
            .ok()?;
        <&str>::try_from(&v)
            .ok()
            .filter(|s| s.len() <= 1024)
            .map(str::to_owned)
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    set(store, theme).await;
}
pub async fn watch(conn: &Connection, store: Handle) -> zbus::Result<()> {
    let mut events = SelectAll::new();
    let settings = MatchRule::builder()
        .msg_type(Type::Signal)
        .path(PATH)?
        .interface(IFACE)?
        .member("SettingChanged")?
        .build();
    let owners = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .add_arg(NAME)?
        .build();
    // Subscribe first so neither startup nor replacement loses a queued event.
    events.push(MessageStream::for_match_rule(settings, conn, Some(64)).await?);
    events.push(MessageStream::for_match_rule(owners, conn, Some(64)).await?);
    let mut owner = zbus::fdo::DBusProxy::new(conn)
        .await?
        .get_name_owner(NAME.try_into().unwrap())
        .await
        .map(|o| o.to_string())
        .unwrap_or_default();
    let conn = conn.clone();
    tokio::spawn(async move {
        read(&conn, &owner, &store).await;
        while let Some(Ok(message)) = events.next().await {
            let h = message.header();
            if h.member().is_some_and(|m| m.as_str() == "NameOwnerChanged") {
                if let Ok((_, _, new)) = message.body().deserialize::<(String, String, String)>() {
                    owner = new;
                    read(&conn, &owner, &store).await;
                }
            } else if h.sender().is_some_and(|s| s.as_str() == owner)
                && let Ok((ns, key, value)) =
                    message.body().deserialize::<(String, String, OwnedValue)>()
                && ns == NAMESPACE
                && key == "icon-theme"
                && let Ok(value) = <&str>::try_from(&value)
                && value.len() <= 1024
            {
                set(&store, value.to_owned()).await;
            }
        }
    });
    Ok(())
}
