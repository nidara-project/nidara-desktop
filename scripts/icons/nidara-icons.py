#!/usr/bin/env python3
"""
nidara-icons.py — maintain the Nidara icon theme (#587).

    scripts/icons/nidara-icons.py sync [--check]
    scripts/icons/nidara-icons.py add <source.svg> <nd-name>

The theme lives in the repository, once: `ui/shell/assets/icons/nidara/`. Its
`scalable/actions/*-symbolic.svg` are THE drawings — reviewed, committed, what the
shell draws. Everything else in the theme follows from them, and this is the tool
that does the following.

`sync` rewrites `16x16/actions` from `scalable/actions`. `--check` writes nothing
and fails if the committed small variant is not exactly what `sync` would write —
CI runs that, so a drawing changed in one size and forgotten in the other cannot
land.

`add` converts a stroke SVG (a Lucide icon, typically: `ui/shell/node_modules/
lucide-static/icons/<name>.svg`) into both sizes under an `nd-` name. Then add the
name to `ICON_NAMES` in `ui/shell/core/Icons.ts` and its row to the theme's
`SPEC.md` — `scripts/ci/icon-registry-check.mjs` fails until all three agree. A
drawing can be edited by hand afterwards; `sync` keeps its classes.

── What the conversion does, and why ───────────────────────────────────────────

1. **Symbolic classes.** A stroke drawing with `stroke="currentColor"` is NOT
   recoloured by GTK: it only recolours a file whose name ends in `-symbolic`, and
   then only by the symbolic classes. So every shape gets `foreground-stroke` plus
   either `transparent-fill` or `foreground-fill`, decided from the fill it
   EFFECTIVELY has — its own, or the root's. Without the classes a stroke-only icon
   renders as a filled blob (measured, GTK 4.22.5). A shape that ALREADY carries
   symbolic classes keeps them: in a converted file the class is the only place the
   intent survives (`nd-media-playback-stop`'s filled square has `fill="none"` on
   its root and `foreground-fill` on the rect — recomputing lost the fill).

2. **The 16-unit variant.** GTK forces symbolic strokes to 2 SVG USER UNITS, so a
   24-unit drawing shown at 16px has a 1.33px stroke and reads thin in the bar.
   Rewriting the coordinates to a 16-unit viewBox gives a real 2px there. A
   `<g transform="scale(…)">` does NOT work — the stroke scales with it.
   ⚠️ Measured: that variant only wins at 12–16px and scale 1. At 18px, and at any
   size on a scale-2 display, GTK takes the scalable one.

The output is deterministic: same input, byte-identical files.
"""

import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SVG_NS = "http://www.w3.org/2000/svg"

# 16/24. The scalable drawings are 24 units; the small variant is 16.
SCALE = 16.0 / 24.0

SYMBOLIC_CLASSES = {"foreground-stroke", "foreground-fill", "transparent-fill"}

SHAPES = ("path", "rect", "circle", "ellipse", "line", "polyline", "polygon")


# ── numbers ─────────────────────────────────────────────────────────────────

def fmt(value, scale=True):
    """A coordinate, scaled or not, with no trailing zeros and no negative zero."""
    out = f"{value * SCALE:.4f}" if scale else f"{value:.4f}"
    out = out.rstrip("0").rstrip(".")
    return "0" if out in ("-0", "") else out


# ── SVG path arithmetic ─────────────────────────────────────────────────────

