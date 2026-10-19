#!/bin/sh
# load-vkms.sh — the kernel's virtual KMS device on a GitHub Ubuntu runner, for the smokes.
#
# vkms comes in linux-modules-extra-<running kernel> — on most images. On 2026-10-19 some runners
# (image ubuntu-24.04 20261012) booted 7.0.0-1017-azure, a kernel the archive publishes no
# linux-modules-extra for at all: every attempt failed with "Unable to locate package", which
# apt.sh reported as a mirror not answering, and re-running only helped by landing on another
# runner. So: the module as the kernel already has it; else the package; else say what is wrong.
set -u
k=$(uname -r)
pkg="linux-modules-extra-$k"
if ! sudo modprobe vkms 2>/dev/null; then
    sudo timeout 240 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update -qq || true
    if ! apt-cache show "$pkg" >/dev/null 2>&1; then
        echo "::error::this runner's kernel $k has no vkms, and the archive has no $pkg: the runner image, not the change — a re-run lands on another runner"
        exit 1
    fi
    scripts/ci/apt.sh install "$pkg" && sudo modprobe vkms || exit 1
fi
ls -l /dev/dri
