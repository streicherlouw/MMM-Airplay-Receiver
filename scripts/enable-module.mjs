#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const configPath = path.resolve(process.argv[2] || "config/config.js");
const receiverName = process.argv[3] || "Art Wall";
const videoSink = process.argv[4] || "waylandsink";
const moduleName = "MMM-Airplay-Receiver";

const original = fs.readFileSync(configPath, "utf8");
if (/module\s*:\s*["']MMM-Airplay-Receiver["']/.test(original)) {
  console.log(`${moduleName} is already present in ${configPath}`);
  process.exit(0);
}

const modulesMatch = /\bmodules\s*:\s*\[/.exec(original);
if (!modulesMatch) {
  throw new Error(`Could not find the modules array in ${configPath}`);
}

const insertAt = modulesMatch.index + modulesMatch[0].length;
const snippet = `
\n\t\t{
\t\t\tmodule: ${JSON.stringify(moduleName)},
\t\t\tposition: "top_center",
\t\t\tconfig: {
\t\t\t\treceiverName: ${JSON.stringify(receiverName)},
\t\t\t\tpin: false,
\t\t\t\tshowStatus: false,
\t\t\t\tvideoSink: ${JSON.stringify(videoSink)}
\t\t\t}
\t\t},`;
const updated = original.slice(0, insertAt) + snippet + original.slice(insertAt);

new vm.Script(updated, { filename: configPath });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${configPath}.before-airplay-${timestamp}`;
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

console.log(`Enabled ${moduleName} in ${configPath}`);
console.log(`Backup: ${backupPath}`);
