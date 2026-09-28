"use strict";

function classifyDaemonLine(line) {
  const text = String(line).trim();
  if (!text) return null;

  if (/raop_rtp_mirror\s+starting\s+mirroring/i.test(text)) {
    return { type: "stream", stream: "video", active: true };
  }

  if (/raop_rtp\s+starting\s+audio/i.test(text)) {
    return { type: "stream", stream: "audio", active: true };
  }

  if (
    /raop_rtp_mirror->running is no longer true/i.test(text) ||
    /raop_rtp_mirror exiting TCP thread/i.test(text) ||
    /This packet indicates video stream is stopping/i.test(text)
  ) {
    return { type: "video-stopping" };
  }

  if (/video_reset:\s*type\s*=\s*RTP_Shutdown/i.test(text)) {
    return { type: "stream", stream: "video", active: false, teardownConfirmed: true };
  }

  if (/raop_rtp\s+exiting\s+thread/i.test(text) && !/raop_rtp_mirror/i.test(text)) {
    return { type: "stream", stream: "audio", active: false };
  }

  if (/Initialized server socket/i.test(text)) {
    return { type: "server-ready" };
  }

  return null;
}

class StreamLifecycle {
  constructor() {
    this.reset();
  }

  reset() {
    this.activeStreams = new Set();
    this.lastStatusKey = null;
    this.lastAnyActive = false;
    this.lastVideoActive = false;
  }

  snapshot() {
    const audioActive = this.activeStreams.has("audio");
    const videoActive = this.activeStreams.has("video");
    return { audioActive, videoActive, anyActive: audioActive || videoActive };
  }

  apply(event) {
    if (!event) return null;

    if (event.type === "stream") {
      if (event.active) this.activeStreams.add(event.stream);
      else this.activeStreams.delete(event.stream);
    }

    const audioActive = this.activeStreams.has("audio");
    const videoActive = this.activeStreams.has("video");
    const anyActive = audioActive || videoActive;
    const state = anyActive ? "STREAMING" : "READY";
    const message = videoActive
      ? "An AirPlay client is mirroring"
      : (audioActive ? "AirPlay audio is streaming" : "Waiting for an AirPlay client");
    const statusKey = `${state}\0${message}`;
    const result = {
      state,
      message,
      audioActive,
      videoActive,
      anyActive,
      statusChanged: statusKey !== this.lastStatusKey,
      volumeChanged: anyActive !== this.lastAnyActive,
      displayChanged: videoActive !== this.lastVideoActive
    };

    this.lastStatusKey = statusKey;
    this.lastAnyActive = anyActive;
    this.lastVideoActive = videoActive;
    return result;
  }
}

module.exports = { classifyDaemonLine, StreamLifecycle };
