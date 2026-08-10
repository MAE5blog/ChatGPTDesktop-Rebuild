#!/usr/bin/env node
/**
 * Verify that a Linux ARM64 Forge ZIP contains the runtime pieces required by
 * @parcel/watcher. This runs entirely against the built artifact and does not
 * launch the GUI.
 *
 * Usage:
 *   node scripts/verify-linux-runtime-package.js --artifact out/make/zip/linux/arm64/Codex-linux-arm64.zip
 *   node scripts/verify-linux-runtime-package.js --artifact <zip> --smoke
 *
 * --smoke requires a Linux ARM64 host. It runs the packaged Electron binary
 * with ELECTRON_RUN_AS_NODE=1 and requires @parcel/watcher from worker.js.
 */
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXIT = Object.freeze({
  USAGE: 2,
  ARTIFACT: 3,
  ARCHIVE: 4,
  LAYOUT: 5,
  ASAR: 6,
  BINDING: 7,
  SMOKE: 8,
  INTERNAL: 10,
});

const WATCHER_PACKAGE_JSON = "src/node_modules/@parcel/watcher/package.json";
const WORKER_ENTRY = "src/.vite/build/worker.js";

function verificationError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  error.exitCode = EXIT[kind] || EXIT.INTERNAL;
  return error;
}

function usage() {
  console.log("Usage: node scripts/verify-linux-runtime-package.js --artifact <linux-arm64.zip> [--smoke] [--keep-extracted]");
  console.log("");
  console.log("  --artifact <zip>   Linux ARM64 Forge ZIP to validate");
  console.log("  --smoke            Require @parcel/watcher via packaged Electron (Linux ARM64 only)");
  console.log("  --keep-extracted   Keep the temporary extracted artifact for diagnosis");
}

