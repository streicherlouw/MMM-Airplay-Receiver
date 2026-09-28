"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { BlackFrameGuard } = require("./lib/black-frame-guard");
const { buildReceiverEnvironment, buildUxplayArgs, normalizeConfig } = require("./lib/uxplay");
const { classifyDaemonLine, StreamLifecycle } = require("./lib/daemon-events");
const { DisplayPowerManager } = require("./lib/display-power");
const { SystemVolumeManager } = require("./lib/system-volume");
const { VideoHandoffCoordinator } = require("./lib/video-handoff");

const execFileAsync = promisify(execFile);
const configurationPath = path.resolve(process.argv[2] || path.join(__dirname, "receiver-daemon.config.json"));
const daemonConfig = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
const receiverConfig = normalizeConfig(daemonConfig);
const receiverEnvironment = buildReceiverEnvironment(receiverConfig);
const statusFile = daemonConfig.externalStatusFile || path.join(
  receiverConfig.xdgRuntimeDir || process.env.XDG_RUNTIME_DIR || "/tmp",
  "mmm-airplay-receiver-status.json"
);
const pm2Path = daemonConfig.pm2Path || "/usr/local/bin/pm2";
const pm2ProcessName = daemonConfig.pm2ProcessName || "MagicMirror";
const manageMagicMirror = daemonConfig.manageMagicMirror !== false;
const restartDelay = receiverConfig.restartDelay;
const receiverOutputSampleLines = Number.isInteger(daemonConfig.receiverOutputSampleLines)
  ? Math.max(0, Math.min(300, daemonConfig.receiverOutputSampleLines))
  : 0;
const performanceReportSamples = Number.isInteger(daemonConfig.performanceReportSamples)
  ? Math.max(0, Math.min(10, daemonConfig.performanceReportSamples))
  : 0;
const videoTeardownTimeoutMs = Number.isInteger(daemonConfig.videoTeardownTimeoutMs)
  ? Math.max(500, Math.min(10000, daemonConfig.videoTeardownTimeoutMs))
  : 2000;
const magicMirrorReadyDelayMs = Number.isInteger(daemonConfig.magicMirrorReadyDelayMs)
  ? Math.max(0, Math.min(15000, daemonConfig.magicMirrorReadyDelayMs))
  : 3500;
const receiverRecycleKillTimeoutMs = Number.isInteger(daemonConfig.receiverRecycleKillTimeoutMs)
  ? Math.max(500, Math.min(10000, daemonConfig.receiverRecycleKillTimeoutMs))
  : 2000;

let receiver = null;
let restartTimer = null;
let shuttingDown = false;
let magicMirrorStopped = false;
let pm2Queue = Promise.resolve();
let handoffQueue = Promise.resolve();
let lastState = null;
let receiverOutputLinesRemaining = 0;
let performanceReportsRemaining = 0;
let capturingPerformanceReport = false;
let controlledReceiverExit = null;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function log(message) {
  console.log(`[MMM-Airplay-Receiver daemon] ${message}`);
}

const systemVolume = new SystemVolumeManager(
  daemonConfig,
  (command, args) => execFileAsync(command, args, {
    env: process.env,
    timeout: 5000,
    maxBuffer: 1024 * 1024
  }),
  log
);
const displayPower = new DisplayPowerManager(
  daemonConfig,
  (command, args) => execFileAsync(command, args, {
    env: receiverEnvironment,
    timeout: 5000,
    maxBuffer: 1024 * 1024
  }),
  log
);
const streamLifecycle = new StreamLifecycle();
const blackFrameGuard = new BlackFrameGuard(
  daemonConfig,
  (command, args) => spawn(command, args, {
    env: receiverEnvironment,
    stdio: ["ignore", "ignore", "ignore"]
  }),
  delay,
  log
);
const videoHandoff = new VideoHandoffCoordinator({
  showGuard: () => blackFrameGuard.show(),
  hideGuard: () => blackFrameGuard.hide(),
  onTimeout: () => recycleReceiverAfterMissingTeardown(),
  timeoutMs: videoTeardownTimeoutMs,
  logger: log
});

function writeStatus(state, message) {
  const status = {
    state,
    message,
    receiverName: receiverConfig.receiverName,
    updatedAt: new Date().toISOString()
  };
  if (lastState && lastState.state === status.state && lastState.message === status.message) return;
  lastState = status;

  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, "utf8");
  fs.renameSync(temporary, statusFile);
}

