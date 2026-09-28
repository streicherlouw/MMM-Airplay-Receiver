"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  BlackFrameGuard,
  buildBlackFrameArgs,
  normalizeBlackFrameConfig
} = require("../lib/black-frame-guard");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

test("normalizes a black-frame guard from the receiver resolution", () => {
  assert.deepEqual(normalizeBlackFrameConfig({
    manageBlackFrameGuard: true,
    resolution: "1280x720@60",
    blackFrameReadyDelayMs: 250,
    blackFrameRate: 5
  }), {
    enabled: true,
    command: "/usr/bin/gst-launch-1.0",
    readyDelayMs: 250,
    terminationTimeoutMs: 1500,
    frameRate: 5,
    width: 1280,
    height: 720
  });
});

test("builds a fullscreen continuous black Wayland pipeline", () => {
  const config = normalizeBlackFrameConfig({
    manageBlackFrameGuard: true,
    resolution: "1920x1080@60"
  });
  const args = buildBlackFrameArgs(config);
  assert.ok(args.includes("pattern=black"));
  assert.ok(args.includes("video/x-raw,width=1920,height=1080,framerate=10/1"));
  assert.deepEqual(args.slice(-5), [
    "waylandsink",
    "fullscreen=true",
    "sync=false",
    "async=false",
    "enable-last-sample=false"
  ]);
});

test("shows one guard process and removes it cleanly", async () => {
  const calls = [];
  const logs = [];
  const child = new FakeChild();
  const guard = new BlackFrameGuard(
    { manageBlackFrameGuard: true },
    (command, args) => {
      calls.push([command, args]);
      return child;
    },
    async () => {},
    (message) => logs.push(message)
  );

  assert.equal(await guard.show(), true);
  assert.equal(await guard.show(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/gst-launch-1.0");

  assert.equal(await guard.hide(), true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.match(logs[0], /covering the Wayland output/);
  assert.match(logs[1], /Removed black handoff frame/);
});
