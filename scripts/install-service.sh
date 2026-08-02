#!/usr/bin/env bash
set -euo pipefail

module_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
user_unit_dir="$HOME/.config/systemd/user"

mkdir -p "$user_unit_dir"
install -m 0644 "$module_root/systemd/mmm-airplay-receiver.service" "$user_unit_dir/mmm-airplay-receiver.service"
systemctl --user daemon-reload
systemctl --user enable --now mmm-airplay-receiver.service

echo "Installed and started the external MMM-Airplay-Receiver service."
