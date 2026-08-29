# Nidara Plymouth theme — parked, on purpose

Nothing in this repository installs these files, and that is not an oversight.

A boot splash is the **product's** branding, not the desktop's. `install.sh` puts Nidara
Desktop on an Arch somebody already uses, and repainting their boot is exactly what it must
not do — GNOME Shell does not depend on Plymouth; Ubuntu ships a Plymouth theme.

So the theme is waiting for **`nidara-system`**, a package in `nidara-iso` that does not exist
yet. See `nidara-iso/PRODUCT.md`, "Four layers, and the third one had no owner", for the
decision and the ordered work.

⚠️ **Do not re-wire these into `packaging/nidara/PKGBUILD`, `install.sh` or `bin/nidara-setup`.**
That is where they were between 2026-08-27 and 2026-08-30, and it is the mistake this note
exists to stop repeating. When `nidara-system` is created, these files move to it — they do not
get copied into it, or there will be two themes to keep in step.

Until that package exists, no machine has a boot splash. That was also true for every day
before the theme was written: `plymouth` was never in any dependency list, so it never rendered
on a real installation.
