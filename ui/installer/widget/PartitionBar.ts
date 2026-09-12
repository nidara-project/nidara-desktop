import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import { formatSize } from "../lib/format-size"
import { t, getLocale } from "../lib/i18n"
import { ndIcon } from "../../lib/icons"

export interface PartitionBarSlice {
  key: string
  path: string
  label: string | null
  partlabel?: string | null
  size: number
  start: number
  fstype: string | null
  isFree: boolean
  mountpoint?: string
}

export interface PartitionBarOpts {
  diskPath: string
  diskName: string
  diskSize: number
  slices: PartitionBarSlice[]
  showLegend?: boolean
  diskSelector?: Gtk.Widget
  onSliceClick?: (slice: PartitionBarSlice) => void
}

export interface PartitionBarResult {
  widget: Gtk.Box
  updateSlices: (slices: PartitionBarSlice[]) => void
  setSelectedKey: (key: string | null) => void
}

// Slice Color Scheme
interface SliceColor {
  r: number
  g: number
  b: number
}

const COLOR_EFI: SliceColor   = { r: 0.08, g: 0.55, b: 0.85 } // Sky Blue #148cd9
const COLOR_ROOT: SliceColor  = { r: 0.54, g: 0.36, b: 0.96 } // Nidara Violet #8b5cf6
const COLOR_HOME: SliceColor  = { r: 0.06, g: 0.72, b: 0.50 } // Emerald #10b981
const COLOR_SWAP: SliceColor  = { r: 0.96, g: 0.62, b: 0.07 } // Amber #f59e0b
const COLOR_OTHER: SliceColor = { r: 0.33, g: 0.41, b: 0.52 } // Slate #546984
const COLOR_FREE: SliceColor  = { r: 0.16, g: 0.20, b: 0.27 } // Dark Slate #293345

function getSliceColor(s: PartitionBarSlice): SliceColor {
  if (s.isFree) return COLOR_FREE
  if (s.mountpoint === "/") return COLOR_ROOT
  if (s.mountpoint === "/boot" || (s.fstype === "vfat" && (s.label?.toLowerCase().includes("efi") || s.path.endsWith("1")))) {
    return COLOR_EFI
  }
  if (s.mountpoint === "/home") return COLOR_HOME
  if (s.mountpoint === "swap" || s.fstype === "swap") return COLOR_SWAP
  return COLOR_OTHER
}

function roundRectPath(cr: any, x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0 || h <= 0) return
  r = Math.min(r, w / 2, h / 2)
  cr.newPath()
  cr.arc(x + w - r, y + r,     r, -Math.PI / 2, 0)
  cr.arc(x + w - r, y + h - r, r, 0,            Math.PI / 2)
  cr.arc(x + r,     y + h - r, r, Math.PI / 2,  Math.PI)
  cr.arc(x + r,     y + r,     r, Math.PI,      1.5 * Math.PI)
  cr.closePath()
}

