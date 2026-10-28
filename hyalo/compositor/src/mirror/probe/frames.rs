// SPDX-License-Identifier: GPL-3.0-or-later
//! A real wl_surface.frame client, driven by deterministic source/follower clock schedules.
use crate::Hyalo;
use smithay::{
    output::Output,
    reexports::{calloop::EventLoop, wayland_server::protocol::wl_surface::WlSurface},
    wayland::compositor::{SurfaceAttributes, with_states},
};
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn pending(surface: &WlSurface) -> bool {
    with_states(surface, |s| {
        !s.cached_state
            .get::<SurfaceAttributes>()
            .current()
            .frame_callbacks
            .is_empty()
    })
}
fn wait_pending(
    event_loop: &mut EventLoop<'static, Hyalo>,
    state: &mut Hyalo,
    surface: &WlSurface,
) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !pending(surface) {
        event_loop
            .dispatch(Some(Duration::from_millis(5)), state)
            .unwrap();
        state.after_dispatch();
        assert!(
            Instant::now() < deadline,
            "frame client did not rearm its callback"
        );
    }
}
pub fn run(
    event_loop: &mut EventLoop<'static, Hyalo>,
    state: &mut Hyalo,
    source: &Output,
    target: &Output,
    out: &Path,
) {
    let counter = out.join("frame-counter");
    let mut client = Command::new(std::env::var_os("MIRROR_FRAME_CLIENT").expect("frame fixture"))
        .arg(&counter)
        .env("WAYLAND_DISPLAY", &state.socket_name)
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        let surface = loop {
            event_loop
                .dispatch(Some(Duration::from_millis(5)), state)
                .unwrap();
            state.after_dispatch();
            if let Some(window) = state
                .wm
                .windows
                .iter()
                .find(|w| w.mapped && crate::wm::app_id(&w.window) == "org.nidara.MirrorFrames")
            {
                break crate::wm::surface_of(&window.window).unwrap();
            }
            assert!(Instant::now() < deadline, "frame client did not map");
        };
        crate::backend::capture_output(state, target, false).unwrap();
        let states = crate::render::mirror::states(target).unwrap();
        let mut expected = 0;
        let mut evidence = String::new();
        for (source_hz, follower_hz) in [(60, 144), (144, 60)] {
            for (output, hz) in [(source, source_hz), (target, follower_hz)] {
                let mode = output.current_mode().unwrap();
                output.change_current_state(
                    Some(smithay::output::Mode {
                        refresh: hz * 1000,
                        ..mode
                    }),
                    None,
                    None,
                    None,
                );
            }
            // One simulated second, 720 rational slots. Each client request is actually
            // received before the next opportunity: CPU speed cannot hide double delivery.
            for tick in 1..=720 {
                for (output, hz) in [(source, source_hz), (target, follower_hz)] {
                    if tick % (720 / hz) == 0 {
                        wait_pending(event_loop, state, &surface);
                        crate::backend::post_repaint(state, output, &states, None);
                        state.after_dispatch();
                    }
                }
            }
            wait_pending(event_loop, state, &surface);
            expected += source_hz as u32;
            let deadline = Instant::now() + Duration::from_secs(3);
            let actual = loop {
                if let Ok(value) = std::fs::read_to_string(&counter)
                    && let Ok(count) = value.trim().parse::<u32>()
                    && count >= expected
                {
                    break count;
                }
                event_loop
                    .dispatch(Some(Duration::from_millis(1)), state)
                    .unwrap();
                state.after_dispatch();
                assert!(
                    Instant::now() < deadline,
                    "frame client counter did not advance"
                );
            };
            assert_eq!(
                actual, expected,
                "callbacks followed the sum of source and follower clocks"
            );
            evidence.push_str(&format!("one simulated second: source={source_hz}Hz follower={follower_hz}Hz callbacks={source_hz}; cumulative={actual}\n"));
        }
        std::fs::write(out.join("frame-callbacks.txt"), &evidence).unwrap();
        print!("{evidence}");
    }));
    let _ = client.kill();
    let _ = client.wait();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
