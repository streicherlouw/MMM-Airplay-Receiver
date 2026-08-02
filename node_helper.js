"use strict";

const NodeHelper = require("node_helper");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildReceiverEnvironment,
  buildUxplayArgs,
  normalizeConfig,
  parseUxplayLine
} = require("./lib/uxplay");

module.exports = NodeHelper.create({
  start() {
    this.receiver = null;
    this.config = null;
    this.restartTimer = null;
    this.stopTimer = null;
    this.stopRequested = false;
    this.lastStatus = null;
    this.externalStatusTimer = null;
  },

  stop() {
    this.stopExternalStatusMonitor();
    this.stopReceiver(false);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "AIRPLAY_CONFIG") {
      this.config = normalizeConfig(payload);
      if (this.config.externalService) this.startExternalStatusMonitor();
      else if (this.config.autoStart) this.startReceiver();
      else this.publishStatus("STOPPED", "AirPlay is stopped");
      return;
    }

    if (this.config?.externalService) return;

    if (notification === "AIRPLAY_START") {
      if (!this.config) this.config = normalizeConfig();
      this.startReceiver();
      return;
    }

    if (notification === "AIRPLAY_STOP") {
      this.stopReceiver(true);
      return;
    }

    if (notification === "AIRPLAY_RESTART") {
      this.restartReceiver();
    }
  },

  startReceiver() {
    if (this.receiver || !this.config) return;

    this.clearTimers();
    this.stopRequested = false;
    const args = buildUxplayArgs(this.config);
    const env = buildReceiverEnvironment(this.config);

    this.publishStatus("STARTING", `Starting ${this.config.receiverName}`);
    console.log(`[MMM-Airplay-Receiver] Launching ${this.config.uxplayPath} ${this.redactArgs(args).join(" ")}`);

    let child;
    try {
      child = spawn(this.config.uxplayPath, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      this.handleStartError(error);
      return;
    }

    this.receiver = child;
    this.attachOutput(child.stdout);
    this.attachOutput(child.stderr);

    child.once("error", (error) => {
      if (this.receiver === child) this.receiver = null;
      this.handleStartError(error);
    });

    child.once("close", (code, signal) => {
      if (this.receiver === child) this.receiver = null;
      this.clearStopTimer();

      if (this.stopRequested) {
        this.publishStatus("STOPPED", "AirPlay is stopped");
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this.publishStatus("ERROR", `UxPlay stopped (${reason})`);
      this.scheduleRestart();
    });
  },

  startExternalStatusMonitor() {
    this.stopExternalStatusMonitor();
    const statusFile = this.config.externalStatusFile || path.join(
      process.env.XDG_RUNTIME_DIR || "/tmp",
      "mmm-airplay-receiver-status.json"
    );
    let missingReads = 0;

    const readStatus = () => {
      fs.readFile(statusFile, "utf8", (error, contents) => {
        if (error) {
          missingReads += 1;
          if (missingReads >= 5) this.publishStatus("ERROR", "External AirPlay service is unavailable");
          return;
        }
        missingReads = 0;
        try {
          const status = JSON.parse(contents);
          if (["STARTING", "READY", "STREAMING", "ERROR", "STOPPED"].includes(status.state)) {
            this.publishStatus(status.state, status.message || "AirPlay service update");
          }
        } catch (parseError) {
          console.error(`[MMM-Airplay-Receiver] Could not read external status: ${parseError.message}`);
        }
      });
    };

    this.publishStatus("STARTING", "Connecting to the external AirPlay service");
    readStatus();
    this.externalStatusTimer = setInterval(readStatus, 1000);
  },

  stopExternalStatusMonitor() {
    if (this.externalStatusTimer) clearInterval(this.externalStatusTimer);
    this.externalStatusTimer = null;
  },

  stopReceiver(publish = true) {
    this.stopRequested = true;
    this.clearRestartTimer();

    if (!this.receiver) {
      if (publish) this.publishStatus("STOPPED", "AirPlay is stopped");
      return;
    }

    const child = this.receiver;
    child.kill("SIGTERM");
    this.clearStopTimer();
    this.stopTimer = setTimeout(() => {
      if (this.receiver === child) child.kill("SIGKILL");
    }, 3000);
  },

  restartReceiver() {
    this.stopRequested = true;
    this.clearRestartTimer();

    if (!this.receiver) {
      this.stopRequested = false;
      this.startReceiver();
      return;
    }

    const child = this.receiver;
    child.once("close", () => {
      this.stopRequested = false;
      this.startReceiver();
    });
    this.stopReceiver(false);
  },

  attachOutput(stream) {
    if (!stream) return;
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) this.handleOutputLine(line);
    });
    stream.on("end", () => {
      if (pending) this.handleOutputLine(pending);
    });
  },

  handleOutputLine(line) {
    const event = parseUxplayLine(line);
    if (!event) return;

    if (event.type === "pin") {
      this.sendSocketNotification("AIRPLAY_PIN", { pin: event.pin });
      this.publishStatus("PIN", "Enter the PIN on your iPhone");
      return;
    }

    if (event.type === "status") {
      this.publishStatus(event.state, event.message);
      return;
    }

    console.log(`[MMM-Airplay-Receiver] [UxPlay] ${event.message}`);
  },

  handleStartError(error) {
    const message = error && error.code === "ENOENT"
      ? `UxPlay was not found at '${this.config.uxplayPath}'`
      : `Could not start UxPlay: ${error.message}`;
    console.error(`[MMM-Airplay-Receiver] ${message}`);
    this.publishStatus("ERROR", message);
    this.scheduleRestart();
  },

  scheduleRestart() {
    if (!this.config || !this.config.restartOnExit || this.stopRequested || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startReceiver();
    }, this.config.restartDelay);
  },

  publishStatus(state, message) {
    const status = { state, message, receiverName: this.config?.receiverName || "Magic Mirror" };
    if (JSON.stringify(status) === JSON.stringify(this.lastStatus)) return;
    this.lastStatus = status;
    this.sendSocketNotification("AIRPLAY_STATUS", status);
  },

  redactArgs(args) {
    const result = [...args];
    const passwordIndex = result.indexOf("-pw");
    if (passwordIndex >= 0 && result[passwordIndex + 1]) result[passwordIndex + 1] = "[redacted]";
    return result;
  },

  clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  },

  clearStopTimer() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  },

  clearTimers() {
    this.clearRestartTimer();
    this.clearStopTimer();
  }
});
