// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
#[derive(Clone)]
struct Fake {
    data: Arc<RwLock<(String, String, i64, f64)>>,
    calls: Arc<Mutex<Vec<String>>>,
}
#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl FakeRoot {
    #[zbus(property)]
    fn identity(&self) -> &str {
        "Fixture"
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        "org.nidara.Fixture"
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }
}
struct FakeRoot;
#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Fake {
    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.data.read().unwrap().0.clone()
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        self.data.read().unwrap().3
    }
    #[zbus(property)]
    fn position(&self) -> i64 {
        self.data.read().unwrap().2
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        HashMap::from([
            (
                "mpris:trackid".into(),
                Value::from(path("/track/one")).try_into().unwrap(),
            ),
            (
                "xesam:title".into(),
                Value::from(self.data.read().unwrap().1.clone())
                    .try_into()
                    .unwrap(),
            ),
            ("mpris:length".into(), OwnedValue::from(i64::MAX)),
            (
                "xesam:artist".into(),
                Value::from(vec!["Artist"]).try_into().unwrap(),
            ),
        ])
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }
    async fn play_pause(&self) {
        self.calls.lock().await.push("PlayPause".into());
    }
    async fn pause(&self) {
        self.calls.lock().await.push("Pause".into());
    }
    async fn next(&self) {
        self.calls.lock().await.push("Next".into());
    }
    async fn set_position(&self, track: Path, position: i64) {
        self.calls
            .lock()
            .await
            .push(format!("SetPosition:{track}:{position}"));
        self.data.write().unwrap().2 = position;
    }
}
async fn wait<T>(mut f: impl FnMut() -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(v) = f() {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture condition")
}
async fn run() {
    artwork_fixture().await;
    let fixture = Fake {
        data: Arc::new(RwLock::new((
            "Playing".into(),
            "First".into(),
            100_000,
            1.0,
        ))),
        calls: Default::default(),
    };
    let c = zbus::connection::Builder::session()
        .unwrap()
        .name("org.mpris.MediaPlayer2.fixture")
        .unwrap()
        .serve_at(MPRIS_PATH, FakeRoot)
        .unwrap()
        .serve_at(MPRIS_PATH, fixture.clone())
        .unwrap()
        .build()
        .await
        .unwrap();
    let conn = zbus::connection::Builder::session()
        .unwrap()
        .name("org.nidara.Session")
        .unwrap()
        .build()
        .await
        .unwrap();
    let level = Arc::new(RwLock::new(0.4));
    conn.object_server()
        .at("/org/nidara/Audio", zbus::fdo::ObjectManager)
        .await
        .unwrap();
    conn.object_server()
        .at("/org/nidara/Audio", FakeAudio(level.clone()))
        .await
        .unwrap();
    conn.object_server()
        .at("/org/nidara/Audio/g1/app", FakeStream(level.clone()))
        .await
        .unwrap();
    let service = start(&conn).await.unwrap();
    let client = Connection::session().await.unwrap();
    let root = Proxy::new(&client, "org.nidara.Session", ROOT, "org.nidara.Media1")
        .await
        .unwrap();
    let objects: Vec<Path> = root.get_property("Players").await.unwrap();
    assert_eq!(objects.len(), 1);
    let selected: Path = root.get_property("Selected").await.unwrap();
    assert_eq!(objects[0], selected);
    let player = Proxy::new(
        &client,
        "org.nidara.Session",
        selected.as_str(),
        "org.nidara.MediaPlayer1",
    )
    .await
    .unwrap();
    assert_eq!(player.get_property::<i64>("LengthUs").await.unwrap(), 0);
    assert_eq!(
        player
            .get_property::<Path>("TrackId")
            .await
            .unwrap()
            .as_str(),
        "/track/one"
    );
    assert_eq!(
        player.get_property::<Vec<String>>("Artists").await.unwrap(),
        ["Artist"]
    );
    assert!(
        !player
            .get_property::<bool>("ShuffleAvailable")
            .await
            .unwrap()
    );
    let err = root
        .call::<_, _, ()>("SelectedSetShuffle", &(selected.clone(), true))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("NotSupported"));
    root.call::<_, _, ()>("SelectedPlayPause", &())
        .await
        .unwrap();
    assert_eq!(*fixture.calls.lock().await, ["PlayPause"]);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if player.get_property::<String>("VolumeSource").await.unwrap() == "audio1" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    root.call::<_, _, ()>("SelectedSetVolume", &(selected.clone(), 0.6f64))
        .await
        .unwrap();
    assert_eq!(*level.read().unwrap(), 0.6);
    conn.emit_signal(
        None::<&str>,
        "/org/nidara/Audio",
        "org.nidara.Audio1",
        "HeadphoneFallback",
        &(
            1u64,
            path("/old"),
            path("/speaker"),
            vec![path("/org/nidara/Audio/g1/app")],
            "fixture",
        ),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fixture.calls.lock().await.iter().any(|s| s == "Pause") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let count = fixture.calls.lock().await.len();
    service.prefs.write().unwrap().1 = false;
    audio::pause_affected(&service, 2, &[path("/org/nidara/Audio/g1/app")]).await;
    assert_eq!(fixture.calls.lock().await.len(), count);
    service.prefs.write().unwrap().1 = true;
    {
        service
            .roster
            .write()
            .unwrap()
            .players
            .get_mut(selected.as_str())
            .unwrap()
            .status = "Paused".into();
    }
    audio::pause_affected(&service, 3, &[path("/org/nidara/Audio/g1/app")]).await;
    assert_eq!(fixture.calls.lock().await.len(), count);
    let revision: u64 = player.get_property("TrackRevision").await.unwrap();
    player
        .call::<_, _, ()>("SeekTo", &(revision, 400_000i64))
        .await
        .unwrap();
    assert!(
        fixture
            .calls
            .lock()
            .await
            .iter()
            .any(|s| s == "SetPosition:/track/one:400000")
    );
    let wrong = path("/old/selection");
    assert!(
        root.call::<_, _, ()>("SelectedSetVolume", &(wrong, 0.5f64))
            .await
            .unwrap_err()
            .to_string()
            .contains("StaleSelection")
    );
    let props = Proxy::new(
        &client,
        "org.nidara.Session",
        selected.as_str(),
        "org.freedesktop.DBus.Properties",
    )
    .await
    .unwrap();
    let mut changed = props.receive_signal("PropertiesChanged").await.unwrap();
    let root_before = service
        .announced
        .lock()
        .await
        .get(ROOT)
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.try_clone().unwrap()))
        .collect::<HashMap<_, _>>();
    fixture.data.write().unwrap().1 = "Second".into();
    c.emit_signal(
        None::<&str>,
        MPRIS_PATH,
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        &(
            PLAYER,
            HashMap::<String, OwnedValue>::new(),
            vec!["Metadata"],
        ),
    )
    .await
    .unwrap();
    let pcopy = player.clone();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let rev: u64 = pcopy.get_property("TrackRevision").await.unwrap();
            if rev > revision {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let delta = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let msg = changed.next().await.unwrap();
            let (_, values, invalidated): (String, HashMap<String, OwnedValue>, Vec<String>) =
                msg.body().deserialize().unwrap();
            if values.contains_key("Title") {
                assert!(invalidated.is_empty());
                break values;
            }
        }
    })
    .await
    .unwrap();
    assert!(delta.contains_key("TrackRevision"));
    assert!(!delta.contains_key("Identity"));
    assert!(!delta.contains_key("CanSeek"));
    assert_eq!(
        service.announced.lock().await.get(ROOT).unwrap(),
        &root_before,
        "metadata changes do not churn root"
    );
    assert!(
        player
            .call::<_, _, ()>("SeekTo", &(revision, 1i64))
            .await
            .unwrap_err()
            .to_string()
            .contains("StaleTrack")
    );
    root.call::<_, _, ()>("SetSelection", &("org.mpris.MediaPlayer2.fixture",))
        .await
        .unwrap();
    c.release_name("org.mpris.MediaPlayer2.fixture")
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let p: Path = root.get_property("Selected").await.unwrap();
            if p.as_str() == "/" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        root.get_property::<String>("PinnedBus")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        root.call::<_, _, ()>("SelectedPause", &())
            .await
            .unwrap_err()
            .to_string()
            .contains("NotFound")
    );
    let replacement = Fake {
        data: Arc::new(RwLock::new((
            "Playing".into(),
            "Replacement".into(),
            0,
            1.0,
        ))),
        calls: Default::default(),
    };
    let replacement_conn = zbus::connection::Builder::session()
        .unwrap()
        .name("org.mpris.MediaPlayer2.fixture")
        .unwrap()
        .serve_at(MPRIS_PATH, FakeRoot)
        .unwrap()
        .serve_at(MPRIS_PATH, replacement.clone())
        .unwrap()
        .build()
        .await
        .unwrap();
    let new = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let p: Path = root.get_property("Selected").await.unwrap();
            if p.as_str() != "/" {
                break p;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(new, selected);
    assert!(player.call::<_, _, ()>("PlayPause", &()).await.is_err());
    root.call::<_, _, ()>("SelectedPlayPause", &())
        .await
        .unwrap();
    assert_eq!(*replacement.calls.lock().await, ["PlayPause"]);
    drop(replacement_conn);
    drop(c);
    let _ = wait(|| Some(())).await;
}
#[test]
fn private_bus_mpris_contract() {
    if std::env::var_os("NIDARA_MEDIA_TEST_CHILD").is_none() {
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/media-test-home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(
            std::process::Command::new("dbus-run-session")
                .arg("--")
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "media::tests::private_bus_mpris_contract",
                    "--nocapture"
                ])
                .env("NIDARA_MEDIA_TEST_CHILD", "1")
                .env("GIO_USE_VFS", "local")
                .env("GSETTINGS_BACKEND", "memory")
                .env("HOME", &home)
                .env("XDG_CONFIG_HOME", home.join("config"))
                .env("XDG_CACHE_HOME", home.join("cache"))
                .env("XDG_DATA_HOME", home.join("data"))
                .status()
                .unwrap()
                .success()
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(run());
}

