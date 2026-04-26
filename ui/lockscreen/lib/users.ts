import GLib from "gi://GLib"

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
      const displayName = gecos.split(",")[0] || username

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
    console.error("[Greeter] getUsers:", e)
    return []
  }
}

export function getDefaultUser(): User {
  const users = getUsers()
  return users[0] ?? { username: "user", displayName: "User", avatarPath: null }
}
