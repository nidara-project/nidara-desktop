// SPDX-License-Identifier: LGPL-3.0-or-later
use nk::files::{Sources, file_uri};
use nk_render::Raster;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Job {
    pub generation: u64,
    pub path: PathBuf,
    pub large: bool,
}
impl Job {
    pub fn id(&self) -> String {
        format!(
            "{}:{}",
            if self.large { "preview" } else { "thumbnail" },
            file_uri(&self.path).unwrap_or_default()
        )
    }
}

pub struct Pictures {
    send: SyncSender<Job>,
    receive: Receiver<(Job, Option<Arc<Raster>>)>,
    inflight: HashSet<Job>,
    ready: HashMap<Job, Option<Arc<Raster>>>,
}
impl Pictures {
    pub fn new(sources: Sources) -> Result<Self, String> {
        let (send, jobs) = mpsc::sync_channel::<Job>(16);
        let (replies, receive) = mpsc::channel();
        std::thread::Builder::new()
            .name("chooser-pictures".into())
            .spawn(move || {
                while let Ok(job) = jobs.recv() {
                    let picture = sources
                        .preview(&job.path, job.large)
                        .and_then(|image| {
                            Raster::from_rgba(image.width, image.height, image.rgba).ok()
                        })
                        .map(Arc::new);
                    if replies.send((job, picture)).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            send,
            receive,
            inflight: HashSet::new(),
            ready: HashMap::new(),
        })
    }
    pub fn update(&mut self, wanted: &[Job]) -> bool {
        let mut changed = false;
        self.ready.retain(|job, art| {
            let keep = wanted.contains(job);
            changed |= !keep && art.is_some();
            keep
        });
        while let Ok((job, art)) = self.receive.try_recv() {
            self.inflight.remove(&job);
            if wanted.contains(&job) {
                changed |= art.is_some();
                self.ready.insert(job, art);
            }
        }
        for job in wanted {
            if self.inflight.contains(job) || self.ready.contains_key(job) {
                continue;
            }
            if self.send.try_send(job.clone()).is_err() {
                break;
            }
            self.inflight.insert(job.clone());
        }
        changed
    }
    pub fn pending(&self) -> bool {
        !self.inflight.is_empty()
    }
    pub fn preview(&self, path: &Path) -> Option<String> {
        self.ready.iter().find_map(|(job, image)| {
            (job.large && job.path == path && image.is_some()).then(|| job.id())
        })
    }
    pub fn thumbnails(&self) -> HashMap<PathBuf, String> {
        self.ready
            .iter()
            .filter(|(job, image)| !job.large && image.is_some())
            .map(|(job, _)| (job.path.clone(), job.id()))
            .collect()
    }
    pub fn rasters(&self) -> HashMap<String, Arc<Raster>> {
        self.ready
            .iter()
            .filter_map(|(job, raster)| Some((job.id(), Arc::clone(raster.as_ref()?))))
            .collect()
    }
}
