import type Gtk from "gi://Gtk?version=4.0"
import ScreenRecordingPage from "./pages/ScreenRecording"

// Builders belong to Settings, keyed by the catalogue's stable widget id (#571).
// Unknown ids simply have no Configure button. Never import widgets/ here.
const pages: ReadonlyMap<string, () => Gtk.Widget> = new Map([
    ["screenrecord", ScreenRecordingPage],
])

export function widgetSettingsPage(id: string): (() => Gtk.Widget) | undefined {
    return pages.get(id)
}
