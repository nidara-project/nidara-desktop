// SPDX-License-Identifier: GPL-3.0-or-later
//! A bounded child per I/O, killed and reaped on deadline/cancellation; never a shell.
use super::Error;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, sync::watch};
pub async fn run(
    executable: &Path,
    args: &[String],
    cancel: watch::Receiver<bool>,
) -> Result<String, Error> {
    run_with_timeout(executable, args, cancel, Duration::from_secs(2)).await
}
pub async fn run_with_timeout(
    executable: &Path,
    args: &[String],
    mut cancel: watch::Receiver<bool>,
    budget: Duration,
) -> Result<String, Error> {
    if *cancel.borrow() {
        return Err(Error::Stale("channel withdrawn".into()));
    }
    let mut child = tokio::process::Command::new(executable)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Unavailable(format!("DDC launch: {e}")))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let io = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = stdout.take(65537);
        let mut stderr = stderr.take(16385);
        let (status, a, b) = tokio::join!(
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err)
        );
        a.map_err(|e| Error::Unavailable(e.to_string()))?;
        b.map_err(|e| Error::Unavailable(e.to_string()))?;
        let status = status.map_err(|e| Error::Unavailable(e.to_string()))?;
        if !status.success() || out.len() > 65536 || err.len() > 16384 {
            return Err(Error::Unavailable(
                "DDC command refused or exceeded output bounds".into(),
            ));
        }
        String::from_utf8(out).map_err(|_| Error::Unavailable("invalid DDC output".into()))
    };
    let result = tokio::select! {r=io=>r,_=tokio::time::sleep(budget)=>Err(Error::Unavailable("DDC deadline".into())),_=cancel.changed()=>Err(Error::Stale("channel withdrawn".into()))};
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}