function queueMagicMirror(shouldRun) {
  if (!manageMagicMirror) return pm2Queue;
  if (shouldRun && !magicMirrorStopped) return pm2Queue;
  if (!shouldRun && magicMirrorStopped) return pm2Queue;

  magicMirrorStopped = !shouldRun;
  const action = shouldRun ? "start" : "stop";
  pm2Queue = pm2Queue.then(async () => {
    try {
      await execFileAsync(pm2Path, [action, pm2ProcessName], {
        env: process.env,
        timeout: 15000,
        maxBuffer: 1024 * 1024
      });
      log(`${action === "stop" ? "Stopped" : "Started"} ${pm2ProcessName}`);
    } catch (error) {
      log(`PM2 ${action} failed: ${error.message}`);
      if (!shouldRun) magicMirrorStopped = false;
    }
  });
  return pm2Queue;
}

function queueSessionHandoff({ anyActive, videoActive }, { releaseVideoGuard = false } = {}) {
  handoffQueue = handoffQueue.then(async () => {
    if (releaseVideoGuard && !videoActive) {
      const guardVisible = await blackFrameGuard.show();
      await queueMagicMirror(true);
      if (guardVisible && manageMagicMirror && magicMirrorReadyDelayMs > 0) {
        log(`Holding black frame for ${magicMirrorReadyDelayMs} ms while ${pm2ProcessName} paints`);
        await delay(magicMirrorReadyDelayMs);
      }

      const current = streamLifecycle.snapshot();
      if (current.videoActive) {
        await queueMagicMirror(false);
      } else if (current.anyActive) {
        await Promise.all([
          systemVolume.beginSession(),
          displayPower.beginSession()
        ]);
      } else {
        await Promise.all([
          systemVolume.endSession(),
          displayPower.endSession()
        ]);
      }

      await blackFrameGuard.hide();
      return;
    }

    if (anyActive) {
      await Promise.all([
        systemVolume.beginSession(),
        displayPower.beginSession()
      ]);
    } else {
      await Promise.all([
        systemVolume.endSession(),
        displayPower.endSession()
      ]);
    }

    await queueMagicMirror(!videoActive);
  }).catch((error) => {
    log(`Session handoff failed: ${error.message}`);
  });
  return handoffQueue;
}

function handleReceiverLine(line) {
  const text = String(line).trim();
  if (!text) return;

  const event = classifyDaemonLine(text);
  if (event) {
    log(text);
    if (event.type === "video-stopping") {
      void videoHandoff.beginStopping();
      return;
    }
    if (event.type === "stream" && event.stream === "video" && event.active) {
      void videoHandoff.cancelStopping();
    }
    const releaseVideoGuard = event.type === "stream" &&
      event.stream === "video" &&
      event.active === false &&
      event.teardownConfirmed === true;
    if (releaseVideoGuard) void videoHandoff.confirmStopping();
    const lifecycle = streamLifecycle.apply(event);
    if (lifecycle.statusChanged) writeStatus(lifecycle.state, lifecycle.message);
    if (event.type === "stream" && event.stream === "video" && event.active) {
      receiverOutputLinesRemaining = receiverOutputSampleLines;
      performanceReportsRemaining = performanceReportSamples;
      capturingPerformanceReport = false;
    }
    if (lifecycle.volumeChanged || lifecycle.displayChanged) {
      queueSessionHandoff(lifecycle, { releaseVideoGuard });
    }
    return;
  }

  if (/Received video streaming performance info packet/i.test(text) && performanceReportsRemaining > 0) {
    capturingPerformanceReport = true;
    log(`[UxPlay performance] ${text}`);
    return;
  }

  if (capturingPerformanceReport) {
    log(`[UxPlay performance] ${text}`);
    if (/<\/plist>/i.test(text)) {
      capturingPerformanceReport = false;
      performanceReportsRemaining -= 1;
    }
    return;
  }

  if (
    /begin video stream\s+wxh|raop_rtp_mirror width_source|Received unencrypted codec packet|This packet indicates video stream is stopping|video_pipeline state change|GStreamer h26[45] bus message .* (?:warning|error|new-clock)$/i.test(text)
  ) {
    log(`[UxPlay format] ${text}`);
    return;
  }

  if (/^(?:User-Agent|X-Apple-Device-ID):|(?:deviceName|model)\s*[=:]/i.test(text)) {
    log(`[UxPlay client] ${text}`);
    return;
  }

  if (/error|failed|warning|critical|unsupported|connection reset/i.test(text)) {
    log(`[UxPlay] ${text}`);
    return;
  }

  if (receiverOutputLinesRemaining > 0) {
    receiverOutputLinesRemaining -= 1;
    log(`[UxPlay sample] ${text}`);
  }
}

function finishControlledReceiverExit(child) {
  if (!controlledReceiverExit || controlledReceiverExit.child !== child) return false;
  clearTimeout(controlledReceiverExit.killTimer);
  const resolve = controlledReceiverExit.resolve;
  controlledReceiverExit = null;
  resolve();
  return true;
}

