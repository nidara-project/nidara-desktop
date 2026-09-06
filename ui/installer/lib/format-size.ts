/**
 * A byte count in the unit that fits it.
 *
 * Every size in this installer used to be printed as `(size / 1024³).toFixed(1)`
 * followed by the literal string "GiB", which is right for a disk and a lie for
 * everything smaller than one: an EFI partition (512 MiB), a BIOS boot partition
 * (1 MiB) and a Windows recovery partition all rendered as **`0.0 GiB`**, i.e.
 * "empty", on the one page where the user is deciding what to erase (D-14).
 *
 * The unit is the largest one the value reaches, and the precision follows the
 * magnitude rather than the unit — 3 significant-ish digits, which is how every
 * disk utility prints a size: `1 MiB`, `512 MiB`, `1.5 GiB`, `932 GiB`. A
 * trailing `.0` is dropped because it claims a precision the number does not
 * have.
 *
 * ⚠️ Binary units on purpose: this reads `lsblk -b`, whose bytes are what the
 * kernel reports, and the partition tools the run step calls speak the same. A
 * "1 TB" disk that shows as 932 GiB here is the same disk `sgdisk` will see.
 */
export function formatSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const text = value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)
  return `${text.replace(/\.0$/, "")} ${units[unit]}`
}
