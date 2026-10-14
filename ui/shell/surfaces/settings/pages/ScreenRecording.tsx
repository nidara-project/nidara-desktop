import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { NidaraButton, NidaraDropDown, NidaraList, NidaraRow, NidaraToggleRow, NidaraDropDownRow } from "../../../../lib/nidara-kit"
import { t } from "../../../core/i18n"
import { settings as compositorSettings } from "../../../core/CompositorState"
import recordingConfig, {
    AUDIO_MIC, AUDIO_SYSTEM, FORMATS, FRAMERATES, QUALITIES,
    hardwareAvailable, listAudioDevices, type RecordFormat, type RecordQuality,
} from "../../../core/RecordingConfig"

// Settings owns this page (#571); the capture widget reads the same preferences.
// No live widget module or Gtk builder is passed through the catalogue.

/** The audio-source picker. Its options are the two logical sentinels plus every
 *  PulseAudio source, and that list only exists after pactl answers — so the row
 *  ships with the sentinels (which is what the default resolves to anyway) and
 *  splices the devices in when they arrive, without disturbing the selection. */
function audioSourceRow(): Gtk.ListBoxRow {
    const deviceLabels = new Map<string, string>()
    let values: string[] = [AUDIO_SYSTEM, AUDIO_MIC]
    const labels = () => values.map(v =>
        v === AUDIO_SYSTEM ? t("widget.screenrecord.settings.source.system")
        : v === AUDIO_MIC  ? t("widget.screenrecord.settings.source.mic")
        : deviceLabels.get(v) ?? v)

    const model = new Gtk.StringList({ strings: labels() })
    const drp = NidaraDropDown({ model, valign: Gtk.Align.CENTER })

    let syncing = false
    const selectStored = () => {
        const idx = values.indexOf(recordingConfig.audioSource)
        syncing = true
        drp.selected = idx >= 0 ? idx : 0
        syncing = false
    }
    selectStored()

    drp.connect("notify::selected", () => {
        if (syncing) return
        const v = values[drp.selected]
        if (v !== undefined) recordingConfig.setAudioSource(v)
    })

    listAudioDevices().then(devices => {
        for (const d of devices) deviceLabels.set(d.name, d.description)
        values = [AUDIO_SYSTEM, AUDIO_MIC, ...devices.map(d => d.name)]
        // splice(0, n, …) replaces the whole model in one go — swapping the
        // model object instead would reset `selected` to 0. Guarded, because the
        // replacement itself moves `selected` and the resulting notify would
        // otherwise persist whatever landed under the index mid-splice.
        syncing = true
        model.splice(0, model.get_n_items(), labels())
        syncing = false
        selectStored()
    }).catch(() => {})

    return NidaraRow(
        t("widget.screenrecord.settings.source"),
        t("widget.screenrecord.settings.source.desc"),
        drp,
    )
}

/** Destination folder: the current path, and a button that opens a folder chooser. */
function saveDirRow(): Gtk.ListBoxRow {
    const home = GLib.get_home_dir()
    const pretty = (p: string) => p.startsWith(home) ? `~${p.slice(home.length)}` : p

    const pathLabel = new Gtk.Label({
        label: pretty(recordingConfig.saveDir),
        css_classes: ["dimmed"],
        ellipsize: 3, max_width_chars: 28, valign: Gtk.Align.CENTER,
    })
    const chooseBtn = NidaraButton({
        label: t("widget.screenrecord.settings.choose-folder"),
        variant: "secondary", pill: true, valign: Gtk.Align.CENTER,
    })
    chooseBtn.connect("clicked", () => {
        const fd = new Gtk.FileDialog({ title: t("widget.screenrecord.settings.dialog.folder"), modal: true })
        try { fd.set_initial_folder(Gio.File.new_for_path(recordingConfig.saveDir)) } catch {}
        fd.select_folder(chooseBtn.get_root() as Gtk.Window | null, null, (_: any, res: any) => {
            try {
                const path = fd.select_folder_finish(res)?.get_path()
                if (!path) return                 // cancelled
                recordingConfig.setSaveDir(path)
                pathLabel.label = pretty(path)
            } catch { /* cancelled */ }
        })
    })

    const trailing = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
    trailing.append(pathLabel)
    trailing.append(chooseBtn)
    return NidaraRow(t("widget.screenrecord.settings.save-to"), "", trailing)
}

