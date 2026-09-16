#!/usr/bin/env python3
"""
icon-theme-sheet — draw icon-theme-audit.js's output as contact sheets.

    python3 scripts/dev/icon-theme-sheet.py <audit.tsv> <out prefix> [rows per sheet]

One row per interface icon: Nidara's own drawing, then one column per theme.
A YELLOW cell is a theme with no usable drawing for that name — the shell shows
ours there. Glyphs are drawn from their alpha, so every theme reads black on
white whatever colour its file carries. Needs rsvg-convert and ImageMagick.
Read it for MEANING, not just for style: a name is right when every column draws
the same idea (see the header of icon-theme-audit.js for what that has caught).
"""
import os, subprocess, sys, tempfile

tsv, prefix = sys.argv[1], sys.argv[2]
per = int(sys.argv[3]) if len(sys.argv) > 3 else 25
ASSETS = "ui/shell/assets/icons/hicolor/scalable/actions"

names, themes, res = [], [], {}
for line in open(tsv):
    n, th, path = line.rstrip("\n").split("\t")
    if n not in names: names.append(n)
    if th not in themes: themes.append(th)
    res[(n, th)] = path

tmp = tempfile.mkdtemp()
run = lambda *a: subprocess.run(a, check=True)

def glyph(src, out, bg="white"):
    subprocess.run(f'rsvg-convert -w 40 -h 40 "{src}" | magick - -alpha extract -negate '
                   f'-bordercolor white -border 6 -fill "{bg}" -opaque white "{out}"', shell=True, check=True)

rows = []
for i, n in enumerate(names):
    parts = [f"{tmp}/l{i}.png"]
    run("magick", "-size", "300x52", "xc:white", "-gravity", "west", "-pointsize", "15", "-annotate", "+6+0", n, parts[0])
    own = f"{ASSETS}/{n}-symbolic.svg"
    glyph(own, f"{tmp}/o{i}.png"); parts.append(f"{tmp}/o{i}.png")
    for j, th in enumerate(themes):
        c = f"{tmp}/c{i}_{j}.png"
        path = res.get((n, th), "")
        glyph(path, c) if path else glyph(own, c, bg="#ffe28a")
        parts.append(c)
    rows.append(f"{tmp}/r{i}.png"); run("magick", *parts, "+append", rows[-1])

head = [f"{tmp}/h.png"]; run("magick", "-size", "300x30", "xc:white", head[0])
for k, t in enumerate(["Nidara"] + themes):
    head.append(f"{tmp}/h{k}.png")
    run("magick", "-size", "52x30", "xc:white", "-gravity", "center", "-pointsize", "9", "-annotate", "0", t[:10], head[-1])
run("magick", *head, "+append", f"{tmp}/head.png")
for p in range(0, len(rows), per):
    out = f"{prefix}-{p // per + 1}.png"
    run("magick", f"{tmp}/head.png", *rows[p:p + per], "-append", out)
    print(out)
