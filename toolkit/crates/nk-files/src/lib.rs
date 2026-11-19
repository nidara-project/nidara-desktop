// SPDX-License-Identifier: LGPL-3.0-or-later
//! Shared file browsing and freedesktop thumbnail caching.
mod listing;
mod mime;
mod places;
mod thumbnails;

pub use listing::{Entry, Listing, Options, Sort};
pub use mime::{Filter, MimeDb};
pub use places::{Location, Place, PlaceKind, Recent, Sources, file_uri};
pub use thumbnails::Preview;

#[cfg(test)]
#[test]
fn lists_filtered_files_and_reads_shared_bookmarks() -> std::io::Result<()> {
    use std::{
        fs,
        sync::Arc,
        time::{Duration, Instant},
    };

    let tmp = tempfile::tempdir()?;
    let root = tmp.path();
    let sources = Sources {
        home: root.to_owned(),
        config: root.join("config"),
        data: root.join("data"),
        cache: root.join("cache"),
        mountinfo: root.join("mountinfo"),
        media: None,
    };
    let folder = root.join("files");
    fs::create_dir_all(folder.join("Z folder"))?;
    fs::write(folder.join("A.txt"), "hello")?;
    fs::write(folder.join("B.jpeg"), "photo")?;
    fs::write(folder.join(".secret.txt"), "private")?;
    fs::write(folder.join("C.bin"), "unmatched")?;
    fs::create_dir_all(sources.config.join("gtk-3.0"))?;
    let uri = url::Url::from_file_path(folder.join("Z folder")).unwrap();
    fs::write(
        sources.config.join("gtk-3.0/bookmarks"),
        format!("{uri} Work\n"),
    )?;
    let bookmark = sources
        .places()
        .into_iter()
        .find(|place| place.kind == PlaceKind::Bookmark)
        .unwrap();
    assert_eq!(bookmark.name, "Work");
    assert_eq!(bookmark.path(), Some(folder.join("Z folder").as_path()));

    let db = root.join("mime");
    fs::create_dir(&db)?;
    fs::write(db.join("globs2"), "50:image/jpeg:*.jpeg\n")?;
    fs::write(db.join("generic-icons"), "image/jpeg:image-x-generic\n")?;
    let mime = Arc::new(MimeDb::load([db]));
    let run = |show_hidden| -> std::io::Result<Vec<Entry>> {
        let filter = Filter::new(
            "Text and images",
            &[(0, "*.txt".into()), (1, "image/*".into())],
        )
        .unwrap();
        let mut scan = Listing::start(
            folder.clone(),
            Options {
                show_hidden,
                filter: Some(filter),
                ..Options::default()
            },
            Arc::clone(&mime),
        )?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while scan.loading() {
            assert!(Instant::now() < deadline, "directory scan timed out");
            if !scan.poll() {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        assert!(scan.error().is_none());
        Ok(scan.entries().to_owned())
    };
    let visible = run(false)?;
    let names = |entries: &[Entry]| {
        entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&visible), ["Z folder", "A.txt", "B.jpeg"]);
    assert_eq!(
        names(&run(true)?),
        ["Z folder", ".secret.txt", "A.txt", "B.jpeg"]
    );
    assert_eq!(visible[2].mime, "image/jpeg");
    assert_eq!(visible[2].icon, "image-x-generic");
    Ok(())
}
