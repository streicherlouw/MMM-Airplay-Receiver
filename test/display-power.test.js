"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DisplayPowerManager,
  normalizeDisplayPowerConfig,
  parseWlrRandrOutput
} = require("../lib/display-power");

const OUTPUT_WITH_HDMI_OFF = `HDMI-A-1 "NEC Corporation E805 83105413NB (HDMI-A-1)"
  Physical size: 1770x1000 mm
  Enabled: no
  Modes:
    1920x1080 px, 60.000000 Hz (preferred)
NOOP-1 "Headless output 7"
  Enabled: yes
  Modes:
    1920x1080 px (current)
`;

test("parses the named output without using another output's state", () => {
  assert.deepEqual(parseWlrRandrOutput(OUTPUT_WITH_HDMI_OFF, "HDMI-A-1"), { enabled: false });
  assert.deepEqual(parseWlrRandrOutput(OUTPUT_WITH_HDMI_OFF, "NOOP-1"), { enabled: true });
  assert.throws(
    () => parseWlrRandrOutput(OUTPUT_WITH_HDMI_OFF, "DP-1"),
    /Output DP-1 was not found/
  );
});

test("normalizes display power settings", () => {
  assert.deepEqual(normalizeDisplayPowerConfig({
    manageDisplayPower: true,
    displayOutput: "DP-2",
    wlrRandrPath: "/custom/wlr-randr"
  }), {
    enabled: true,
    output: "DP-2",
    wlrRandrPath: "/custom/wlr-randr"
  });
  assert.equal(normalizeDisplayPowerConfig({}).enabled, false);
});

test("turns an off display on once and restores it after the session", async () => {
  const calls = [];
  const logs = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (args.length === 0) return { stdout: OUTPUT_WITH_HDMI_OFF };
    return { stdout: "" };
  };
  const manager = new DisplayPowerManager({ manageDisplayPower: true }, execute, (message) => {
    logs.push(message);
  });

  await Promise.all([manager.beginSession(), manager.beginSession()]);
  assert.deepEqual(calls, [
    ["/usr/bin/wlr-randr", []],
    ["/usr/bin/wlr-randr", ["--output", "HDMI-A-1", "--on", "--preferred"]]
  ]);

  await Promise.all([manager.endSession(), manager.endSession()]);
  assert.deepEqual(calls[2], [
    "/usr/bin/wlr-randr",
    ["--output", "HDMI-A-1", "--off"]
  ]);
  assert.match(logs[0], /Turned HDMI-A-1 on.*saved off/);
  assert.match(logs[1], /Restored HDMI-A-1 to off/);
});

test("restores an initially enabled display to its preferred mode", async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (args.length === 0) {
      return { stdout: OUTPUT_WITH_HDMI_OFF.replace("Enabled: no", "Enabled: yes") };
    }
    return { stdout: "" };
  };
  const manager = new DisplayPowerManager({ manageDisplayPower: true }, execute);

  await manager.beginSession();
  await manager.endSession();

  assert.deepEqual(calls[2], [
    "/usr/bin/wlr-randr",
    ["--output", "HDMI-A-1", "--on", "--preferred"]
  ]);
});
