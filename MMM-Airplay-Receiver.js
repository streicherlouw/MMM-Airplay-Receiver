/* global Module */

Module.register("MMM-Airplay-Receiver", {
  defaults: {
    receiverName: "Magic Mirror",
    uxplayPath: "uxplay",
    autoStart: true,
    externalService: false,
    externalStatusFile: null,
    fullscreen: true,
    pin: false,
    persistTrustedClients: true,
    port: 7000,
    resolution: null,
    fps: 30,
    lowLatency: true,
    noFreeze: true,
    inhibitScreensaver: false,
    appendHostname: false,
    videoSink: null,
    audioSink: null,
    display: ":0",
    waylandDisplay: null,
    xdgRuntimeDir: null,
    dbusSessionBusAddress: null,
    xAuthority: null,
    useBt709: false,
    allowTakeover: false,
    restartOnExit: true,
    restartDelay: 5000,
    extraArgs: [],
    showStatus: false,
    hideStatusWhileStreaming: true
  },

  start() {
    this.receiverStatus = {
      state: this.config.autoStart ? "STARTING" : "STOPPED",
      message: this.config.autoStart ? "Starting AirPlay…" : "AirPlay is stopped"
    };
    this.pin = null;
    this.sendSocketNotification("AIRPLAY_CONFIG", this.config);
  },

  getStyles() {
    return ["MMM-Airplay-Receiver.css", "font-awesome.css"];
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = `airplay-receiver airplay-${this.receiverStatus.state.toLowerCase()}`;

    if (!this.config.showStatus) {
      wrapper.classList.add("airplay-hidden");
      return wrapper;
    }

    const row = document.createElement("div");
    row.className = "airplay-status-row";

    const icon = document.createElement("span");
    icon.className = "fa fa-brands fa-airplay airplay-icon";
    icon.setAttribute("aria-hidden", "true");
    // Font Awesome versions bundled with older MagicMirror releases do not
    // include the AirPlay glyph, so the text fallback remains visible.
    icon.textContent = "◫";

    const text = document.createElement("div");
    text.className = "airplay-copy";

    const title = document.createElement("div");
    title.className = "airplay-title bright";
    title.textContent = this.statusTitle();
    text.appendChild(title);

    const detail = document.createElement("div");
    detail.className = "airplay-detail dimmed small";
    detail.textContent = this.statusDetail();
    text.appendChild(detail);

    row.appendChild(icon);
    row.appendChild(text);
    wrapper.appendChild(row);

    if (this.pin) {
      const pin = document.createElement("div");
      pin.className = "airplay-pin bright";
      pin.textContent = this.pin;
      pin.setAttribute("aria-label", `AirPlay PIN ${this.pin}`);
      wrapper.appendChild(pin);
    }

    return wrapper;
  },

  statusTitle() {
    const titles = {
      STARTING: "Starting AirPlay",
      READY: "Ready to mirror",
      PIN: "Enter this PIN",
      STREAMING: "Mirroring iPhone",
      STOPPED: "AirPlay stopped",
      ERROR: "AirPlay unavailable"
    };
    return titles[this.receiverStatus.state] || "AirPlay";
  },

  statusDetail() {
    if (this.receiverStatus.state === "READY" || this.receiverStatus.state === "PIN") {
      return `Control Centre → Screen Mirroring → ${this.config.receiverName}`;
    }
    return this.receiverStatus.message || this.config.receiverName;
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "AIRPLAY_STATUS") {
      this.receiverStatus = payload;
      if (payload.state !== "PIN") {
        this.pin = null;
      }

      if (payload.state === "STREAMING" && this.config.hideStatusWhileStreaming) {
        this.hide(200);
      } else if (this.config.showStatus) {
        this.show(200);
      }

      this.updateDom(200);
      this.sendNotification("AIRPLAY_RECEIVER_STATUS", payload);
    }

    if (notification === "AIRPLAY_PIN") {
      this.pin = payload.pin;
      this.receiverStatus = {
        state: "PIN",
        message: "Enter the code shown below on your iPhone"
      };
      this.show(100);
      this.updateDom(100);
      this.sendNotification("AIRPLAY_RECEIVER_PIN", payload);
    }
  },

  notificationReceived(notification) {
    const controls = {
      AIRPLAY_RECEIVER_START: "AIRPLAY_START",
      AIRPLAY_RECEIVER_STOP: "AIRPLAY_STOP",
      AIRPLAY_RECEIVER_RESTART: "AIRPLAY_RESTART"
    };

    if (controls[notification]) {
      this.sendSocketNotification(controls[notification]);
    }
  },

  suspend() {
    // Visibility is independent from the receiver lifecycle. This keeps the
    // AirPlay service discoverable while other modules hide this status tile.
  }
});
