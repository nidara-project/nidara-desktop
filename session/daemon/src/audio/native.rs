// SPDX-License-Identifier: GPL-3.0-or-later
//! Small libwireplumber ABI boundary. All pointers and GObjects stay on this GLib thread.
//! Parameters use libspa's checked deserializer; no hand-cast SPA layout or shell commands.
use super::model::*;
use super::*;
use glib::{prelude::*, translate::*};
use pipewire::spa::{
    self,
    pod::{Value as PodValue, ValueArray, deserialize::PodDeserializer},
};
use std::{
    cell::Cell,
    collections::BTreeSet,
    ffi::{CStr, CString, c_char, c_void},
    ptr,
    rc::Rc,
};
type Ptr = *mut c_void;
type Callback =
    Option<unsafe extern "C" fn(*mut glib::gobject_ffi::GObject, *mut gio::ffi::GAsyncResult, Ptr)>;
#[link(name = "wireplumber-0.5")]
unsafe extern "C" {
    fn wp_init(flags: u32);
    fn wp_core_new(
        context: *mut glib::ffi::GMainContext,
        conf: Ptr,
        props: Ptr,
    ) -> *mut glib::gobject_ffi::GObject;
    fn wp_core_get_own_bound_id(core: Ptr) -> u32;
    fn wp_core_get_remote_cookie(core: Ptr) -> u32;
    fn wp_core_connect(core: Ptr) -> i32;
    fn wp_core_disconnect(core: Ptr);
    fn wp_core_is_connected(core: Ptr) -> i32;
    fn wp_core_load_component(
        core: Ptr,
        component: *const c_char,
        kind: *const c_char,
        args: Ptr,
        provides: *const c_char,
        cancel: Ptr,
        callback: Callback,
        data: Ptr,
    );
    fn wp_core_load_component_finish(
        core: Ptr,
        result: *mut gio::ffi::GAsyncResult,
        error: *mut *mut glib::ffi::GError,
    ) -> i32;
    fn wp_object_activate(obj: Ptr, features: u32, cancel: Ptr, callback: Callback, data: Ptr);
    fn wp_object_activate_finish(
        obj: Ptr,
        result: *mut gio::ffi::GAsyncResult,
        error: *mut *mut glib::ffi::GError,
    ) -> i32;
    fn wp_plugin_find(core: Ptr, name: *const c_char) -> *mut glib::gobject_ffi::GObject;
    fn wp_object_manager_new() -> *mut glib::gobject_ffi::GObject;
    fn wp_object_manager_add_interest(om: Ptr, type_: usize, ...);
    fn wp_object_manager_request_object_features(om: Ptr, type_: usize, features: u32);
    fn wp_core_install_object_manager(core: Ptr, om: Ptr);
    fn wp_object_manager_is_installed(om: Ptr) -> i32;
    fn wp_object_manager_new_iterator(om: Ptr) -> Ptr;
    fn wp_iterator_foreach(
        it: Ptr,
        callback: Option<unsafe extern "C" fn(*const glib::gobject_ffi::GValue, Ptr)>,
        data: Ptr,
    ) -> i32;
    fn wp_iterator_unref(it: Ptr);
    fn wp_node_get_type() -> usize;
    fn wp_device_get_type() -> usize;
    fn wp_metadata_get_type() -> usize;
    fn wp_link_get_type() -> usize;
    fn wp_node_get_state(node: Ptr, error: *mut *const c_char) -> i32;
    fn wp_proxy_get_bound_id(proxy: Ptr) -> u32;
    fn wp_pipewire_object_get_property(obj: Ptr, key: *const c_char) -> *const c_char;
    fn wp_pipewire_object_enum_params_sync(obj: Ptr, id: *const c_char, filter: Ptr) -> Ptr;
    fn wp_pipewire_object_set_param(obj: Ptr, id: *const c_char, flags: u32, param: Ptr) -> i32;
    fn wp_spa_pod_get_spa_pod(pod: Ptr) -> *const spa::sys::spa_pod;
    fn wp_spa_pod_new_wrap_const(pod: *const spa::sys::spa_pod) -> Ptr;
    fn wp_spa_pod_unref(pod: Ptr);
    fn wp_global_proxy_get_global_properties(obj: Ptr) -> Ptr;
    fn wp_properties_get(props: Ptr, key: *const c_char) -> *const c_char;
    fn wp_properties_unref(props: Ptr);
    fn wp_metadata_find(
        metadata: Ptr,
        subject: u32,
        key: *const c_char,
        type_: *mut *const c_char,
    ) -> *const c_char;
    fn wp_metadata_set(
        metadata: Ptr,
        subject: u32,
        key: *const c_char,
        type_: *const c_char,
        value: *const c_char,
    );
    fn wp_link_get_linked_object_ids(
        link: Ptr,
        out_node: *mut u32,
        out_port: *mut u32,
        in_node: *mut u32,
        in_port: *mut u32,
    );
}
fn raw(o: &glib::Object) -> Ptr {
    o.as_ptr().cast()
}
fn c(s: &str) -> CString {
    CString::new(s).expect("internal string or PipeWire property without NUL")
}
unsafe fn string(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}
fn prop(o: &glib::Object, key: &str) -> String {
    unsafe { string(wp_pipewire_object_get_property(raw(o), c(key).as_ptr())) }
}
fn id(o: &glib::Object) -> u32 {
    unsafe { wp_proxy_get_bound_id(raw(o)) }
}
fn is(o: &glib::Object, t: usize) -> bool {
    o.type_().is_a(unsafe { from_glib(t) })
}
fn objects(om: &glib::Object) -> Vec<glib::Object> {
    unsafe extern "C" fn each(v: *const glib::gobject_ffi::GValue, p: Ptr) {
        let target = unsafe { &mut *p.cast::<Vec<glib::Object>>() };
        let o = unsafe { glib::gobject_ffi::g_value_get_object(v) };
        if !o.is_null() {
            target.push(unsafe { from_glib_none(o) });
        }
    }
    let mut out = Vec::new();
    unsafe {
        let it = wp_object_manager_new_iterator(raw(om));
        if !it.is_null() {
            wp_iterator_foreach(it, Some(each), (&mut out as *mut Vec<glib::Object>).cast());
            wp_iterator_unref(it);
        }
    }
    out
}
fn params(o: &glib::Object, name: &str) -> Vec<spa::pod::Object> {
    unsafe extern "C" fn each(v: *const glib::gobject_ffi::GValue, p: Ptr) {
        let target = unsafe { &mut *p.cast::<Vec<spa::pod::Object>>() };
        let wp = unsafe { glib::gobject_ffi::g_value_get_boxed(v) };
        if wp.is_null() {
            return;
        }
        let pod = unsafe { wp_spa_pod_get_spa_pod(wp) };
        if let Some(pod) = ptr::NonNull::new(pod.cast_mut())
            && let Ok(PodValue::Object(obj)) =
                unsafe { PodDeserializer::deserialize_ptr::<PodValue>(pod) }
        {
            target.push(obj);
        }
    }
    let mut out = Vec::new();
    unsafe {
        let it = wp_pipewire_object_enum_params_sync(raw(o), c(name).as_ptr(), ptr::null_mut());
        if !it.is_null() {
            wp_iterator_foreach(
                it,
                Some(each),
                (&mut out as *mut Vec<spa::pod::Object>).cast(),
            );
            wp_iterator_unref(it);
        }
    }
    out
}
fn field(o: &spa::pod::Object, key: u32) -> Option<&PodValue> {
    o.properties.iter().find(|p| p.key == key).map(|p| &p.value)
}
fn int(o: &spa::pod::Object, key: u32) -> i32 {
    match field(o, key) {
        Some(PodValue::Int(i)) => *i,
        Some(PodValue::Id(i)) => i.0 as i32,
        _ => -1,
    }
}
fn text(o: &spa::pod::Object, key: u32) -> String {
    match field(o, key) {
        Some(PodValue::String(s)) => s.clone(),
        _ => String::new(),
    }
}
fn ints(o: &spa::pod::Object, key: u32) -> Vec<i32> {
    match field(o, key) {
        Some(PodValue::ValueArray(ValueArray::Int(v))) => v.clone(),
        _ => Vec::new(),
    }
}
fn availability(v: i32) -> String {
    match v {
        1 => "no",
        2 => "yes",
        _ => "unknown",
    }
    .into()
}
fn set_param(o: &glib::Object, name: &str, obj: spa::pod::Object) -> Result<(), Error> {
    let bytes = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &PodValue::Object(obj),
    )
    .map_err(|_| Error::Failed("serialize SPA parameter".into()))?
    .0
    .into_inner();
    let pod = spa::pod::Pod::from_bytes(&bytes)
        .ok_or_else(|| Error::Failed("invalid serialized parameter".into()))?;
    unsafe {
        let wp = wp_spa_pod_new_wrap_const(pod.as_raw_ptr());
        let ok = wp_pipewire_object_set_param(raw(o), c(name).as_ptr(), 0, wp);
        wp_spa_pod_unref(wp);
        if ok == 0 {
            return Err(Error::Failed("backend rejected parameter".into()));
        }
    }
    Ok(())
}
fn property(key: u32, value: PodValue) -> spa::pod::Property {
    spa::pod::Property {
        key,
        flags: spa::pod::PropertyFlags::empty(),
        value,
    }
}
struct Completion {
    done: Rc<Cell<bool>>,
    failed: Rc<Cell<bool>>,
    activate: bool,
}
unsafe extern "C" fn complete(
    o: *mut glib::gobject_ffi::GObject,
    r: *mut gio::ffi::GAsyncResult,
    p: Ptr,
) {
    let state = unsafe { Box::from_raw(p.cast::<Completion>()) };
    let mut error = ptr::null_mut();
    let ok = unsafe {
        if state.activate {
            wp_object_activate_finish(o.cast(), r, &mut error)
        } else {
            wp_core_load_component_finish(o.cast(), r, &mut error)
        }
    };
    if !error.is_null() {
        unsafe { glib::ffi::g_error_free(error) };
    }
    state.failed.set(ok == 0);
    state.done.set(true);
}
fn wait(context: &glib::MainContext, done: &Cell<bool>, timeout: Duration) -> bool {
    let until = std::time::Instant::now() + timeout;
    while !done.get() && std::time::Instant::now() < until {
        while context.pending() {
            context.iteration(false);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    done.get()
}
fn plugin(
    context: &glib::MainContext,
    core: &glib::Object,
    name: &str,
) -> Result<glib::Object, String> {
    let done = Rc::new(Cell::new(false));
    let failed = Rc::new(Cell::new(false));
    let state = Box::new(Completion {
        done: done.clone(),
        failed: failed.clone(),
        activate: false,
    });
    unsafe {
        wp_core_load_component(
            raw(core),
            c(&format!("libwireplumber-module-{name}")).as_ptr(),
            c("module").as_ptr(),
            ptr::null_mut(),
            c(name).as_ptr(),
            ptr::null_mut(),
            Some(complete),
            Box::into_raw(state).cast(),
        );
    }
    if !wait(context, &done, Duration::from_secs(5)) || failed.get() {
        return Err(format!("cannot load {name}"));
    }
    let ptr = unsafe { wp_plugin_find(raw(core), c(name).as_ptr()) };
    if ptr.is_null() {
        return Err(format!("missing {name}"));
    }
    let obj: glib::Object = unsafe { from_glib_full(ptr) };
    done.set(false);
    failed.set(false);
    let state = Box::new(Completion {
        done: done.clone(),
        failed: failed.clone(),
        activate: true,
    });
    unsafe {
        wp_object_activate(
            raw(&obj),
            1,
            ptr::null_mut(),
            Some(complete),
            Box::into_raw(state).cast(),
        );
    }
    if !wait(context, &done, Duration::from_secs(5)) || failed.get() {
        return Err(format!("cannot activate {name}"));
    }
    Ok(obj)
}
fn global_prop(o: &glib::Object, key: &str) -> String {
    unsafe {
        let props = wp_global_proxy_get_global_properties(raw(o));
        if props.is_null() {
            return String::new();
        }
        let value = string(wp_properties_get(props, c(key).as_ptr()));
        wp_properties_unref(props);
        value
    }
}
fn metadata(objects: &[glib::Object]) -> Option<glib::Object> {
    objects
        .iter()
        .find(|o| {
            is(o, unsafe { wp_metadata_get_type() }) && global_prop(o, "metadata.name") == "default"
        })
        .cloned()
}
fn meta(md: &glib::Object, subject: u32, key: &str) -> String {
    unsafe {
        string(wp_metadata_find(
            raw(md),
            subject,
            c(key).as_ptr(),
            ptr::null_mut(),
        ))
    }
}
fn set_meta(md: &glib::Object, subject: u32, key: &str, value: Option<&str>) {
    let key = c(key);
    let value = value.map(c);
    unsafe {
        wp_metadata_set(
            raw(md),
            subject,
            key.as_ptr(),
            if value.is_some() {
                c"Spa:Id".as_ptr()
            } else {
                ptr::null()
            },
            value.as_ref().map_or(ptr::null(), |v| v.as_ptr()),
        );
    }
}
fn read_mixer(mixer: &glib::Object, id: u32, node: &mut Node) {
    let Some(v) = mixer.emit_by_name::<Option<glib::Variant>>("get-volume", &[&id]) else {
        return;
    };
    let dict = glib::VariantDict::new(Some(&v));
    if let Ok(Some(value)) = dict.lookup::<bool>("mute") {
        node.muted = value;
        if !node.capabilities.iter().any(|c| c == "mute") {
            node.capabilities.push("mute".into());
        }
    }
    if let Ok(Some(value)) = dict.lookup::<f64>("volume") {
        node.volume = value;
        if !node.capabilities.iter().any(|c| c == "volume") {
            node.capabilities.push("volume".into());
        }
    }
    if let Some(channels) = dict.lookup_value("channelVolumes", None) {
        let mut ordered = BTreeMap::new();
        for i in 0..channels.n_children() {
            let pair = channels.child_value(i);
            let Some(index) = pair
                .child_value(0)
                .str()
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            let Some(value) = pair.child_value(1).as_variant() else {
                continue;
            };
            let entry = glib::VariantDict::new(Some(&value));
            if let Ok(Some(volume)) = entry.lookup::<f64>("volume") {
                let position = entry
                    .lookup::<String>("channel")
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                ordered.insert(index, Channel { position, volume });
            }
        }
        node.channels = ordered.into_values().collect();
        if !node.channels.is_empty() {
            node.volume = node.channels.iter().map(|c| c.volume).fold(0.0, f64::max);
        }
    }
}
struct Worker {
    core: glib::Object,
    om: glib::Object,
    mixer: glib::Object,
    defaults: glib::Object,
    graph: Graph,
    dirty: Rc<Cell<bool>>,
    streams: super::streams::Manager,
    prefs: Arc<RwLock<Preferences>>,
    sequences: BTreeMap<String, u64>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        unsafe {
            wp_core_disconnect(raw(&self.core));
        }
    }
}
impl Worker {
    fn new(
        context: &glib::MainContext,
        generation: u64,
        prefs: Arc<RwLock<Preferences>>,
        streams: super::streams::Manager,
    ) -> Result<Self, String> {
        let core: glib::Object = unsafe {
            from_glib_full(wp_core_new(
                context.to_glib_none().0,
                ptr::null_mut(),
                ptr::null_mut(),
            ))
        };
        if unsafe { wp_core_connect(raw(&core)) } == 0 {
            return Err("PipeWire socket unavailable".into());
        }
        let mixer = plugin(context, &core, "mixer-api")?;
        let scale = glib::EnumClass::with_type(mixer.find_property("scale").unwrap().value_type())
            .unwrap()
            .to_value(1)
            .unwrap();
        mixer.set_property_from_value("scale", &scale);
        let defaults = plugin(context, &core, "default-nodes-api")?;
        let om: glib::Object = unsafe { from_glib_full(wp_object_manager_new()) };
        let dirty = Rc::new(Cell::new(true));
        {
            let name = "changed";
            let d = dirty.clone();
            mixer.connect_local(name, false, move |_| {
                d.set(true);
                None
            });
            let d = dirty.clone();
            defaults.connect_local(name, false, move |_| {
                d.set(true);
                None
            });
        }
        let d = dirty.clone();
        om.connect_local("objects-changed", false, move |_| {
            d.set(true);
            None
        });
        let d = dirty.clone();
        om.connect_local("object-added", false, move |args| {
            let obj = args[1].get::<glib::Object>().unwrap();
            for name in [
                "params-changed",
                "notify::properties",
                "notify::state",
                "changed",
            ] {
                let signal = name.split("::").next().unwrap();
                if glib::subclass::SignalId::lookup(signal, obj.type_()).is_some() {
                    let d = d.clone();
                    obj.connect_local(name, false, move |_| {
                        d.set(true);
                        None
                    });
                }
            }
            d.set(true);
            None
        });
        unsafe {
            for t in [
                wp_node_get_type(),
                wp_device_get_type(),
                wp_metadata_get_type(),
                wp_link_get_type(),
            ] {
                wp_object_manager_add_interest(raw(&om), t, ptr::null::<c_void>());
                wp_object_manager_request_object_features(raw(&om), t, u32::MAX);
            }
            wp_core_install_object_manager(raw(&core), raw(&om));
        }
        let start = std::time::Instant::now();
        while unsafe { wp_object_manager_is_installed(raw(&om)) } == 0 {
            while context.pending() {
                context.iteration(false);
            }
            if start.elapsed() > Duration::from_secs(5) {
                return Err("initial graph enumeration timed out".into());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(Self {
            core,
            om,
            mixer,
            defaults,
            graph: Graph {
                generation,
                state: "ready".into(),
                ..Default::default()
            },
            dirty,
            streams,
            prefs,
            sequences: BTreeMap::new(),
        })
    }
    fn snapshot(&mut self) -> Graph {
        let all = objects(&self.om);
        let epoch = self.graph.generation;
        let mut graph = Graph {
            generation: epoch,
            state: "ready".into(),
            ..Default::default()
        };
        let md = metadata(&all);
        graph.defaults_available = md.is_some();
        if md.is_none() {
            graph.state = "degraded".into();
            graph.error = "WirePlumber default metadata unavailable".into();
        }
        graph.switch_policy = md
            .as_ref()
            .is_some_and(|m| meta(m, 0, "nidara.audio.switch-policy") == "1");
        let mut by_id = BTreeMap::new();
        for obj in all
            .iter()
            .filter(|o| is(o, unsafe { wp_device_get_type() }))
        {
            let serial = prop(obj, "object.serial");
            if serial.parse::<u64>().is_err() {
                continue;
            }
            let key = format!("{ROOT}/g{epoch}/devices/d{serial}");
            let mut device = Device {
                path: key.clone(),
                id: id(obj),
                name: prop(obj, "device.name"),
                description: prop(obj, "device.description"),
                active_profile: "/".into(),
                ..Default::default()
            };
            by_id.insert(id(obj), key.clone());
            let active = params(obj, "Profile")
                .first()
                .map(|p| int(p, 1))
                .unwrap_or(-1);
            for p in params(obj, "EnumProfile") {
                let index = int(&p, 1);
                if index < 0 {
                    continue;
                }
                let path = format!("{key}/profiles/p{index}");
                if index == active {
                    device.active_profile = path.clone();
                }
                device.profiles.push(path.clone());
                graph.profiles.insert(
                    path.clone(),
                    Profile {
                        path,
                        device: key.clone(),
                        index,
                        name: text(&p, 2),
                        description: text(&p, 3),
                        availability: availability(int(&p, 5)),
                        priority: int(&p, 4),
                    },
                );
            }
            if !device.profiles.is_empty() {
                device.capabilities.push("profiles".into());
            }
            let active = params(obj, "Route");
            for r in params(obj, "EnumRoute") {
                let index = int(&r, 1);
                let direction = int(&r, 2);
                if index < 0 {
                    continue;
                }
                let mut devices = ints(&r, 11);
                if devices.is_empty() {
                    let d = int(&r, 3);
                    if d >= 0 {
                        devices.push(d);
                    }
                }
                for dev in devices {
                    let path = format!("{key}/routes/r{index}_{dev}_{direction}");
                    let route = Route {
                        path: path.clone(),
                        device: key.clone(),
                        index,
                        device_index: dev,
                        direction: if direction == 0 { "input" } else { "output" }.into(),
                        name: text(&r, 4),
                        description: text(&r, 5),
                        availability: availability(int(&r, 7)),
                        profiles: ints(&r, 9)
                            .into_iter()
                            .filter_map(|i| {
                                device
                                    .profiles
                                    .iter()
                                    .find(|s| s.ends_with(&format!("/p{i}")))
                                    .cloned()
                            })
                            .collect(),
                        active: active
                            .iter()
                            .any(|a| int(a, 1) == index && int(a, 3) == dev),
                    };
                    graph.routes.insert(path, route);
                }
            }
            graph.devices.insert(key, device);
        }
        let mut nodes_by_id = BTreeMap::new();
        for obj in all.iter().filter(|o| is(o, unsafe { wp_node_get_type() })) {
            let kind = match prop(obj, "media.class").as_str() {
                "Audio/Sink" => "output",
                "Audio/Source" | "Audio/Source/Virtual" => "input",
                "Stream/Output/Audio" => "playback",
                "Stream/Input/Audio" => "capture",
                _ => continue,
            };
            let Ok(serial) = prop(obj, "object.serial").parse::<u64>() else {
                continue;
            };
            let key = format!("{ROOT}/g{epoch}/nodes/n{serial}");
            let node_id = id(obj);
            nodes_by_id.insert(node_id, key.clone());
            let device = prop(obj, "device.id")
                .parse::<u32>()
                .ok()
                .and_then(|i| by_id.get(&i))
                .cloned()
                .unwrap_or("/".into());
            let description = [
                "node.description",
                "node.nick",
                "application.name",
                "node.name",
            ]
            .iter()
            .map(|k| prop(obj, k))
            .find(|v| !v.is_empty())
            .unwrap_or_default();
            let mut node = Node {
                path: key.clone(),
                id: node_id,
                serial,
                kind: kind.into(),
                name: prop(obj, "node.name"),
                description,
                media_name: prop(obj, "media.name"),
                process_id: prop(obj, "application.process.id").parse().unwrap_or(0),
                endpoint_kind: {
                    let dev = all
                        .iter()
                        .find(|o| id(o) == prop(obj, "device.id").parse().unwrap_or(u32::MAX));
                    dev.map(|d| {
                        if prop(d, "device.api") == "bluez5" || prop(d, "device.bus") == "bluetooth"
                        {
                            "bluetooth"
                        } else {
                            match prop(d, "device.form-factor").as_str() {
                                "headphone" | "headset" => "headphones",
                                "speaker" => "speaker",
                                _ => "unknown",
                            }
                        }
                    })
                    .unwrap_or("unknown")
                    .into()
                },
                application_id: prop(obj, "application.id"),
                application_name: prop(obj, "application.name"),
                icon_name: [
                    "media.icon-name",
                    "window.icon-name",
                    "application.icon-name",
                ]
                .iter()
                .map(|k| prop(obj, k))
                .find(|v| !v.is_empty())
                .unwrap_or_default(),
                device,
                device_index: prop(obj, "card.profile.device").parse().unwrap_or(-1),
                state: match unsafe { wp_node_get_state(raw(obj), ptr::null_mut()) } {
                    3 => "running",
                    2 => "idle",
                    1 => "suspended",
                    0 => "creating",
                    _ => "error",
                }
                .into(),
                requested_target: "/".into(),
                active_route: "/".into(),
                internal: self.streams.is_internal_client(
                    unsafe { wp_core_get_remote_cookie(raw(&self.core)) },
                    prop(obj, "client.id").parse().unwrap_or(u32::MAX),
                ),
                capture_kind: "unknown".into(),
                ..Default::default()
            };
            read_mixer(&self.mixer, node_id, &mut node);
            if can_balance(&node.channels) {
                node.capabilities.push("balance".into());
            }
            if kind == "playback" && prop(obj, "node.dont-move") != "true" && md.is_some() {
                node.capabilities.push("move".into());
            }
            if kind == "input" {
                node.capabilities.push("peak".into());
            }
            if kind == "output"
                && !node.channels.is_empty()
                && node
                    .channels
                    .iter()
                    .all(|c| channel_id(&c.position).is_some())
            {
                node.capabilities.push("test-channels".into());
            }
            node.routes = graph
                .routes
                .values()
                .filter(|r| {
                    r.device == node.device
                        && r.device_index == node.device_index
                        && r.direction == kind
                })
                .map(|r| r.path.clone())
                .collect();
            node.active_route = node
                .routes
                .iter()
                .find(|r| graph.routes[*r].active)
                .cloned()
                .unwrap_or("/".into());
            if !node.routes.is_empty() {
                node.capabilities.push("routes".into());
            }
            graph.nodes.insert(key, node);
        }
        for obj in all.iter().filter(|o| is(o, unsafe { wp_link_get_type() })) {
            let (mut output, mut input) = (0, 0);
            unsafe {
                wp_link_get_linked_object_ids(
                    raw(obj),
                    &mut output,
                    ptr::null_mut(),
                    &mut input,
                    ptr::null_mut(),
                );
            }
            let (Some(out), Some(inp)) = (nodes_by_id.get(&output), nodes_by_id.get(&input)) else {
                continue;
            };
            if graph.nodes[out].kind == "playback" {
                graph.nodes.get_mut(out).unwrap().targets.push(inp.clone());
            }
            if graph.nodes[inp].kind == "capture" {
                graph.nodes.get_mut(inp).unwrap().targets.push(out.clone());
            }
        }
        let capture_kinds: BTreeMap<_, _> = graph
            .nodes
            .iter()
            .filter(|(_, n)| matches!(n.kind.as_str(), "output" | "input"))
            .map(|(k, n)| {
                (
                    k.clone(),
                    if n.kind == "output" {
                        "monitor"
                    } else if n.device == "/" {
                        "virtual"
                    } else {
                        "microphone"
                    },
                )
            })
            .collect();
        let requested: BTreeMap<_, _> = graph
            .nodes
            .iter()
            .map(|(k, n)| {
                let mut value = md
                    .as_ref()
                    .map(|m| meta(m, n.id, "target.object"))
                    .unwrap_or_default();
                if value.is_empty()
                    && let Some(obj) = all
                        .iter()
                        .find(|o| is(o, unsafe { wp_node_get_type() }) && id(o) == n.id)
                {
                    value = prop(obj, "target.object");
                }
                (k.clone(), value)
            })
            .collect();
        let identity: BTreeMap<_, _> = graph
            .nodes
            .iter()
            .flat_map(|(k, n)| {
                [
                    (n.name.clone(), k.clone()),
                    (n.serial.to_string(), k.clone()),
                ]
            })
            .collect();
        for (k, n) in &mut graph.nodes {
            n.targets.sort();
            n.targets.dedup();
            n.requested_target = identity.get(&requested[k]).cloned().unwrap_or("/".into());
            if n.kind == "capture" {
                n.capture_kind = if n.internal {
                    "internal"
                } else {
                    let kinds: BTreeSet<_> = n
                        .targets
                        .iter()
                        .filter_map(|k| capture_kinds.get(k))
                        .copied()
                        .collect();
                    if kinds.len() == 1 {
                        *kinds.first().unwrap()
                    } else {
                        "unknown"
                    }
                }
                .into();
            }
        }
        for (kind, dest) in [
            ("Audio/Sink", &mut graph.default_output),
            ("Audio/Source", &mut graph.default_input),
        ] {
            let id = self
                .defaults
                .emit_by_name::<u32>("get-default-node", &[&kind]);
            *dest = nodes_by_id.get(&id).cloned().unwrap_or("/".into());
        }
        self.graph = graph.clone();
        graph
    }
    fn execute(&mut self, r: &Request) -> Result<(), Error> {
        if r.generation != self.graph.generation
            || unsafe { wp_core_is_connected(raw(&self.core)) } == 0
        {
            return Err(Error::Unavailable("provider generation changed".into()));
        }
        if let Action::Volume(v) = r.action {
            finite(v, 0.0, self.prefs.read().unwrap().limit())?;
            if r.sequence > 0 {
                let seen = self.sequences.entry(r.path.clone()).or_default();
                if r.sequence < *seen {
                    return Err(Error::Superseded("newer volume already dispatched".into()));
                }
                *seen = r.sequence;
            }
        }
        let all = objects(&self.om);
        let find = |device: &Device| {
            all.iter()
                .find(|o| {
                    is(o, unsafe { wp_device_get_type() })
                        && id(o) == device.id
                        && device
                            .path
                            .ends_with(&format!("/d{}", prop(o, "object.serial")))
                })
                .ok_or_else(|| Error::NotFound("object removed".into()))
        };
        let node = self.graph.nodes.get(&r.path);
        if let Some(n) = node {
            let current = all
                .iter()
                .find(|o| is(o, unsafe { wp_node_get_type() }) && id(o) == n.id);
            if !current
                .is_some_and(|o| prop(o, "object.serial").parse::<u64>().ok() == Some(n.serial))
            {
                return Err(Error::NotFound(
                    "node removed or provider ID recycled".into(),
                ));
            }
        }
        let result = match &r.action {
            Action::Volume(value) | Action::Balance(value) => {
                let mut n = node
                    .ok_or_else(|| Error::NotFound("node removed".into()))?
                    .clone();
                read_mixer(&self.mixer, n.id, &mut n);
                let channels = if matches!(r.action, Action::Volume(_)) {
                    scale(&n.channels, *value)
                } else {
                    set_balance(&n.channels, *value)
                };
                let payload = if channels.is_empty() {
                    BTreeMap::from([("volume".to_string(), value.to_variant())])
                } else {
                    let channels: BTreeMap<String, glib::Variant> = channels
                        .iter()
                        .enumerate()
                        .map(|(i, c)| {
                            (
                                i.to_string(),
                                BTreeMap::from([("volume", c.volume.to_variant())]).to_variant(),
                            )
                        })
                        .collect();
                    BTreeMap::from([("channelVolumes".into(), channels.to_variant())])
                }
                .to_variant();
                if !self
                    .mixer
                    .emit_by_name::<bool>("set-volume", &[&n.id, &payload])
                {
                    return Err(Error::Failed("mixer rejected volume".into()));
                }
                Ok(())
            }
            Action::Muted(v) => {
                let n = node.ok_or_else(|| Error::NotFound("node removed".into()))?;
                let payload = BTreeMap::from([("mute", v.to_variant())]).to_variant();
                if !self
                    .mixer
                    .emit_by_name::<bool>("set-volume", &[&n.id, &payload])
                {
                    return Err(Error::Failed("mixer rejected mute".into()));
                }
                Ok(())
            }
            Action::Default => {
                let n = node.ok_or_else(|| Error::NotFound("endpoint removed".into()))?;
                let class = if n.kind == "output" {
                    "Audio/Sink"
                } else {
                    "Audio/Source"
                };
                let name = Some(n.name.as_str());
                if !self
                    .defaults
                    .emit_by_name::<bool>("set-default-configured-node-name", &[&class, &name])
                {
                    return Err(Error::Failed("default selection rejected".into()));
                }
                Ok(())
            }
            Action::ClearDefault(direction) => {
                let class = if direction == "output" {
                    "Audio/Sink"
                } else {
                    "Audio/Source"
                };
                let name: Option<&str> = None;
                if !self
                    .defaults
                    .emit_by_name::<bool>("set-default-configured-node-name", &[&class, &name])
                {
                    return Err(Error::Failed("clear default rejected".into()));
                }
                Ok(())
            }
            Action::Move(target) => {
                let n = node.ok_or_else(|| Error::NotFound("stream removed".into()))?;
                let md = metadata(&all)
                    .ok_or_else(|| Error::NotSupported("default metadata unavailable".into()))?;
                let serial = target
                    .as_ref()
                    .map(|p| self.graph.node(p, None).map(|n| n.serial.to_string()))
                    .transpose()?;
                // -1 masks an immutable app target.object property too; removing metadata
                // alone would send such an app back to its original explicit target.
                set_meta(
                    &md,
                    n.id,
                    "target.object",
                    Some(serial.as_deref().unwrap_or("-1")),
                );
                Ok(())
            }
            Action::Profile => {
                let p = self
                    .graph
                    .profiles
                    .get(&r.path)
                    .ok_or_else(|| Error::NotFound("profile removed".into()))?;
                if p.availability == "no" {
                    return Err(Error::NotSupported("profile unavailable".into()));
                }
                let d = &self.graph.devices[&p.device];
                set_param(
                    find(d)?,
                    "Profile",
                    spa::pod::Object {
                        type_: spa::sys::SPA_TYPE_OBJECT_ParamProfile,
                        id: spa::sys::SPA_PARAM_Profile,
                        properties: vec![
                            property(1, PodValue::Int(p.index)),
                            property(8, PodValue::Bool(true)),
                        ],
                    },
                )
            }
            Action::Route(path) => {
                let p = self
                    .graph
                    .routes
                    .get(path)
                    .ok_or_else(|| Error::NotFound("route removed".into()))?;
                if p.availability == "no" {
                    return Err(Error::NotSupported("route unavailable".into()));
                }
                let d = &self.graph.devices[&p.device];
                set_param(
                    find(d)?,
                    "Route",
                    spa::pod::Object {
                        type_: spa::sys::SPA_TYPE_OBJECT_ParamRoute,
                        id: spa::sys::SPA_PARAM_Route,
                        properties: vec![
                            property(1, PodValue::Int(p.index)),
                            property(3, PodValue::Int(p.device_index)),
                            property(13, PodValue::Bool(true)),
                        ],
                    },
                )
            }
            Action::Synchronize => Ok(()),
            Action::Switch(enabled) => {
                if !self.graph.switch_policy {
                    return Err(Error::NotSupported(
                        "WirePlumber Nidara hotplug policy not loaded".into(),
                    ));
                }
                let md = metadata(&all)
                    .ok_or_else(|| Error::Unavailable("metadata unavailable".into()))?;
                let subject = unsafe { wp_core_get_own_bound_id(raw(&self.core)) };
                let value = if *enabled { "1" } else { "0" };
                if meta(&md, subject, "nidara.audio.switch-on-connect") != value {
                    set_meta(&md, subject, "nidara.audio.switch-on-connect", Some(value));
                }
                Ok(())
            }
        };
        self.dirty.set(true);
        result
    }
}
pub fn channel_id(s: &str) -> Option<u32> {
    Some(match s {
        "MONO" => spa::sys::SPA_AUDIO_CHANNEL_MONO,
        "FL" => spa::sys::SPA_AUDIO_CHANNEL_FL,
        "FR" => spa::sys::SPA_AUDIO_CHANNEL_FR,
        "FC" => spa::sys::SPA_AUDIO_CHANNEL_FC,
        "LFE" => spa::sys::SPA_AUDIO_CHANNEL_LFE,
        "RL" => spa::sys::SPA_AUDIO_CHANNEL_RL,
        "RR" => spa::sys::SPA_AUDIO_CHANNEL_RR,
        "SL" => spa::sys::SPA_AUDIO_CHANNEL_SL,
        "SR" => spa::sys::SPA_AUDIO_CHANNEL_SR,
        _ => return None,
    })
}
fn preferences(dirty: &Rc<Cell<bool>>, prefs: &Arc<RwLock<Preferences>>) -> Vec<gio::Settings> {
    use gio::prelude::*;
    let mut guards = Vec::new();
    let Some(source) = gio::SettingsSchemaSource::default() else {
        return guards;
    };
    if let Some(schema) = source
        .lookup("org.gnome.desktop.sound", true)
        .filter(|s| s.has_key("theme-name"))
    {
        let sound = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
        let theme = sound.string("theme-name").to_string();
        if !theme.is_empty() {
            prefs.write().unwrap().sound_theme = theme;
        }
        let p = prefs.clone();
        let d = dirty.clone();
        sound.connect_changed(Some("theme-name"), move |s, _| {
            let theme = s.string("theme-name").to_string();
            p.write().unwrap().sound_theme = if theme.is_empty() {
                "freedesktop".into()
            } else {
                theme
            };
            d.set(true);
        });
        guards.push(sound);
    }
    let Some(schema) = source.lookup("org.nidara.audio", true).filter(|s| {
        [
            "overamplification",
            "alerts-enabled",
            "alert-volume",
            "volume-feedback",
            "switch-on-connect",
        ]
        .iter()
        .all(|k| s.has_key(k))
    }) else {
        return guards;
    };
    let s = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
    let read = |s: &gio::Settings, theme: String| Preferences {
        overamplification: s.boolean("overamplification"),
        alerts_enabled: s.boolean("alerts-enabled"),
        alert_volume: s.double("alert-volume"),
        volume_feedback: s.boolean("volume-feedback"),
        switch_on_connect: s.boolean("switch-on-connect"),
        sound_theme: theme,
    };
    let theme = prefs.read().unwrap().sound_theme.clone();
    *prefs.write().unwrap() = read(&s, theme);
    let p = prefs.clone();
    let d = dirty.clone();
    s.connect_changed(None, move |s, _| {
        let theme = p.read().unwrap().sound_theme.clone();
        *p.write().unwrap() = read(s, theme);
        d.set(true);
    });
    guards.push(s);
    guards
}

pub fn start(
    rx: std::sync::mpsc::Receiver<Request>,
    snapshots: watch::Sender<Graph>,
    prefs: Arc<RwLock<Preferences>>,
    streams: super::streams::Manager,
) {
    std::thread::spawn(move || {
        unsafe { wp_init(3) }; // Never install a process-global GLib log writer.
        let context = glib::MainContext::new();
        let _thread_default = context.acquire().expect("new context");
        let _ = context.with_thread_default(|| {
            let dirty = Rc::new(Cell::new(true));
            let _settings = preferences(&dirty, &prefs);
            let mut previous_prefs = prefs.read().unwrap().clone();
            let mut generation = 0;
            let mut worker: Option<Worker> = None;
            let mut retry = std::time::Instant::now();
            let mut backoff = 1;
            loop {
                while context.pending() {
                    context.iteration(false);
                }
                if worker
                    .as_ref()
                    .is_some_and(|w| unsafe { wp_core_is_connected(raw(&w.core)) } == 0)
                {
                    worker = None;
                    streams.cancel_all("provider-disconnected");
                    let _ = snapshots.send(Graph {
                        generation,
                        error: "PipeWire disconnected".into(),
                        ..Default::default()
                    });
                    retry = std::time::Instant::now() + Duration::from_secs(1);
                }
                if worker.is_none() && std::time::Instant::now() >= retry {
                    generation += 1;
                    match Worker::new(&context, generation, prefs.clone(), streams.clone()) {
                        Ok(w) => {
                            worker = Some(w);
                            backoff = 1;
                            dirty.set(true);
                        }
                        Err(e) => {
                            let _ = snapshots.send(Graph {
                                generation,
                                error: e,
                                ..Default::default()
                            });
                            retry = std::time::Instant::now() + Duration::from_secs(backoff);
                            backoff = (backoff * 2).min(30);
                        }
                    }
                }
                if let Some(w) = &mut worker
                    && (dirty.replace(false) || w.dirty.replace(false))
                {
                    let mut graph = w.snapshot();
                    let current = prefs.read().unwrap().clone();
                    let preference_changed = current != previous_prefs;
                    if previous_prefs.overamplification && !current.overamplification {
                        for n in graph.nodes.values().filter(|n| {
                            n.volume > 1.0 && n.capabilities.iter().any(|s| s == "volume")
                        }) {
                            let (tx, _) = oneshot::channel();
                            if let Err(e) = w.execute(&Request {
                                path: n.path.clone(),
                                generation,
                                sequence: 0,
                                action: Action::Volume(1.0),
                                reply: tx,
                            }) {
                                graph.error = format!("overamplification clamp: {e}");
                            }
                        }
                    }
                    if graph.switch_policy {
                        let (tx, _) = oneshot::channel();
                        let _ = w.execute(&Request {
                            path: ROOT.into(),
                            generation,
                            sequence: 0,
                            action: Action::Switch(current.switch_on_connect),
                            reply: tx,
                        });
                        w.dirty.set(false);
                    }
                    previous_prefs = current;
                    if preference_changed || *snapshots.borrow() != graph {
                        let _ = snapshots.send(graph);
                    }
                }
                let mut requests = Vec::new();
                loop {
                    match rx.try_recv() {
                        Ok(r) => requests.push(r),
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                    }
                }
                // Coalesce before dispatch: an obsolete drag value is never written later.
                let mut latest = BTreeMap::new();
                for r in &requests {
                    if matches!(r.action, Action::Volume(_)) {
                        latest
                            .entry(r.path.clone())
                            .and_modify(|v: &mut u64| *v = (*v).max(r.sequence))
                            .or_insert(r.sequence);
                    }
                }
                for r in requests {
                    let result =
                        if matches!(r.action, Action::Volume(_)) && latest[&r.path] != r.sequence {
                            Err(Error::Superseded("newer queued volume request".into()))
                        } else if let Some(w) = &mut worker {
                            w.execute(&r)
                        } else {
                            Err(Error::Unavailable("PipeWire unavailable".into()))
                        };
                    let _ = r.reply.send(result);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    });
}
