// SPDX-License-Identifier: LGPL-3.0-or-later
//! Read-only hover classification, off every UI loop. One worker and one queued
//! offer for the process; a departed drag drops its receiver and cannot be revived.
use gio::prelude::*;
use nk_wayland::Waker;
use std::sync::{
    OnceLock,
    mpsc::{self, Receiver, SyncSender},
};
use std::time::Duration;

type Types = Option<Vec<String>>;
struct Job {
    uris: Vec<String>,
    reply: mpsc::Sender<Types>,
    wake: Waker,
}

pub(crate) fn start(uris: Vec<String>, wake: Waker) -> Option<Receiver<Types>> {
    if uris.is_empty()
        || uris.len() > crate::drops::MAX_URIS
        || uris.iter().map(String::len).sum::<usize>() > 256 * 1024
    {
        return None;
    }
    static WORKER: OnceLock<Option<SyncSender<Job>>> = OnceLock::new();
    let worker = WORKER
        .get_or_init(|| {
            let (tx, rx) = mpsc::sync_channel::<Job>(1);
            std::thread::Builder::new()
                .name("dock-drop-types".into())
                .spawn(move || {
                    for job in rx {
                        let types = classify(&job.uris);
                        if job.reply.send(types).is_ok() {
                            let _ = job.wake.wake();
                        }
                    }
                })
                .ok()?;
            Some(tx)
        })
        .as_ref()?;
    let (tx, rx) = mpsc::channel();
    worker
        .try_send(Job {
            uris,
            reply: tx,
            wake,
        })
        .ok()?;
    Some(rx)
}

fn classify(uris: &[String]) -> Types {
    let context = glib::MainContext::new();
    context
        .with_thread_default(|| {
            context.block_on(glib::future_with_timeout(Duration::from_secs(2), async {
                let mut types = Vec::with_capacity(uris.len());
                for uri in uris {
                    let path = crate::drops::path(uri)?;
                    let info = gio::File::for_path(path)
                        .query_info_future(
                            "standard::type,standard::content-type",
                            gio::FileQueryInfoFlags::NONE,
                            glib::Priority::DEFAULT,
                        )
                        .await
                        .ok()?;
                    let kind = match info.file_type() {
                        gio::FileType::Directory => "inode/directory".into(),
                        gio::FileType::Regular => info.content_type()?.to_string(),
                        _ => return None,
                    };
                    if kind.is_empty() {
                        return None;
                    }
                    types.push(kind);
                }
                Some(types)
            }))
        })
        .ok()?
        .ok()?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_gio_types_cover_directories_files_and_whole_list_failure() {
        let root = std::env::temp_dir().join(format!("nidara-drop-types-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let pdf = root.join("example.pdf");
        std::fs::write(&pdf, b"%PDF-1.4\n").unwrap();
        let uri = |p: &std::path::Path| glib::filename_to_uri(p, None).unwrap().to_string();
        assert_eq!(
            classify(&[uri(&root), uri(&pdf)]),
            Some(vec!["inode/directory".into(), "application/pdf".into()])
        );
        assert_eq!(classify(&[uri(&pdf), uri(&root.join("missing"))]), None);
        assert_eq!(classify(&["https://example.invalid/a.pdf".into()]), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
