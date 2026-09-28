#!/usr/bin/env bash
set -euo pipefail

UXPLAY_VERSION="${UXPLAY_VERSION:-v1.73.7}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is intended for Raspberry Pi OS or another Debian-based Linux." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get was not found; install UxPlay using your distribution's instructions." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  avahi-daemon \
  avahi-utils \
  build-essential \
  cmake \
  git \
  gstreamer1.0-alsa \
  gstreamer1.0-gl \
  gstreamer1.0-libav \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-pulseaudio \
  gstreamer1.0-tools \
  gstreamer1.0-x \
  libavahi-compat-libdnssd-dev \
  libgstreamer-plugins-base1.0-dev \
  libgstreamer1.0-dev \
  libplist-dev \
  libsodium-dev \
  libssl-dev \
  libx11-dev \
  pkg-config

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

git clone --depth 1 --branch "$UXPLAY_VERSION" https://github.com/FDH2/UxPlay.git "$build_dir/UxPlay"
cmake -S "$build_dir/UxPlay" -B "$build_dir/UxPlay/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir/UxPlay/build" --parallel "$(nproc)"
sudo cmake --install "$build_dir/UxPlay/build"
sudo systemctl enable --now avahi-daemon

echo "Installed $(command -v uxplay) from UxPlay $UXPLAY_VERSION"
