/**
 * Format an elapsed duration in seconds to human-readable units.
 *
 * For installation summaries ("Nidara has been installed in 3 min 42 s"):
 * - Under a minute: "45 s"
 * - Exact minute: "3 min"
 * - Minutes and seconds: "3 min 42 s"
 *
 * Uses SI standard unit symbols ("min", "s") which are universally understood
 * across all supported locales without grammatical pluralization mismatches.
 */
export function formatDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m === 0) return `${s} s`
  if (s === 0) return `${m} min`
  return `${m} min ${s} s`
}

/**
 * Format elapsed seconds as a compact MM:SS stopwatch string.
 *
 * Used for live elapsed timer displays during installation (e.g. "00:00", "03:42").
 */
export function formatLiveTimer(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return `${mm}:${ss}`
}
