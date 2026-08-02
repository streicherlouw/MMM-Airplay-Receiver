#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const configPath = path.resolve(process.argv[2] || "config/config.js");
const updates = JSON.parse(process.argv[3] || "{}");
const allowedKeys = new Set([
  "receiverName", "externalService", "externalStatusFile", "fullscreen", "pin",
  "persistTrustedClients", "port", "resolution", "fps",
  "lowLatency", "noFreeze", "inhibitScreensaver", "appendHostname", "videoSink",
  "audioSink", "display", "waylandDisplay", "xdgRuntimeDir", "dbusSessionBusAddress",
  "xAuthority", "useBt709", "allowTakeover", "restartOnExit", "restartDelay",
  "extraArgs", "showStatus", "hideStatusWhileStreaming"
]);

for (const key of Object.keys(updates)) {
  if (!allowedKeys.has(key)) throw new Error(`Unsupported module option: ${key}`);
}

function matchingBrace(source, openingIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Could not find the end of the module config object");
}

const original = fs.readFileSync(configPath, "utf8");
const moduleMatch = /module\s*:\s*["']MMM-Airplay-Receiver["']/.exec(original);
if (!moduleMatch) throw new Error(`MMM-Airplay-Receiver is not configured in ${configPath}`);

const configMatch = /\bconfig\s*:\s*\{/.exec(original.slice(moduleMatch.index));
if (!configMatch) throw new Error("The MMM-Airplay-Receiver entry has no config object");

const configStart = moduleMatch.index + configMatch.index + configMatch[0].lastIndexOf("{");
const configEnd = matchingBrace(original, configStart);
let block = original.slice(configStart + 1, configEnd);
const configLineStart = original.lastIndexOf("\n", configStart) + 1;
const configIndent = original.slice(configLineStart, configStart).match(/^\s*/)?.[0] || "";
const propertyIndent = `${configIndent}\t`;

for (const [key, value] of Object.entries(updates)) {
  const propertyPattern = new RegExp(`(^[\\t ]*)${key}\\s*:[^\\n]*(,?)([\\t ]*$)`, "m");
  const replacement = `${propertyIndent}${key}: ${JSON.stringify(value)},`;
  if (propertyPattern.test(block)) block = block.replace(propertyPattern, replacement);
  else block = `\n${replacement}${block}`;
}

const updated = original.slice(0, configStart + 1) + block + original.slice(configEnd);
new vm.Script(updated, { filename: configPath });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${configPath}.before-airplay-update-${timestamp}`;
const temporaryPath = `${configPath}.airplay-${process.pid}.tmp`;
const mode = fs.statSync(configPath).mode;

fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
try {
  fs.writeFileSync(temporaryPath, updated, { encoding: "utf8", mode });
  fs.renameSync(temporaryPath, configPath);
} catch (error) {
  fs.rmSync(temporaryPath, { force: true });
  throw error;
}

console.log(`Updated MMM-Airplay-Receiver in ${configPath}`);
console.log(`Backup: ${backupPath}`);
