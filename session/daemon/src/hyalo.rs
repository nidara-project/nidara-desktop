// SPDX-License-Identifier: GPL-3.0-or-later
//! The existing compositor IPC; Hyalo alone persists its settings layer.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
};
pub fn socket() -> Option<PathBuf> {
    std::env::var_os("HYALO_SOCKET")
        .map(PathBuf::from)
        .or_else(|| {
            let rt = std::env::var_os("XDG_RUNTIME_DIR")?;
            let display = std::env::var("WAYLAND_DISPLAY").ok()?;
            let name = std::path::Path::new(&display).file_name()?.to_str()?;
            Some(PathBuf::from(rt).join(format!("nidara-hyalo.{name}.sock")))
        })
}
pub fn request(value: Value) -> Result<Value, String> {
    let sock = socket().ok_or("Hyalo socket unavailable")?;
    let mut stream = UnixStream::connect(sock).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut stream, &value).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    let n = BufReader::new(stream)
        .take(4 * 1024 * 1024)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if n == 0 || bytes.last() != Some(&b'\n') {
        return Err("incomplete compositor reply".into());
    }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if let Some(error) = reply.get("error") {
        return Err(error
            .as_str()
            .or_else(|| error.get("message").and_then(Value::as_str))
            .unwrap_or("compositor refused")
            .into());
    }
    reply
        .get("ok")
        .cloned()
        .ok_or("missing compositor result".into())
}
pub fn idle(field: &str) -> Result<u32, String> {
    request(json!({"request":"config"}))?["config"]["idle"][field]
        .as_u64()
        .and_then(|n| n.try_into().ok())
        .ok_or("idle capability unavailable".into())
}
pub fn set_idle(field: &str, seconds: u32) -> Result<(), String> {
    request(json!({"request":"settings","patch":{"idle":{field:seconds}}}))?;
    if idle(field)? != seconds {
        return Err("idle setting is overridden by user configuration".into());
    }
    Ok(())
}
