// SPDX-License-Identifier: LGPL-3.0-or-later
//! Bounded off-UI decoding; page builders own visibility, operation tokens and policy.
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use nk_render::{ImageFit, Raster};
use std::{
    io::{Cursor, Read},
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    },
};
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Operation {
    pub mount: u64,
    pub request: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub encoded_bytes: u64,
    pub decoded_bytes: u64,
}
#[derive(Clone, Debug)]
pub struct Request {
    pub path: PathBuf,
    pub size: (u16, u16),
    pub fit: ImageFit,
    pub budget: Budget,
}
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Busy,
    Failed(String),
}
impl Request {
    fn validate(&self) -> Result<()> {
        if !self.path.is_absolute()
            || self.size.0 == 0
            || self.size.1 == 0
            || self.budget.encoded_bytes == 0
            || self.budget.encoded_bytes == u64::MAX
            || self.budget.decoded_bytes == 0
        {
            return Err("invalid image path/target/budget".into());
        }
        let target = u64::from(self.size.0) * u64::from(self.size.1) * 4;
        if target > self.budget.decoded_bytes {
            return Err("image target exceeds decode budget".into());
        }
        Ok(())
    }
}
fn decode(request: Request) -> Result<Arc<Raster>> {
    request.validate()?;
    if !std::fs::metadata(&request.path)
        .map_err(|e| format!("image metadata: {e}"))?
        .is_file()
    {
        return Err("image path is not a regular file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&request.path)
        .map_err(|e| format!("opening image: {e}"))?
        .take(request.budget.encoded_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("reading image: {e}"))?;
    if bytes.len() as u64 > request.budget.encoded_bytes {
        return Err("encoded image exceeds budget".into());
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let format = reader.format();
    if !matches!(
        format,
        Some(
            ImageFormat::Png
                | ImageFormat::Jpeg
                | ImageFormat::Gif
                | ImageFormat::WebP
                | ImageFormat::Avif
        )
    ) {
        return Err("unsupported wallpaper image format".into());
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(request.budget.decoded_bytes);
    limits.max_image_width = Some(u16::MAX as u32);
    limits.max_image_height = Some(u16::MAX as u32);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    if decoder.total_bytes() > request.budget.decoded_bytes {
        return Err("decoded image exceeds budget".into());
    }
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut decoded = if format == Some(ImageFormat::Jpeg) {
        match jpeg_thumbnail(&bytes, &request, orientation)? {
            Some(image) => image,
            None => DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?,
        }
    } else {
        DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?
    };
    decoded.apply_orientation(orientation);
    let (w, h) = (u32::from(request.size.0), u32::from(request.size.1));
    let small = match request.fit {
        ImageFit::Contain => decoded.thumbnail(w, h),
        ImageFit::Cover => decoded.resize_to_fill(w, h, image::imageops::FilterType::Triangle),
    }
    .into_rgba8();
    let size = small.dimensions();
    Raster::from_rgba(
        size.0.try_into().map_err(|_| "image width overflow")?,
        size.1.try_into().map_err(|_| "image height overflow")?,
        small.into_raw(),
    )
    .map(Arc::new)
}
// JPEG's IDCT emits 1/8, 1/4, 1/2 or full dimensions before RGB allocation.
// Other formats and uncommon JPEG pixel formats retain the bounded image decoder.
fn jpeg_thumbnail(
    bytes: &[u8],
    request: &Request,
    orientation: image::metadata::Orientation,
) -> Result<Option<DynamicImage>> {
    use jpeg_decoder::{Decoder, PixelFormat};
    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.set_max_decoding_buffer_size(
        request
            .budget
            .decoded_bytes
            .try_into()
            .unwrap_or(usize::MAX),
    );
    decoder
        .read_info()
        .map_err(|e| format!("JPEG header: {e}"))?;
    let info = decoder.info().ok_or("JPEG metadata missing")?;
    if !matches!(info.pixel_format, PixelFormat::L8 | PixelFormat::RGB24) {
        return Ok(None);
    }
    // Fit in source coordinates; EXIF 5–8 swap the target axes.
    let (tw, th) = if orientation.to_exif() >= 5 {
        (request.size.1, request.size.0)
    } else {
        request.size
    };
    let ratios = (
        f64::from(tw) / f64::from(info.width),
        f64::from(th) / f64::from(info.height),
    );
    let ratio = match request.fit {
        ImageFit::Contain => ratios.0.min(ratios.1),
        ImageFit::Cover => ratios.0.max(ratios.1),
    }
    .min(1.0);
    let target = (
        (f64::from(info.width) * ratio).ceil() as u16,
        (f64::from(info.height) * ratio).ceil() as u16,
    );
    let (w, h) = decoder
        .scale(target.0.max(1), target.1.max(1))
        .map_err(|e| format!("JPEG scaling: {e}"))?;
    let pixels = decoder.decode().map_err(|e| format!("JPEG decode: {e}"))?;
    let image = match info.pixel_format {
        PixelFormat::RGB24 => {
            image::RgbImage::from_raw(w.into(), h.into(), pixels).map(DynamicImage::ImageRgb8)
        }
        PixelFormat::L8 => {
            image::GrayImage::from_raw(w.into(), h.into(), pixels).map(DynamicImage::ImageLuma8)
        }
        _ => unreachable!("pixel format checked before decoding"),
    }
    .ok_or("JPEG scaled buffer has invalid dimensions")?;
    Ok(Some(image))
}
struct Job {
    request: Request,
    canceled: Arc<AtomicBool>,
    reply: mpsc::Sender<Result<Arc<Raster>>>,
}
fn worker(
    capacity: usize,
    mut decoder: impl FnMut(Request) -> Result<Arc<Raster>> + Send + 'static,
) -> Result<SyncSender<Job>> {
    let (send, receive) = mpsc::sync_channel::<Job>(capacity);
    std::thread::Builder::new()
        .name("wallpaper-decode".into())
        .spawn(move || {
            while let Ok(job) = receive.recv() {
                if job.canceled.load(Ordering::Acquire) {
                    continue;
                }
                let result = decoder(job.request);
                if !job.canceled.load(Ordering::Acquire) {
                    let _ = job.reply.send(result);
                }
            }
        })
        .map_err(|e| format!("starting image worker: {e}"))?;
    Ok(send)
}
fn queue() -> Result<&'static SyncSender<Job>> {
    static QUEUE: OnceLock<Result<SyncSender<Job>>> = OnceLock::new();
    QUEUE
        .get_or_init(|| worker(4, decode))
        .as_ref()
        .map_err(Clone::clone)
}
struct Pending {
    operation: Operation,
    canceled: Arc<AtomicBool>,
    reply: Receiver<Result<Arc<Raster>>>,
}
#[derive(Default)]
pub struct Load {
    pending: Option<Pending>,
}
impl Load {
    pub fn start(
        &mut self,
        operation: Operation,
        request: Request,
    ) -> std::result::Result<(), StartError> {
        request.validate().map_err(StartError::Failed)?;
        if operation.mount == 0 || operation.request == 0 {
            return Err(StartError::Failed("invalid image operation token".into()));
        }
        self.start_on(queue().map_err(StartError::Failed)?, operation, request)
    }
    fn start_on(
        &mut self,
        queue: &SyncSender<Job>,
        operation: Operation,
        request: Request,
    ) -> std::result::Result<(), StartError> {
        self.cancel();
        let (send, reply) = mpsc::channel();
        let canceled = Arc::new(AtomicBool::new(false));
        queue
            .try_send(Job {
                request,
                canceled: canceled.clone(),
                reply: send,
            })
            .map_err(|e| match e {
                TrySendError::Full(_) => StartError::Busy,
                TrySendError::Disconnected(_) => {
                    StartError::Failed("image worker unavailable".into())
                }
            })?;
        self.pending = Some(Pending {
            operation,
            canceled,
            reply,
        });
        Ok(())
    }
    pub fn poll(&mut self, current: Operation) -> Option<Result<Arc<Raster>>> {
        let pending = self.pending.as_ref()?;
        if pending.operation != current {
            self.cancel();
            return None;
        }
        let result = match pending.reply.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => Err("image worker stopped before replying".into()),
        };
        self.cancel();
        Some(result)
    }
    pub fn pending(&self) -> bool {
        self.pending.is_some()
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
    use nk_render::Canvas;
    use nk_text::Rect;
    use std::{
        sync::{Barrier, atomic::AtomicUsize},
        time::{Duration, Instant},
    };
    fn request(file: &str) -> Request {
        Request {
            path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/images")
                .join(file),
            size: (8, 8),
            fit: ImageFit::Cover,
            budget: Budget {
                encoded_bytes: 1024 * 1024,
                decoded_bytes: 1024 * 1024,
            },
        }
    }
    fn receive(load: &mut Load, token: Operation) -> Result<Arc<Raster>> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(r) = load.poll(token) {
                return r;
            }
            assert!(
                Instant::now() < deadline,
                "image worker did not complete setup"
            );
            std::thread::yield_now();
        }
    }
    #[test]
    #[ignore = "local wallpaper timing; NK_THUMB_BENCH is an absolute JPEG path"]
    fn real_wallpaper_decode_timing() {
        let path = std::path::PathBuf::from(std::env::var_os("NK_THUMB_BENCH").unwrap());
        let bytes = std::fs::read(&path).unwrap();
        let mut r = request("sample.jpg");
        r.path = path;
        r.size = (320, 200);
        r.budget = Budget {
            encoded_bytes: 64 * 1024 * 1024,
            decoded_bytes: 256 * 1024 * 1024,
        };
        for _ in 0..3 {
            let start = Instant::now();
            let full = image::load_from_memory(&bytes)
                .unwrap()
                .resize_to_fill(320, 200, image::imageops::FilterType::Triangle)
                .into_rgba8();
            let full_ms = start.elapsed().as_secs_f64() * 1000.;
            let start = Instant::now();
            let scaled = decode(r.clone()).unwrap();
            eprintln!(
                "THUMB_TIMING full_ms={full_ms:.3} reduced_ms={:.3} target={:?} full_pixels={}",
                start.elapsed().as_secs_f64() * 1000.,
                scaled.size(),
                full.len()
            );
        }
    }
    #[test]
    fn jpeg_decoder_emits_reduced_pixels_before_final_resizing() {
        let source = image::RgbImage::from_pixel(1536, 1024, image::Rgb([20, 180, 50]));
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&source)
            .unwrap();
        let mut r = request("sample.jpg");
        r.size = (96, 64);
        let image = jpeg_thumbnail(&bytes, &r, image::metadata::Orientation::NoTransforms)
            .unwrap()
            .unwrap();
        assert_eq!((image.width(), image.height()), (192, 128));
        assert!(image.as_bytes().len() < source.as_raw().len() / 16);
        // Cover must retain enough pixels on both axes, including portrait crops.
        r.size = (64, 256);
        let image = jpeg_thumbnail(&bytes, &r, image::metadata::Orientation::Rotate90)
            .unwrap()
            .unwrap();
        assert!(image.width() >= 256 && image.height() >= 64);
    }
    #[test]
    fn real_five_codec_files_decode_to_bounded_target_pixels_and_exif_orientation() {
        for (file, channels) in [
            ("sample.png", [true, false, false]),
            ("sample.jpg", [false, true, false]),
            ("sample.gif", [false, false, true]),
            ("sample.webp", [true, true, false]),
            ("sample.avif", [true, false, true]),
        ] {
            let r = decode(request(file));
            assert!(r.is_ok(), "{file}: {r:?}");
            let image = r.unwrap();
            assert_eq!(image.size(), (8, 8));
            let mut c = Canvas::new(8, 8, 1.);
            c.image(
                &image,
                Rect {
                    x: 0.,
                    y: 0.,
                    width: 8.,
                    height: 8.,
                },
                ImageFit::Cover,
            );
            let bytes = c.finish();
            let v = u32::from_ne_bytes(
                bytes[(4 * 8 + 4) * 4..(4 * 8 + 4) * 4 + 4]
                    .try_into()
                    .unwrap(),
            );
            let rgb = [(v >> 16) as u8, (v >> 8) as u8, v as u8];
            for (channel, high) in rgb.into_iter().zip(channels) {
                assert!(
                    if high { channel > 200 } else { channel < 50 },
                    "{file}: decoded colour {rgb:?}"
                );
            }
        }
        let mut r = request("rotated.jpg");
        r.fit = ImageFit::Contain;
        assert_eq!(
            decode(r).unwrap().size(),
            (4, 8),
            "Exif orientation precedes target fitting"
        );
    }
    #[test]
    fn malformed_missing_and_over_budget_inputs_are_explicit_errors() {
        let mut r = request("sample.png");
        r.budget.encoded_bytes = 1;
        assert!(
            decode(r)
                .unwrap_err()
                .contains("encoded image exceeds budget")
        );
        let mut r = request("sample.png");
        r.budget.decoded_bytes = 300;
        assert!(
            decode(r).is_err(),
            "full decoded source exceeds budget before target resize"
        );
        assert!(decode(request("missing.png")).is_err());
        assert!(
            decode(request("README.md"))
                .unwrap_err()
                .contains("unsupported wallpaper image format")
        );
        let mut r = request("sample.png");
        r.path = "relative.png".into();
        assert!(matches!(
            Load::default().start(
                Operation {
                    mount: 1,
                    request: 1
                },
                r
            ),
            Err(StartError::Failed(_))
        ));
    }
    #[test]
    fn bounded_queue_skips_canceled_jobs_and_rejects_stale_completed_result() {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let count = Arc::new(AtomicUsize::new(0));
        let (started_tx, started) = mpsc::channel();
        let a = entered.clone();
        let b = release.clone();
        let calls = count.clone();
        let queue = worker(4, move |_| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                a.wait();
                b.wait();
            } else {
                started_tx.send(n).unwrap();
            }
            Err("test decoder completion".into())
        })
        .unwrap();
        let token = Operation {
            mount: 3,
            request: 1,
        };
        let mut first = Load::default();
        first
            .start_on(&queue, token, request("sample.png"))
            .unwrap();
        entered.wait();
        let mut canceled = Vec::new();
        for _ in 0..4 {
            let mut load = Load::default();
            load.start_on(&queue, token, request("sample.png")).unwrap();
            canceled.push(load);
        }
        for load in &mut canceled {
            load.cancel();
        }
        let mut next = Load::default();
        assert_eq!(
            next.start_on(&queue, token, request("sample.png")),
            Err(StartError::Busy)
        );
        release.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        while next.start_on(&queue, token, request("sample.png")) == Err(StartError::Busy) {
            assert!(Instant::now() < deadline, "queue failed to drain setup");
            std::thread::yield_now();
        }
        // The second decoder call proves the first result was sent and canceled job skipped.
        assert_eq!(started.recv_timeout(Duration::from_secs(5)).unwrap(), 1);
        assert!(
            first
                .poll(Operation {
                    mount: 4,
                    request: 1
                })
                .is_none(),
            "completed stale result reached another mount"
        );
        assert!(!first.pending());
        assert!(
            receive(&mut next, token)
                .unwrap_err()
                .contains("test decoder completion")
        );
        assert_eq!(
            count.load(Ordering::SeqCst),
            2,
            "canceled queued decode ran"
        );
    }
}
