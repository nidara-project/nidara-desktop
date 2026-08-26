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
}

export interface LanguageAnswer {
  locale: string
  sysLang: string
  sysEnc: string
  label: string
}

export interface KeyboardAnswer {
  layout: string
  variant: string
  label: string
}

export interface TimezoneAnswer {
  timezone: string
}

export interface Answers {
  language: LanguageAnswer | null
  keyboard: KeyboardAnswer | null
  timezone: TimezoneAnswer | null
  disk: DiskAnswer | null
  account: AccountAnswer | null
}

const _answers: Answers = {
  language: null,
  keyboard: null,
  timezone: null,
  disk: null,
  account: null,
}

export function getAnswers(): Readonly<Answers> {
  return _answers
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

