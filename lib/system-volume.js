"use strict";

const DEFAULTS = Object.freeze({
  enabled: false,
  limitPercent: 100,
  target: "@DEFAULT_AUDIO_SINK@",
  wpctlPath: "/usr/bin/wpctl"
});

function optionalString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeSystemVolumeConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const configuredLimit = Number(source.systemVolumeLimitPercent);
  const limitPercent = Number.isFinite(configuredLimit) && configuredLimit > 0 && configuredLimit <= 100
    ? configuredLimit
    : DEFAULTS.limitPercent;

  return {
    enabled: source.manageSystemVolume === true,
    limitPercent,
    target: optionalString(source.systemVolumeTarget, DEFAULTS.target),
    wpctlPath: optionalString(source.wpctlPath, DEFAULTS.wpctlPath)
  };
}

function parseWpctlVolume(output) {
  const text = String(output);
  const match = text.match(/\bVolume:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) throw new Error(`Unexpected wpctl volume output: ${text.trim() || "(empty)"}`);

  const volume = Number(match[1]);
  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error(`Invalid wpctl volume: ${match[1]}`);
  }

  return {
    volume,
    muted: /\[MUTED\]/i.test(text)
  };
}

function formatVolumeScalar(value) {
  return Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

class SystemVolumeManager {
  constructor(configInput, execute, logger = () => {}) {
    this.config = normalizeSystemVolumeConfig(configInput);
    this.execute = execute;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.sessionActive = false;
    this.savedState = null;
  }

  beginSession() {
    if (!this.config.enabled || this.sessionActive) return this.queue;
    this.sessionActive = true;
    this.queue = this.queue.then(() => this.setStreamingVolume());
    return this.queue;
  }

  endSession() {
    if (!this.config.enabled || !this.sessionActive) return this.queue;
    this.sessionActive = false;
    this.queue = this.queue.then(() => this.restoreSavedVolume());
    return this.queue;
  }

  async setStreamingVolume() {
    try {
      const result = await this.execute(this.config.wpctlPath, [
        "get-volume",
        this.config.target
      ]);
      this.savedState = parseWpctlVolume(result.stdout);

      const limit = formatVolumeScalar(this.config.limitPercent / 100);
      await this.execute(this.config.wpctlPath, [
        "set-volume",
        "-l",
        limit,
        this.config.target,
        limit
      ]);
      await this.execute(this.config.wpctlPath, [
        "set-mute",
        this.config.target,
        "0"
      ]);
      this.logger(
        `Set ${this.config.target} to ${this.config.limitPercent}% for AirPlay ` +
        `(saved ${Math.round(this.savedState.volume * 100)}%${this.savedState.muted ? ", muted" : ""})`
      );
    } catch (error) {
      this.logger(`Could not prepare system volume for AirPlay: ${error.message}`);
    }
  }

  async restoreSavedVolume() {
    const savedState = this.savedState;
    this.savedState = null;
    if (!savedState) return;

    try {
      await this.execute(this.config.wpctlPath, [
        "set-volume",
        this.config.target,
        formatVolumeScalar(savedState.volume)
      ]);
      await this.execute(this.config.wpctlPath, [
        "set-mute",
        this.config.target,
        savedState.muted ? "1" : "0"
      ]);
      this.logger(
        `Restored ${this.config.target} to ${Math.round(savedState.volume * 100)}%` +
        `${savedState.muted ? ", muted" : ""}`
      );
    } catch (error) {
      this.logger(`Could not restore system volume after AirPlay: ${error.message}`);
    }
  }
}

module.exports = {
  DEFAULTS,
  SystemVolumeManager,
  formatVolumeScalar,
  normalizeSystemVolumeConfig,
  parseWpctlVolume
};
