// Answers collected by the installer steps before execution.
//
// Kept in memory — not written to disk or logged, because the account step
// collects a password and nothing should persist it until archinstall runs.

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

export interface Answers {
  disk: DiskAnswer | null
  account: AccountAnswer | null
}

const _answers: Answers = {
  disk: null,
  account: null,
}

export function getAnswers(): Readonly<Answers> {
  return _answers
}

export function setDiskAnswer(disk: DiskAnswer | null): void {
  _answers.disk = disk
}

export function setAccountAnswer(account: AccountAnswer | null): void {
  _answers.account = account
}