export function NidaraPartitionBar(opts: PartitionBarOpts): PartitionBarResult {
  let currentSlices = [...opts.slices]
  let hoveredIndex = -1
  let selectedKey: string | null = null

  const container = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 8,
    hexpand: true,
    css_classes: ["nidara-partition-bar-container"],
  })

  // ── Header: Disk identity and size ──
  const headerBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 8,
    valign: Gtk.Align.CENTER,
  })

  const diskIcon = ndIcon("hard-drive")
  if (diskIcon) {
    headerBox.append(new Gtk.Image({ gicon: diskIcon, pixel_size: 16, css_classes: ["nd-icon"] }))
  }

  if (opts.diskSelector) {
    headerBox.append(opts.diskSelector)
  } else {
    const diskLabel = new Gtk.Label({
      label: `${opts.diskName}  ·  ${formatSize(opts.diskSize)}  ·  ${opts.diskPath}`,
      css_classes: ["installer-check-title"],
      halign: Gtk.Align.START,
      hexpand: true,
    })
    headerBox.append(diskLabel)
  }
  container.append(headerBox)

  // ── The Visual Canvas ──
  const da = new Gtk.DrawingArea({
    hexpand: true,
    content_height: 38,
    can_focus: false,
    css_classes: ["nidara-partition-bar-canvas"],
  })
  da.set_size_request(-1, 38)

  // Anchored popover tooltip (styled with Nidara glass theme, anchored stably to slice center)
  const popover = new Gtk.Popover({
    autohide: false,
    can_focus: false,
    cascade_popdown: false,
    has_arrow: true,
    position: Gtk.PositionType.BOTTOM,
    css_classes: ["nidara-partition-popover"],
  })
  popover.set_parent(da)

  const popoverLabel = new Gtk.Label({
    css_classes: ["nidara-partition-popover-text"],
  })
  popover.set_child(popoverLabel)

  // Geometry calculation helper
  interface SliceLayout {
    slice: PartitionBarSlice
    x: number
    w: number
    color: SliceColor
  }

  let calculatedLayouts: SliceLayout[] = []

  function computeLayout(totalW: number, totalH: number): SliceLayout[] {
    if (currentSlices.length === 0 || totalW <= 0) return []

    const gap = 2
    const totalGaps = (currentSlices.length - 1) * gap
    const availW = Math.max(0, totalW - totalGaps)

    const minW = Math.min(32, Math.floor(availW / currentSlices.length))
    const totalBytes = opts.diskSize > 0
      ? opts.diskSize
      : currentSlices.reduce((acc, s) => acc + s.size, 0)

    // First pass: minimum widths
    const widths: number[] = new Array(currentSlices.length).fill(minW)
    let allocated = minW * currentSlices.length
    const remainingW = Math.max(0, availW - allocated)

    // Second pass: distribute proportional weight
    if (totalBytes > 0 && remainingW > 0) {
      for (let i = 0; i < currentSlices.length; i++) {
        const share = Math.round((currentSlices[i].size / totalBytes) * remainingW)
        widths[i] += share
      }
    }

    // Normalize rounding delta to fit exactly in availW
    const actualSum = widths.reduce((a, b) => a + b, 0)
    const diff = availW - actualSum
    if (diff !== 0 && widths.length > 0) {
      widths[widths.length - 1] += diff
    }

    const layouts: SliceLayout[] = []
    let curX = 0
    for (let i = 0; i < currentSlices.length; i++) {
      const s = currentSlices[i]
      const w = Math.max(4, widths[i])
      layouts.push({
        slice: s,
        x: curX,
        w,
        color: getSliceColor(s),
      })
      curX += w + gap
    }

    return layouts
  }

  da.set_draw_func((_, cr: any, width: number, height: number) => {
    calculatedLayouts = computeLayout(width, height)
    if (calculatedLayouts.length === 0) return

    // Background track clip
    roundRectPath(cr, 0, 0, width, height, 8)
    cr.clip()

    for (let i = 0; i < calculatedLayouts.length; i++) {
      const { slice, x, w, color } = calculatedLayouts[i]
      const isHovered = i === hoveredIndex
      const isSelected = slice.key === selectedKey

      // Base fill with highlight boost
      const brightness = isSelected ? 1.35 : (isHovered ? 1.2 : 1.0)
      const r = Math.min(1.0, color.r * brightness)
      const g = Math.min(1.0, color.g * brightness)
      const b = Math.min(1.0, color.b * brightness)

      cr.rectangle(x, 0, w, height)
      cr.setSourceRGB(r, g, b)
      cr.fill()

      // Free space hatch / subtle pattern
      if (slice.isFree) {
        cr.save()
        cr.rectangle(x, 0, w, height)
        cr.clip()
        cr.setSourceRGBA(1, 1, 1, 0.08)
        cr.setLineWidth(1)
        for (let hx = x - height; hx < x + w + height; hx += 8) {
          cr.moveTo(hx, 0)
          cr.lineTo(hx + height, height)
          cr.stroke()
        }
        cr.restore()
      }

      // Subtle top highlight sheen
      cr.save()
      cr.rectangle(x, 0, w, height / 2)
      cr.clip()
      cr.setSourceRGBA(1, 1, 1, isHovered || isSelected ? 0.22 : 0.08)
      cr.fill()
      cr.restore()

      // Selection or Hover outline
      if (isSelected) {
        cr.save()
        cr.setSourceRGBA(1, 1, 1, 0.95)
        cr.setLineWidth(2.5)
        cr.rectangle(x + 1.25, 1.25, Math.max(1, w - 2.5), height - 2.5)
        cr.stroke()
        cr.restore()
      } else if (isHovered) {
        cr.save()
        cr.setSourceRGBA(1, 1, 1, 0.4)
        cr.setLineWidth(1.5)
        cr.rectangle(x + 0.75, 0.75, Math.max(1, w - 1.5), height - 1.5)
        cr.stroke()
        cr.restore()
      }

      // Slice label text (if wide enough)
      if (w >= 36) {
        cr.save()
        const textLabel = slice.mountpoint
          ? slice.mountpoint
          : (slice.isFree ? t("diskFreeSpace") : (slice.path.split("/").pop() || slice.label || ""))

        const sizeStr = formatSize(slice.size)
        const fullText = w >= 85 ? `${textLabel} · ${sizeStr}` : textLabel

        const pangoLayout = da.create_pango_layout(fullText)
        const fontDesc = Pango.FontDescription.from_string("Inter, sans-serif 9")
        fontDesc.set_weight(Pango.Weight.SEMIBOLD)
        pangoLayout.set_font_description(fontDesc)
        pangoLayout.set_ellipsize(Pango.EllipsizeMode.END)
        pangoLayout.set_width(Math.max(0, (w - 8) * Pango.SCALE))

        const [, logicalRect] = pangoLayout.get_pixel_extents()
        const textX = x + Math.max(4, (w - logicalRect.width) / 2)
        const textY = (height - logicalRect.height) / 2

        // Text shadow for legibility
        cr.setSourceRGBA(0, 0, 0, 0.5)
        cr.moveTo(textX + 0.5, textY + 1)
        PangoCairo.show_layout(cr, pangoLayout)

        // Text foreground
        cr.setSourceRGBA(1, 1, 1, slice.isFree ? 0.8 : 0.95)
        cr.moveTo(textX, textY)
        PangoCairo.show_layout(cr, pangoLayout)
        cr.restore()
      }
    }

    // Subtle outer border
    cr.resetClip()
    roundRectPath(cr, 0.5, 0.5, width - 1, height - 1, 8)
    cr.setSourceRGBA(1, 1, 1, 0.15)
    cr.setLineWidth(1)
    cr.stroke()
  })

  // ── Motion and Click Controller ──
  const motion = new Gtk.EventControllerMotion()
  motion.connect("motion", (_, x: number) => {
    let newIdx = -1
    for (let i = 0; i < calculatedLayouts.length; i++) {
      const l = calculatedLayouts[i]
      if (x >= l.x && x <= l.x + l.w) {
        newIdx = i
        break
      }
    }
    if (newIdx !== hoveredIndex) {
      hoveredIndex = newIdx
      da.set_cursor_from_name(hoveredIndex >= 0 ? "pointer" : null)
      da.queue_draw()

      if (hoveredIndex >= 0 && hoveredIndex < calculatedLayouts.length) {
        const l = calculatedLayouts[hoveredIndex]
        const s = l.slice
        const displayLabel = s.partlabel || s.label
        const nameStr = s.isFree ? t("diskFreeSpace") : s.path
        const tagStr = displayLabel ? ` (${displayLabel})` : ""
        const fsStr = s.fstype ? ` · ${s.fstype}` : ""
        const mpStr = s.mountpoint ? ` → ${s.mountpoint}` : ""
        popoverLabel.label = `${nameStr}${tagStr} · ${formatSize(s.size)}${fsStr}${mpStr}`

        const rect = new Gdk.Rectangle()
        rect.x = Math.round(l.x)
        rect.y = 0
        rect.width = Math.max(1, Math.round(l.w))
        rect.height = 38
        popover.set_pointing_to(rect)
        popover.popup()
      } else {
        popover.popdown()
      }
    }
  })
  motion.connect("leave", () => {
    if (hoveredIndex !== -1) {
      hoveredIndex = -1
      da.set_cursor_from_name(null)
      da.queue_draw()
    }
    popover.popdown()
  })
  da.add_controller(motion)

  da.connect("unmap", () => {
    popover.popdown()
  })

  const click = new Gtk.GestureClick()
  click.connect("pressed", (_, n_press: number, x: number) => {
    if (n_press !== 1) return
    for (let i = 0; i < calculatedLayouts.length; i++) {
      const l = calculatedLayouts[i]
      if (x >= l.x && x <= l.x + l.w) {
        selectedKey = l.slice.key
        da.queue_draw()
        opts.onSliceClick?.(l.slice)
        break
      }
    }
  })
  da.add_controller(click)

  container.append(da)

  if (opts.showLegend !== false) {
    container.append(NidaraPartitionLegend())
  }

  return {
    widget: container,
    updateSlices: (newSlices: PartitionBarSlice[]) => {
      currentSlices = [...newSlices]
      da.queue_draw()
    },
    setSelectedKey: (key: string | null) => {
      if (selectedKey !== key) {
        selectedKey = key
        da.queue_draw()
      }
    },
  }
}

