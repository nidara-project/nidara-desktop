//! What can be asked of the window manager, written the same way in a key binding and over
//! IPC (`nidara-hyalo msg do workspace 3`): one command, its arguments after it.
//!
//! A command that names no window acts on the focused one. Windows are named by the id
//! `nidara-hyalo msg windows` lists.

use super::{Fullscreen, WindowId, WorkspaceMode, layout};
use crate::state::Hyalo;

#[derive(Debug, Clone, PartialEq)]
pub enum WorkspaceTarget {
    Number(i32),
    /// `e+1` / `e-1`: the next or previous workspace that exists, round the end.
    Relative(i32),
    Previous,
    /// `name:gamespace` — a named workspace; it must exist (a rule makes it).
    Named(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Spawn(String),
    CloseWindow(Option<WindowId>),
    FocusWindow(WindowId),
    Focus(Direction),
    /// The output the user is on, and the pointer, to another output.
    FocusOutput(String),
    Cycle { forward: bool },
    Workspace(WorkspaceTarget),
    MoveToWorkspace { target: WorkspaceTarget, window: Option<WindowId>, follow: bool },
    ToggleSpecial(String),
    /// The focused app gives the keyboard shortcuts back, or takes them again (shortcuts.rs).
    ToggleShortcutsInhibit,
    MoveToSpecial { name: String, window: Option<WindowId> },
    ToggleFloating(Option<WindowId>),
    Float(Option<WindowId>),
    Tile(Option<WindowId>),
    Fullscreen(Option<WindowId>),
    Maximize(Option<WindowId>),
    Pseudo(Option<WindowId>),
    Pin(Option<WindowId>),
    Center(Option<WindowId>),
    Resize { dx: i32, dy: i32, window: Option<WindowId> },
    /// `None` = back to the configured default.
    SetWorkspaceMode { workspace: Option<i32>, mode: Option<WorkspaceMode> },
    ToggleWorkspaceMode(Option<i32>),
    FloatAll(Option<i32>),
    TileAll(Option<i32>),
    /// Mouse bindings only: carry or resize the window under the pointer while the button is
    /// held.
    MoveWithPointer,
    ResizeWithPointer,
    /// Draw the real pointer or not (`cursor-visible off` while the agent pointer acts).
    CursorVisible(bool),
    /// The cursor theme and size, for this session (Settings persists them).
    SetCursor { theme: String, size: u32 },
    /// Re-decide which surface is under the pointer without moving it: after the surface
    /// that had it went away (a closed popover), nothing holds the pointer until it moves.
    RefocusPointer,
    ReloadConfig,
    Quit,
}

fn window_arg(arg: Option<&&str>) -> Result<Option<WindowId>, String> {
    arg.map(|a| a.parse::<WindowId>().map_err(|_| format!("{a:?} is not a window id"))).transpose()
}

fn workspace_target(arg: Option<&&str>) -> Result<WorkspaceTarget, String> {
    let a = *arg.ok_or("which workspace?")?;
    Ok(match a {
        "previous" => WorkspaceTarget::Previous,
        "e+1" | "next" => WorkspaceTarget::Relative(1),
        "e-1" | "prev" => WorkspaceTarget::Relative(-1),
        n if n.starts_with("name:") && n.len() > 5 => WorkspaceTarget::Named(n[5..].into()),
        n => WorkspaceTarget::Number(match n.parse::<i32>() {
            // A negative number is a named workspace's id, as the shell lists it.
            Ok(i) if i != 0 => i,
            _ => return Err(format!("{n:?} is not a workspace (1, 2…, e+1, e-1, previous, name:NAME)")),
        }),
    })
}

/// A workspace that resolved to none: a name or an id that does not exist is said; there
/// being no `previous` yet is not an error.
fn missing_workspace(t: &WorkspaceTarget) -> Result<(), String> {
    match t {
        WorkspaceTarget::Named(n) => Err(format!("no workspace named {n:?}")),
        WorkspaceTarget::Number(n) => Err(format!("no workspace {n}")),
        _ => Ok(()),
    }
}

fn int(arg: Option<&&str>, what: &str) -> Result<i32, String> {
    let a = arg.ok_or_else(|| format!("{what} missing"))?;
    a.parse().map_err(|_| format!("{what}: {a:?} is not a number"))
}

impl std::str::FromStr for Action {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (verb, rest) = s.split_once(char::is_whitespace).unwrap_or((s, ""));
        let rest = rest.trim();
        let args: Vec<&str> = rest.split_whitespace().collect();
        let a = |i: usize| args.get(i);
        let none_after = |n: usize| if args.len() > n { Err(format!("{verb}: too many arguments")) } else { Ok(()) };
        Ok(match verb {
            "spawn" if !rest.is_empty() => Action::Spawn(rest.to_string()),
            "spawn" => return Err("spawn: what command?".into()),
            "close-window" => {
                none_after(1)?;
                Action::CloseWindow(window_arg(a(0))?)
            }
            "focus-window" => {
                none_after(1)?;
                Action::FocusWindow(window_arg(a(0))?.ok_or("focus-window: which window?")?)
            }
            "focus" => {
                none_after(1)?;
                Action::Focus(match a(0).copied() {
                    Some("left") => Direction::Left,
                    Some("right") => Direction::Right,
                    Some("up") => Direction::Up,
                    Some("down") => Direction::Down,
                    _ => return Err("focus: left, right, up or down".into()),
                })
            }
            "focus-output" => {
                none_after(1)?;
                Action::FocusOutput(a(0).ok_or("focus-output: which output?")?.to_string())
            }
            "cycle" => {
                none_after(1)?;
                Action::Cycle {
                    forward: match a(0).copied() {
                        None | Some("next") => true,
                        Some("prev") => false,
                        Some(x) => return Err(format!("cycle: next or prev, not {x:?}")),
                    },
                }
            }
            "workspace" => {
                none_after(1)?;
                Action::Workspace(workspace_target(a(0))?)
            }
            "move-to-workspace" | "move-to-workspace-silent" => {
                none_after(2)?;
                Action::MoveToWorkspace {
                    target: workspace_target(a(0))?,
                    window: window_arg(a(1))?,
                    follow: verb == "move-to-workspace",
                }
            }
            "toggle-shortcuts-inhibit" => {
                none_after(0)?;
                Action::ToggleShortcutsInhibit
            }
            "toggle-special" => {
                none_after(1)?;
                Action::ToggleSpecial(a(0).copied().unwrap_or("magic").to_string())
            }
            "move-to-special" => {
                none_after(2)?;
                Action::MoveToSpecial { name: a(0).copied().unwrap_or("magic").to_string(), window: window_arg(a(1))? }
            }
            "toggle-floating" | "float" | "tile" | "fullscreen" | "maximize" | "pseudo" | "pin" | "center" => {
                none_after(1)?;
                let w = window_arg(a(0))?;
                match verb {
                    "toggle-floating" => Action::ToggleFloating(w),
                    "float" => Action::Float(w),
                    "tile" => Action::Tile(w),
                    "fullscreen" => Action::Fullscreen(w),
                    "maximize" => Action::Maximize(w),
                    "pseudo" => Action::Pseudo(w),
                    "pin" => Action::Pin(w),
                    _ => Action::Center(w),
                }
            }
            "resize" => {
                none_after(3)?;
                Action::Resize { dx: int(a(0), "resize: dx")?, dy: int(a(1), "resize: dy")?, window: window_arg(a(2))? }
            }
            "set-workspace-mode" => {
                none_after(2)?;
                let workspace = Some(int(a(0), "set-workspace-mode: workspace")?);
                let mode = match a(1).copied() {
                    Some("default") => None,
                    Some(m) => Some(WorkspaceMode::parse(m).ok_or_else(|| format!("{m:?}: floating, tiling or default"))?),
                    None => return Err("set-workspace-mode: floating, tiling or default".into()),
                };
                Action::SetWorkspaceMode { workspace, mode }
            }
            "toggle-workspace-mode" | "float-all" | "tile-all" => {
                none_after(1)?;
                let ws = a(0).map(|_| int(a(0), verb)).transpose()?;
                match verb {
                    "toggle-workspace-mode" => Action::ToggleWorkspaceMode(ws),
                    "float-all" => Action::FloatAll(ws),
                    _ => Action::TileAll(ws),
                }
            }
            "cursor-visible" => {
                none_after(1)?;
                Action::CursorVisible(match a(0).copied() {
                    Some("on") => true,
                    Some("off") => false,
                    _ => return Err("cursor-visible: on or off".into()),
                })
            }
            "set-cursor" => {
                none_after(2)?;
                let theme = a(0).ok_or("set-cursor: theme and size")?.to_string();
                let size = int(a(1), "set-cursor: size")?;
                if !(8..=256).contains(&size) {
                    return Err(format!("set-cursor: size {size} is outside 8..256"));
                }
                Action::SetCursor { theme, size: size as u32 }
            }
            "refocus-pointer" => Action::RefocusPointer,
            "move-with-pointer" => Action::MoveWithPointer,
            "resize-with-pointer" => Action::ResizeWithPointer,
            "reload-config" => Action::ReloadConfig,
            "quit" => Action::Quit,
            "" => return Err("no command".into()),
            other => return Err(format!("unknown command {other:?}")),
        })
    }
}