export default function ScreenRecordingPage(): Gtk.Widget {
    // Settings wraps subpages in its page frame; keep the same group spacing.
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24 })

    // ── Audio ─────────────────────────────────────────────────────────────
    const audio = NidaraList(t("widget.screenrecord.settings.audio-group"))
    audio.listBox.append(audioSourceRow())
    page.append(audio.box)

    // ── Video ─────────────────────────────────────────────────────────────
    const qualityLabels: Record<RecordQuality, string> = {
        low: t("widget.screenrecord.settings.quality.low"),
        balanced: t("widget.screenrecord.settings.quality.balanced"),
        high: t("widget.screenrecord.settings.quality.high"),
    }
    const fpsLabel = (n: number) => n === 0 ? t("widget.screenrecord.settings.framerate.auto") : `${n} fps`

    const video = NidaraList(t("widget.screenrecord.settings.video-group"))
    video.listBox.append(NidaraDropDownRow(
        t("widget.screenrecord.settings.quality"),
        t("widget.screenrecord.settings.quality.desc"),
        qualityLabels[recordingConfig.quality],
        QUALITIES.map(q => qualityLabels[q]),
        v => {
            const q = QUALITIES.find(k => qualityLabels[k] === v)
            if (q) recordingConfig.setQuality(q)
        },
    ))
    video.listBox.append(NidaraDropDownRow(
        t("widget.screenrecord.settings.framerate"),
        t("widget.screenrecord.settings.framerate.desc"),
        fpsLabel(recordingConfig.framerate),
        FRAMERATES.map(fpsLabel),
        v => {
            const n = FRAMERATES.find(f => fpsLabel(f) === v)
            if (n !== undefined) recordingConfig.setFramerate(n)
        },
    ))
    // No render node, no row: a toggle that cannot change anything is worse than
    // an absent one. The stored value still exists and comes back with the GPU.
    if (hardwareAvailable()) {
        video.listBox.append(NidaraToggleRow(
            t("widget.screenrecord.settings.hardware"),
            t("widget.screenrecord.settings.hardware.desc"),
            recordingConfig.hardware,
            v => recordingConfig.setHardware(v),
        ))
    }
    // The compositor's switch, not the recorder's (wf-recorder always asks for the pointer):
    // absent where the compositor has none.
    if (compositorSettings.caps.recordedPointer) {
        video.listBox.append(NidaraToggleRow(
            t("widget.screenrecord.settings.pointer"),
            t("widget.screenrecord.settings.pointer.desc"),
            compositorSettings.readRecordedPointer(),
            v => compositorSettings.setRecordedPointer(v),
        ))
    }
    page.append(video.box)

    // ── File ──────────────────────────────────────────────────────────────
    const formatLabels: Record<RecordFormat, string> = { mp4: "MP4", mkv: "MKV", webm: "WebM" }
    const file = NidaraList(t("widget.screenrecord.settings.file-group"))
    file.listBox.append(NidaraDropDownRow(
        t("widget.screenrecord.settings.format"),
        t("widget.screenrecord.settings.format.desc"),
        formatLabels[recordingConfig.format],
        FORMATS.map(f => formatLabels[f]),
        v => {
            const f = FORMATS.find(k => formatLabels[k] === v)
            if (f) recordingConfig.setFormat(f)
        },
    ))
    file.listBox.append(saveDirRow())
    page.append(file.box)

    return page
}
