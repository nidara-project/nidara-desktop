#!/usr/bin/env python3
"""Measure the contrast of a kitty color palette. DEV ONLY; nothing installs this.

    scripts/dev/terminal-contrast.py [kitty.conf ...]     (default: the shipped one)

Why it exists: the terminal's colors are the one part of Nidara that deliberately
ignores the Appearance light/dark toggle, and that decision was made with numbers
rather than taste. A terminal spends its life showing colored output — ls, git,
build logs, any TUI — and those colors are chosen by their authors against a dark
background. The light palette Nidara shipped until 2026-08-24 read plain text
beautifully (8.7:1 measured on screen, past WCAG AAA) and still left FIVE of the
twelve ANSI colors under 3:1, bright yellow among them at 1.2:1 — invisible.

So if anyone proposes a light palette again — a perfectly reasonable thing to
want — this is the gate it has to pass, and the reason the answer is not "no" but
"measure it". Contrast here is the WCAG 2.x relative-luminance ratio, the same
one used everywhere else in this project.
"""
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT = REPO / "defaults" / "kitty" / "kitty.conf"

NAMES = {
    "color1": "red",      "color2": "green",   "color3": "yellow",
    "color4": "blue",     "color5": "magenta", "color6": "cyan",
    "color7": "white",
    "color9": "bright red",     "color10": "bright green", "color11": "bright yellow",
    "color12": "bright blue",   "color13": "bright magenta", "color14": "bright cyan",
    "color15": "bright white",
}
FLOOR = 3.0  # WCAG AA for large text / graphical objects; a glyph is neither prose nor an icon


def parse(path):
    """kitty settings are `name value`; last one wins, as kitty itself resolves them."""
    out = {}
    for line in Path(path).read_text().splitlines():
        m = re.match(r"^\s*(foreground|background|cursor|color\d+)\s+#([0-9a-fA-F]{6})\s*$", line)
        if m:
            h = m.group(2)
            out[m.group(1)] = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    return out


def luminance(rgb):
    def channel(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def report(path):
    colors = parse(path)
    bg = colors.get("background")
    if bg is None:
        print(f"{path}: no `background` setting — nothing to measure against")
        return 0
    print(f"\n{path}   background #{'%02x%02x%02x' % bg}")
    print(f"  {'':<16}{'ratio':>8}")
    failed = []
    for key, name in NAMES.items():
        if key not in colors:
            continue
        r = ratio(colors[key], bg)
        mark = "  ← under %.0f:1" % FLOOR if r < FLOOR else ""
        print(f"  {name:<16}{r:>7.1f}:1{mark}")
        if r < FLOOR:
            failed.append(name)
    if "foreground" in colors:
        print(f"  {'(plain text)':<16}{ratio(colors['foreground'], bg):>7.1f}:1")
    print(f"  → {len(failed)} of {len([k for k in NAMES if k in colors])} below {FLOOR:.0f}:1"
          + (f": {', '.join(failed)}" if failed else ""))
    return len(failed)


if __name__ == "__main__":
    paths = sys.argv[1:] or [DEFAULT]
    total = sum(report(p) for p in paths)
    # Exit non-zero when something fails, so this can be wired into a check later.
    sys.exit(1 if total else 0)