impl Hyalo {
    /// The window a command acts on: the one named, else the focused one.
    fn target(&self, w: Option<WindowId>) -> Result<WindowId, String> {
        match w {
            Some(id) if self.wm.get(id).is_some_and(|m| m.mapped) => Ok(id),
            Some(id) => Err(format!("no window {id}")),
            None => self.wm.focused.ok_or_else(|| "no window has the focus".into()),
        }
    }

    fn workspace_of_focus(&mut self) -> i32 {
        let output = self.focused_output().map(|o| o.name()).unwrap_or_default();
        self.active_workspace(&output)
    }

    fn resolve_workspace(&mut self, t: &WorkspaceTarget) -> Option<i32> {
        let current = self.workspace_of_focus();
        match t {
            // A numbered one is made when asked for; a named one only by its rule.
            WorkspaceTarget::Number(n) if *n > 0 => Some(*n),
            WorkspaceTarget::Number(n) => self.wm.workspaces.get(n).filter(|w| !w.is_special()).map(|w| w.id),
            WorkspaceTarget::Named(name) => self.wm.named_id(name),
            WorkspaceTarget::Relative(step) => Some(self.relative_workspace(current, *step)),
            WorkspaceTarget::Previous => self.wm.previous_workspace.filter(|p| *p != current),
        }
    }

