// SPDX-License-Identifier: LGPL-3.0-or-later
//! The same assembly View with real exports/retained Tree. No Window, Bridge or GUI is faked.
use super::*;
use nk_settings::session::{ApplyError, Raw, Session};
use nk_text::Size;
use std::time::{Duration, Instant};

fn appearance() -> Appearance {
    Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "opaque".into(),
        reduced_motion: false,
        font: "Inter Variable 11".into(),
        text_scale: 1.,
    }
}
fn schema() -> String {
    include_str!("../../tests/fixtures/appearance-snapshot.json").into()
}
fn view() -> View {
    let mut view = View::new(
        Exports::load(&Exports::root()).expect("actual exports required"),
        appearance(),
    )
    .unwrap();
    let reference =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    view.shell
        .tree
        .set_icon_theme(icons("", &reference).unwrap());
    view
}
fn layout(view: &mut View) {
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let size = open_size(&view.exports).unwrap();
    view.shell
        .layout_controls(
            Size {
                width: size.0 as f32,
                height: size.1 as f32,
            },
            ControlsSide::Right,
            false,
            &mut text,
        )
        .unwrap();
}
struct Editing {
    session: Session,
    writes: Vec<(String, Value)>,
}
impl Editing {
    fn new(schema: String) -> Self {
        let (mut session, _) = Session::start();
        session.handle(Raw::Snapshot(Ok((7, 1, schema))));
        Self {
            session,
            writes: Vec::new(),
        }
    }
}
impl Editor for Editing {
    fn session(&self) -> &Session {
        &self.session
    }
    fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError> {
        self.session.apply(key, value.clone())?;
        self.writes.push((key.into(), value));
        Ok(())
    }
}
fn named(view: &View, name: &str, kind: Kind) -> NodeId {
    view.shell
        .tree
        .semantics()
        .nodes
        .values()
        .find(|n| {
            view.shell.tree.node(n.id).unwrap().name() == name
                && view.shell.tree.node(n.id).unwrap().kind() == kind
        })
        .unwrap_or_else(|| panic!("missing {name}"))
        .id
}
fn activate(view: &mut View, editor: &mut dyn Editor, id: NodeId) {
    let effect = view
        .shell
        .tree
        .dispatch(view.shell.tree.target(id), Command::Activate)
        .unwrap();
    view.page
        .as_mut()
        .unwrap()
        .renderer()
        .effect(
            Host {
                tree: &mut view.shell.tree,
                editor,
                exports: &view.exports,
                styles: &view.styles,
                window: None,
                modal: None,
            },
            effect,
        )
        .unwrap();
}
#[test]
fn loading_full_page_and_snapshot_reconciliation_are_the_actual_assembly() {
    let mut view = view();
    assert!(view.page.is_none());
    assert!(!view.shell.tree.is_hidden(view.status));
    let mut editor = Editing::new(schema());
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    assert!(view.page.is_some());
    assert!(view.shell.tree.is_hidden(view.status));
    assert_eq!(editor.writes.len(), 0);
    let picker = named(
        &view,
        view.exports.text("settings.appearance.browse").unwrap(),
        Kind::Button,
    );
    let first_generation = view.shell.tree.generation();
    assert!(view.shell.tree.node(picker).is_some());
    // Fresh real-session Snapshot boundary replaces roots and retires old operations/IDs.
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    assert!(view.shell.tree.node(picker).is_none());
    assert!(view.shell.tree.generation() > first_generation);
    assert_eq!(view.mount, 2);
    assert_eq!(editor.writes.len(), 0);
}
#[test]
fn external_picker_masks_parent_and_unavailable_cancels_without_writes() {
    let mut view = view();
    let mut editor = Editing::new(schema());
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    let picker = named(
        &view,
        view.exports.text("settings.appearance.browse").unwrap(),
        Kind::Button,
    );
    activate(&mut view, &mut editor, picker);
    assert!(
        view.external_modal(),
        "real picker did not enter pending state"
    );
    let snapshot = project(&view.shell.tree, true);
    assert!(
        snapshot
            .nodes
            .values()
            .all(|n| n.actions.is_empty() && !n.states.focused && !n.states.active),
        "external modal left parent actions/focus published"
    );
    let generation = view.shell.tree.generation();
    assert!(
        request(
            &mut view.shell.tree,
            Some((19, generation, false)),
            19,
            Request::Activate(picker),
            true
        )
        .is_err()
    );
    let (notices, _) = editor.session.handle(Raw::Owner(false));
    view.notices(&mut editor, &notices).unwrap();
    assert!(!view.external_modal());
    assert_eq!(editor.writes.len(), 0);
}
#[test]
fn action_requires_current_publication_and_generation_after_successful_focus() {
    let mut view = view();
    let mut editor = Editing::new(schema());
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    let picker = named(
        &view,
        view.exports.text("settings.appearance.browse").unwrap(),
        Kind::Button,
    );
    let publication = Some((19, view.shell.tree.generation(), false));
    request(
        &mut view.shell.tree,
        publication,
        19,
        Request::Focus(picker),
        false,
    )
    .unwrap();
    assert_eq!(view.shell.tree.focused(), Some(picker));
    assert!(
        request(
            &mut view.shell.tree,
            publication,
            18,
            Request::Activate(picker),
            false
        )
        .is_err(),
        "old publication accepted"
    );
    view.shell
        .tree
        .group(view.shell.content, "new generation")
        .unwrap();
    assert!(
        request(
            &mut view.shell.tree,
            publication,
            19,
            Request::Activate(picker),
            false
        )
        .is_err(),
        "old tree generation accepted"
    );
}
#[test]
fn portal_restyle_keeps_focus_ids_and_edits_at_zero() {
    let mut view = view();
    let mut editor = Editing::new(schema());
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    let picker = named(
        &view,
        view.exports.text("settings.appearance.browse").unwrap(),
        Kind::Button,
    );
    view.shell.tree.focus(picker).unwrap();
    let mut a = appearance();
    a.text_scale = 1.5;
    a.dark = false;
    a.reduce_transparency = true;
    view.restyle(a).unwrap();
    layout(&mut view);
    assert_eq!(view.shell.tree.focused(), Some(picker));
    assert_eq!(view.styles.text_scale, 1.5);
    assert_eq!(editor.writes.len(), 0);
}
#[test]
fn fresh_snapshot_adds_previously_unavailable_generic_row() {
    let mut data: serde_json::Value = serde_json::from_str(&schema()).unwrap();
    data["keys"]["appearance.darkMode"]["available"] = false.into();
    let mut editor = Editing::new(data.to_string());
    let mut view = view();
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    let title = data["keys"]["appearance.darkMode"]["ui"]["title"]
        .as_str()
        .unwrap();
    assert!(
        !view
            .shell
            .tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name == title)
    );
    editor.session.handle(Raw::Snapshot(Ok((7, 2, schema()))));
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    assert!(
        view.shell
            .tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name == title),
        "fresh snapshot left generic row absent"
    );
}