def parse_path(d):
    """
    Tokenise a path's `d` into commands and numbers.

    Written against the SVG grammar rather than a regex because of one case a
    regex gets wrong: in an arc (`A`/`a`) the two flags are single characters and
    may be written with no separator at all — `a5 5 0 0116 0` is `0` then `1`
    then `16`, not `0`, `116`.
    """
    i, n, tokens, cmd = 0, len(d), [], None

    def skip():
        nonlocal i
        while i < n and d[i] in " \t\r\n,":
            i += 1

    def number():
        nonlocal i
        skip()
        if i >= n:
            return None
        start = i
        if d[i] in "+-":
            i += 1
        digits = False
        while i < n and d[i].isdigit():
            digits, i = True, i + 1
        if i < n and d[i] == ".":
            i += 1
            while i < n and d[i].isdigit():
                digits, i = True, i + 1
        if not digits:
            i = start
            return None
        if i < n and d[i] in "eE":
            mark = i
            i += 1
            if i < n and d[i] in "+-":
                i += 1
            exp = False
            while i < n and d[i].isdigit():
                exp, i = True, i + 1
            if not exp:
                i = mark
        return float(d[start:i])

    def flag():
        nonlocal i
        skip()
        if i < n and d[i] in "01":
            i += 1
            return int(d[i - 1])
        return None

    while i < n:
        skip()
        if i >= n:
            break
        if d[i].isalpha():
            cmd = d[i]
            tokens.append(cmd)
            i += 1
            continue
        if cmd in ("A", "a"):
            arc = [number(), number(), number(), flag(), flag(), number(), number()]
            if any(v is None for v in arc):
                raise ValueError(f"malformed arc near {i} in: {d}")
            tokens.extend(arc)
        elif cmd in ("Z", "z"):
            pass
        else:
            value = number()
            if value is None:
                raise ValueError(f"unexpected {d[i]!r} at {i} in: {d}")
            tokens.append(value)
    return tokens


# How many numbers each command takes, per repetition.
ARITY = {"M": 2, "L": 2, "T": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4}


def scale_path(d):
    """Rewrite a path's `d` from 24 units to 16."""
    tokens = parse_path(d)
    out, i, cmd = [], 0, None
    while i < len(tokens):
        token = tokens[i]
        if isinstance(token, str):
            cmd, i = token, i + 1
            out.append(token)
            continue
        upper = (cmd or "").upper()
        if upper in ARITY:
            count = ARITY[upper]
            out.extend(fmt(v) for v in tokens[i:i + count])
            i += count
        elif upper == "A":
            rx, ry, rot, large, sweep, x, y = tokens[i:i + 7]
            # The rotation is an ANGLE and the flags are booleans — scaling either
            # would bend the arc or flip which way it goes round.
            out.extend([fmt(rx), fmt(ry), fmt(rot, scale=False),
                        str(int(large)), str(int(sweep)), fmt(x), fmt(y)])
            i += 7
        elif upper == "Z":
            i += 1
        else:
            raise ValueError(f"unknown path command: {cmd!r}")
    return " ".join(out)


COORDS = {
    "rect": ("x", "y", "width", "height", "rx", "ry"),
    "circle": ("cx", "cy", "r"),
    "ellipse": ("cx", "cy", "rx", "ry"),
    "line": ("x1", "y1", "x2", "y2"),
}

NUMBER = re.compile(r"[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?")


def scale_shape(tag, attrs):
    """Rewrite one shape's coordinates from 24 units to 16, in place."""
    if tag == "path" and "d" in attrs:
        attrs["d"] = scale_path(attrs["d"])
    elif tag in COORDS:
        for name in COORDS[tag]:
            if name in attrs:
                attrs[name] = fmt(float(attrs[name]))
    elif tag in ("polyline", "polygon") and "points" in attrs:
        values = [float(v) for v in NUMBER.findall(attrs["points"])]
        attrs["points"] = " ".join(
            f"{fmt(values[i])},{fmt(values[i + 1])}"
            for i in range(0, len(values) - 1, 2))


# ── conversion ──────────────────────────────────────────────────────────────

def symbolic_classes(attrs, root_fill, root_stroke):
    """
    The symbolic classes for one shape.

    GTK's traditional symbolic mode lets a CLASS override the element's own
    presentation attributes, so these decide the paint — which is why the fill has
    to be read the way SVG resolves it (the element's own, else the root's), and
    not just off the element. `record-stop` keeps `fill="currentColor"` on the
    root; `record`'s inner dot carries `stroke="none"` and must not get
    `foreground-stroke`, or GTK's forced 2-unit stroke fattens the dot.
    """
    fill = attrs.get("fill", root_fill)
    stroke = attrs.get("stroke", root_stroke)
    classes = []
    if stroke == "currentColor":
        classes.append("foreground-stroke")
    classes.append("foreground-fill" if fill == "currentColor" else "transparent-fill")
    return " ".join(classes)


