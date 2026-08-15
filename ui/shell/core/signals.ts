/**
 * `safeDisconnect` moved to `ui/lib/signals.ts` (2026-08-15) so the kit could use it:
 * `nidara-kit/slider.ts` connects to the appearance source and must clean up on
 * `unrealize`, and nothing in `ui/lib/` may import from `ui/shell/`.
 *
 * This file stays as the shell's import path on purpose rather than being deleted:
 * 40 files import `core/signals`, and rewriting all of them would have buried the
 * slider's move in unrelated churn. The implementation — and its explanation — is in
 * `ui/lib/signals.ts`.
 */
export { safeDisconnect } from "../../lib/signals"