    /// Carries out a command. `Err` says why it could not be.
    pub fn run_action(&mut self, action: Action) -> Result<(), String> {
        match action {
            Action::Spawn(cmd) => crate::spawn(&cmd),
            Action::CloseWindow(w) => {
                let id = self.target(w)?;
                if let Some(t) = self.wm.get(id).and_then(|m| m.window.toplevel()) {
                    t.send_close();
                }
            }
            Action::FocusWindow(id) => {
                self.target(Some(id))?;
                self.focus_window(Some(id));
            }
            Action::Focus(dir) => self.focus_direction(dir),
            Action::FocusOutput(name) => {
                let output = self.output_named(&name).ok_or_else(|| format!("no output {name}"))?;
                let geo = self.space.output_geometry(&output).ok_or("output not placed")?;
                let centre = geo.loc.to_f64() + geo.size.to_f64().downscale(2.0).to_point();
                self.pointer_moved_to(centre, smithay::backend::input::InputTime::now());
                self.wm.focused_output = Some(name);
                let ws = self.workspace_of_focus();
                let next = self.wm.last_focused_on(ws);
                self.focus_window(next);
            }
            Action::Cycle { forward } => self.cycle(forward),
            Action::Workspace(t) => match self.resolve_workspace(&t) {
                Some(ws) => self.show_workspace(ws, false),
                None => missing_workspace(&t)?,
            },
            Action::MoveToWorkspace { target, window, follow } => {
                let id = self.target(window)?;
                match self.resolve_workspace(&target) {
                    Some(ws) => self.move_to_workspace(id, ws, follow),
                    None => missing_workspace(&target)?,
                }
            }
            Action::ToggleSpecial(name) => self.toggle_special(&name),
            Action::ToggleShortcutsInhibit => self.toggle_shortcuts_inhibit()?,
            Action::MoveToSpecial { name, window } => {
                let id = self.target(window)?;
                let output = self.focused_output().map(|o| o.name()).unwrap_or_default();
                let ws = self.ensure_special(&name, &output);
                self.move_to_workspace(id, ws, false);
            }
            Action::ToggleFloating(w) => {
                let id = self.target(w)?;
                let floating = self.wm.get(id).unwrap().floating;
                self.set_floating(id, !floating);
            }
            Action::Float(w) => {
                let id = self.target(w)?;
                self.set_floating(id, true);
            }
            Action::Tile(w) => {
                let id = self.target(w)?;
                self.set_floating(id, false);
            }
            Action::Fullscreen(w) | Action::Maximize(w) => {
                let id = self.target(w)?;
                let want = if matches!(action, Action::Fullscreen(_)) { Fullscreen::Fullscreen } else { Fullscreen::Maximized };
                let now = self.wm.get(id).unwrap().fullscreen;
                self.set_fullscreen(id, if now == want { Fullscreen::None } else { want });
            }
            Action::Pseudo(w) => {
                let id = self.target(w)?;
                let m = self.wm.get_mut(id).unwrap();
                m.pseudo = !m.pseudo;
                let ws = m.workspace;
                self.wm.dirty_windows = true;
                self.arrange_workspace(ws);
                self.sync_space();
            }
            Action::Pin(w) => {
                let id = self.target(w)?;
                let m = self.wm.get(id).unwrap();
                if !m.floating {
                    return Err("only a floating window can be pinned".into());
                }
                let m = self.wm.get_mut(id).unwrap();
                m.pinned = !m.pinned;
                self.wm.dirty_windows = true;
            }
            Action::Center(w) => {
                let id = self.target(w)?;
                self.center(id)?;
            }
            Action::Resize { dx, dy, window } => {
                let id = self.target(window)?;
                self.resize_by(id, dx, dy);
            }
            Action::SetWorkspaceMode { workspace, mode } => {
                let ws = match workspace {
                    Some(w) => w,
                    None => self.workspace_of_focus(),
                };
                self.set_workspace_mode(ws, mode);
            }
            Action::ToggleWorkspaceMode(ws) => {
                let ws = match ws {
                    Some(w) => w,
                    None => self.workspace_of_focus(),
                };
                let next = match self.workspace_mode(ws) {
                    WorkspaceMode::Floating => WorkspaceMode::Tiling,
                    WorkspaceMode::Tiling => WorkspaceMode::Floating,
                };
                self.set_workspace_mode(ws, Some(next));
            }
            Action::FloatAll(ws) | Action::TileAll(ws) => {
                let ws = match ws {
                    Some(w) => w,
                    None => self.workspace_of_focus(),
                };
                self.set_all_floating(ws, matches!(action, Action::FloatAll(_)));
            }
            Action::MoveWithPointer | Action::ResizeWithPointer => {
                return Err("a pointer binding only (Super+drag)".into());
            }
            Action::CursorVisible(on) => {
                self.wm.cursor_hidden = !on;
                self.queue_redraw(None);
            }
            // Persisted through the settings layer, like every other choice the shell makes: set
            // only in memory, the next reload (any Settings change: a keyboard layout) put the
            // file's cursor back (measured, 2026-10-02). The reload applies it.
            Action::SetCursor { theme, size } => {
                let patch = serde_json::json!({ "cursor": { "theme": theme, "size": size } });
                crate::config::apply_settings(self, patch)?;
                self.queue_redraw(None);
            }
            Action::RefocusPointer => {
                let pos = self.seat.get_pointer().unwrap().current_location();
                self.pointer_moved_to(pos, smithay::backend::input::InputTime::now());
            }
            Action::ReloadConfig => crate::config::reload(self)?,
            Action::Quit => self.loop_signal.stop(),
        }
        Ok(())
    }

