#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    i++;
  }
  return values;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ["assets", "output", "version", "tag", "commit", "run-url"];
  for (const key of required) {
    if (!args[key]) throw new Error(`Required option missing: --${key}`);
  }

  const assetsDir = path.resolve(args.assets);
  const outputPath = path.resolve(args.output);
  const outputName = path.basename(outputPath);
  const files = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== outputName && entry.name !== "SHA256SUMS.txt")
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) throw new Error(`No release assets found in ${assetsDir}`);

  const manifest = {
    schemaVersion: 1,
    product: "ChatGPTDesktop-Rebuild",
    version: args.version,
    tag: args.tag,
    commit: args.commit,
    workflowRun: args["run-url"],
    generatedAt: new Date().toISOString(),
    upstream: {
      windowsX64: args["windows-version"] || null,
      linuxArm64: args["linux-version"] || null,
    },
    assets: files.map((name) => {
      const filePath = path.join(assetsDir, name);
      return {
        name,
        bytes: fs.statSync(filePath).size,
        sha256: sha256(filePath),
      };
    }),
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const pendingPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(pendingPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  fs.renameSync(pendingPath, outputPath);
  console.log(`Created ${path.relative(process.cwd(), outputPath)} with ${files.length} assets`);
}

main();
