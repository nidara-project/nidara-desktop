#!/usr/bin/env python3
"""
build-icon-theme.py — build Nidara's shipped symbolic icon theme (#587).

    scripts/icons/build-icon-theme.py --src <lucide-static dir> --out <theme dir>

Turns the `lucide-static` npm package into a real Linux icon theme: symbolic
files GTK recolours, under freedesktop standard names, in the two sizes the shell
actually asks for. It is the theme a user can pick as their INTERFACE icon theme,
and the last link of the chain in `ui/shell/core/Icons.ts` when their own theme
has no icon for a concept.

── What it does, and why each step exists ──────────────────────────────────────

1. **Symbolic classes.** Lucide's SVGs are stroke drawings with
   `stroke="currentColor"`, which GTK does NOT recolour: it only recolours a file
   whose name ends in `-symbolic`, and then only by the symbolic classes. So every
   shape gets `foreground-stroke` plus either `transparent-fill` or
   `foreground-fill`, decided from the fill it EFFECTIVELY has — its own, or the
   root's, which is where `record-stop` keeps it. Without the classes a
   stroke-only icon renders as a filled blob (measured, GTK 4.22.5).

2. **The 16-unit variant.** GTK forces symbolic strokes to 2 SVG USER UNITS, so a
   24-unit drawing shown at 16px has a 1.33px stroke and reads thin in the bar.
   Rewriting the coordinates to a 16-unit viewBox gives a real 2px there. A
   `<g transform="scale(…)">` does NOT work — the stroke scales with it.
   ⚠️ Measured: that variant only wins at 12–16px and scale 1. At 18px, and at any
   size on a scale-2 display, GTK takes the scalable one. The bar's 18px icons
   therefore keep the thin stroke, and HiDPI loses the heavy one entirely.

3. **Deduplication.** Lucide ships the same drawing under several names. Identical
   output becomes a relative symlink to the first name, which is what keeps the
   theme from being three times its size.

4. **Standard names.** `aliases.csv` maps a freedesktop name to the Lucide drawing
   that means it — the 83 our own registry asks for first, then the exact matches
   from the icon study. Each alias is a symlink IN BOTH SIZE DIRECTORIES.
   ⚠️ The study's first pass wrote them only into `scalable/`, so at 16px GTK
   silently fell back to the thin drawing. Both, always.

5. **Nidara's own drawings.** `scripts/icons/nidara/*.svg` are merged in as extra
   sources. Two icons live there because they are our edits, not stock Lucide:
   `record` (a filled dot) and `record-stop` (a filled square).

The build is deterministic: same inputs, byte-identical tree.
"""

import argparse
import csv
import hashlib
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SVG_NS = "http://www.w3.org/2000/svg"

# 16/24. The scalable drawings are 24 units; the small variant is 16.
SCALE = 16.0 / 24.0

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
        attrs.pop("class", None)
        classes = symbolic_classes(attrs, root_fill, root_stroke)
        if scale:
            scale_shape(tag, attrs)
        attrs["class"] = classes
        ET.SubElement(out, tag, attrs)

    ET.indent(out, space="  ")
    return ET.tostring(out, encoding="utf-8", xml_declaration=False) + b"\n"


# ── the theme tree ──────────────────────────────────────────────────────────

INDEX_THEME = """[Icon Theme]
Name={name}
Comment={comment}
Inherits=Adwaita,hicolor
Directories=16x16/actions,scalable/actions

[16x16/actions]
Context=Actions
Size=16
Type=Fixed

[scalable/actions]
Context=Actions
Size=24
MinSize=16
MaxSize=512
Type=Scalable
"""

NOTICE = """{name}
{underline}

An icon theme built for the Nidara desktop environment from the Lucide icon set
(https://lucide.dev), which is a community fork of Feather Icons. The drawings
are Lucide's, converted to freedesktop symbolic icons and renamed to standard
icon names by scripts/icons/build-icon-theme.py in the Nidara repository.

This theme is NOT an official Lucide release and is not endorsed by the Lucide
project. Please report anything wrong with the conversion or the naming to
Nidara, not to Lucide.

Built from lucide-static {version}. Licence: ISC, plus MIT for the icons
inherited from Feather — see LICENSE, which is Lucide's own, shipped unchanged.
"""


def link(path, target):
    """A relative symlink at `path` pointing at `target` in the same directory."""
    if os.path.lexists(path):
        os.unlink(path)
    os.symlink(target, path)


