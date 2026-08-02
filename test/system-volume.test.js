"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SystemVolumeManager,
  normalizeSystemVolumeConfig,
  parseWpctlVolume
} = require("../lib/system-volume");

test("parses wpctl volume and mute state", () => {
  assert.deepEqual(parseWpctlVolume("Volume: 0.40\n"), { volume: 0.4, muted: false });
  assert.deepEqual(parseWpctlVolume("Volume: 1.00 [MUTED]\n"), { volume: 1, muted: true });
  assert.throws(() => parseWpctlVolume("no volume here"), /Unexpected wpctl volume output/);
});

test("normalizes system volume settings to a maximum of 100 percent", () => {
  assert.deepEqual(normalizeSystemVolumeConfig({
    manageSystemVolume: true,
    systemVolumeLimitPercent: 80,
    systemVolumeTarget: "sink-id",
    wpctlPath: "/custom/wpctl"
  }), {
    enabled: true,
    limitPercent: 80,
    target: "sink-id",
    wpctlPath: "/custom/wpctl"
  });
  assert.equal(normalizeSystemVolumeConfig({ systemVolumeLimitPercent: 120 }).limitPercent, 100);
});

test("sets a capped streaming volume once and restores the previous state", async () => {
  const calls = [];
  const logs = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "get-volume") return { stdout: "Volume: 0.40 [MUTED]\n" };
    return { stdout: "" };
  };
  const manager = new SystemVolumeManager({
    manageSystemVolume: true,
    systemVolumeLimitPercent: 100
  }, execute, (message) => logs.push(message));

  await Promise.all([manager.beginSession(), manager.beginSession()]);
  assert.deepEqual(calls, [
    ["/usr/bin/wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]],
    ["/usr/bin/wpctl", ["set-volume", "-l", "1", "@DEFAULT_AUDIO_SINK@", "1"]],
    ["/usr/bin/wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "0"]]
  ]);

  await Promise.all([manager.endSession(), manager.endSession()]);
  assert.deepEqual(calls.slice(3), [
    ["/usr/bin/wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.4"]],
    ["/usr/bin/wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "1"]]
  ]);
  assert.match(logs[0], /Set .* to 100%/);
  assert.match(logs[1], /Restored .* to 40%, muted/);
});
