/**
 * Typed registry for shell-level actions. Populated by app.ts main() at startup;
 * consumed by widgets that can't import from app.ts directly (circular dep).
 *
 * Usage in widgets:
 *   import shellActions from "../core/ShellActions"
 *   shellActions.toggleSettings?.()
 */

export interface ShellActionsMap {
  toggleAppGrid?: () => void
  toggleSettings?: () => void
  /** Open the Settings window directly on a page id (e.g. "bluetooth"). */
  openSettingsPage?: (id: string) => string
  toggleOverview?: () => void
  toggleGameOverlay?: () => void
  lockScreen?: () => void
  unlockScreen?: () => void
}

const shellActions: ShellActionsMap = {}

export default shellActions
