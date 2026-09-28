"use strict";

class VideoHandoffCoordinator {
  constructor({
    showGuard,
    hideGuard,
    onTimeout,
    timeoutMs,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = () => {}
  }) {
    this.showGuard = showGuard;
    this.hideGuard = hideGuard;
    this.onTimeout = onTimeout;
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.pending = false;
    this.generation = 0;
    this.timer = null;
    this.guardPromise = null;
  }

  beginStopping() {
    if (this.pending) return this.guardPromise;
    this.pending = true;
    const generation = ++this.generation;
    this.guardPromise = Promise.resolve(this.showGuard());
    this.timer = this.setTimer(() => this.handleTimeout(generation), this.timeoutMs);
    return this.guardPromise;
  }

  confirmStopping() {
    const guardPromise = this.pending ? this.guardPromise : this.beginStopping();
    this.clearPending();
    return guardPromise;
  }

  cancelStopping() {
    const guardPromise = this.guardPromise;
    this.clearPending();
    return Promise.resolve(guardPromise).then(() => this.hideGuard());
  }

  clearPending() {
    this.generation += 1;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = false;
    this.guardPromise = null;
  }

  async handleTimeout(generation) {
    if (!this.pending || generation !== this.generation) return;
    const guardPromise = this.guardPromise;
    this.clearPending();
    try {
      await guardPromise;
      this.logger(`UxPlay did not confirm video teardown within ${this.timeoutMs} ms`);
      await this.onTimeout();
    } catch (error) {
      this.logger(`Video teardown fallback failed: ${error.message}`);
    }
  }
}

module.exports = { VideoHandoffCoordinator };
