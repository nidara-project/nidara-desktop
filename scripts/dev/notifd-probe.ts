// The REAL shell client, driven over stdin by scripts/ci/sessiond-test.py on its
// private bus. No GTK, window, config or user's store. snapshot is observation;
// dismiss/invoke exercise the facade API. onNotified counts the callbacks which
// the unmodified banners consume, so hydration must leave that array empty.
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import { getDefault } from "../../ui/shell/core/notifd"

const client = getDefault()
const notified: { id: number, replaced: boolean }[] = []
const resolved: { id: number, reason: number }[] = []
let history: any[] = []
client.onNotified((id, replaced) => notified.push({ id, replaced }))
client.onResolved((id, reason) => {
    resolved.push({ id, reason })
    // Model an already-open NC: its unchanged watchResolved rereads the roster.
    history = client.notifications.map(n => n.serialize())
})
const loop = new GLib.MainLoop(null, false)
const input = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) })
function read(): void {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream: any, result: any) => {
        const [bytes] = stream.read_line_finish(result)
        if (!bytes) { loop.quit(); return }
        const command = JSON.parse(new TextDecoder().decode(bytes))
        if (command.method === "dismiss") client.getNotification(command.id)?.dismiss()
        if (command.method === "invoke") client.getNotification(command.id)?.invoke(command.action)
        print(JSON.stringify({ notifications: client.notifications.map(n => n.serialize()), notified, resolved, history }))
        read()
    })
}
read()
loop.run()