async fn artwork_fixture() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut png = vec![];
    let mut writer = png::Encoder::new(&mut png, 1, 1).write_header().unwrap();
    writer.write_image_data(&[0]).unwrap();
    drop(writer);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let bad = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let count = bad.clone();
    let pixels = png.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut request = [0u8; 4096];
            let n = socket.read(&mut request).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&request[..n]);
            let (header, body) = if req.starts_with("GET /ok ") {
                (
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        pixels.len()
                    ),
                    pixels.clone(),
                )
            } else if req.starts_with("GET /huge ") {
                (
                    "HTTP/1.1 200 OK\r\nContent-Length: 10485761\r\nConnection: close\r\n\r\n"
                        .into(),
                    vec![],
                )
            } else if req.starts_with("GET /redirect ") {
                ("HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),vec![])
            } else {
                count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                (
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .into(),
                    vec![],
                )
            };
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    let art = art::Art::new();
    let url = format!("http://{addr}/ok");
    let file = art.resolve(url.clone()).await.unwrap();
    assert!(file.contains("/media-art/sessiond/"));
    assert_eq!(std::fs::read(&file).unwrap(), png);
    assert_eq!(art.resolve(url).await.unwrap(), file);
    for suffix in ["huge", "redirect", "missing"] {
        assert!(
            art.resolve(format!("http://{addr}/{suffix}"))
                .await
                .is_err()
        );
    }
    assert!(art.resolve(format!("http://{addr}/missing")).await.is_err());
    assert_eq!(bad.load(std::sync::atomic::Ordering::Relaxed), 1);
    let data = format!("data:image/png;base64,{}", glib::base64_encode(&png));
    assert!(art.resolve(data).await.is_ok());
    assert!(
        art.resolve("data:image/png;base64,not-valid!".into())
            .await
            .is_err()
    );
    let local = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/media-test-home/local.png");
    std::fs::write(&local, &png).unwrap();
    assert!(art.resolve(local.to_string_lossy().into()).await.is_ok());
    assert!(
        art.resolve("file://remote.invalid/path.png".into())
            .await
            .is_err()
    );
    task.abort();
}

