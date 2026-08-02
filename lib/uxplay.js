"use strict";

const fs = require("node:fs");

const DEFAULTS = Object.freeze({
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
  extraArgs: []
});

function boolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolution(value) {
  const candidate = optionalString(value);
  return candidate && /^\d{1,4}x\d{1,4}(?:@\d{1,3})?$/.test(candidate) ? candidate : null;
}

function normalizeConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const pin = source.pin === true
    ? true
    : (/^\d{4}$/.test(String(source.pin)) ? String(source.pin) : false);

  return {
    receiverName: optionalString(source.receiverName)?.slice(0, 80) || DEFAULTS.receiverName,
    uxplayPath: optionalString(source.uxplayPath) || DEFAULTS.uxplayPath,
    autoStart: boolean(source.autoStart, DEFAULTS.autoStart),
    externalService: boolean(source.externalService, DEFAULTS.externalService),
    externalStatusFile: optionalString(source.externalStatusFile),
    fullscreen: boolean(source.fullscreen, DEFAULTS.fullscreen),
    pin,
    persistTrustedClients: boolean(source.persistTrustedClients, DEFAULTS.persistTrustedClients),
    port: source.port === null ? null : integer(source.port, DEFAULTS.port, 1024, 65533),
    resolution: resolution(source.resolution),
    fps: source.fps === null ? null : integer(source.fps, DEFAULTS.fps, 1, 255),
    lowLatency: boolean(source.lowLatency, DEFAULTS.lowLatency),
    noFreeze: boolean(source.noFreeze, DEFAULTS.noFreeze),
    inhibitScreensaver: boolean(source.inhibitScreensaver, DEFAULTS.inhibitScreensaver),
    appendHostname: boolean(source.appendHostname, DEFAULTS.appendHostname),
    videoSink: optionalString(source.videoSink),
    audioSink: optionalString(source.audioSink),
    display: optionalString(source.display) || DEFAULTS.display,
    waylandDisplay: optionalString(source.waylandDisplay),
    xdgRuntimeDir: optionalString(source.xdgRuntimeDir),
    dbusSessionBusAddress: optionalString(source.dbusSessionBusAddress),
    xAuthority: optionalString(source.xAuthority),
    useBt709: boolean(source.useBt709, DEFAULTS.useBt709),
    allowTakeover: boolean(source.allowTakeover, DEFAULTS.allowTakeover),
    restartOnExit: boolean(source.restartOnExit, DEFAULTS.restartOnExit),
    restartDelay: integer(source.restartDelay, DEFAULTS.restartDelay, 1000, 60000),
    extraArgs: Array.isArray(source.extraArgs)
      ? source.extraArgs.filter((arg) => typeof arg === "string" && arg.length > 0).slice(0, 40)
      : []
  };
}

function buildReceiverEnvironment(configInput, baseEnvironment = process.env, readDirectory = fs.readdirSync) {
  const config = normalizeConfig(configInput);
  const env = { ...baseEnvironment, DISPLAY: config.display };

  if (config.xAuthority) env.XAUTHORITY = config.xAuthority;
  if (config.xdgRuntimeDir) env.XDG_RUNTIME_DIR = config.xdgRuntimeDir;
  if (config.dbusSessionBusAddress) env.DBUS_SESSION_BUS_ADDRESS = config.dbusSessionBusAddress;
  if (config.waylandDisplay) env.WAYLAND_DISPLAY = config.waylandDisplay;

  const needsWayland = config.videoSink && config.videoSink.toLowerCase().includes("wayland");
  if (needsWayland && !env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) {
    try {
      env.WAYLAND_DISPLAY = readDirectory(env.XDG_RUNTIME_DIR)
        .filter((entry) => /^wayland-\d+$/.test(entry))
        .sort()[0];
    } catch {
      // UxPlay will report the actionable display error if discovery fails.
    }
  }

  return env;
}

function buildUxplayArgs(configInput) {
  const config = normalizeConfig(configInput);
  const args = ["-n", config.receiverName];

  if (!config.appendHostname) args.push("-nh");
  if (config.port !== null) args.push("-p", String(config.port));
  if (config.resolution) args.push("-s", config.resolution);
  if (config.fullscreen) args.push("-fs");
  if (config.pin) {
    args.push("-pin");
    if (typeof config.pin === "string") args.push(config.pin);
    if (config.persistTrustedClients) args.push("-reg");
  }
  if (config.noFreeze) args.push("-nofreeze");
  if (config.inhibitScreensaver) args.push("-scrsv", "1");
  if (config.lowLatency) args.push("-vsync", "no");
  if (config.fps !== null) args.push("-fps", String(config.fps));
  if (config.videoSink) args.push("-vs", config.videoSink);
  if (config.audioSink) args.push("-as", config.audioSink);
  if (config.useBt709) args.push("-bt709");
  if (config.allowTakeover) args.push("-nohold");

  return args.concat(config.extraArgs);
}

function parseUxplayLine(line) {
  const text = String(line).trim();
  if (!text) return null;

  const pinMatch = text.match(/(?:pin(?:\s+code)?|password)[^0-9]{0,40}(\d{4})(?!\d)/i);
  if (pinMatch) {
    return { type: "pin", pin: pinMatch[1], message: text };
  }

  if (/raop_rtp_mirror\s+starting\s+mirroring|(?:start(?:ed|ing)|beginning)\s+(?:screen\s+)?mirroring/i.test(text)) {
    return { type: "status", state: "STREAMING", message: "An AirPlay client is connected" };
  }

  if (/stopp(?:ed|ing)\s+(?:screen\s+)?mirroring|(?:client|connection).*(?:closed|disconnected|reset)|teardown.*(?:mirror|connection)/i.test(text)) {
    return { type: "status", state: "READY", message: "Waiting for an iPhone" };
  }

  if (/initialized server socket|server.*(?:ready|listening)|announc(?:ed|ing).*airplay/i.test(text)) {
    return { type: "status", state: "READY", message: "Waiting for an iPhone" };
  }

  return { type: "log", message: text };
}

module.exports = {
  DEFAULTS,
  normalizeConfig,
  buildUxplayArgs,
  buildReceiverEnvironment,
  parseUxplayLine
};
