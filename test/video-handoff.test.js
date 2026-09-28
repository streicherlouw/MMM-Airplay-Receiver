"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { VideoHandoffCoordinator } = require("../lib/video-handoff");

function harness() {
  const calls = [];
  let timer = null;
  let cleared = false;
  const coordinator = new VideoHandoffCoordinator({
    showGuard: async () => calls.push("show"),
    hideGuard: async () => calls.push("hide"),
    onTimeout: async () => calls.push("timeout"),
    timeoutMs: 2000,
    setTimer: (callback) => {
      timer = callback;
      return 1;
    },
    clearTimer: () => {
      cleared = true;
    }
  });
  return { coordinator, calls, getTimer: () => timer, wasCleared: () => cleared };
}

test("covers on the first stop hint and waits for confirmed teardown", async () => {
  const state = harness();
  await Promise.all([
    state.coordinator.beginStopping(),
    state.coordinator.beginStopping()
  ]);
  assert.deepEqual(state.calls, ["show"]);
  assert.equal(state.coordinator.pending, true);

  await state.coordinator.confirmStopping();
  assert.equal(state.wasCleared(), true);
  assert.equal(state.coordinator.pending, false);
  await state.getTimer()();
  assert.deepEqual(state.calls, ["show"]);
});

test("recycles the receiver when teardown confirmation times out", async () => {
  const state = harness();
  await state.coordinator.beginStopping();
  await state.getTimer()();
  assert.deepEqual(state.calls, ["show", "timeout"]);
  assert.equal(state.coordinator.pending, false);
});

test("a new video start cancels teardown and removes the guard", async () => {
  const state = harness();
  await state.coordinator.beginStopping();
  await state.coordinator.cancelStopping();
  assert.deepEqual(state.calls, ["show", "hide"]);
  assert.equal(state.coordinator.pending, false);
});
