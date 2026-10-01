//! keyboard-shortcuts-inhibit-v1: an app that wants the keys the desktop would take — a virtual
//! machine, a remote desktop, a game that binds Super — holds them while it has the keyboard.
//!
//! Granted at once, as sway, KDE and niri do (GNOME asks first). While the focused surface holds
//! them, only the bindings marked `dont_inhibit` run (binds.rs): the way back, Super+Escape →
//! `toggle-shortcuts-inhibit` (GNOME's and niri's key for it), and the computer-control kill
//! switch, which nothing an app does may take away. The built-in keys — Ctrl+Alt+F1…F12 and
//! Ctrl+Alt+Backspace — are not bindings and always work. Pointer bindings are not shortcuts
//! and are not held.

use smithay::wayland::keyboard_shortcuts_inhibit::{
    KeyboardShortcutsInhibitHandler, KeyboardShortcutsInhibitState, KeyboardShortcutsInhibitor,
    KeyboardShortcutsInhibitorSeat,
};

use crate::state::Hyalo;

impl KeyboardShortcutsInhibitHandler for Hyalo {
    fn keyboard_shortcuts_inhibit_state(&mut self) -> &mut KeyboardShortcutsInhibitState {
        &mut self.shortcuts_inhibit_state
    }

    fn new_inhibitor(&mut self, inhibitor: KeyboardShortcutsInhibitor) {
        tracing::debug!("an app holds the keyboard shortcuts while focused");
        inhibitor.activate();
    }
}

impl Hyalo {
    /// The focused surface holds the shortcuts.
    pub fn shortcuts_inhibited(&self) -> bool {
        let Some(focus) = self.seat.get_keyboard().and_then(|k| k.current_focus()) else { return false };
        self.seat.keyboard_shortcuts_inhibitor_for_surface(&focus).is_some_and(|i| i.is_active())
    }

    /// Super+Escape: the focused app gives the shortcuts back — or takes them again, if it still
    /// asks. `Err` when it never asked.
    pub fn toggle_shortcuts_inhibit(&mut self) -> Result<(), String> {
        let focus = self.seat.get_keyboard().and_then(|k| k.current_focus()).ok_or("nothing has the keyboard")?;
        let inhibitor = self
            .seat
            .keyboard_shortcuts_inhibitor_for_surface(&focus)
            .ok_or("the focused window does not hold the shortcuts")?;
        if inhibitor.is_active() {
            inhibitor.inactivate();
            tracing::info!("shortcuts given back to the desktop");
        } else {
            inhibitor.activate();
            tracing::info!("shortcuts held by the focused app again");
        }
        Ok(())
    }
}
