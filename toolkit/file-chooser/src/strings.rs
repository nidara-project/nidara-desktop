// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_platform::exports::Exports;

#[derive(Default)]
pub struct Strings {
    pub open: String,
    pub cancel: String,
    pub files: String,
    pub location: String,
    pub view: String,
    pub list: String,
    pub icons: String,
    pub hidden: String,
    pub file_type: String,
    pub loading: String,
    pub empty: String,
    pub folder_only: String,
    pub invalid_location: String,
    pub unreadable_location: String,
    pub home: String,
    pub places: String,
    pub bookmarks: String,
    pub drives: String,
    pub show_places: String,
    pub hide_places: String,
    pub name: String,
    pub size: String,
    pub modified: String,
    pub save: String,
    pub new_folder: String,
    pub folder_name: String,
    pub create: String,
    pub invalid_name: String,
    pub folder_exists: String,
    pub cannot_create: String,
    pub replace_title: String,
    pub replace_message: String,
    pub replace: String,
}

impl Strings {
    pub fn load(exports: &Exports) -> Result<Self, String> {
        let text = |key| {
            exports
                .text(&format!("fileChooser.{key}"))
                .map(str::to_owned)
        };
        Ok(Self {
            open: text("open")?,
            cancel: exports.text("settings.native.cancel")?.into(),
            files: text("files")?,
            location: text("location")?,
            view: text("view")?,
            list: text("list")?,
            icons: text("icons")?,
            hidden: text("hidden")?,
            file_type: text("fileType")?,
            loading: text("loading")?,
            empty: text("empty")?,
            folder_only: text("folderOnly")?,
            invalid_location: text("invalidLocation")?,
            unreadable_location: text("unreadableLocation")?,
            home: text("home")?,
            places: text("places")?,
            bookmarks: text("bookmarks")?,
            drives: text("drives")?,
            show_places: text("showPlaces")?,
            hide_places: text("hidePlaces")?,
            name: text("name")?,
            size: text("size")?,
            modified: text("modified")?,
            save: text("save")?,
            new_folder: text("newFolder")?,
            folder_name: text("folderName")?,
            create: text("create")?,
            invalid_name: text("invalidName")?,
            folder_exists: text("folderExists")?,
            cannot_create: text("cannotCreate")?,
            replace_title: text("replaceTitle")?,
            replace_message: text("replaceMessage")?,
            replace: text("replace")?,
        })
    }
}
