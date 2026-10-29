// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
const IFACE: &str = "com.canonical.dbusmenu";
const MAX_NODES: usize = 4096;
const MAX_MENU_BYTES: usize = 16 * 1024 * 1024;
const MENU_FIELDS: &[&str] = &[
    "type",
    "label",
    "enabled",
    "visible",
    "icon-name",
    "icon-data",
    "toggle-type",
    "toggle-state",
    "children-display",
    "accessible-desc",
    "shortcut",
];
type Layout = (i32, Props, Vec<OwnedValue>);
#[derive(Clone)]
pub struct Session {
    pub caller: String,
    pub handle: String,
    pub generation: u64,
    pub path: String,
    pub revision: u32,
    pub nodes: BTreeMap<i32, Props>,
    pub parents: BTreeMap<i32, Vec<i32>>,
    pub depths: BTreeMap<i32, u8>,
    pub loaded: BTreeSet<i32>,
}
pub struct Event<'a> {
    pub token: &'a str,
    pub revision: u32,
    pub node_id: i32,
    pub event: &'a str,
    pub data: OwnedValue,
    pub timestamp: u32,
}
fn flag(p: &Props, k: &str, default: bool) -> bool {
    p.get(k)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(default)
}
fn png(bytes: Vec<u8>) -> Option<(u32, u32, Vec<u8>)> {
    if bytes.len() > 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(512);
    limits.max_image_height = Some(512);
    limits.max_alloc = Some(4 * 1024 * 1024);
    reader.limits(limits);
    let im = reader.decode().ok()?.to_rgba8();
    Some((im.width(), im.height(), im.into_raw()))
}
fn clean(id: i32, mut props: Props, room: &mut usize) -> Props {
    props.retain(|k, _| MENU_FIELDS.contains(&k.as_str()));
    let mut p = Props::from([("Id".into(), val(id))]);
    for (k, v) in props {
        if k == "icon-data" {
            if let Ok(b) = Vec::<u8>::try_from(v)
                && let Some((w, h, b)) = png(b)
                && b.len() <= *room
            {
                *room -= b.len();
                p.insert("IconRgba".into(), val(b));
                p.insert("IconWidth".into(), val(w));
                p.insert("IconHeight".into(), val(h));
            }
        } else if matches!(k.as_str(), "enabled" | "visible") {
            p.insert(k, val(bool::try_from(&v).unwrap_or(true)));
        } else if k == "toggle-state" {
            p.insert(k, val(i32::try_from(&v).unwrap_or(-1)));
        } else if k == "shortcut" {
            if let Ok(s) = Vec::<Vec<String>>::try_from(v) {
                p.insert(
                    k,
                    val(s
                        .into_iter()
                        .take(8)
                        .map(|r| {
                            r.into_iter()
                                .take(8)
                                .map(model::bounded)
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>()),
                );
            }
        } else if let Ok(s) = String::try_from(v) {
            p.insert(k, val(model::bounded(s)));
        }
    }
    p
}
impl Tray {
    pub(super) async fn menu_signal<T>(&self, caller: &str, member: &str, body: &T)
    where
        T: serde::ser::Serialize + zbus::zvariant::DynamicType,
    {
        let _ = self
            .conn
            .emit_signal(Some(caller), ROOT, "org.nidara.Tray1", member, body)
            .await;
    }
    pub(super) fn menu(&self, token: &str, caller: &str) -> Result<Session, Error> {
        let s = self.state.read().unwrap();
        let m = s
            .menus
            .get(token)
            .filter(|m| m.caller == caller)
            .ok_or_else(|| Error::Stale("menu belongs to another host or is closed".into()))?;
        if !s.hosts.contains(caller)
            || !s.items.get(&m.handle).is_some_and(|i| {
                i.generation == m.generation && i.menu_path().as_deref() == Some(&m.path)
            })
        {
            return Err(Error::Stale("menu item/host has departed".into()));
        }
        Ok(m.clone())
    }
    pub(super) async fn open_menu(
        &self,
        handle: &str,
        generation: u64,
        parent: i32,
        caller: &str,
    ) -> Result<(String, u32, Vec<Props>), Error> {
        if parent != 0 {
            return Err(Error::InvalidArgument(
                "open root (0); ReadMenu opens submenus".into(),
            ));
        }
        let i = self.item(handle, generation)?;
        let path = i
            .menu_path()
            .ok_or_else(|| Error::NotFound("no dbusmenu".into()))?;
        let token = {
            let mut s = self.state.write().unwrap();
            if !s.hosts.contains(caller) {
                return Err(Error::Denied("RegisterHost required".into()));
            }
            if s.menus.len() >= 64 || s.menus.values().filter(|m| m.caller == caller).count() >= 8 {
                return Err(Error::Busy("menu quota".into()));
            }
            let token = format!("m{}", s.next());
            s.menus.insert(
                token.clone(),
                Session {
                    caller: caller.into(),
                    handle: handle.into(),
                    generation,
                    path,
                    revision: 1,
                    nodes: Default::default(),
                    parents: Default::default(),
                    depths: BTreeMap::from([(0, 0)]),
                    loaded: Default::default(),
                },
            );
            token
        };
        match self.read_menu(&token, 0, caller).await {
            Ok((r, p)) => Ok((token, r, p)),
            Err(e) => {
                self.state.write().unwrap().menus.remove(&token);
                Err(e)
            }
        }
    }
    pub(super) async fn read_menu(
        &self,
        token: &str,
        parent: i32,
        caller: &str,
    ) -> Result<(u32, Vec<Props>), Error> {
        let _slot = self.slot()?;
        let m = self.menu(token, caller)?;
        let depth = *m
            .depths
            .get(&parent)
            .ok_or_else(|| Error::InvalidArgument("unknown menu parent".into()))?;
        if depth >= 16 {
            return Err(Error::InvalidArgument("submenu depth limit".into()));
        }
        if parent != 0
            && !m.nodes.get(&parent).is_some_and(|p| {
                text(p, "children-display") == "submenu"
                    && flag(p, "visible", true)
                    && flag(p, "enabled", true)
            })
        {
            return Err(Error::InvalidArgument("not an enabled submenu".into()));
        }
        let i = self.item(&m.handle, m.generation)?;
        let p = Proxy::new(&self.conn, i.owner.as_str(), m.path.as_str(), IFACE).await?;
        match deadline(p.call::<_, _, bool>("AboutToShow", &(parent,))).await {
            Ok(_) => {}
            Err(e) if unsupported_about(&e) => {}
            Err(e) => return Err(e),
        }
        let (_, layout): (u32, Layout) =
            deadline(p.call("GetLayout", &(parent, 1i32, MENU_FIELDS))).await?;
        if layout.0 != parent {
            return Err(Error::Failed("wrong layout root".into()));
        }
        let mut replaced = BTreeSet::new();
        descendants(&m, parent, &mut replaced);
        let retained = m.nodes.iter().filter(|(id, _)| !replaced.contains(*id));
        let retained_bytes = retained.clone().map(|(_, p)| icon_bytes(p)).sum::<usize>();
        let (other_nodes, other_item_nodes, other_bytes, other_item_bytes) = {
            let s = self.state.read().unwrap();
            let others = s.menus.iter().filter(|(t, _)| t.as_str() != token);
            (
                others.clone().map(|(_, m)| m.nodes.len()).sum::<usize>(),
                others
                    .clone()
                    .filter(|(_, n)| n.handle == m.handle)
                    .map(|(_, m)| m.nodes.len())
                    .sum::<usize>(),
                others
                    .clone()
                    .flat_map(|(_, m)| m.nodes.values())
                    .map(icon_bytes)
                    .sum::<usize>(),
                others
                    .filter(|(_, n)| n.handle == m.handle)
                    .flat_map(|(_, m)| m.nodes.values())
                    .map(icon_bytes)
                    .sum::<usize>(),
            )
        };
        let mut room = MAX_MENU_BYTES
            .saturating_sub(other_item_bytes + retained_bytes)
            .min((32 * 1024 * 1024usize).saturating_sub(other_bytes + retained_bytes));
        // The worker retains the RPC permit if the caller disappears mid-decode.
        let slot = _slot;
        let remaining = MAX_NODES
            .saturating_sub(other_item_nodes + retained.clone().count())
            .min(16384usize.saturating_sub(other_nodes + retained.count()));
        let (nodes, truncated) = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let mut nodes = vec![];
            let mut seen = BTreeSet::new();
            let mut truncated = false;
            for (n, child) in layout.2.into_iter().enumerate() {
                if n >= remaining {
                    truncated = true;
                    break;
                }
                let Ok((id, p, _)) = Layout::try_from(child) else {
                    continue;
                };
                if id == 0 || id == i32::MIN || id == parent || !seen.insert(id) {
                    continue;
                }
                nodes.push((id, clean(id, p, &mut room)));
            }
            (nodes, truncated)
        })
        .await
        .map_err(|e| Error::Failed(e.to_string()))?;
        self.menu(token, caller)?;
        let mut s = self.state.write().unwrap();
        // Budget was sampled before decode. Concurrent menu reads may have
        // consumed it meanwhile; retry rather than exceed a central quota.
        let current_other = s.menus.iter().filter(|(t, _)| t.as_str() != token);
        let new_count = nodes.len() + m.nodes.keys().filter(|id| !replaced.contains(*id)).count();
        let new_bytes = nodes.iter().map(|(_, p)| icon_bytes(p)).sum::<usize>() + retained_bytes;
        if current_other
            .clone()
            .map(|(_, m)| m.nodes.len())
            .sum::<usize>()
            + new_count
            > 16384
            || current_other
                .clone()
                .filter(|(_, n)| n.handle == m.handle)
                .map(|(_, m)| m.nodes.len())
                .sum::<usize>()
                + new_count
                > MAX_NODES
            || current_other
                .clone()
                .flat_map(|(_, m)| m.nodes.values())
                .map(icon_bytes)
                .sum::<usize>()
                + new_bytes
                > 32 * 1024 * 1024
            || current_other
                .filter(|(_, n)| n.handle == m.handle)
                .flat_map(|(_, m)| m.nodes.values())
                .map(icon_bytes)
                .sum::<usize>()
                + new_bytes
                > MAX_MENU_BYTES
        {
            return Err(Error::Busy("menu cache budget changed; retry".into()));
        }
        let live = s
            .menus
            .get_mut(token)
            .ok_or_else(|| Error::Stale("menu closed".into()))?;
        if live.revision != m.revision {
            return Err(Error::Stale("layout changed during read; retry".into()));
        }
        // Do not bind the same remote ID under two parents: stale recycled IDs
        // must never activate an unrelated row.
        let old = live.parents.get(&parent).cloned().unwrap_or_default();
        for id in old {
            retire(live, id);
        }
        let mut ids = vec![];
        let mut result = vec![];
        for (id, p) in nodes {
            if live.nodes.contains_key(&id) {
                continue;
            }
            live.depths.insert(id, depth + 1);
            live.nodes.insert(id, p.clone());
            ids.push(id);
            result.push(p);
        }
        live.parents.insert(parent, ids);
        live.loaded.insert(parent);
        live.revision = live
            .revision
            .checked_add(1)
            .ok_or_else(|| Error::Failed("menu revision exhausted".into()))?;
        if truncated {
            result.push(HashMap::from([
                ("Id".into(), val(i32::MIN)),
                ("label".into(), val("…")),
                ("enabled".into(), val(false)),
                ("visible".into(), val(true)),
                ("LimitReached".into(), val(true)),
            ]));
        }
        Ok((live.revision, result))
    }
    pub(super) async fn menu_event(&self, e: Event<'_>, caller: &str) -> Result<(), Error> {
        let _slot = self.slot()?;
        let m = self.menu(e.token, caller)?;
        if m.revision != e.revision {
            return Err(Error::Stale("menu revision changed".into()));
        }
        if !matches!(e.event, "clicked" | "opened" | "closed") {
            return Err(Error::InvalidArgument("menu event".into()));
        }
        // dbusmenu's event data is reserved here. Do not forward arbitrary host
        // payloads through the session daemon.
        if i32::try_from(&e.data).ok() != Some(0) {
            return Err(Error::InvalidArgument(
                "event data must be int32 zero".into(),
            ));
        }
        if e.node_id != 0 || e.event == "clicked" {
            let node = m
                .nodes
                .get(&e.node_id)
                .ok_or_else(|| Error::Stale("node removed".into()))?;
            if !flag(node, "enabled", true)
                || !flag(node, "visible", true)
                || text(node, "type") == "separator"
            {
                return Err(Error::InvalidArgument("node cannot be activated".into()));
            }
        }
        let i = self.item(&m.handle, m.generation)?;
        let p = Proxy::new(&self.conn, i.owner.as_str(), m.path.as_str(), IFACE).await?;
        if self.menu(e.token, caller)?.revision != e.revision {
            return Err(Error::Stale("menu changed before dispatch".into()));
        }
        deadline(p.call::<_, _, ()>("Event", &(e.node_id, e.event, e.data, e.timestamp))).await?;
        self.menu(e.token, caller)?;
        Ok(())
    }
    pub(super) async fn invalidate_menus(&self, owner: &str, path: &str) {
        let changes = {
            let mut s = self.state.write().unwrap();
            let handles = s
                .items
                .values()
                .filter(|i| i.owner == owner)
                .map(|i| i.handle.clone())
                .collect::<BTreeSet<_>>();
            s.menus
                .iter_mut()
                .filter(|(_, m)| handles.contains(&m.handle) && m.path == path)
                .map(|(t, m)| {
                    m.revision = m.revision.saturating_add(1);
                    m.nodes.clear();
                    m.parents.clear();
                    m.depths = BTreeMap::from([(0, 0)]);
                    m.loaded.clear();
                    (t.clone(), m.caller.clone(), m.revision)
                })
                .collect::<Vec<_>>()
        };
        for (token, caller, r) in changes {
            self.menu_signal(&caller, "MenuChanged", &(token, r)).await;
        }
    }
}
fn retire(m: &mut Session, id: i32) {
    if let Some(children) = m.parents.remove(&id) {
        for child in children {
            retire(m, child);
        }
    }
    m.nodes.remove(&id);
    m.depths.remove(&id);
    m.loaded.remove(&id);
}

fn icon_bytes(p: &Props) -> usize {
    p.get("IconRgba")
        .and_then(|v| <&zbus::zvariant::Array>::try_from(v).ok())
        .map_or(0, |a| a.len())
}
fn descendants(m: &Session, parent: i32, out: &mut BTreeSet<i32>) {
    if let Some(ids) = m.parents.get(&parent) {
        for id in ids {
            if out.insert(*id) {
                descendants(m, *id, out);
            }
        }
    }
}

fn unsupported_about(e: &Error) -> bool {
    match e {
        Error::ZBus(zbus::Error::MethodError(name, _, _)) => {
            name.as_str().ends_with(".UnknownMethod") || name.as_str().ends_with(".NotSupported")
        }
        Error::ZBus(zbus::Error::FDO(e)) => matches!(
            **e,
            zbus::fdo::Error::UnknownMethod(_) | zbus::fdo::Error::NotSupported(_)
        ),
        _ => false,
    }
}
