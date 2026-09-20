#!/usr/bin/env bash
# qt-platformtheme-probe.sh — what a Qt application actually gets from this desktop,
# under each candidate `QT_QPA_PLATFORMTHEME`, on the RUNNING session.
#
# Qt reads NOTHING of GTK's settings.ini by itself, so everything a Qt app knows about
# this desktop arrives through its platform theme plugin. The two candidates trade
# against each other and the trade is not obvious, so it gets measured rather than
# reasoned about. What this prints, per plugin:
#
#   1. icon theme + whether a plain `folder` icon resolves at all
#   2. the default application font
#   3. whether `QStyleHints::colorSchemeChanged` arrives on a live mode change,
#      and whether the palette is invalidated with it
#   4. which PROCESS owns the file dialog (the portal's, or one inside the Qt app)
#      and whether libgtk-3 ends up mapped into that Qt process
#
# 🔑 THE TRAP THIS SCRIPT EXISTS FOR — the delay in step 4 is load-bearing.
# The `xdgdesktopportal` plugin asks the portal for its FileChooser version over
# D-Bus ASYNCHRONOUSLY at start-up, and falls back to Qt's own widget dialog if the
# dialog is opened before that answer lands. A probe that opens the dialog immediately
# measures the race and reports "no portal dialog" under BOTH plugins — which is
# exactly the wrong answer, and it was reported to the owner once (2026-09-21) before
# the delay was added. Do not shorten DIALOG_DELAY_MS.
#
# Control: every measurement is taken with BOTH plugins from the same binary. A row
# that reads the same under both is a row this probe cannot see — not a row that ties.
#
# Usage:  scripts/dev/qt-platformtheme-probe.sh            # steps 1-2 only (no windows)
#         scripts/dev/qt-platformtheme-probe.sh --dialogs  # also step 4 (opens windows)
#
# Needs: qt6-base + its headers, g++, pkg-config, and a running Nidara session for
# `nidara-ipc listWindows` in step 4.

set -euo pipefail

DIALOG_DELAY_MS=2500
THEMES=(xdgdesktopportal gtk3)
work="$(mktemp -d)"
trap 'rm -rf "$work"; for p in ${PIDS:-}; do kill "$p" 2>/dev/null || true; done' EXIT
PIDS=""

if ! pkg-config --exists Qt6Gui Qt6Widgets; then
    echo "qt6-base development files not found (pkg-config Qt6Gui Qt6Widgets) — install qt6-base" >&2
    exit 1
fi

# ── steps 1-2: what the plugin hands a Qt app ────────────────────────────────
cat > "$work/hints.cpp" <<'EOF'
#include <QGuiApplication>
#include <QIcon>
#include <QFont>
#include <cstdio>
int main(int argc, char **argv) {
    QGuiApplication app(argc, argv);
    printf("  icon theme        : %s\n", QIcon::themeName().toUtf8().constData());
    printf("  hasThemeIcon(folder): %d\n", (int)QIcon::hasThemeIcon("folder"));
    printf("  default font      : %s\n", QGuiApplication::font().toString().section(',', 0, 1).toUtf8().constData());
    return 0;
}
EOF
g++ -fPIC -o "$work/hints" "$work/hints.cpp" $(pkg-config --cflags --libs Qt6Gui Qt6Core)

echo "=== 1-2 · icon theme and font, per plugin"
for t in "${THEMES[@]}"; do
    echo "QT_QPA_PLATFORMTHEME=$t"
    QT_QPA_PLATFORMTHEME="$t" "$work/hints" 2>/dev/null
done

