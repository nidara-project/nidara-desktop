// SPDX-License-Identifier: GPL-3.0-or-later
//! Local main-thread EGL probe; entered only through the explicit controlled dev command.
use super::*;
use smithay::{
    output::{Mode, PhysicalProperties, Subpixel},
    utils::Transform,
};
fn output(name: &str, w: i32, h: i32, scale: f64, transform: Transform) -> Output {
    let o = Output::new(
        name.into(),
        PhysicalProperties {
            size: (0, 0).into(),
            subpixel: Subpixel::Unknown,
            make: "Test".into(),
            model: "Mirror".into(),
            serial_number: name.into(),
        },
    );
    let mode = Mode {
        size: (w, h).into(),
        refresh: 60_000,
    };
    o.change_current_state(
        Some(mode),
        Some(transform),
        Some(smithay::output::Scale::Fractional(scale)),
        None,
    );
    o.set_preferred(mode);
    o
}
/// Real GTK shm buffers through the compositor scene, GL mirror and capture paths.
/// This probe is deliberately local: it needs its own headless host and bus.
pub fn run() {
    use smithay::{
        backend::input::{ButtonState, InputTime},
        reexports::{calloop::EventLoop, wayland_server::Display},
    };
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let out = std::path::PathBuf::from(
        std::env::var_os("MIRROR_EVIDENCE").expect("isolated evidence directory"),
    );
    let mut event_loop = EventLoop::<Hyalo>::try_new().unwrap();
    let (winit, _) = crate::backend::winit::WinitBackend::new().unwrap();
    let mut config = crate::config::Config::default();
    config.animations.enabled = false;
    let mut state = Hyalo::new(
        Display::new().unwrap(),
        event_loop.handle(),
        event_loop.get_signal(),
        crate::backend::Backend::Winit(winit),
        config,
    );
    let src = output("source", 800, 450, 1.25, Transform::Normal);
    src.create_global::<Hyalo>(&state.display_handle);
    state.space.map_output(&src, (100, 50));
    state.outputs_changed();
    let target = output("follower", 1024, 768, 1.0, Transform::Normal);
    link(&target, Some(src.clone()));
    let client = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/dev/mirror-scene-client.py");
    let mut child = Command::new("python3")
        .arg(client)
        .env("WAYLAND_DISPLAY", &state.socket_name)
        .env("GDK_BACKEND", "wayland")
        .env("GSK_RENDERER", "cairo")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + Duration::from_secs(15);
        let (sw, sh, source_image) = loop {
            event_loop
                .dispatch(Some(Duration::from_millis(10)), &mut state)
                .unwrap();
            state.after_dispatch();
            if state.wm.windows.iter().any(|w| w.mapped) {
                let image = crate::backend::capture_output(&mut state, &src, false).unwrap();
                let colored = image
                    .2
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|p| p[0] > 200 && p[1] < 20 && p[2] < 20)
                    && image
                        .2
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .any(|p| p[1] > 200 && p[0] < 20 && p[2] < 20);
                if colored {
                    break image;
                }
            }
            assert!(
                Instant::now() < deadline,
                "GTK scene did not produce its colored buffer"
            );
        };
        assert_eq!((sw, sh), (800, 450));
        crate::screenshot::write_png(&out.join("source.png"), sw, sh, &source_image).unwrap();
        // Sample real colored content, not just background at guessed window coordinates.
        let pixel = |x: u32, y: u32| {
            &source_image[((y * sw + x) * 4) as usize..((y * sw + x) * 4 + 3) as usize]
        };
        let samples: Vec<_> = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]
            .into_iter()
            .map(|rgb| {
                (4..sh - 4)
                    .step_by(4)
                    .find_map(|y| {
                        (4..sw - 4).step_by(4).find_map(|x| {
                            [(-3, -3), (3, -3), (-3, 3), (3, 3), (0, 0)]
                                .iter()
                                .all(|(dx, dy)| {
                                    pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32) == rgb
                                })
                                .then_some((x, y))
                        })
                    })
                    .expect("GTK scene missing a colored quadrant")
            })
            .collect();
        for (name, w, h, transform) in [
            ("standard", 1024, 768, Transform::Normal),
            ("portrait", 900, 1600, Transform::Normal),
            ("rotated", 900, 1600, Transform::_90),
            ("fractional", 1366, 768, Transform::Normal),
        ] {
            let target = if name == "standard" {
                target.clone()
            } else {
                let o = output(
                    name,
                    w,
                    h,
                    if name == "fractional" { 1.5 } else { 1.0 },
                    transform,
                );
                link(&o, Some(src.clone()));
                o
            };
            let (tw, th, image) =
                crate::backend::capture_output(&mut state, &target, false).unwrap();
            let physical = physical_size(&target).unwrap();
            assert_eq!((tw as i32, th as i32), (physical.w, physical.h));
            let map = Contain::new((sw as i32, sh as i32), (tw as i32, th as i32)).unwrap();
            let at = |x: u32, y: u32| {
                &image[((y * tw + x) * 4) as usize..((y * tw + x) * 4 + 4) as usize]
            };
            if map.y > 2.0 {
                assert_eq!(&at(tw / 2, 1)[..3], &[0, 0, 0]);
                assert_eq!(&at(tw / 2, th - 2)[..3], &[0, 0, 0]);
            }
            if map.x > 2.0 {
                assert_eq!(&at(1, th / 2)[..3], &[0, 0, 0]);
            }
            for &(sx, sy) in &samples {
                let (tx, ty) = (
                    (map.x + sx as f64 * map.scale) as u32,
                    (map.y + sy as f64 * map.scale) as u32,
                );
                let expected =
                    &source_image[((sy * sw + sx) * 4) as usize..((sy * sw + sx) * 4 + 3) as usize];
                for (a, b) in at(tx, ty).iter().take(3).zip(expected) {
                    assert!(
                        a.abs_diff(*b) <= 2,
                        "scaled scene differs for {name} at {tx},{ty}: {:?} vs {:?}",
                        at(tx, ty),
                        expected
                    );
                }
            }
            crate::screenshot::write_png(&out.join(format!("{name}.png")), tw, th, &image).unwrap();
        }
        // Rotating the source changes its native mode, not the upright logical scene.
        src.change_current_state(
            Some(Mode {
                size: (450, 800).into(),
                refresh: 60_000,
            }),
            Some(Transform::_90),
            None,
            None,
        );
        state.space.refresh();
        let (rw, rh, rotated) = crate::backend::capture_output(&mut state, &target, false).unwrap();
        assert_eq!((rw, rh), (1024, 768));
        crate::screenshot::write_png(&out.join("rotated-source.png"), rw, rh, &rotated).unwrap();
        let (_, _, original) = crate::backend::capture_output(&mut state, &src, false).unwrap();
        for (a, b) in original.iter().zip(&source_image) {
            assert!(
                a.abs_diff(*b) <= 2,
                "source rotation changed the upright scene"
            );
        }
        let pointer = state.seat.get_pointer().unwrap();
        state.pointer_moved_on_output(&target, (512.0, 384.0).into(), InputTime::now());
        assert_eq!(pointer.current_location(), (420.0, 230.0).into());
        assert!(pointer.current_focus().is_some());
        state.pointer_moved_on_output(&target, (512.0, 10.0).into(), InputTime::now());
        assert!(pointer.current_focus().is_none());
        assert_eq!(state.pointer_motion_origin(), (420.0, 230.0).into());
        state.pointer_button(0x110, ButtonState::Pressed, InputTime::now());
        assert!(!pointer.is_grabbed());
        state.pointer_moved_on_output(&target, (512.0, 384.0).into(), InputTime::now());
        state.pointer_button(0x110, ButtonState::Released, InputTime::now());
        assert!(!pointer.is_grabbed());
        state.pointer_button(0x110, ButtonState::Pressed, InputTime::now());
        assert!(pointer.is_grabbed());
        state.pointer_moved_on_output(&target, (512.0, 10.0).into(), InputTime::now());
        state.pointer_button(0x110, ButtonState::Released, InputTime::now());
        assert!(!pointer.is_grabbed());
        assert!(
            !state
                .space
                .outputs()
                .filter_map(|o| state.space.output_geometry(o))
                .any(|g| g.to_f64().contains(pointer.current_location()))
        );
        // Let the real GTK widget consume protocol events: a band release must cancel,
        // while an ordinary press/release at the same scene point must activate it.
        for _ in 0..20 {
            event_loop
                .dispatch(Some(Duration::from_millis(10)), &mut state)
                .unwrap();
            state.after_dispatch();
        }
        let clicks = out.join("clicks");
        assert!(!clicks.exists(), "band input activated the GTK button");
        state.pointer_moved_on_output(&target, (512.0, 384.0).into(), InputTime::now());
        state.pointer_button(0x110, ButtonState::Pressed, InputTime::now());
        state.pointer_button(0x110, ButtonState::Released, InputTime::now());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !std::fs::read_to_string(&clicks).is_ok_and(|s| s == "clicked\n") {
            event_loop
                .dispatch(Some(Duration::from_millis(10)), &mut state)
                .unwrap();
            state.after_dispatch();
            assert!(
                Instant::now() < deadline,
                "GTK button did not receive the valid click"
            );
        }
        assert_eq!(std::fs::read_to_string(&clicks).unwrap(), "clicked\n");
        assert!(crate::render::mirror::states(&target).is_some());
        link(&target, None);
        assert!(crate::render::mirror::states(&target).is_none());
        assert!(crate::render::mirror::ok(&target));
        println!("mirror GL scene/capture/input passed: {}", out.display());
    }));
    let _ = child.kill();
    let _ = child.wait();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
