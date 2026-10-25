// SPDX-License-Identifier: LGPL-3.0-or-later
//! Lazy Fontconfig metadata for the FontChooser, off Settings' first frame.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    process::Command,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
};

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Face {
    /// Empty when Fontconfig supplies no named style (valid for some variable faces).
    pub style: String,
    pub file: PathBuf,
    /// Fontconfig's full index; high bits may identify a named variable-font instance.
    pub index: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Family {
    pub name: String,
    pub faces: Vec<Face>,
}
#[derive(Debug)]
pub struct Catalogue {
    pub families: Vec<Family>,
    /// Malformed records omitted; good families remain selectable.
    pub skipped_records: usize,
}
impl Catalogue {
    fn enumerate() -> Result<Self> {
        let start = std::time::Instant::now();
        let output = Command::new("fc-list")
            .args(["--format", "%{family[0]}\t%{style[0]}\t%{file}\t%{index}\n"])
            .output()
            .map_err(|e| format!("enumerating installed fonts: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "fc-list failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let catalogue = Self::parse_bytes(&output.stdout)?;
        eprintln!(
            "FONT_CATALOGUE families={} skipped={} enumeration_ms={}",
            catalogue.families.len(),
            catalogue.skipped_records,
            start.elapsed().as_millis()
        );
        Ok(catalogue)
    }
    #[cfg(test)]
    fn parse(output: &str) -> Result<Self> {
        Self::parse_bytes(output.as_bytes())
    }
    fn parse_bytes(output: &[u8]) -> Result<Self> {
        let mut families: BTreeMap<String, Vec<Face>> = BTreeMap::new();
        let mut seen = BTreeSet::new();
        let mut skipped_records = 0;
        let records = output.strip_suffix(b"\n").unwrap_or(output);
        for (line, record) in records.split(|b| *b == b'\n').enumerate() {
            let parsed = || -> Option<(String, String, PathBuf, u32)> {
                let record = std::str::from_utf8(record).ok()?;
                let fields: Vec<_> = record.split('\t').collect();
                let [family, style, file, index] = fields.as_slice() else {
                    return None;
                };
                if family.is_empty()
                    || file.is_empty()
                    || [family, style, file]
                        .iter()
                        .any(|s| s.chars().any(char::is_control))
                    || !std::path::Path::new(file).is_absolute()
                {
                    return None;
                }
                Some((
                    family.to_string(),
                    style.to_string(),
                    file.into(),
                    index.parse().ok()?,
                ))
            };
            let Some((family, style, file, index)) = parsed() else {
                skipped_records += 1;
                eprintln!(
                    "FONT_CATALOGUE_SKIPPED line={} bytes={:?}",
                    line + 1,
                    &record[..record.len().min(160)]
                );
                continue;
            };
            if seen.insert((family.clone(), style.clone(), file.clone(), index)) {
                families
                    .entry(family)
                    .or_default()
                    .push(Face { style, file, index });
            }
        }
        if families.is_empty() {
            return Err(format!(
                "fontconfig returned no usable installed families ({skipped_records} bad records)"
            ));
        }
        let mut families: Vec<_> = families
            .into_iter()
            .map(|(name, mut faces)| {
                faces.sort_by_key(|f| {
                    (
                        f.style.to_lowercase(),
                        f.style.clone(),
                        f.file.clone(),
                        f.index,
                    )
                });
                Family { name, faces }
            })
            .collect();
        families.sort_by_key(|f| (f.name.to_lowercase(), f.name.clone()));
        Ok(Self {
            families,
            skipped_records,
        })
    }
    /// Family-name search only; the caller keeps the selected face independently of filtering.
    pub fn matching(&self, query: &str) -> impl Iterator<Item = &Family> {
        let query = query.trim().to_lowercase();
        self.families
            .iter()
            .filter(move |family| family.name.to_lowercase().contains(&query))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Operation {
    pub mount: u64,
    pub request: u64,
}
struct Job {
    canceled: Arc<AtomicBool>,
    reply: mpsc::Sender<Result<Arc<Catalogue>>>,
}
fn worker(
    mut enumerate: impl FnMut() -> Result<Arc<Catalogue>> + Send + 'static,
) -> Result<SyncSender<Job>> {
    let (send, receive) = mpsc::sync_channel::<Job>(1);
    std::thread::Builder::new()
        .name("font-catalogue".into())
        .spawn(move || {
            while let Ok(job) = receive.recv() {
                if job.canceled.load(Ordering::Acquire) {
                    continue;
                }
                let result = enumerate();
                if !job.canceled.load(Ordering::Acquire) {
                    let _ = job.reply.send(result);
                }
            }
        })
        .map_err(|e| format!("starting font catalogue worker: {e}"))?;
    Ok(send)
}
fn queue() -> Result<&'static SyncSender<Job>> {
    static QUEUE: OnceLock<Result<SyncSender<Job>>> = OnceLock::new();
    QUEUE
        .get_or_init(|| worker(|| Catalogue::enumerate().map(Arc::new)))
        .as_ref()
        .map_err(Clone::clone)
}
struct Pending {
    token: Operation,
    canceled: Arc<AtomicBool>,
    receive: Receiver<Result<Arc<Catalogue>>>,
}
/// One cancellable operation; constructing/defaulting it enumerates nothing.
#[derive(Default)]
pub struct Load {
    pending: Option<Pending>,
}
impl Load {
    pub fn start(&mut self, operation: Operation) -> Result<()> {
        self.cancel();
        let (send, receive) = mpsc::channel();
        let canceled = Arc::new(AtomicBool::new(false));
        queue()?
            .try_send(Job {
                canceled: canceled.clone(),
                reply: send,
            })
            .map_err(|_| "font catalogue worker busy or unavailable".to_owned())?;
        self.pending = Some(Pending {
            token: operation,
            canceled,
            receive,
        });
        Ok(())
    }
    pub fn poll(&mut self, current: Operation) -> Option<Result<Arc<Catalogue>>> {
        let Pending { token, receive, .. } = self.pending.as_ref()?;
        if *token != current {
            self.cancel();
            return None;
        }
        match receive.try_recv() {
            Ok(result) => {
                self.pending = None;
                Some(result)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.pending = None;
                Some(Err("font catalogue worker disconnected".into()))
            }
        }
    }
    pub fn cancel(&mut self) {
        if let Some(pending) = self.pending.take() {
            pending.canceled.store(true, Ordering::Release);
        }
    }
}
impl Drop for Load {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_is_unicode_deterministic_and_does_not_open_font_files() {
        let c = Catalogue::parse("日本語 Sans\tRegular\t/not-opened/Japanese.ttf\t0\nAlpha\tItalic\t/not-opened/Alpha.ttf\t131073\nAlpha\tRegular\t/not-opened/Alpha.ttf\t0\nAlpha\tRegular\t/not-opened/Alpha.ttf\t0\n").unwrap();
        assert_eq!(c.families.len(), 2);
        assert_eq!(c.families[0].name, "Alpha");
        assert_eq!(c.families[0].faces.len(), 2);
        assert_eq!(c.families[0].faces[0].index, 131073);
        assert_eq!(c.matching("  日本語 ").count(), 1);
        let unnamed = Catalogue::parse("Adwaita Sans\t\t/not-opened/Variable.ttf\t0\n").unwrap();
        assert_eq!(unnamed.families[0].faces[0].style, "");
        assert_eq!(c.matching("ALPHA").count(), 1);
        assert_eq!(
            c.matching("not installed").count(),
            0,
            "no substituted family"
        );
    }
    #[test]
    fn malformed_or_partial_catalogue_is_never_accepted() {
        for text in [
            "",
            "Family\tRegular\trelative.ttf\t0\n",
            "Family\tRegular\t/a.ttf\twrong\n",
            "\tRegular\t/a.ttf\t0\n",
            "Family\tRegular\t/a.ttf\t0\textra\n",
        ] {
            assert!(Catalogue::parse(text).is_err(), "accepted {text:?}");
        }
    }
    #[test]
    fn good_families_survive_bad_records_and_invalid_utf8() {
        let data = b"Good\tRegular\t/good.ttf\t0\nBAD\nOther\tRegular\t/other.ttf\t0\nBroken\tRegular\t/a.ttf\tx\n\xff\n";
        let c = Catalogue::parse_bytes(data).unwrap();
        assert_eq!(c.skipped_records, 3);
        assert_eq!(
            c.families
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["Good", "Other"]
        );
    }
    fn pending(token: Operation) -> (Load, mpsc::Sender<Result<Arc<Catalogue>>>, Arc<AtomicBool>) {
        let (send, receive) = mpsc::channel();
        let canceled = Arc::new(AtomicBool::new(false));
        (
            Load {
                pending: Some(Pending {
                    token,
                    canceled: canceled.clone(),
                    receive,
                }),
            },
            send,
            canceled,
        )
    }
    #[test]
    fn canceled_or_other_mount_request_cannot_publish_even_an_already_completed_result() {
        let token = Operation {
            mount: 7,
            request: 2,
        };
        for current in [
            Operation {
                mount: 8,
                request: 2,
            },
            Operation {
                mount: 7,
                request: 3,
            },
        ] {
            let (mut load, send, canceled) = pending(token);
            send.send(Err("old result".into())).unwrap();
            assert!(load.poll(current).is_none());
            assert!(canceled.load(Ordering::Acquire));
            assert!(load.poll(token).is_none());
        }
        let (mut load, send, canceled) = pending(token);
        load.cancel();
        assert!(canceled.load(Ordering::Acquire));
        assert!(send.send(Err("late result".into())).is_err());
    }
    #[test]
    fn current_result_is_delivered_once_and_loading_poll_never_waits() {
        let token = Operation {
            mount: 7,
            request: 2,
        };
        let (mut load, send, _) = pending(token);
        assert!(load.poll(token).is_none());
        send.send(Err("reported failure".into())).unwrap();
        assert_eq!(load.poll(token).unwrap().unwrap_err(), "reported failure");
        assert!(load.poll(token).is_none());
    }

    #[test]
    fn worker_has_one_active_one_queued_and_skips_a_canceled_queued_job() {
        use std::time::Duration;
        let (started, start_rx) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let queue = worker(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            started.send(()).unwrap();
            released.recv().unwrap();
            Ok(Arc::new(
                Catalogue::parse("Installed\tRegular\t/not-opened/font.ttf\t0\n").unwrap(),
            ))
        })
        .unwrap();
        let make_job = || {
            let (reply, receive) = mpsc::channel();
            (
                Job {
                    canceled: Arc::new(AtomicBool::new(false)),
                    reply,
                },
                receive,
            )
        };
        let (first, first_rx) = make_job();
        queue.try_send(first).unwrap();
        start_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (second, second_rx) = make_job();
        second.canceled.store(true, Ordering::Release);
        queue.try_send(second).unwrap();
        let (third, _) = make_job();
        assert!(
            matches!(queue.try_send(third), Err(mpsc::TrySendError::Full(_))),
            "queue admitted unbounded work"
        );
        release.send(()).unwrap();
        assert!(
            first_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .is_ok()
        );
        assert!(
            matches!(
                second_rx.recv_timeout(Duration::from_secs(5)),
                Err(mpsc::RecvTimeoutError::Disconnected)
            ),
            "canceled queued work ran or sent a result"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn real_fontconfig_enumeration_runs_only_after_open_request() {
        let mut load = Load::default();
        assert!(load.pending.is_none());
        let token = Operation {
            mount: 1,
            request: 1,
        };
        load.start(token).unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let result = loop {
            if let Some(result) = load.poll(token) {
                break result.unwrap();
            }
            assert!(
                std::time::Instant::now() < end,
                "fontconfig enumeration did not complete"
            );
            std::thread::yield_now();
        };
        assert!(!result.families.is_empty());
        assert!(result.families.iter().all(|f| !f.faces.is_empty()));
    }
}
