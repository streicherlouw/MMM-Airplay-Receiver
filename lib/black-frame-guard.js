"use strict";

const DEFAULTS = Object.freeze({
  enabled: false,
  command: "/usr/bin/gst-launch-1.0",
  readyDelayMs: 400,
  terminationTimeoutMs: 1500,
  frameRate: 10,
  width: 1920,
  height: 1080
});

function optionalString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function normalizeBlackFrameConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const resolution = optionalString(source.resolution, "").match(/^(\d{1,4})x(\d{1,4})/);

  return {
    enabled: source.manageBlackFrameGuard === true,
    command: optionalString(source.blackFrameCommand, DEFAULTS.command),
    readyDelayMs: boundedInteger(
      source.blackFrameReadyDelayMs,
      DEFAULTS.readyDelayMs,
      50,
      5000
    ),
    terminationTimeoutMs: boundedInteger(
      source.blackFrameTerminationTimeoutMs,
      DEFAULTS.terminationTimeoutMs,
      100,
      5000
    ),
    frameRate: boundedInteger(source.blackFrameRate, DEFAULTS.frameRate, 1, 60),
    width: resolution ? Number(resolution[1]) : DEFAULTS.width,
    height: resolution ? Number(resolution[2]) : DEFAULTS.height
  };
}

function buildBlackFrameArgs(config) {
  return [
    "-q",
    "videotestsrc",
    "is-live=true",
    "pattern=black",
    "!",
    `video/x-raw,width=${config.width},height=${config.height},framerate=${config.frameRate}/1`,
    "!",
    "waylandsink",
    "fullscreen=true",
    "sync=false",
    "async=false",
    "enable-last-sample=false"
  ];
}

class BlackFrameGuard {
  constructor(configInput, spawnProcess, wait, logger = () => {}) {
    this.config = normalizeBlackFrameConfig(configInput);
    this.spawnProcess = spawnProcess;
    this.wait = wait;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.visible = false;
    this.child = null;
  }

  show() {
    if (!this.config.enabled) return Promise.resolve(false);
    if (this.visible) return this.queue;
    this.visible = true;
    this.queue = this.queue.then(() => this.start()).catch((error) => {
      this.visible = false;
      this.logger(`Could not show black handoff frame: ${error.message}`);
      return false;
    });
    return this.queue;
  }

  hide() {
    if (!this.config.enabled || (!this.visible && !this.child)) return this.queue;
    this.visible = false;
    this.queue = this.queue.then(() => this.stop()).catch((error) => {
      this.logger(`Could not remove black handoff frame: ${error.message}`);
      return false;
    });
    return this.queue;
  }

  async start() {
    if (this.child) return true;

    const child = this.spawnProcess(this.config.command, buildBlackFrameArgs(this.config));
    this.child = child;
    const failed = new Promise((resolve) => {
      child.once("error", (error) => resolve(error));
      child.once("close", (code, signal) => {
        if (this.child === child) this.child = null;
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        resolve(new Error(`black-frame process stopped before presentation (${reason})`));
      });
    });

    const failure = await Promise.race([
      this.wait(this.config.readyDelayMs).then(() => null),
      failed
    ]);
    if (failure) throw failure;
    if (!this.visible) {
      await this.stop();
      return false;
    }

    this.logger("Black handoff frame is covering the Wayland output");
    return true;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;

    const exited = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      this.wait(this.config.terminationTimeoutMs).then(() => false)
    ]);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, this.wait(250)]);
    }

    this.logger("Removed black handoff frame");
    return true;
  }
}

module.exports = {
  DEFAULTS,
  BlackFrameGuard,
  buildBlackFrameArgs,
  normalizeBlackFrameConfig
};