// Explicit private bus, full actual exported Appearance schema and the production Client.
// Service and portal Appearance values are fixtures; there is no native Window/dialog/provider.
struct Bus {
    daemon: std::process::Child,
    directory: PathBuf,
    address: String,
}
impl Bus {
    fn new() -> Self {
        use std::io::{BufRead, BufReader};
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target")
            .join(format!("ap-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let config = directory.join("bus.conf");
        std::fs::write(&config, format!("<busconfig><type>session</type><listen>unix:path={}/bus</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\"/><allow receive_sender=\"*\"/><allow own=\"*\"/></policy></busconfig>", directory.display())).unwrap();
        let mut daemon = std::process::Command::new("dbus-daemon")
            .arg("--nofork")
            .arg("--print-address")
            .arg(format!("--config-file={}", config.display()))
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            daemon,
            directory,
            address: address.trim().into(),
        }
    }
    fn connect(&self) -> zbus::blocking::Connection {
        zbus::blocking::connection::Builder::address(self.address.as_str())
            .unwrap()
            .method_timeout(Duration::from_secs(3))
            .build()
            .unwrap()
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
struct Config {
    count: Arc<std::sync::atomic::AtomicUsize>,
}
#[zbus::interface(name = "org.nidara.Config1")]
impl Config {
    fn snapshot(&self) -> (u64, u64, String) {
        (7, 1, schema())
    }
    async fn apply(
        &self,
        key: String,
        value: zbus::zvariant::OwnedValue,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<(u64, zbus::zvariant::OwnedValue)> {
        assert_eq!(key, "appearance.darkMode");
        let owner = zbus::fdo::DBusProxy::new(connection)
            .await
            .unwrap()
            .get_name_owner(routing::NATIVE.try_into().unwrap())
            .await
            .unwrap();
        assert_eq!(
            header.sender().unwrap().as_str(),
            owner.as_str(),
            "Apply must use the Router-owned Client connection"
        );
        self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok((2, value))
    }
}
#[test]
fn assembled_row_uses_real_client_and_router_owned_connection() {
    let bus = Bus::new();
    let server = bus.connect();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    server
        .object_server()
        .at(
            "/org/nidara/Config",
            Config {
                count: count.clone(),
            },
        )
        .unwrap();
    server.request_name("org.nidara.Config").unwrap();
    let connection = bus.connect();
    let _router = Router::start(
        &connection,
        Mode::Native,
        Arc::new(|| Err("forbidden launcher".into())),
        &[],
    )
    .unwrap()
    .unwrap();
    let mut client = Client::start(connection).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut notices = Vec::new();
    while !client.session().available() && Instant::now() < deadline {
        notices.extend(client.wait(deadline));
    }
    assert!(
        client.session().available(),
        "private Config1 Snapshot missing"
    );
    let mut view = view();
    view.notices(&mut client, &notices).unwrap();
    layout(&mut view);
    assert!(view.page.is_some());
    let toggle = view
        .shell
        .tree
        .semantics()
        .nodes
        .values()
        .find(|n| n.role == nk_a11y::Role::ToggleButton && n.name == "Dark mode")
        .unwrap()
        .id;
    activate(&mut view, &mut client, toggle);
    let deadline = Instant::now() + Duration::from_secs(3);
    while client.session().pending("appearance.darkMode") && Instant::now() < deadline {
        let notices = client.wait(deadline);
        view.notices(&mut client, &notices).unwrap();
    }
    assert!(!client.session().pending("appearance.darkMode"));
    assert_eq!(
        count.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "assembled activation must make one real Apply"
    );
    assert_eq!(
        client.session().shown("appearance.darkMode"),
        Some(&Value::Bool(false))
    );
    assert!(client.connection().unique_name().is_some());
}

#[test]
fn staged_external_change_retires_real_picker_before_idle_acceptance() {
    let mut view = view();
    let mut editor = Editing::new(schema());
    view.notices(&mut editor, &[Notice::Ready]).unwrap();
    layout(&mut view);
    let picker = named(
        &view,
        view.exports.text("settings.appearance.browse").unwrap(),
        Kind::Button,
    );
    activate(&mut view, &mut editor, picker);
    assert!(view.external_modal());
    view.invalidate_external(&mut editor).unwrap();
    assert!(
        !view.external_modal(),
        "staged external change left old picker pending"
    );
    assert!(view.shell.tree.node(picker).is_none());
    assert_ne!(view.shell.tree.focused(), Some(picker));
    assert!(editor.writes.is_empty());
}

#[test]
fn suggestions_leave_content_in_place_until_view_all_and_never_apply() {
    let mut view = view();
    let mut editor = Editing::new(schema());
    view.mount(&mut editor).unwrap();
    layout(&mut view);
    let original = view
        .shell
        .tree
        .node(view.shell.content)
        .unwrap()
        .children()
        .to_vec();
    view.shell.tree.focus(view.shell.search).unwrap();
    view.shell
        .tree
        .set_search_text(view.shell.search, "color")
        .unwrap();
    let mut text = ParleyBackend::new(view.fonts.clone()).unwrap();
    view.update_search(editor.session.store(), &mut text)
        .unwrap();
    assert!(view.suggestions.is_open());
    assert!(!view.search_matches.is_empty());
    assert!(view.page.is_some());
    assert!(view.results.is_none());
    assert_eq!(
        view.shell.tree.node(view.shell.content).unwrap().children(),
        original
    );
    assert_eq!(
        view.shell.tree.node(view.shell.titlebar).unwrap().name(),
        "Appearance"
    );
    view.show_results(&mut editor, false).unwrap();
    assert!(view.page.is_none());
    let results = view.results.as_ref().unwrap().root;
    layout(&mut view);
    assert_eq!(
        view.shell.tree.node(view.shell.titlebar).unwrap().name(),
        "Search results"
    );
    assert!(
        view.shell
            .tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name == "Accent color")
    );
    view.shell
        .tree
        .set_search_text(view.shell.search, "no-such-setting-982375")
        .unwrap();
    view.update_search(editor.session.store(), &mut text)
        .unwrap();
    assert_eq!(
        view.results.as_ref().unwrap().root,
        results,
        "typing replaced the content page"
    );
    assert!(view.search_matches.is_empty());
    view.show_results(&mut editor, false).unwrap();
    layout(&mut view);
    assert!(
        view.shell
            .tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name == "No results")
    );
    view.mount(&mut editor).unwrap();
    layout(&mut view);
    assert!(view.results.is_none());
    assert!(view.page.is_some());
    assert_eq!(
        view.shell.tree.node(view.shell.titlebar).unwrap().name(),
        "Appearance"
    );
    assert!(editor.writes.is_empty());
}

#[test]
fn search_indexes_pages_available_rows_and_bounds_only_the_suggestions() {
    let view = view();
    let editor = Editing::new(schema());
    for page in view.exports.pages.iter().filter(|p| p.parent.is_none()) {
        let label = view.exports.text(&page.label).unwrap();
        let found = search::find(&view.exports, editor.session.store(), label).unwrap();
        assert!(
            found.iter().any(|m| m.page == page.id && m.is_page),
            "page missing from search: {}",
            page.id
        );
    }
    let found = search::find(&view.exports, editor.session.store(), "appearance").unwrap();
    assert!(found.len() > 8);
    assert!(found[0].is_page);
    let choices = search::suggestions(&found, &view.exports).unwrap();
    assert_eq!(choices.len(), 9);
    assert_eq!(choices.last().unwrap().key, search::ALL);
    assert_eq!(
        choices.last().unwrap().label,
        format!("View all ({})", found.len())
    );
    assert!(choices[0].description.is_empty());
    assert!(choices[1..8].iter().all(|m| !m.description.is_empty()));
    let mut snapshot: serde_json::Value = serde_json::from_str(&schema()).unwrap();
    snapshot["keys"]["appearance.darkMode"]["available"] = false.into();
    let store = nk_settings::session::Store::parse(7, 1, &snapshot.to_string()).unwrap();
    assert!(
        !search::find(&view.exports, Some(&store), "dark mode")
            .unwrap()
            .iter()
            .any(|m| m.label == "Dark mode")
    );
    let semantics = view.shell.tree.semantics();
    assert_eq!(
        semantics.nodes[&view.shell.search].role,
        nk_a11y::Role::ComboBox
    );
    assert!(semantics.nodes[&view.shell.search].states.expandable);
    assert!(!semantics.nodes[&view.shell.search].states.expanded);
    semantics.validate().unwrap();
}

#[test]
fn dismissed_suggestions_leave_the_parent_clean_in_repeated_idle_samples() {
    let mut view = view();
    let mut text = ParleyBackend::new(view.fonts.clone()).unwrap();
    layout(&mut view);
    view.shell.tree.focus(view.shell.search).unwrap();
    view.shell
        .tree
        .set_search_text(view.shell.search, "appearance")
        .unwrap();
    view.update_search(None, &mut text).unwrap();
    view.suggestions.dismiss(&mut view.shell.tree).unwrap();
    layout(&mut view);
    view.shell.tree.acknowledge();
    for _ in 0..10 {
        view.suggestions.dismiss(&mut view.shell.tree).unwrap();
    }
    assert_eq!(
        view.shell.tree.invalidation(),
        nk_widgets::Invalid::default()
    );
    assert_eq!(
        view.shell.tree.search_text(view.shell.search).unwrap(),
        "appearance"
    );
}

#[test]
fn suggestions_use_the_existing_menu_keyboard_highlight_without_editing_the_query() {
    let mut view = view();
    layout(&mut view);
    view.shell.tree.focus(view.shell.search).unwrap();
    view.shell
        .tree
        .set_search_text(view.shell.search, "appearance")
        .unwrap();
    let mut text = ParleyBackend::new(view.fonts.clone()).unwrap();
    view.update_search(None, &mut text).unwrap();
    let paint = |menu: &Tree| {
        let size = menu.node(menu.root()).unwrap().bounds();
        let width = size.width.ceil() as u32;
        let height = size.height.ceil() as u32;
        menu.paint(
            Frame {
                width,
                height,
                pixel_width: width as u16,
                pixel_height: height as u16,
                scale: 1.,
                material: false,
            },
            nk_widgets::Surface::Content,
            view.styles.palette,
        )
        .unwrap()
    };
    let before = paint(view.suggestions.view().unwrap());
    view.suggestions
        .move_selection(&mut view.shell.tree, true)
        .unwrap();
    let menu = view.suggestions.view().unwrap();
    assert!(menu.focus_visible());
    assert!(menu.focused().is_some());
    assert_ne!(
        before,
        paint(menu),
        "keyboard selection has no visible highlight"
    );
    assert_eq!(
        view.shell.tree.search_text(view.shell.search).unwrap(),
        "appearance"
    );
}