struct FakeAudio(Arc<RwLock<f64>>);
#[zbus::interface(name = "org.nidara.Audio1")]
impl FakeAudio {
    #[zbus(property)]
    fn streams(&self) -> Vec<Path> {
        vec![path("/org/nidara/Audio/g1/app")]
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<&str> {
        vec!["mixer", "headphone-fallback"]
    }
    #[zbus(property)]
    fn volume_limit(&self) -> f64 {
        1.5
    }
    fn set_volume(&self, _target: Path, volume: f64) {
        *self.0.write().unwrap() = volume;
    }
}
struct FakeStream(Arc<RwLock<f64>>);
#[zbus::interface(name = "org.nidara.AudioNode1")]
impl FakeStream {
    #[zbus(property)]
    fn kind(&self) -> &str {
        "playback"
    }
    #[zbus(property)]
    fn process_id(&self) -> u32 {
        0
    }
    #[zbus(property)]
    fn application_id(&self) -> &str {
        "org.nidara.Fixture"
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<&str> {
        vec!["volume"]
    }
    #[zbus(property)]
    fn volume(&self) -> f64 {
        *self.0.read().unwrap()
    }
}

#[test]
fn media_key_only_falls_back_when_service_absent() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = root.join("target/media-key-fixture");
    std::fs::create_dir_all(&dir).unwrap();
    let gdbus = dir.join("gdbus");
    let playerctl = dir.join("playerctl");
    let called = dir.join("called");
    std::fs::write(&gdbus,"#!/bin/sh\ncase \"$*\" in *NameHasOwner*) printf '(%s,)\\n' \"${FIXTURE_OWNER:-false}\"; exit 0 ;; esac\n[ -z \"$FIXTURE_ERROR\" ] && exit 0\nprintf '%s\\n' \"$FIXTURE_ERROR\" >&2\nexit 1\n").unwrap();
    std::fs::write(
        &playerctl,
        "#!/bin/sh\nprintf '%s\\n' \"$1\" >\"$FIXTURE_CALLED\"\n",
    )
    .unwrap();
    for file in [&gdbus, &playerctl] {
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (error, expected) in [
        ("", false),
        (
            "GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: absent",
            true,
        ),
        (
            "GDBus.Error:org.freedesktop.DBus.Error.NameHasNoOwner: absent",
            true,
        ),
        ("Timeout was reached", false),
        (
            "GDBus.Error:org.nidara.Media1.Error.NotSupported: pause",
            false,
        ),
        (
            "GDBus.Error:org.nidara.Media1.Error.Failed: result uncertain",
            false,
        ),
    ] {
        let _ = std::fs::remove_file(&called);
        let result = std::process::Command::new(root.join("bin/nidara-media-key"))
            .arg("pause")
            .env("PATH", &dir)
            .env("FIXTURE_ERROR", error)
            .env("FIXTURE_CALLED", &called)
            .output()
            .unwrap();
        assert_eq!(called.exists(), expected, "{error}");
        if expected {
            assert!(result.status.success());
            assert_eq!(std::fs::read_to_string(&called).unwrap(), "pause\n");
        }
    }
    let _ = std::fs::remove_file(&called);
    let result = std::process::Command::new(root.join("bin/nidara-media-key"))
        .arg("pause")
        .env("PATH", &dir)
        .env(
            "FIXTURE_ERROR",
            "GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: vanished player",
        )
        .env("FIXTURE_OWNER", "true")
        .env("FIXTURE_CALLED", &called)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        !called.exists(),
        "a vanished player must not invoke legacy selection"
    );
}
