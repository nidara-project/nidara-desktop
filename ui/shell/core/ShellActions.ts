/**
 * Typed registry for shell-level actions. Mostly populated by app.ts main() at
 * startup and consumed by widgets that can't import from app.ts directly (circular
 * dep). It also works the other way for a few WIDGET-OWNED actions whose
 * implementation must live in the widget (it needs the widget's local state) but
 * which an IPC command wants to invoke — e.g. `openWindowMenu`: AppTitle registers
 * it, the `openWindowMenu` IPC command reads it. Those are deterministic
 * interaction hooks (no synthetic input): pair them with `queryUI` to verify a
 * menu/surface (open via the hook, then assert its contents).
 *
 * Usage in widgets:
 *   import shellActions from "../core/ShellActions"
 *   shellActions.openSettings?.()
 */

export interface ShellActionsMap {
  toggleAppGrid?: () => void
  /** Open/raise the Settings window (a normal window — not a toggle). */
  openSettings?: () => void
  /** Open the Settings window directly on a page id (e.g. "bluetooth"). */
  openSettingsPage?: (id: string) => string
  toggleOverview?: () => void
  toggleGameOverlay?: () => void
  lockScreen?: () => void
  unlockScreen?: () => void
  /** Widget-owned: AppTitle registers this to open the focused window's options
   *  menu deterministically (no synthetic click). Consumed by the IPC command. */
  openWindowMenu?: () => void
}

const shellActions: ShellActionsMap = {}

export default shellActions