function stopReceiverForRecycle() {
  const child = receiver;
  if (!child) return Promise.resolve();
  if (controlledReceiverExit && controlledReceiverExit.child === child) {
    return controlledReceiverExit.promise;
  }

  let resolveExit;
  const promise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const killTimer = setTimeout(() => {
    if (receiver === child && child.exitCode === null && child.signalCode === null) {
      log("UxPlay did not stop after SIGTERM; sending SIGKILL");
      child.kill("SIGKILL");
    }
  }, receiverRecycleKillTimeoutMs);
  controlledReceiverExit = { child, promise, resolve: resolveExit, killTimer };
  child.kill("SIGTERM");
  return promise;
}

async function recycleReceiverAfterMissingTeardown() {
  await blackFrameGuard.show();
  await stopReceiverForRecycle();
  streamLifecycle.reset();
  const handoff = queueSessionHandoff(
    { anyActive: false, videoActive: false },
    { releaseVideoGuard: true }
  );
  if (!shuttingDown) startReceiver();
  await handoff;
}

function attachOutput(stream) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) handleReceiverLine(line);
  });
  stream.on("end", () => {
    if (pending) handleReceiverLine(pending);
  });
}

function scheduleReceiverRestart() {
  if (shuttingDown || restartTimer || !receiverConfig.restartOnExit) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startReceiver();
  }, restartDelay);
}

function startReceiver() {
  if (receiver || shuttingDown) return;

  streamLifecycle.reset();
  const uxplayArgs = buildUxplayArgs(receiverConfig);
  if (daemonConfig.debugReceiver && !uxplayArgs.includes("-d")) {
    uxplayArgs.push("-d");
    // Keep lifecycle messages while suppressing per-packet debug output,
    // which adds avoidable CPU and I/O load during live mirroring.
    if (daemonConfig.debugReceiver !== "full") uxplayArgs.push("1");
  }
  const stdbufPath = daemonConfig.stdbufPath || "/usr/bin/stdbuf";
  const commandArgs = ["-oL", "-eL", receiverConfig.uxplayPath, ...uxplayArgs];

  writeStatus("STARTING", `Starting ${receiverConfig.receiverName}`);
  log(`Launching ${receiverConfig.uxplayPath} ${uxplayArgs.join(" ")}`);
  const child = spawn(stdbufPath, commandArgs, {
    env: receiverEnvironment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  receiver = child;
  attachOutput(child.stdout);
  attachOutput(child.stderr);

  child.once("error", (error) => {
    if (receiver === child) receiver = null;
    if (finishControlledReceiverExit(child)) return;
    const releaseVideoGuard = streamLifecycle.snapshot().videoActive || videoHandoff.pending;
    if (releaseVideoGuard) void videoHandoff.confirmStopping();
    streamLifecycle.reset();
    writeStatus("ERROR", `Could not start UxPlay: ${error.message}`);
    queueSessionHandoff(
      { anyActive: false, videoActive: false },
      { releaseVideoGuard }
    );
    scheduleReceiverRestart();
  });

  child.once("close", (code, signal) => {
    if (receiver === child) receiver = null;
    if (finishControlledReceiverExit(child)) {
      log("Recycled UxPlay after unconfirmed video teardown");
      return;
    }
    if (shuttingDown) return;
    const releaseVideoGuard = streamLifecycle.snapshot().videoActive || videoHandoff.pending;
    if (releaseVideoGuard) void videoHandoff.confirmStopping();
    streamLifecycle.reset();
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    writeStatus("ERROR", `UxPlay stopped (${reason})`);
    log(`UxPlay stopped (${reason})`);
    queueSessionHandoff(
      { anyActive: false, videoActive: false },
      { releaseVideoGuard }
    );
    scheduleReceiverRestart();
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Stopping after ${signal}`);
  if (restartTimer) clearTimeout(restartTimer);
  const releaseVideoGuard = streamLifecycle.snapshot().videoActive || videoHandoff.pending;
  if (releaseVideoGuard) await videoHandoff.confirmStopping();
  if (receiver) receiver.kill("SIGTERM");
  streamLifecycle.reset();
  await queueSessionHandoff(
    { anyActive: false, videoActive: false },
    { releaseVideoGuard }
  );
  await blackFrameGuard.hide();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", async (error) => {
  log(`Uncaught error: ${error.stack || error.message}`);
  const releaseVideoGuard = streamLifecycle.snapshot().videoActive || videoHandoff.pending;
  if (releaseVideoGuard) await videoHandoff.confirmStopping();
  streamLifecycle.reset();
  await queueSessionHandoff(
    { anyActive: false, videoActive: false },
    { releaseVideoGuard }
  );
  await blackFrameGuard.hide();
  process.exit(1);
});

startReceiver();
