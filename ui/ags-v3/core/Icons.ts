import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { SHELL_ROOT } from "./Paths"

function resolveIconsDir(): string {
    const candidates = [
        `${GLib.get_user_config_dir()}/crystal-shell/ui/ags-v3/assets/icons/hicolor/scalable/actions`,
        `${SHELL_ROOT}/assets/icons/hicolor/scalable/actions`,
    ]
    for (const p of candidates) {
        if (GLib.file_test(p, GLib.FileTest.IS_DIR)) return p
    }
    return candidates[1]
}

const DIR = resolveIconsDir()
const f = (name: string) => Gio.FileIcon.new(Gio.File.new_for_path(`${DIR}/${name}.svg`))

const Icons = {
    app:          f("app-window"),
    mic:          f("mic"),
    speaker:      f("speaker"),
    volumeHigh:   f("volume-2"),
    volumeMedium: f("volume-1"),
    volumeLow:    f("volume"),
    volumeMuted:  f("volume-x"),
    user:         f("user"),
    battery:      f("battery"),
    bluetooth:    f("bluetooth"),
    cpu:          f("cpu"),
    wifi:         f("wifi"),
    ethernet:     f("ethernet-port"),
    moon:         f("moon"),
    sun:          f("sun"),
    calculator:   f("calculator"),
    info:         f("info"),
    key:          f("key"),
    filePen:      f("file-pen"),
    trash:        f("trash"),
    search:       f("search"),
    chevronRight: f("chevron-right"),
    chevronLeft:  f("chevron-left"),
    chevronUp:    f("chevron-up"),
    chevronDown:  f("chevron-down"),
    plus:         f("plus"),
    minus:        f("minus"),
    pause:        f("pause"),
    play:         f("play"),
    skipBack:     f("skip-back"),
    skipForward:  f("skip-forward"),
    wifiOff:      f("wifi-off"),
    bell:         f("bell"),
    bellOff:      f("bell-off"),
    check:        f("check"),
    menu:         f("menu"),
    settings2:    f("settings-2"),
    settings:     f("settings"),
    terminal:     f("terminal"),
    grid:         f("grid"),
    sidebar:      f("sidebar"),
    close:        f("x"),
    lock:         f("lock"),
    logOut:       f("log-out"),
    power:        f("power"),
    rotateCcw:    f("rotate-ccw"),
    palette:      f("palette"),
    monitor:      f("monitor"),
    keyboard:     f("keyboard"),
    clock:        f("clock"),
    type:         f("type"),
    mousePointer: f("mouse-pointer"),
    zap:          f("zap"),
    leaf:         f("leaf"),
    dock:              f("dock"),
    accessibility:     f("accessibility"),
    puzzle:            f("puzzle"),
    panelTop:          f("panel-top"),
    rocket:            f("rocket"),
    bluetoothConnected: f("bluetooth-connected"),
    bluetoothOff:      f("bluetooth-off"),
    bluetoothSearching: f("bluetooth-searching"),
    globe:             f("globe"),
    clipboard:         f("clipboard"),
    camera:            f("camera"),
    record:            f("record"),
    recordStop:        f("record-stop"),
    shield:            f("shield"),
    shieldOff:         f("shield-off"),
    gamepad:           f("gamepad-2"),
} as const

export type IconGIcon = Gio.FileIcon
export default Icons
