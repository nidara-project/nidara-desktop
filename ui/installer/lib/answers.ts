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
}

export interface EntireDiskAnswer {
  mode: "entire_disk"
  disk: BlockDevice
  filesystem: FilesystemType
}

export interface ManualPartitionMount {
  name: string
  path: string
  size: number
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

