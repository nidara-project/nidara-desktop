// Where to ask for a timezone suggestion based on public IP (#491).
//
// ─── WHY THIS SERVICE ────────────────────────────────────────────────────────
// The maintainer evaluated endpoints (issue #491) and selected KDE's GeoIP
// service (sysadmin/geoip-service-backend, CC0, based on MaxMind GeoLite2 data).
// It returns `{"time_zone":"<tz>"}` and nothing else — no IP, no country, no
// coordinates, ISP, or tracking data.
//
// Three hard requirements:
// 1. Configurable: URL is a top-level configuration line, overrideable via NIDARA_GEOIP_URL.
// 2. Identified: The request carries User-Agent `Nidara/<version>`.
// 3. Fails silently: offline or slow response never throws, blocks, or shows errors.

import GLib from "gi://GLib"
import { execAsync } from "../../lib/process"
import { countryForTimezone } from "./region"

/**
 * The GeoIP endpoint queried for a timezone suggestion.
 *
 * Configurable here like Calamares's `locale.conf: url` rather than buried
 * deep inside a request function, so pointing at an alternative service or
 * our own self-hosted deployment requires changing only this value.
 */
export const GEOIP_URL = "https://geoip.kde.org/v1/calamares"

export interface GeoIpSuggestion {
  timezone: string
  countryCode: string
}

function readVersion(): string {
  for (const path of ["/usr/share/nidara/VERSION", "./VERSION"]) {
    try {
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        const [ok, data] = GLib.file_get_contents(path)
        if (ok) return new TextDecoder().decode(data as Uint8Array).trim()
      }
    } catch {}
  }
  return "0.12.1"
}

/**
 * Perform a single HTTPS GET to fetch a timezone suggestion.
 *
 * Never rejects: errors, timeouts, or unexpected payloads resolve to null.
 */
export async function fetchGeoIpSuggestion(
  urlOverride?: string,
  preferredCountry?: string | null,
): Promise<GeoIpSuggestion | null> {
  const envUrl = GLib.getenv("NIDARA_GEOIP_URL")
  const url = urlOverride || (envUrl && envUrl.trim() ? envUrl.trim() : GEOIP_URL)
  const userAgent = `Nidara/${readVersion()}`

  try {
    const out = await execAsync([
      "curl", "-fsSL",
      "--connect-timeout", "3",
      "--max-time", "5",
      "-A", userAgent,
      url,
    ])
    const data = JSON.parse(out)
    const tz = typeof data?.time_zone === "string" ? data.time_zone.trim() : null
    if (!tz) return null

    const countryCode = countryForTimezone(tz, preferredCountry)
    if (!countryCode) return null

    return { timezone: tz, countryCode }
  } catch {
    return null
  }
}

let _cachedSuggestion: GeoIpSuggestion | null = null
let _fetchPromise: Promise<GeoIpSuggestion | null> | null = null

/**
 * Kick off the background lookup early in the installer lifecycle.
 */
export function initGeoIpLookup(): void {
  if (!_fetchPromise) {
    _fetchPromise = fetchGeoIpSuggestion().then(res => {
      _cachedSuggestion = res
      return res
    }).catch(() => null)
  }
}

/**
 * Returns the resolved suggestion, or null if pending, offline, or failed.
 */
export function getGeoIpSuggestion(): GeoIpSuggestion | null {
  return _cachedSuggestion
}

/**
 * Await the lookup if already started or start it. Used in probes and test runners.
 */
export async function awaitGeoIpSuggestion(): Promise<GeoIpSuggestion | null> {
  if (!_fetchPromise) initGeoIpLookup()
  return _fetchPromise!
}
