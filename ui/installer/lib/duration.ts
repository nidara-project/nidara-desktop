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
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  // Past the hour the seconds stop meaning anything: "1 h 15 min", never "75 min 3 s".
  if (h > 0) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
  if (m === 0) return `${s} s`
  if (s === 0) return `${m} min`
  return `${m} min ${s} s`
}

/**
 * Format elapsed seconds as a compact MM:SS stopwatch string.
 *
 * Used for live elapsed timer displays during installation (e.g. "00:00", "03:42").
 * Past the hour it grows an hours field ("1:15:03") rather than counting minutes
 * on past 59 ("75:03") — a slow mirror on an old machine gets there.
 */
export function formatLiveTimer(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  const s = sec % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
