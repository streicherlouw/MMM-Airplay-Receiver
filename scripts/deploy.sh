#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--install-uxplay] [--restart] [user@]host [MagicMirror directory]" >&2
}

install_uxplay=0
restart_magicmirror=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-uxplay) install_uxplay=1; shift ;;
    --restart) restart_magicmirror=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) usage; exit 2 ;;
    *) break ;;
  esac
done

remote="${1:-artwall1.local}"
magicmirror_dir="${2:-MagicMirror}"
module_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

remote_home="$(ssh "$remote" 'printf %s "$HOME"')"
if [[ "$magicmirror_dir" = /* ]]; then
  remote_mm="$magicmirror_dir"
else
  remote_mm="$remote_home/$magicmirror_dir"
fi
remote_target="$remote_mm/modules/MMM-Airplay-Receiver"

ssh "$remote" mkdir -p "$remote_target/lib" "$remote_target/scripts" "$remote_target/systemd"
scp \
  "$module_root/MMM-Airplay-Receiver.js" \
  "$module_root/MMM-Airplay-Receiver.css" \
  "$module_root/node_helper.js" \
  "$module_root/receiver_daemon.js" \
  "$module_root/receiver-daemon.config.json" \
  "$module_root/package.json" \
  "$module_root/README.md" \
  "$module_root/LICENSE" \
  "$remote:$remote_target/"
scp "$module_root/lib/uxplay.js" "$module_root/lib/daemon-events.js" "$remote:$remote_target/lib/"
scp \
  "$module_root/scripts/install-uxplay.sh" \
  "$module_root/scripts/enable-module.mjs" \
  "$module_root/scripts/update-module-config.mjs" \
  "$module_root/scripts/install-service.sh" \
  "$remote:$remote_target/scripts/"
scp "$module_root/systemd/mmm-airplay-receiver.service" "$remote:$remote_target/systemd/"

ssh "$remote" chmod +x "$remote_target/scripts/install-uxplay.sh" "$remote_target/scripts/install-service.sh"

if ! ssh "$remote" command -v uxplay >/dev/null 2>&1; then
  if [[ "$install_uxplay" -eq 1 ]]; then
    ssh -t "$remote" "$remote_target/scripts/install-uxplay.sh"
  else
    echo "UxPlay is not installed. Re-run with --install-uxplay." >&2
    exit 3
  fi
fi

ssh "$remote" node --check "$remote_target/MMM-Airplay-Receiver.js"
ssh "$remote" node --check "$remote_target/node_helper.js"
ssh "$remote" node --check "$remote_target/receiver_daemon.js"
ssh "$remote" node --check "$remote_target/lib/uxplay.js"
ssh "$remote" node --check "$remote_target/lib/daemon-events.js"

if [[ "$restart_magicmirror" -eq 1 ]]; then
  ssh "$remote" sh -s <<'REMOTE_RESTART'
set -eu
if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 was not found; restart MagicMirror using its normal service manager." >&2
  exit 4
fi
for process_name in MagicMirror magicmirror mm; do
  if pm2 describe "$process_name" >/dev/null 2>&1; then
    pm2 restart "$process_name"
    exit 0
  fi
done
echo "No common MagicMirror PM2 process name was found; restart it manually." >&2
exit 4
REMOTE_RESTART
fi

echo "Deployed MMM-Airplay-Receiver to $remote:$remote_target"
echo "Add the module entry from README.md to $remote_mm/config/config.js, then restart MagicMirror."