def convert(src_path, size):
    """One source SVG → the symbolic file's bytes, at 24 (scalable) or 16 units."""
    root = ET.parse(src_path).getroot()
    root_fill = root.get("fill", "none")
    root_stroke = root.get("stroke", "currentColor")
    scale = size == 16

    out = ET.Element("svg", {
        "xmlns": SVG_NS,
        "width": str(size), "height": str(size),
        "viewBox": f"0 0 {size} {size}",
        "fill": "none",
        "stroke": "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
    })
    for child in root:
        tag = child.tag.split("}")[-1]
        if tag not in SHAPES:
            continue
        attrs = dict(child.attrib)
        existing = attrs.pop("class", "")
        classes = (existing if SYMBOLIC_CLASSES & set(existing.split())
                   else symbolic_classes(attrs, root_fill, root_stroke))
        if scale:
            scale_shape(tag, attrs)
        attrs["class"] = classes
        ET.SubElement(out, tag, attrs)

    ET.indent(out, space="  ")
    return ET.tostring(out, encoding="utf-8", xml_declaration=False) + b"\n"


# ── the theme ───────────────────────────────────────────────────────────────

THEME = os.path.normpath(os.path.join(HERE, "..", "..", "ui", "shell", "assets", "icons", "nidara"))
SIZES = {24: os.path.join(THEME, "scalable", "actions"), 16: os.path.join(THEME, "16x16", "actions")}


def sync(check):
    """Rewrite (or, with `check`, verify) the 16-unit variant from the scalable drawings."""
    names = sorted(f for f in os.listdir(SIZES[24]) if f.endswith("-symbolic.svg"))
    os.makedirs(SIZES[16], exist_ok=True)
    stale = [f for f in os.listdir(SIZES[16]) if f not in names]
    wrong = []
    for f in names:
        body = convert(os.path.join(SIZES[24], f), 16)
        target = os.path.join(SIZES[16], f)
        current = open(target, "rb").read() if os.path.exists(target) else None
        if current == body:
            continue
        wrong.append(f)
        if not check:
            with open(target, "wb") as fp:
                fp.write(body)
    if not check:
        for f in stale:
            os.unlink(os.path.join(SIZES[16], f))
        print(f"16x16/actions: {len(names)} drawings, {len(wrong)} rewritten, {len(stale)} removed")
        return 0
    for f in wrong:
        print(f"  ✗ 16x16/actions/{f} is not what the scalable drawing converts to")
    for f in stale:
        print(f"  ✗ 16x16/actions/{f} has no scalable drawing")
    if wrong or stale:
        print("Run scripts/icons/nidara-icons.py sync and commit the result.")
        return 1
    print(f"16x16/actions matches scalable/actions ({len(names)} drawings)")
    return 0


def add(source, name):
    if not name.startswith("nd-") or name.endswith("-symbolic") or name.endswith(".svg"):
        sys.exit(f"{name!r}: give the bare spec name, e.g. nd-cpu")
    for size, directory in SIZES.items():
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, f"{name}-symbolic.svg"), "wb") as fp:
            fp.write(convert(source, size))
    print(f"wrote {name}-symbolic.svg in both sizes — now add it to ICON_NAMES and SPEC.md")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Maintain the Nidara icon theme.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_sync = sub.add_parser("sync", help="derive 16x16/actions from scalable/actions")
    p_sync.add_argument("--check", action="store_true", help="verify only; exit 1 on drift")
    p_add = sub.add_parser("add", help="convert a stroke SVG into both sizes under an nd- name")
    p_add.add_argument("source")
    p_add.add_argument("name")
    args = ap.parse_args()
    return sync(args.check) if args.cmd == "sync" else add(args.source, args.name)


if __name__ == "__main__":
    sys.exit(main())
