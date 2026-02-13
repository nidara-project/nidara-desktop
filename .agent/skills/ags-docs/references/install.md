# AGS Installation Guide

## Arch Linux
Maintainer: [@kotontrion](https://github.com/kotontrion)

```bash
yay -S aylurs-gtk-shell-git
```

## Nix
Maintainer: [@Aylur](https://github.com/Aylur)

```bash
nix shell github:aylur/ags
```

Read more about running AGS on [Nix](nix.md)

## From Source
1. Install [Astal packages](https://aylur.github.io/astal/guide/installation): `astal-io`, `astal3`, `astal4`.
2. Install dependencies:
   - **Arch**: `sudo pacman -Syu npm meson ninja go gobject-introspection gtk3 gtk-layer-shell gtk4 gtk4-layer-shell`
   - **Fedora**: `sudo dnf install npm meson ninja golang gobject-introspection-devel gtk3-devel gtk-layer-shell-devel gtk4-devel gtk4-layer-shell-devel`
3. Clone and install AGS:
```bash
git clone https://github.com/aylur/ags.git
cd ags
npm install
meson setup build
meson install -C build # Installs to /usr/local by default
```
