# MMM-Airplay-Receiver

Mirror an iPhone, iPad, or Mac to a MagicMirror display on Raspberry Pi. The
MagicMirror module starts and monitors
[UxPlay](https://github.com/FDH2/UxPlay), advertises the receiver on the local
network, shows connection status, and automatically restarts the receiver if
it exits.

UxPlay renders the stream in a native full-screen window over MagicMirror.
When mirroring stops, `-nofreeze` closes that window and reveals the mirror
again. This avoids routing real-time H.264 video through the MagicMirror web
view and gives the Pi access to GStreamer hardware acceleration.

## Requirements

- Raspberry Pi OS or another Linux installation with a graphical session
- MagicMirror²
- Node.js 18 or newer (current MagicMirror releases already satisfy this)
- UxPlay 1.73 or newer and its GStreamer plugins
- The Pi and iPhone on the same local network

## Install on the Pi

Copy this directory to `~/MagicMirror/modules/MMM-Airplay-Receiver`. If UxPlay
is not already installed, run:

```bash
cd ~/MagicMirror/modules/MMM-Airplay-Receiver
./scripts/install-uxplay.sh
```

The installer builds the current tested UxPlay release and enables Avahi for
AirPlay discovery. It uses `sudo` for Debian packages and installation under
`/usr/local`.

Add the following object inside the `modules` array in
`~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-Airplay-Receiver",
  position: "top_center",
  config: {
    receiverName: "Art Wall",
    pin: false
  }
},
```

Restart MagicMirror. On the iPhone, open Control Centre, choose **Screen
Mirroring**, and select **Art Wall**.

PIN pairing is off by default. UxPlay still supports a PIN request made by a
managed device for compatibility. Set `pin: true` only when you want every new
device to pair with a one-time PIN, or set a four-digit string such as
`pin: "4821"` for a fixed PIN.

## Deploy from another machine

Set up SSH key authentication first, then run from this repository:

```bash
./scripts/deploy.sh --install-uxplay streicher@artwall1.local
```

If UxPlay is already installed, omit `--install-uxplay`. Add `--restart` when
MagicMirror is managed by PM2 under one of the common process names
`MagicMirror`, `magicmirror`, or `mm`.

The deployment script copies only this module. It deliberately does not edit
`config.js`, because that file often contains private calendars, tokens, and
local customizations.

After reviewing your configuration, the included helper can add the standard
module entry while retaining a timestamped backup:

```bash
node scripts/enable-module.mjs ~/MagicMirror/config/config.js "Art Wall" waylandsink
```

Existing module settings can be changed with a validated JSON patch. This also
creates a timestamped backup before replacing the config file:

```bash
node scripts/update-module-config.mjs ~/MagicMirror/config/config.js '{"fullscreen":false}'
```

### External service mode

On a Wayland-based mirror, UxPlay can run independently from MagicMirror and
temporarily stop the `MagicMirror` PM2 process while an iPhone is mirroring.
This frees the compositor for the AirPlay video window and automatically
restores MagicMirror after the phone disconnects:

```bash
node scripts/update-module-config.mjs ~/MagicMirror/config/config.js \
  '{"externalService":true,"externalStatusFile":"/run/user/1000/mmm-airplay-receiver-status.json"}'
./scripts/install-service.sh
pm2 restart MagicMirror
```

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `receiverName` | `"Magic Mirror"` | Name shown in the iPhone Screen Mirroring list |
| `externalService` | `false` | Monitor an independently managed receiver service |
| `externalStatusFile` | automatic | Status file written by the external receiver |
| `fullscreen` | `true` | Ask UxPlay to cover the display while mirroring |
| `pin` | `false` | `false`, `true` for a one-time PIN, or a four-digit string |
| `persistTrustedClients` | `true` | Remember clients authenticated with PIN pairing |
| `port` | `7000` | First of three consecutive TCP/UDP ports used by UxPlay |
| `resolution` | automatic | Requested stream size and refresh rate, e.g. `"1280x720@60"` |
| `fps` | `30` | Maximum advertised frame rate |
| `lowLatency` | `true` | Prefer immediate screen response over timestamp A/V sync |
| `videoSink` | automatic | GStreamer sink, e.g. `"waylandsink"` or `"glimagesink"` |
| `audioSink` | automatic | GStreamer sink, e.g. `"pipewiresink"` |
| `display` | `":0"` | X11 display used by the MagicMirror graphical session |
| `waylandDisplay` | detected | Wayland socket override, e.g. `"wayland-0"` |
| `xdgRuntimeDir` | inherited | Wayland runtime directory override |
| `inhibitScreensaver` | `false` | Use UxPlay's D-Bus screensaver inhibitor |
| `useBt709` | `false` | Enable Pi 4-and-earlier color workaround if colors are wrong |
| `allowTakeover` | `false` | Let a new client disconnect the current client |
| `restartOnExit` | `true` | Restart UxPlay after an unexpected exit |
| `extraArgs` | `[]` | Additional UxPlay arguments, passed directly without a shell |
| `showStatus` | `false` | Show an AirPlay availability/status tile in MagicMirror |

For Raspberry Pi OS using native Wayland, try `videoSink: "waylandsink"`. For
an X11/XWayland desktop, the automatic sink or `"glimagesink"` is usually the
best choice.

## Notifications

The module broadcasts `AIRPLAY_RECEIVER_STATUS` and
`AIRPLAY_RECEIVER_PIN`. Other modules can send `AIRPLAY_RECEIVER_START`,
`AIRPLAY_RECEIVER_STOP`, or `AIRPLAY_RECEIVER_RESTART`.

## Troubleshooting

- Receiver not visible: verify `systemctl status avahi-daemon` and that UDP
  5353 is not blocked.
- Receiver visible but connection fails: allow TCP and UDP ports 7000–7002, or
  change `port` and allow the matching three-port range.
- UxPlay says it cannot open a display: confirm whether the graphical session
  uses `DISPLAY=:0`; set `display` and, if required, `xAuthority` accordingly.
- Blank video on Wayland: set `videoSink: "waylandsink"`.
- Incorrect colors on a Pi 4 or older: set `useBt709: true`.
- Choppy video on a low-power Pi: lower `fps` to 20 or 15.
- For smoother 60 fps playback with hardware decoding, set `fps: 60`, use
  timestamp synchronization (`lowLatency: false`), and keep the video sink synchronized.
- For one profile shared by iPhone/iPad video and macOS desktop mirroring, keep
  `fps: 60` but use immediate rendering (`lowLatency: true` and sink `sync=false`);
  this avoids macOS desktop-transition frames being discarded as late.
- High interaction latency: use `lowLatency: true`, request `resolution: "1280x720@60"`,
  and set a sink such as `"waylandsink sync=false async=false"`.
- To cover a Wayland display without exposing the desktop, add the native sink
  property `fullscreen=true`, for example `"waylandsink fullscreen=true sync=false"`.
- On a Pi 4 with unstable automatic V4L2 buffer negotiation, use
  `extraArgs: ["-vd", "v4l2h264dec capture-io-mode=mmap output-io-mode=mmap", "-vc", "videoconvert"]`.

View the MagicMirror/PM2 logs to see UxPlay output and receiver lifecycle
events.
