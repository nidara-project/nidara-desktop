import GLib from "gi://GLib"

// System user enumeration shared by the greeter, lockscreen and shell bundles.
// Context-independent (reads /etc/passwd + AccountsService), so it behaves the
// same whether running as the `greeter` system user or the logged-in user.
// displayName falls back to the username when the GECOS field is empty — never
// use GLib.get_real_name() for this: it returns the literal string "Unknown"
// on empty GECOS (the archinstall/useradd default).

export interface User {
  username: string
  displayName: string
  avatarPath: string | null
  homeDir: string
}

export function getUsers(): User[] {
  try {
    const [ok, contents] = GLib.file_get_contents("/etc/passwd")
    if (!ok) return []
    const text = new TextDecoder().decode(contents as Uint8Array)
    const users: User[] = []

    for (const line of text.split("\n")) {
      const parts = line.split(":")
      if (parts.length < 7) continue
      const username = parts[0]
      const uid = parseInt(parts[2])
      const shell = parts[6].trim()
      if (uid < 1000 || shell.includes("nologin") || shell.includes("false") || !shell) continue

      const gecos = parts[4] ?? ""
      const displayName = gecos.split(",")[0].trim() || username

      const homeDir = parts[5] ?? ""
      const accountsAvatar = `/var/lib/AccountsService/icons/${username}`
      const faceAvatar     = `${homeDir}/.face`
      const avatarPath = GLib.file_test(accountsAvatar, GLib.FileTest.EXISTS) ? accountsAvatar
                       : GLib.file_test(faceAvatar,     GLib.FileTest.EXISTS) ? faceAvatar
                       : null

      users.push({ username, displayName, avatarPath, homeDir })
    }

    return users
  } catch (e) {
    console.error("[users] getUsers:", e)
    return []
  }
}

// First human user in /etc/passwd — for surfaces running OUTSIDE any user
// session (the greeter, before anyone logs in). Never use this from the
// lockscreen: it points at the wrong account on multi-user machines.
export function getDefaultUser(): User {
  const users = getUsers()
  return users[0] ?? { username: "user", displayName: "User", avatarPath: null, homeDir: "" }
}

// The user running THIS process — the right identity for the lockscreen,
// which runs inside the locked session as its owner.
export function getCurrentUser(): User {
  const username = GLib.get_user_name()
  const match = getUsers().find(u => u.username === username)
  return match ?? { username, displayName: username, avatarPath: null, homeDir: GLib.get_home_dir() }
}
