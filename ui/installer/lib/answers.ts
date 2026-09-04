// Answers collected by the installer steps before execution.
//
// Kept in memory — not written to disk or logged, because the account step
// collects a password and nothing should persist it until archinstall runs.

export type DiskInstallMode = "entire_disk" | "manual"
export type FilesystemType = "btrfs" | "ext4" | "xfs" | "f2fs" | "vfat"

export interface BlockDevice {
  name: string
  path: string
  size: number
  model: string | null
  rm: boolean
  /**
   * Logical sector size, in bytes — 512 on almost everything, 4096 on 4Kn drives.
   *
   * Here because archinstall's schema is not written in "the rest of the disk":
   * every partition is an absolute start and an absolute length, and it VALIDATES
   * them — MiB alignment, no overlap, and the last partition not reaching into the
   * backup GPT header. That arithmetic needs the sector size, so it is a property
   * of the disk the user picked rather than a constant somebody assumed. See
   * lib/disk-config.ts.
   */
  logicalSectorSize: number
}

export interface EntireDiskAnswer {
  mode: "entire_disk"
  disk: BlockDevice
  filesystem: FilesystemType
}

export interface ManualPartitionMount {
  name: string
  path: string
  /**
   * The disk this partition lives on — `/dev/sda` for `/dev/sda2`.
   *
   * archinstall's schema is a list of DEVICE modifications, each carrying its own
   * partitions, so a manual layout spread over two disks is two entries and not
   * one flat list. Taken from the parent node of the same `lsblk` tree the row
   * came from rather than rebuilt from the partition's name, because "strip the
   * digits" is wrong for `nvme0n1p2` and for every mapper name.
   */
  device: string
  /**
   * Where the partition starts on that disk, in BYTES.
   *
   * Not cosmetic: ticking Format sends the partition to archinstall as `modify`,
   * and a modify is a DELETE followed by a create at exactly these numbers
   * (`device_handler._setup_partition`). A start that is off by a sector is a
   * partition recreated in the wrong place. `lsblk` reports it in 512-byte units
   * whatever the drive's own sector size, so the conversion happens where it is
   * read — see steps/disk.ts.
   */
  start: number
  size: number
  /** Logical sector size of the disk, for archinstall's `Size` objects. */
  logicalSectorSize: number
  fsType: string | null
  label: string | null
  mountpoint: string // "/", "/boot", "/boot/efi", "/efi", "/home", "swap"
  filesystem: FilesystemType
  format: boolean
}

export interface ManualDiskAnswer {
  mode: "manual"
  mounts: ManualPartitionMount[]
}

export type DiskAnswer = EntireDiskAnswer | ManualDiskAnswer

export interface AccountAnswer {
  fullName: string
  username: string
  password: string
  hostname: string
}

export interface CountryAnswer {
  /** ISO 3166-1 alpha-2 — the key lib/region.ts joins every other table on. */
  code: string
  name: string
}

export interface LanguageAnswer {
  locale: string
  sysLang: string
  sysEnc: string
  label: string
}

export interface KeyboardAnswer {
  /** xkb layout — the live session and Hyprland. */
  layout: string
  variant: string
  /** vconsole keymap — /etc/vconsole.conf, the TTY, and the LUKS prompt. */
  keymap: string
  label: string
}

export interface TimezoneAnswer {
  timezone: string
}

export interface Answers {
  /** Asked first; it narrows the three below without answering them. */
  country: CountryAnswer | null
  language: LanguageAnswer | null
  keyboard: KeyboardAnswer | null
  timezone: TimezoneAnswer | null
  disk: DiskAnswer | null
  account: AccountAnswer | null
}

const _answers: Answers = {
  country: null,
  language: null,
  keyboard: null,
  timezone: null,
  disk: null,
  account: null,
}

export function getAnswers(): Readonly<Answers> {
  return _answers
}

export function setCountryAnswer(country: CountryAnswer | null): void {
  _answers.country = country
}

export function setLanguageAnswer(language: LanguageAnswer | null): void {
  _answers.language = language
}

export function setKeyboardAnswer(keyboard: KeyboardAnswer | null): void {
  _answers.keyboard = keyboard
}

export function setTimezoneAnswer(timezone: TimezoneAnswer | null): void {
  _answers.timezone = timezone
}

export function setDiskAnswer(disk: DiskAnswer | null): void {
  _answers.disk = disk
}

export function setAccountAnswer(account: AccountAnswer | null): void {
  _answers.account = account
}

