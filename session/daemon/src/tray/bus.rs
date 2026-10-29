// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
pub struct Root(pub Tray);
#[zbus::interface(name = "org.nidara.Tray1")]
impl Root {
    #[zbus(property)]
    fn available(&self) -> bool {
        self.0.state.read().unwrap().available
    }
    #[zbus(property)]
    fn unavailable_reason(&self) -> String {
        self.0.state.read().unwrap().reason.clone()
    }
    #[zbus(property)]
    fn revision(&self) -> u64 {
        self.0.state.read().unwrap().revision
    }
    #[zbus(property)]
    fn items(&self) -> Vec<Props> {
        self.0
            .state
            .read()
            .unwrap()
            .items
            .values()
            .filter(|i| i.ready)
            .map(Item::metadata)
            .collect()
    }
    fn get_snapshot(&self) -> (u64, Vec<Props>) {
        let s = self.0.state.read().unwrap();
        (
            s.revision,
            s.items
                .values()
                .filter(|i| i.ready)
                .map(Item::metadata)
                .collect(),
        )
    }
    async fn register_host(&self, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        self.0.host(&sender(&h)?, true).await
    }
    async fn unregister_host(&self, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        self.0.host(&sender(&h)?, false).await
    }
    fn get_icon(
        &self,
        handle: &str,
        generation: u64,
        kind: &str,
        size: u32,
    ) -> Result<(u32, u32, Vec<u8>), Error> {
        self.0.item(handle, generation)?.icon(kind, size)
    }
    async fn activate(&self, handle: &str, generation: u64, x: i32, y: i32) -> Result<(), Error> {
        self.0.action(handle, generation, "Activate", x, y).await
    }
    async fn secondary_activate(
        &self,
        handle: &str,
        generation: u64,
        x: i32,
        y: i32,
    ) -> Result<(), Error> {
        self.0
            .action(handle, generation, "SecondaryActivate", x, y)
            .await
    }
    async fn context_menu(
        &self,
        handle: &str,
        generation: u64,
        x: i32,
        y: i32,
    ) -> Result<(), Error> {
        self.0.action(handle, generation, "ContextMenu", x, y).await
    }
    async fn scroll(
        &self,
        handle: &str,
        generation: u64,
        delta: i32,
        orientation: &str,
    ) -> Result<(), Error> {
        if !matches!(orientation, "horizontal" | "vertical") {
            return Err(Error::InvalidArgument("scroll orientation".into()));
        }
        let _slot = self.0.slot()?;
        let i = self.0.item(handle, generation)?;
        let p = Proxy::new(
            &self.0.conn,
            i.owner.as_str(),
            i.path.as_str(),
            i.interface.as_str(),
        )
        .await?;
        deadline(p.call::<_, _, ()>("Scroll", &(delta, orientation))).await?;
        self.0.item(handle, generation)?;
        Ok(())
    }
    async fn open_menu(
        &self,
        handle: &str,
        generation: u64,
        parent_id: i32,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(String, u32, Vec<Props>), Error> {
        self.0
            .open_menu(handle, generation, parent_id, &sender(&h)?)
            .await
    }
    async fn read_menu(
        &self,
        token: &str,
        parent_id: i32,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(u32, Vec<Props>), Error> {
        self.0.read_menu(token, parent_id, &sender(&h)?).await
    }
    #[allow(clippy::too_many_arguments)] // Versioned remote event, with original input timestamp.
    async fn menu_event(
        &self,
        token: &str,
        revision: u32,
        node_id: i32,
        event: &str,
        data: OwnedValue,
        timestamp: u32,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), Error> {
        self.0
            .menu_event(
                menu::Event {
                    token,
                    revision,
                    node_id,
                    event,
                    data,
                    timestamp,
                },
                &sender(&h)?,
            )
            .await
    }
    fn close_menu(&self, token: &str, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        let caller = sender(&h)?;
        self.0.menu(token, &caller)?;
        self.0.state.write().unwrap().menus.remove(token);
        Ok(())
    }
    #[zbus(signal)]
    async fn changed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        revision: u64,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn menu_changed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        token: &str,
        revision: u32,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn menu_closed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        token: &str,
    ) -> zbus::Result<()>;
}
macro_rules! watcher {
    ($ty:ident,$iface:literal) => {
        pub struct $ty(pub Tray);
        #[zbus::interface(name=$iface)]
        impl $ty {
            async fn register_status_notifier_item(
                &self,
                service: &str,
                #[zbus(header)] h: Header<'_>,
            ) -> Result<(), Error> {
                self.0.register_item(service, &sender(&h)?).await
            }
            async fn register_status_notifier_host(
                &self,
                service: &str,
                #[zbus(header)] h: Header<'_>,
            ) -> Result<(), Error> {
                let _startup = self.0.registrations.lock().await;
                let caller = sender(&h)?;
                self.0.resolve(service, &caller).await?;
                self.0.host(&caller, true).await
            }
            #[zbus(property)]
            fn registered_status_notifier_items(&self) -> Vec<String> {
                self.0
                    .state
                    .read()
                    .unwrap()
                    .items
                    .values()
                    .filter(|i| i.ready)
                    .map(|i| i.registration.clone())
                    .collect()
            }
            #[zbus(property)]
            fn is_status_notifier_host_registered(&self) -> bool {
                !self.0.state.read().unwrap().hosts.is_empty()
            }
            #[zbus(property)]
            fn protocol_version(&self) -> i32 {
                0
            }
            #[allow(dead_code)] // Emitted for both interfaces by watcher_signal.
            #[zbus(signal)]
            async fn status_notifier_item_registered(
                e: &zbus::object_server::SignalEmitter<'_>,
                service: &str,
            ) -> zbus::Result<()>;
            #[allow(dead_code)] // Emitted for both interfaces by watcher_signal.
            #[zbus(signal)]
            async fn status_notifier_item_unregistered(
                e: &zbus::object_server::SignalEmitter<'_>,
                service: &str,
            ) -> zbus::Result<()>;
            #[allow(dead_code)] // Emitted for both interfaces by watcher_signal.
            #[zbus(signal)]
            async fn status_notifier_host_registered(
                e: &zbus::object_server::SignalEmitter<'_>,
            ) -> zbus::Result<()>;
            #[allow(dead_code)] // Emitted for both interfaces by watcher_signal.
            #[zbus(signal)]
            async fn status_notifier_host_unregistered(
                e: &zbus::object_server::SignalEmitter<'_>,
            ) -> zbus::Result<()>;
        }
    };
}
watcher!(KdeWatcher, "org.kde.StatusNotifierWatcher");
watcher!(FreedesktopWatcher, "org.freedesktop.StatusNotifierWatcher");
