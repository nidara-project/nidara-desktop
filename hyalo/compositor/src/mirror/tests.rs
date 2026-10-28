// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

#[test]
fn contain_has_centered_bands_and_a_single_uniform_scale() {
    let map = Contain::new((1920, 1080), (1024, 768)).unwrap();
    assert_eq!(
        (map.x, map.y, map.width, map.height),
        (0.0, 96.0, 1024.0, 576.0)
    );
    assert_eq!(map.inverse(512.0, 384.0), Some((960.0, 540.0)));
    for point in [
        (0.0, 0.0),
        (512.0, 95.0),
        (512.0, 672.0),
        (1024.0, 384.0),
        (f64::NAN, 0.0),
    ] {
        assert!(map.inverse(point.0, point.1).is_none());
    }
    let portrait = Contain::new((1920, 1080), (1080, 1920)).unwrap();
    assert_eq!(portrait.x, 0.0);
    assert!(portrait.y > 0.0);
    assert!((portrait.width / 1920.0 - portrait.height / 1080.0).abs() < 1e-12);
}
#[test]
fn empty_viewports_fail_and_fractional_mapping_roundtrips() {
    assert!(Contain::new((0, 1080), (1024, 768)).is_none());
    assert!(Contain::new((1920, 1080), (-1, 768)).is_none());
    for (source, target) in [
        ((1366, 768), (1920, 1200)),
        ((800, 450), (1024, 768)),
        ((360, 640), (1600, 900)),
    ] {
        let map = Contain::new(source, target).unwrap();
        for (x, y) in [(1.25, 2.5), (100.5, 200.25)] {
            let actual = map
                .inverse(map.x + x * map.scale, map.y + y * map.scale)
                .unwrap();
            assert!((actual.0 - x).abs() < 1e-10 && (actual.1 - y).abs() < 1e-10);
        }
    }
}
