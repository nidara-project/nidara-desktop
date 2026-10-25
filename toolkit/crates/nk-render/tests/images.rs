// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_render::{Canvas, ImageFit, Raster, rgba};
use nk_text::Rect;
fn pixel(p: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
    let at = (y * width + x) * 4;
    let v = u32::from_ne_bytes(p[at..at + 4].try_into().unwrap());
    [(v >> 16) as u8, (v >> 8) as u8, v as u8, (v >> 24) as u8]
}
#[test]
fn raster_fit_preserves_letterbox_cover_alpha_and_destination_at_both_scales() {
    assert!(Raster::from_rgba(0, 2, vec![]).is_err());
    assert!(Raster::from_rgba(2, 2, vec![0; 12]).is_err());
    let image = Raster::from_rgba(8, 4, [255, 0, 0, 128].repeat(32)).unwrap();
    for scale in [1., 1.25] {
        let width = (32. * scale) as u16;
        let height = (24. * scale) as u16;
        let paint = |fit| {
            let mut c = Canvas::new(width, height, scale);
            c.rect(
                Rect {
                    x: 0.,
                    y: 0.,
                    width: 32.,
                    height: 24.,
                },
                rgba(0, 0, 255, 255),
            );
            c.image(
                &image,
                Rect {
                    x: 8.,
                    y: 4.,
                    width: 16.,
                    height: 16.,
                },
                fit,
            );
            c.finish()
        };
        let contain = paint(ImageFit::Contain);
        let cover = paint(ImageFit::Cover);
        let at = |p: &[u8], x: f64, y: f64| {
            pixel(
                p,
                width as usize,
                (x * scale) as usize,
                (y * scale) as usize,
            )
        };
        assert_eq!(
            at(&contain, 16., 5.),
            [0, 0, 255, 255],
            "contain retains the letterbox"
        );
        assert_eq!(
            at(&cover, 16., 5.),
            [128, 0, 127, 255],
            "cover fills the destination, with alpha"
        );
        assert_eq!(
            at(&contain, 16., 12.),
            [128, 0, 127, 255],
            "actual pixels use the supplied destination"
        );
        assert_eq!(
            at(&cover, 4., 12.),
            [0, 0, 255, 255],
            "cover stays clipped to the destination"
        );
    }
}