function parseArgs(argv) {
  const options = { smoke: false, keepExtracted: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--smoke") {
      options.smoke = true;
    } else if (arg === "--keep-extracted") {
      options.keepExtracted = true;
    } else if (arg === "--artifact") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw verificationError("USAGE", "Missing value for --artifact");
      }
      options.artifact = value;
      index++;
    } else {
      throw verificationError("USAGE", `Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.artifact) {
    throw verificationError("USAGE", "Required option missing: --artifact");
  }
  return options;
}

function readFileExcerpt(value) {
  return String(value || "").trim().slice(0, 4000);
}

function extractZip(artifact, destination) {
  const candidates = process.platform === "win32"
    ? [
        { command: "7zz.exe", args: ["x", "-y", `-o${destination}`, artifact] },
        { command: "7z.exe", args: ["x", "-y", `-o${destination}`, artifact] },
        { command: "7z", args: ["x", "-y", `-o${destination}`, artifact] },
      ]
    : [
        { command: "7zz", args: ["x", "-y", `-o${destination}`, artifact] },
        { command: "7z", args: ["x", "-y", `-o${destination}`, artifact] },
        { command: "unzip", args: ["-q", artifact, "-d", destination] },
      ];

  for (const candidate of candidates) {
    const result = childProcess.spawnSync(candidate.command, candidate.args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error && result.error.code === "ENOENT") continue;
    if (result.error) {
      throw verificationError("ARCHIVE", `Unable to run ${candidate.command}: ${result.error.message}`);
    }
    if (result.status === 0) {
      console.log(`[ok] Extracted archive with ${candidate.command}`);
      return;
    }
    const output = readFileExcerpt(`${result.stdout || ""}\n${result.stderr || ""}`);
    throw verificationError("ARCHIVE", `${candidate.command} failed to extract the ZIP${output ? `:\n${output}` : ""}`);
  }

  throw verificationError("ARCHIVE", "No supported ZIP extractor found (tried 7zz, 7z, and unzip)");
}

function walkFiles(root, predicate) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (!entry.isSymbolicLink() && predicate(entry, entryPath)) {
        matches.push(entryPath);
      }
    }
  }
  return matches;
}

function locatePackagedApp(extractedRoot) {
  const asarPaths = walkFiles(
    extractedRoot,
    (entry, entryPath) => entry.isFile() && entry.name === "app.asar" && path.basename(path.dirname(entryPath)) === "resources",
  );

  if (asarPaths.length !== 1) {
    const found = asarPaths.length ? asarPaths.map((file) => path.relative(extractedRoot, file)).join(", ") : "none";
    throw verificationError("LAYOUT", `Expected exactly one resources/app.asar in the ZIP; found ${found}`);
  }

  const appAsar = asarPaths[0];
  const resourcesDir = path.dirname(appAsar);
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  if (!fs.statSync(unpackedDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw verificationError("LAYOUT", `Missing app.asar.unpacked next to ${appAsar}`);
  }

  return {
    appAsar,
    appRoot: path.dirname(resourcesDir),
    resourcesDir,
    unpackedDir,
  };
}

function loadAsar() {
  try {
    return require("@electron/asar");
  } catch (error) {
    throw verificationError(
      "ASAR",
      `Cannot load @electron/asar. Run this verifier from a repository with npm ci completed: ${error.message}`,
    );
  }
}

function normalizeAsarPath(entry) {
  return entry.replace(/\\/g, "/").replace(/^\/+/, "");
}

function verifyAsarContents(appAsar, requireWorkerEntry) {
  const asar = loadAsar();
  let entries;
  try {
    entries = asar.listPackage(appAsar).map(normalizeAsarPath);
  } catch (error) {
    throw verificationError("ASAR", `Unable to read ${appAsar}: ${error.message}`);
  }

  if (!entries.includes(WATCHER_PACKAGE_JSON)) {
    throw verificationError("ASAR", `Missing ${WATCHER_PACKAGE_JSON} in resources/app.asar`);
  }
  if (requireWorkerEntry && !entries.includes(WORKER_ENTRY)) {
    throw verificationError("ASAR", `Missing ${WORKER_ENTRY} in resources/app.asar; cannot perform the runtime smoke check`);
  }

  let watcherPackage;
  try {
    watcherPackage = JSON.parse(asar.extractFile(appAsar, WATCHER_PACKAGE_JSON).toString("utf8"));
  } catch (error) {
    throw verificationError("ASAR", `Unable to parse ${WATCHER_PACKAGE_JSON}: ${error.message}`);
  }
  if (watcherPackage.name !== "@parcel/watcher") {
    throw verificationError("ASAR", `${WATCHER_PACKAGE_JSON} has unexpected package name: ${watcherPackage.name || "<missing>"}`);
  }

  console.log(`[ok] app.asar contains ${WATCHER_PACKAGE_JSON} (${watcherPackage.version || "unknown version"})`);
}

function readElfHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(20);
  try {
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead !== header.length) {
      throw verificationError("BINDING", `ELF header is truncated: ${filePath}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return header;
}

function isArm64Elf(filePath) {
  const header = readElfHeader(filePath);
  return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && header[4] === 2
    && header[5] === 1
    && header.readUInt16LE(18) === 183;
}

function verifyNativeBinding(unpackedDir) {
  const bindings = walkFiles(unpackedDir, (entry, entryPath) => {
    if (!entry.isFile() || !entry.name.endsWith(".node")) return false;
    const relative = path.relative(unpackedDir, entryPath).split(path.sep).join("/");
    return /(?:^|\/)src\/node_modules\/@parcel\/watcher-linux-arm64-(?:glibc|musl)\/.+\.node$/.test(relative);
  });

  if (bindings.length === 0) {
    throw verificationError(
      "BINDING",
      "Missing ARM64 @parcel/watcher native binding under app.asar.unpacked/src/node_modules/@parcel/watcher-linux-arm64-*/",
    );
  }

  const arm64Bindings = bindings.filter(isArm64Elf);
  if (arm64Bindings.length === 0) {
    const paths = bindings.map((file) => path.relative(unpackedDir, file)).join(", ");
    throw verificationError("BINDING", `Watcher native binding is not a Linux ARM64 ELF file: ${paths}`);
  }

  for (const binding of arm64Bindings) {
    console.log(`[ok] ARM64 watcher binding: ${path.relative(unpackedDir, binding)}`);
  }
}

function findElectronBinary(appRoot) {
  const conventionalNames = ["Codex", "ChatGPT", "codex", "chatgpt"];
  for (const name of conventionalNames) {
    const candidate = path.join(appRoot, name);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }

  const executables = fs.readdirSync(appRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(appRoot, entry.name))
    .filter((candidate) => {
      try { return isArm64Elf(candidate); } catch { return false; }
    });

  if (executables.length === 1) return executables[0];
  throw verificationError("SMOKE", `Cannot identify the packaged Electron executable in ${appRoot}`);
}

function runRuntimeSmoke(appAsar, appRoot) {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw verificationError("SMOKE", "--smoke must run on a Linux ARM64 host; static package validation can run anywhere");
  }

  const electron = findElectronBinary(appRoot);
  const workerPath = path.join(appAsar, ...WORKER_ENTRY.split("/"));
  const probe = [
    "const { createRequire } = require('module');",
    "const requireFromWorker = createRequire(process.env.CHATGPT_REBUILD_WORKER_ENTRY);",
    "const watcher = requireFromWorker('@parcel/watcher');",
    "if (!watcher || typeof watcher.subscribe !== 'function') throw new Error('@parcel/watcher.subscribe is unavailable');",
    "process.stdout.write('@parcel/watcher runtime smoke passed\\n');",
  ].join(" ");

  try { fs.chmodSync(electron, 0o755); } catch {}
  const result = childProcess.spawnSync(electron, ["-e", probe], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CHATGPT_REBUILD_WORKER_ENTRY: workerPath,
    },
  });

  if (result.error) {
    throw verificationError("SMOKE", `Electron runtime smoke could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = readFileExcerpt(`${result.stdout || ""}\n${result.stderr || ""}`);
    throw verificationError("SMOKE", `Electron runtime smoke failed${output ? `:\n${output}` : ""}`);
  }
  console.log(`[ok] ${readFileExcerpt(result.stdout || "@parcel/watcher runtime smoke passed")}`);
}

function verifyArtifact(options) {
  const artifact = path.resolve(options.artifact);
  const stat = fs.statSync(artifact, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw verificationError("ARTIFACT", `Artifact not found: ${artifact}`);
  }
  if (stat.size === 0) {
    throw verificationError("ARTIFACT", `Artifact is empty: ${artifact}`);
  }
  if (path.extname(artifact).toLowerCase() !== ".zip") {
    throw verificationError("ARTIFACT", `Expected a .zip artifact: ${artifact}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-rebuild-verify-"));
  try {
    extractZip(artifact, tempRoot);
    const packaged = locatePackagedApp(tempRoot);
    verifyAsarContents(packaged.appAsar, options.smoke);
    verifyNativeBinding(packaged.unpackedDir);
    if (options.smoke) runRuntimeSmoke(packaged.appAsar, packaged.appRoot);
    console.log(`[ok] Linux ARM64 runtime package verification passed: ${artifact}`);
  } finally {
    if (options.keepExtracted) {
      console.log(`[info] Extracted artifact retained at ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  verifyArtifact(options);
}

try {
  main();
} catch (error) {
  const kind = error.kind || "INTERNAL";
  console.error(`[${kind}] ${error.message}`);
  process.exitCode = error.exitCode || EXIT.INTERNAL;
}
