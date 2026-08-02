"use strict";

function classifyDaemonLine(line) {
  const text = String(line).trim();
  if (!text) return null;

  if (/raop_rtp_mirror\s+starting\s+mirroring/i.test(text)) {
    return { state: "STREAMING", message: "An AirPlay client is connected" };
  }

  if (
    /raop_rtp_mirror->running is no longer true/i.test(text) ||
    /raop_rtp_mirror exiting TCP thread/i.test(text) ||
    /This packet indicates video stream is stopping/i.test(text) ||
    /video_reset:\s*type\s*=\s*RTP_Shutdown/i.test(text)
  ) {
    return { state: "READY", message: "Waiting for an iPhone" };
  }

  if (/Initialized server socket/i.test(text)) {
    return { state: "READY", message: "Waiting for an iPhone" };
  }

  return null;
}

module.exports = { classifyDaemonLine };
