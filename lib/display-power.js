"use strict";

const DEFAULTS = Object.freeze({
  enabled: false,
  output: "HDMI-A-1",
  wlrRandrPath: "/usr/bin/wlr-randr"
});

function optionalString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeDisplayPowerConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    enabled: source.manageDisplayPower === true,
    output: optionalString(source.displayOutput, DEFAULTS.output),
    wlrRandrPath: optionalString(source.wlrRandrPath, DEFAULTS.wlrRandrPath)
  };
}

function parseWlrRandrOutput(output, outputName) {
  const name = optionalString(outputName, DEFAULTS.output);
  const lines = String(output).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => (
    line.length > 0 &&
    !/^\s/.test(line) &&
    (line === name || line.startsWith(`${name} `))
  ));

  if (headerIndex === -1) {
    throw new Error(`Output ${name} was not found in wlr-randr output`);
  }

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !/^\s/.test(line)) break;

    const enabled = line.match(/^\s+Enabled:\s*(yes|no)\s*$/i);
    if (enabled) return { enabled: enabled[1].toLowerCase() === "yes" };
  }

  throw new Error(`Enabled state for ${name} was not found in wlr-randr output`);
}

class DisplayPowerManager {
  constructor(configInput, execute, logger = () => {}) {
    this.config = normalizeDisplayPowerConfig(configInput);
    this.execute = execute;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.sessionActive = false;
    this.savedState = null;
  }

  beginSession() {
    if (!this.config.enabled || this.sessionActive) return this.queue;
    this.sessionActive = true;
    this.queue = this.queue.then(() => this.prepareDisplay());
    return this.queue;
  }

  endSession() {
    if (!this.config.enabled || !this.sessionActive) return this.queue;
    this.sessionActive = false;
    this.queue = this.queue.then(() => this.restoreDisplay());
    return this.queue;
  }

  async prepareDisplay() {
    try {
      const result = await this.execute(this.config.wlrRandrPath, []);
      this.savedState = parseWlrRandrOutput(result.stdout, this.config.output);

      await this.execute(this.config.wlrRandrPath, [
        "--output",
        this.config.output,
        "--on",
        "--preferred"
      ]);
      this.logger(
        `Turned ${this.config.output} on for AirPlay ` +
        `(saved ${this.savedState.enabled ? "on" : "off"})`
      );
    } catch (error) {
      this.logger(`Could not prepare display for AirPlay: ${error.message}`);
    }
  }

  async restoreDisplay() {
    const savedState = this.savedState;
    this.savedState = null;
    if (!savedState) return;

    const args = ["--output", this.config.output];
    if (savedState.enabled) args.push("--on", "--preferred");
    else args.push("--off");

    try {
      await this.execute(this.config.wlrRandrPath, args);
      this.logger(`Restored ${this.config.output} to ${savedState.enabled ? "on" : "off"}`);
    } catch (error) {
      this.logger(`Could not restore display after AirPlay: ${error.message}`);
    }
  }
}

module.exports = {
  DEFAULTS,
  DisplayPowerManager,
  normalizeDisplayPowerConfig,
  parseWlrRandrOutput
};
