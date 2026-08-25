// Shared installer state — collects user answers across flow steps.
//
// In-memory state only. Passwords are never written to disk or logs in plaintext.
// The collected answers are consumed by `lib/plan.ts` (T5) to generate the
// archinstall configuration and credentials files.

export interface DiskAnswer {
  name: string
  path: string
  size: number
  model: string | null
  rm: boolean
}

export interface AccountAnswer {
  fullName: string
  username: string
  password: string
}

export interface InstallerAnswers {
  disk: DiskAnswer | null
  account: AccountAnswer | null
}

const _answers: InstallerAnswers = {
  disk: null,
  account: null,
}

const _listeners = new Set<() => void>()

export function getAnswers(): InstallerAnswers {
  return _answers
}

export function setDiskAnswer(disk: DiskAnswer | null) {
  _answers.disk = disk
  _listeners.forEach(fn => fn())
}

export function setAccountAnswer(account: AccountAnswer | null) {
  _answers.account = account
  _listeners.forEach(fn => fn())
}

export function onAnswersChanged(fn: () => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}