export function NidaraPartitionLegend(): Gtk.Box {
  const legendBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 16,
    halign: Gtk.Align.START,
    css_classes: ["nidara-partition-legend"],
    margin_top: 2,
    margin_bottom: 4,
  })

  const makeLegendItem = (label: string, color: SliceColor, isOutline = false) => {
    const item = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER })
    const dot = new Gtk.DrawingArea({
      content_width: 10,
      content_height: 10,
      valign: Gtk.Align.CENTER,
    })
    dot.set_size_request(10, 10)
    dot.set_draw_func((_, cr, w, h) => {
      roundRectPath(cr, 1, 1, w - 2, h - 2, 3)
      cr.setSourceRGB(color.r, color.g, color.b)
      cr.fill()
      if (isOutline) {
        roundRectPath(cr, 0.5, 0.5, w - 1, h - 1, 3)
        cr.setSourceRGBA(1, 1, 1, 0.25)
        cr.setLineWidth(1)
        cr.stroke()
      }
    })
    const lbl = new Gtk.Label({
      label,
      css_classes: ["installer-check-desc"],
    })
    item.append(dot)
    item.append(lbl)
    return item
  }

  const isEs = getLocale() === "es"
  legendBox.append(makeLegendItem("EFI / /boot", COLOR_EFI))
  legendBox.append(makeLegendItem("/ (Root)", COLOR_ROOT))
  legendBox.append(makeLegendItem("/home", COLOR_HOME))
  legendBox.append(makeLegendItem("Swap", COLOR_SWAP))
  legendBox.append(makeLegendItem(isEs ? "Datos / Otros" : "Data / Other", COLOR_OTHER))
  legendBox.append(makeLegendItem(t("diskFreeSpace"), COLOR_FREE, true))

  return legendBox
}