    pub(super) fn center(&mut self, id: WindowId) -> Result<(), String> {
        let m = self.wm.get(id).ok_or("no such window")?;
        if !m.floating {
            return Err("only a floating window can be centred".into());
        }
        let (ws, insets) = (m.workspace, m.floating_insets());
        // Centred by its whole box, title bar included.
        let size = super::with_insets(m.rect, insets).size;
        let output = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)).ok_or("no output")?;
        let og = self.space.output_geometry(&output).unwrap_or_default();
        let r = super::without_insets(super::centered(size, self.floating_area(&output)), insets);
        self.wm.get_mut(id).unwrap().float_rect = Some(smithay::utils::Rectangle::new(r.loc - og.loc, r.size));
        self.wm.dirty_windows = true;
        self.arrange_workspace(ws);
        self.sync_space();
        Ok(())
    }

    /// Grows (or shrinks) a window: a floating one by its own size, a tiled one by moving
    /// the layout's split lines.
    fn resize_by(&mut self, id: WindowId, dx: i32, dy: i32) {
        let Some(m) = self.wm.get(id) else { return };
        let ws = m.workspace;
        let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { return };
        if m.floating {
            let area = self.floating_area(&output);
            let og = self.space.output_geometry(&output).unwrap_or_default();
            let r = m.rect;
            let size = smithay::utils::Size::from(((r.size.w + dx).max(1), (r.size.h + dy).max(1)));
            let r = super::clamp_floating_with_insets(smithay::utils::Rectangle::new(r.loc, size), area, m.floating_insets());
            self.wm.get_mut(id).unwrap().float_rect = Some(smithay::utils::Rectangle::new(r.loc - og.loc, r.size));
        } else {
            let area = super::inset(self.work_area(&output), self.config.layout.gaps_out);
            if let Some(w) = self.wm.workspaces.get_mut(&ws) {
                layout::grow(w.layout.as_mut(), id, dx, dy, area);
            }
        }
        self.wm.dirty_windows = true;
        self.arrange_workspace(ws);
        self.sync_space();
    }

    /// The nearest window in a direction, among those shown on every output: from the
    /// focused window's centre (or the pointer), the closest centre in that half-plane.
    fn focus_direction(&mut self, dir: Direction) {
        let from = self
            .wm
            .focused
            .and_then(|f| self.wm.get(f))
            .map(|m| m.rect.to_f64())
            .map(|r| (r.loc.x + r.size.w / 2.0, r.loc.y + r.size.h / 2.0))
            .unwrap_or_else(|| {
                let p = self.seat.get_pointer().unwrap().current_location();
                (p.x, p.y)
            });
        let best = self
            .space
            .elements()
            .filter_map(|w| self.wm.by_window(w))
            .filter(|m| Some(m.id) != self.wm.focused)
            .filter_map(|m| {
                let r = m.rect.to_f64();
                let (cx, cy) = (r.loc.x + r.size.w / 2.0, r.loc.y + r.size.h / 2.0);
                let (dx, dy) = (cx - from.0, cy - from.1);
                let ahead = match dir {
                    Direction::Left => dx < -1.0 && dx.abs() >= dy.abs() / 2.0,
                    Direction::Right => dx > 1.0 && dx.abs() >= dy.abs() / 2.0,
                    Direction::Up => dy < -1.0 && dy.abs() >= dx.abs() / 2.0,
                    Direction::Down => dy > 1.0 && dy.abs() >= dx.abs() / 2.0,
                };
                ahead.then_some((m.id, dx * dx + dy * dy))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(id, _)| id);
        if let Some(id) = best {
            self.focus_window(Some(id));
        }
    }

    /// Alt+Tab: the next window of the focused workspace, in the order they were opened.
    fn cycle(&mut self, forward: bool) {
        let ws = match self.wm.focused.and_then(|f| self.wm.get(f)) {
            Some(m) => m.workspace,
            None => self.workspace_of_focus(),
        };
        let mut ids: Vec<WindowId> = self.wm.on_workspace(ws).map(|m| m.id).collect();
        ids.sort_unstable();
        if ids.is_empty() {
            return;
        }
        let pos = self.wm.focused.and_then(|f| ids.iter().position(|i| *i == f));
        let next = match pos {
            None => ids[0],
            Some(p) if forward => ids[(p + 1) % ids.len()],
            Some(p) => ids[(p + ids.len() - 1) % ids.len()],
        };
        self.focus_window(Some(next));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Result<Action, String> {
        s.parse()
    }

    #[test]
    fn commands_read_the_way_they_are_written() {
        assert_eq!(p("workspace 3"), Ok(Action::Workspace(WorkspaceTarget::Number(3))));
        assert_eq!(p("workspace e-1"), Ok(Action::Workspace(WorkspaceTarget::Relative(-1))));
        assert_eq!(p("workspace name:gamespace"), Ok(Action::Workspace(WorkspaceTarget::Named("gamespace".into()))));
        assert_eq!(p("workspace -1337"), Ok(Action::Workspace(WorkspaceTarget::Number(-1337))));
        assert_eq!(
            p("move-to-workspace-silent 2 17"),
            Ok(Action::MoveToWorkspace { target: WorkspaceTarget::Number(2), window: Some(17), follow: false })
        );
        assert_eq!(p("spawn uwsm app -t service -- kitty"), Ok(Action::Spawn("uwsm app -t service -- kitty".into())));
        assert_eq!(p("resize -30 0"), Ok(Action::Resize { dx: -30, dy: 0, window: None }));
        assert_eq!(p("toggle-special"), Ok(Action::ToggleSpecial("magic".into())));
        assert_eq!(p("set-workspace-mode 4 tiling"), Ok(Action::SetWorkspaceMode { workspace: Some(4), mode: Some(WorkspaceMode::Tiling) }));
        assert_eq!(p("set-workspace-mode 4 default"), Ok(Action::SetWorkspaceMode { workspace: Some(4), mode: None }));
        assert_eq!(p("cycle prev"), Ok(Action::Cycle { forward: false }));
        assert_eq!(p("focus-output DP-2"), Ok(Action::FocusOutput("DP-2".into())));
        assert_eq!(p("cursor-visible off"), Ok(Action::CursorVisible(false)));
        assert_eq!(p("set-cursor Adwaita 32"), Ok(Action::SetCursor { theme: "Adwaita".into(), size: 32 }));
    }

    #[test]
    fn mistakes_are_refused_with_a_reason() {
        for bad in ["", "frobnicate", "workspace 0", "workspace name:", "workspace", "focus sideways", "close-window abc", "spawn", "resize 10", "fullscreen 1 2", "set-workspace-mode 3 stacked", "cursor-visible maybe", "set-cursor X 2"] {
            assert!(p(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