# ── step 3: does a live mode change reach Qt, and does the palette move? ─────
cat > "$work/watch.cpp" <<'EOF'
#include <QGuiApplication>
#include <QStyleHints>
#include <QTimer>
#include <QPalette>
#include <cstdio>
static const char *cs(Qt::ColorScheme s) {
    switch (s) { case Qt::ColorScheme::Dark: return "Dark";
                 case Qt::ColorScheme::Light: return "Light";
                 default: return "Unknown"; }
}
int main(int argc, char **argv) {
    QGuiApplication app(argc, argv);
    auto *h = QGuiApplication::styleHints();
    printf("  start: colorScheme=%s windowBg=%s\n", cs(h->colorScheme()),
           QGuiApplication::palette().color(QPalette::Window).name().toUtf8().constData());
    fflush(stdout);
    QObject::connect(h, &QStyleHints::colorSchemeChanged, [](Qt::ColorScheme s) {
        printf("  signal: colorSchemeChanged -> %s  windowBg=%s\n", cs(s),
               QGuiApplication::palette().color(QPalette::Window).name().toUtf8().constData());
        fflush(stdout);
    });
    QTimer::singleShot(12000, &app, &QGuiApplication::quit);
    return app.exec();
}
EOF
g++ -fPIC -o "$work/watch" "$work/watch.cpp" $(pkg-config --cflags --libs Qt6Gui Qt6Core)

echo
echo "=== 3 · live mode change (both plugins listen at once)"
if command -v nidara-ipc >/dev/null 2>&1; then
    was=$(nidara-ipc getConfig appearance.darkMode 2>/dev/null | grep -o 'true\|false' | head -1)
    for t in "${THEMES[@]}"; do
        QT_QPA_PLATFORMTHEME="$t" "$work/watch" > "$work/watch-$t.log" 2>/dev/null &
        PIDS="$PIDS $!"
    done
    # give both a moment to settle, then flip and flip back
    "$work/hints" >/dev/null 2>&1 || true
    [ "$was" = "true" ] && other=false || other=true
    nidara-ipc setConfig appearance.darkMode "$other" >/dev/null 2>&1 || true
    "$work/hints" >/dev/null 2>&1 || true
    nidara-ipc setConfig appearance.darkMode "$was" >/dev/null 2>&1 || true
    for t in "${THEMES[@]}"; do
        echo "QT_QPA_PLATFORMTHEME=$t"
        cat "$work/watch-$t.log" 2>/dev/null | grep -vE '^(qt\.|Warning)' || echo "  (nada)"
    done
else
    echo "  nidara-ipc not on PATH — skipped"
fi

# ── step 4: who owns the file dialog ─────────────────────────────────────────
if [ "${1:-}" != "--dialogs" ]; then
    echo
    echo "=== 4 · file dialog — skipped (pass --dialogs; it opens real windows)"
    exit 0
fi

sed "s/__DELAY__/$DIALOG_DELAY_MS/" > "$work/fd.cpp" <<'EOF'
#include <QApplication>
#include <QFileDialog>
#include <QTimer>
// The delay is the point — see the header of qt-platformtheme-probe.sh.
int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QTimer::singleShot(__DELAY__, [] {
        QFileDialog::getOpenFileName(nullptr, "NIDARA-QT-PROBE", QDir::homePath());
    });
    return app.exec();
}
EOF
g++ -fPIC -o "$work/fd" "$work/fd.cpp" $(pkg-config --cflags --libs Qt6Widgets Qt6Gui Qt6Core)

echo
echo "=== 4 · which process owns the file dialog (delay ${DIALOG_DELAY_MS}ms)"
for t in "${THEMES[@]}"; do
    QT_QPA_PLATFORMTHEME="$t" "$work/fd" >/dev/null 2>&1 &
    pid=$!
    # Poll for the window rather than guessing a fixed wait — but the budget MUST
    # outlast DIALOG_DELAY_MS with room to spare, or this reports "<no apareció>"
    # for both plugins and looks like a tie. That was the first version's bug.
    owner=""
    for _ in $(seq 1 60); do
        python3 -c "import time; time.sleep(0.25)"
        owner=$(nidara-ipc listWindows 2>/dev/null \
            | python3 -c "import json,sys
try:
    for w in json.load(sys.stdin):
        if 'NIDARA-QT-PROBE' in (w.get('title') or ''):
            print(w.get('class')); break
except Exception: pass" || true)
        [ -n "$owner" ] && break
    done
    gtk3_maps=$(grep -c libgtk-3 "/proc/$pid/maps" 2>/dev/null || true)
    gtk3_maps=${gtk3_maps:-0}
    echo "QT_QPA_PLATFORMTHEME=$t"
    echo "  dialog window class : ${owner:-<no apareció>}"
    echo "  libgtk-3 in Qt proc : $gtk3_maps mapping(s)"
    kill "$pid" 2>/dev/null || true
done