def main():
    ap = argparse.ArgumentParser(description="Build Nidara's symbolic icon theme.")
    ap.add_argument("--src", required=True,
                    help="the unpacked lucide-static package (the dir holding icons/)")
    ap.add_argument("--out", required=True, help="theme directory to write")
    ap.add_argument("--aliases", default=os.path.join(HERE, "aliases.csv"))
    ap.add_argument("--own", default=os.path.join(HERE, "nidara"),
                    help="Nidara's own source drawings, merged in as extra icons")
    ap.add_argument("--name", default="Nidara Symbolic")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    say = (lambda *a: None) if args.quiet else print

    icons_dir = os.path.join(args.src, "icons")
    if not os.path.isdir(icons_dir):
        sys.exit(f"no icons/ under {args.src} — is that the lucide-static package?")

    version = "unknown"
    pkg = os.path.join(args.src, "package.json")
    if os.path.exists(pkg):
        import json
        version = json.load(open(pkg)).get("version", "unknown")

    # Sources: Lucide's, then ours — ours win, so a name we redraw is ours.
    sources = {f[:-4]: os.path.join(icons_dir, f)
               for f in sorted(os.listdir(icons_dir)) if f.endswith(".svg")}
    own = 0
    if os.path.isdir(args.own):
        for f in sorted(os.listdir(args.own)):
            if f.endswith(".svg"):
                sources[f[:-4]] = os.path.join(args.own, f)
                own += 1
    say(f"{len(sources)} source drawings ({own} of them Nidara's own), lucide-static {version}")

    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    dirs = {24: os.path.join(args.out, "scalable", "actions"),
            16: os.path.join(args.out, "16x16", "actions")}
    for d in dirs.values():
        os.makedirs(d)

    # ── convert, deduplicating by content ────────────────────────────────────
    # A name whose converted bytes match one already written becomes a symlink to
    # it. The canonical name is the first in sorted order, so the choice is stable
    # across builds.
    canonical = {}   # digest → the name that owns the file
    written, linked = 0, 0
    for name, path in sorted(sources.items()):
        try:
            bodies = {size: convert(path, size) for size in (24, 16)}
        except Exception as e:                      # one bad drawing is not a build
            say(f"  skipped {name}: {e}")
            continue
        digest = hashlib.sha256(bodies[24] + bodies[16]).hexdigest()
        target = canonical.get(digest)
        if target is None:
            canonical[digest] = name
            for size, body in bodies.items():
                with open(os.path.join(dirs[size], f"{name}-symbolic.svg"), "wb") as fp:
                    fp.write(body)
            written += 1
        else:
            for size in dirs:
                link(os.path.join(dirs[size], f"{name}-symbolic.svg"),
                     f"{target}-symbolic.svg")
            linked += 1
    say(f"{written} distinct drawings, {linked} duplicate names linked to them")

    # ── standard names ───────────────────────────────────────────────────────
    aliased, missing = 0, []
    with open(args.aliases) as fp:
        for row in csv.DictReader(fp):
            std, lucide = row["standard_name"], row["lucide_icon"]
            if std == lucide or not lucide:
                continue
            if lucide not in sources:
                missing.append((std, lucide))
                continue
            for size in dirs:
                link(os.path.join(dirs[size], f"{std}-symbolic.svg"),
                     f"{lucide}-symbolic.svg")
            aliased += 1
    say(f"{aliased} standard names aliased in BOTH size directories")
    for std, lucide in missing:
        say(f"  !! {std} wants {lucide!r}, which is not a source drawing")

    # ── metadata ─────────────────────────────────────────────────────────────
    with open(os.path.join(args.out, "index.theme"), "w") as fp:
        fp.write(INDEX_THEME.format(
            name=args.name,
            comment=f"Symbolic icons for Nidara, built from Lucide {version}"))
    with open(os.path.join(args.out, "VERSION"), "w") as fp:
        fp.write(f"lucide-static {version}\n")
    with open(os.path.join(args.out, "NOTICE"), "w") as fp:
        fp.write(NOTICE.format(name=args.name, underline="=" * len(args.name),
                               version=version))
    licence = os.path.join(args.src, "LICENSE")
    if os.path.exists(licence):
        shutil.copyfile(licence, os.path.join(args.out, "LICENSE"))
    else:
        say("  !! no LICENSE in the source package — the theme must ship Lucide's")

    # ── a broken link is a hole on screen, so refuse to finish with one ──────
    broken = [os.path.join(d, e) for d in dirs.values() for e in os.listdir(d)
              if os.path.islink(os.path.join(d, e))
              and not os.path.exists(os.path.join(d, e))]
    if broken:
        for b in broken[:10]:
            print(f"BROKEN LINK {b}", file=sys.stderr)
        sys.exit(f"{len(broken)} broken links in {args.out}")

    say(f"theme written to {args.out}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
