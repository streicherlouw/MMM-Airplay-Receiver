"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildReceiverEnvironment,
  buildUxplayArgs,
  normalizeConfig,
  parseUxplayLine
} = require("../lib/uxplay");
const { classifyDaemonLine, StreamLifecycle } = require("../lib/daemon-events");
const daemonConfig = require("../receiver-daemon.config.json");

test("builds low-latency defaults without mandatory PIN pairing", () => {
  assert.deepEqual(buildUxplayArgs({ receiverName: "Art Wall" }), [
    "-n", "Art Wall", "-nh", "-p", "7000", "-fs",
    "-nofreeze", "-vsync", "no", "-fps", "30"
  ]);
});

test("discovers the active Wayland socket when PM2 did not inherit it", () => {
  const env = buildReceiverEnvironment(
    { videoSink: "waylandsink" },
    { XDG_RUNTIME_DIR: "/run/user/1000" },
    () => ["pipewire-0", "wayland-0.lock", "wayland-0"]
  );
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(env.DISPLAY, ":0");
});

test("respects an explicitly configured Wayland display", () => {
  const env = buildReceiverEnvironment(
    { videoSink: "waylandsink", waylandDisplay: "wayland-2" },
    { XDG_RUNTIME_DIR: "/run/user/1000" },
    () => ["wayland-0"]
  );
  assert.equal(env.WAYLAND_DISPLAY, "wayland-2");
});

test("supports fixed PINs and optional sinks without a shell", () => {
  const args = buildUxplayArgs({
    pin: "1234",
    videoSink: "waylandsink",
    audioSink: "pipewiresink",
    extraArgs: ["-reset", "8"]
  });
  assert.ok(args.includes("1234"));
  assert.ok(args.includes("-pin"));
  assert.deepEqual(args.slice(-6), ["-vs", "waylandsink", "-as", "pipewiresink", "-reset", "8"]);
});

test("requests a validated stream resolution", () => {
  const args = buildUxplayArgs({ resolution: "1280x720@60" });
  assert.deepEqual(args.slice(5, 7), ["-s", "1280x720@60"]);
  assert.equal(normalizeConfig({ resolution: "bad;value" }).resolution, null);
});

test("normalizes unsafe and out-of-range values", () => {
  const config = normalizeConfig({ receiverName: "", port: 65534, fps: 0, restartDelay: 10, extraArgs: [1, "-d"] });
  assert.equal(config.receiverName, "Magic Mirror");
  assert.equal(config.port, 7000);
  assert.equal(config.fps, 30);
  assert.equal(config.restartDelay, 5000);
  assert.deepEqual(config.extraArgs, ["-d"]);
});

test("parses ready, streaming, disconnect, and PIN log events", () => {
  assert.equal(parseUxplayLine("Initialized server socket(s)").state, "READY");
  assert.equal(parseUxplayLine("raop_rtp_mirror starting mirroring").state, "STREAMING");
  assert.equal(parseUxplayLine("client connection closed").state, "READY");
  assert.equal(parseUxplayLine("Please enter PIN code: 4821").pin, "4821");
});

test("classifies external daemon audio and video lifecycle events", () => {
  assert.deepEqual(classifyDaemonLine("Initialized server socket(s)"), { type: "server-ready" });
  assert.deepEqual(classifyDaemonLine("raop_rtp starting audio"), {
    type: "stream", stream: "audio", active: true
  });
  assert.deepEqual(classifyDaemonLine("raop_rtp exiting thread"), {
    type: "stream", stream: "audio", active: false
  });
  assert.deepEqual(classifyDaemonLine("raop_rtp_mirror starting mirroring"), {
    type: "stream", stream: "video", active: true
  });
  assert.deepEqual(classifyDaemonLine("raop_rtp_mirror exiting TCP thread"), {
    type: "stream", stream: "video", active: false
  });
  assert.deepEqual(classifyDaemonLine("video_reset: type = RTP_Shutdown"), {
    type: "stream", stream: "video", active: false
  });
  assert.equal(classifyDaemonLine("unrelated debug line"), null);
});

test("tracks audio volume and video display handoffs independently", () => {
  const lifecycle = new StreamLifecycle();
  let state = lifecycle.apply(classifyDaemonLine("Initialized server socket(s)"));
  assert.equal(state.state, "READY");
  assert.equal(state.volumeChanged, false);
  assert.equal(state.displayChanged, false);

  state = lifecycle.apply(classifyDaemonLine("raop_rtp starting audio"));
  assert.equal(state.state, "STREAMING");
  assert.equal(state.message, "AirPlay audio is streaming");
  assert.equal(state.volumeChanged, true);
  assert.equal(state.displayChanged, false);

  state = lifecycle.apply(classifyDaemonLine("raop_rtp starting audio"));
  assert.equal(state.statusChanged, false);
  assert.equal(state.volumeChanged, false);
  assert.equal(state.displayChanged, false);

  state = lifecycle.apply(classifyDaemonLine("raop_rtp_mirror starting mirroring"));
  assert.equal(state.message, "An AirPlay client is mirroring");
  assert.equal(state.volumeChanged, false);
  assert.equal(state.displayChanged, true);

  state = lifecycle.apply(classifyDaemonLine("raop_rtp exiting thread"));
  assert.equal(state.anyActive, true);
  assert.equal(state.videoActive, true);
  assert.equal(state.volumeChanged, false);

  state = lifecycle.apply(classifyDaemonLine("video_reset: type = RTP_Shutdown"));
  assert.equal(state.state, "READY");
  assert.equal(state.volumeChanged, true);
  assert.equal(state.displayChanged, true);
});

test("keeps the volume handoff active when video ends before audio", () => {
  const lifecycle = new StreamLifecycle();
  lifecycle.apply(classifyDaemonLine("raop_rtp starting audio"));
  lifecycle.apply(classifyDaemonLine("raop_rtp_mirror starting mirroring"));

  let state = lifecycle.apply(classifyDaemonLine("raop_rtp_mirror exiting TCP thread"));
  assert.equal(state.state, "STREAMING");
  assert.equal(state.message, "AirPlay audio is streaming");
  assert.equal(state.volumeChanged, false);
  assert.equal(state.displayChanged, true);

  state = lifecycle.apply(classifyDaemonLine("raop_rtp exiting thread"));
  assert.equal(state.state, "READY");
  assert.equal(state.volumeChanged, true);
  assert.equal(state.displayChanged, false);
});

test("Art Wall daemon uses explicit Pi hardware decoding and native Wayland fullscreen", () => {
  const args = buildUxplayArgs(daemonConfig);
  assert.ok(args.includes("v4l2h264dec capture-io-mode=mmap output-io-mode=mmap"));
  assert.ok(args.includes("videoconvert"));
  assert.ok(args.includes("-srgb"));
  assert.ok(args.includes("-bt709"));
  assert.ok(args.includes("1920x1080@60"));
  assert.deepEqual(args.slice(args.indexOf("-vsync"), args.indexOf("-vsync") + 2), ["-vsync", "no"]);
  assert.ok(args.includes("-FPSdata"));
  assert.deepEqual(args.slice(args.indexOf("-db"), args.indexOf("-db") + 3), ["-db", "-50:0", "-taper"]);
  assert.equal(daemonConfig.fps, 60);
  assert.equal(daemonConfig.manageSystemVolume, true);
  assert.equal(daemonConfig.systemVolumeLimitPercent, 100);
  assert.match(daemonConfig.videoSink, /sync=false/);
  assert.match(daemonConfig.videoSink, /fullscreen=true/);
  assert.ok(!args.includes("-fs"));
  assert.ok(!args.includes("-avdec"));
});
