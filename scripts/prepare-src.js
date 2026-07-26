#!/usr/bin/env node
/**
 * Pre-build: Repack patched ASAR, bundle the matching official Codex CLI,
 * assemble for forge.
 *
 * Flow:
 *   1. Repack _asar/ -> app.asar (with patches applied)
 *   2. Bundle a verified official Codex CLI release
 *   3. Copy everything to src/ for forge (app.asar + unpacked + resources)
 *
 * For Linux: strip macOS-only resources, add an official Linux Codex CLI.
 *
 * Usage:
 *   node scripts/prepare-src.js --platform mac-arm64
 *   node scripts/prepare-src.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { resolveOfficialCodexBinary } = require("./official-codex-cli");

const SRC = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");
const DEFAULT_UPSTREAM_MAIN = ".vite/build/bootstrap.js";

// macOS-only resources to strip for Linux
const MACOS_STRIP = new Set([
  "codex_chronicle", "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
]);
const MACOS_STRIP_DIRS = new Set(["native"]);

function copyRecursive(src, dest, skipFiles, skipDirs) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs?.has(e.name)) continue;
    if (skipFiles?.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d, skipFiles, skipDirs); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function normalizeUpstreamMain(value) {
  if (typeof value !== "string") return DEFAULT_UPSTREAM_MAIN;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return DEFAULT_UPSTREAM_MAIN;
  }
  return normalized;
}

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  const VALID = ["mac-arm64", "mac-x64", "win", "linux-x64", "linux-arm64"];
  if (!platform || !VALID.includes(platform)) {
    console.error(`[x] Usage: prepare-src.js --platform <${VALID.join("|")}>`);
    process.exit(1);
  }

  const isLinux = platform.startsWith("linux");
  const sourceDir = isLinux
    ? path.join(SRC, platform === "linux-arm64" ? "mac-arm64" : "mac-x64")
    : path.join(SRC, platform);

  if (!fs.existsSync(sourceDir)) {
    console.error(`[x] Source not found: ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  const asarContentDir = path.join(sourceDir, "_asar");
  if (!fs.existsSync(asarContentDir)) {
    console.error(`[x] _asar/ not found in ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  console.log(`-- prepare-src: ${platform}`);
  console.log(`   source: ${path.relative(PROJECT_ROOT, sourceDir)}/`);

  // 1. Repack _asar/ -> app.asar
  const repackedAsar = path.join(sourceDir, "app.asar");
  console.log("   [repack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarContentDir}" "${repackedAsar}"`);
  const asarSize = (fs.statSync(repackedAsar).size / 1048576).toFixed(1);
  console.log(`   [ok] app.asar: ${asarSize} MB`);

  // 2. Bundle the official CLI selected for this release. Never silently
  // fall back to @cometix/codex here: doing so can pair a new UI with a stale
  // app-server implementation.
  const isWin = platform === "win";
  const codexBinName = isWin ? "codex.exe" : "codex";
  const officialCodex = resolveOfficialCodexBinary(platform);
  const codexDest = path.join(sourceDir, codexBinName);
  fs.copyFileSync(officialCodex.binaryPath, codexDest);
  try { fs.chmodSync(codexDest, 0o755); } catch {}
  console.log(`   [codex] bundled official ${officialCodex.tag} (${platform})`);

  // 2b. Linux needs the platform-native helpers from the exact same official
  // package as the CLI. This keeps code mode, ripgrep, and sandbox support in
  // lockstep with the app-server.
  if (isLinux) {
    if (!officialCodex.rgPath || !officialCodex.codeModeHostPath) {
      throw new Error(`Official ${officialCodex.tag} package is missing Linux runtime helpers`);
    }
    const rgDest = path.join(sourceDir, "rg");
    fs.copyFileSync(officialCodex.rgPath, rgDest);
    fs.chmodSync(rgDest, 0o755);

    const codeModeHostDest = path.join(sourceDir, "codex-code-mode-host");
    fs.copyFileSync(officialCodex.codeModeHostPath, codeModeHostDest);
    fs.chmodSync(codeModeHostDest, 0o755);

    if (officialCodex.bwrapPath) {
      const bwrapDest = path.join(sourceDir, "codex-resources", "bwrap");
      fs.mkdirSync(path.dirname(bwrapDest), { recursive: true });
      fs.copyFileSync(officialCodex.bwrapPath, bwrapDest);
      fs.chmodSync(bwrapDest, 0o755);
    }
    console.log(`   [helpers] bundled official rg, code-mode host${officialCodex.bwrapPath ? ", and bwrap" : ""}`);
  }

  // 3. For Linux: copy _asar/ content to flat src/ (forge packs ASAR from src/)
  //    Skip node_modules/ — upstream has macOS .node binaries.
  //    Native modules are rebuilt by electron-rebuild and synced separately.
  if (isLinux) {
    // Clear flat src/ dirs
    for (const d of [".vite", "webview", "skills", "native-menu-locales", "node_modules"]) {
      const p = path.join(SRC, d);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    for (const f of fs.readdirSync(SRC)) {
      const p = path.join(SRC, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
    const skipDirs = new Set(["node_modules"]);
    const count = copyRecursive(asarContentDir, SRC, null, skipDirs);
    console.log(`   [linux] _asar/ -> src/ (${count} files, skipped node_modules/)`);
  }

  // 4. Sync version to root package.json
  const upstreamPkg = path.join(asarContentDir, "package.json");
  let upstreamMain = DEFAULT_UPSTREAM_MAIN;
  if (fs.existsSync(upstreamPkg)) {
    const upstream = JSON.parse(fs.readFileSync(upstreamPkg, "utf-8"));
    upstreamMain = normalizeUpstreamMain(upstream.main);
    const rootPkgPath = path.join(PROJECT_ROOT, "package.json");
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    const oldVer = rootPkg.version;
    rootPkg.version = upstream.version || rootPkg.version;
    rootPkg.main = path.posix.join("src", upstreamMain);
    for (const key of [
      "codexBuildNumber", "codexBuildFlavor",
      "codexSparkleFeedUrl", "codexSparklePublicKey",
      "codexWindowsUpdateUrl", "codexWindowsPackageIdentity",
      "codexWindowsPackagePublisher",
    ]) {
      if (upstream[key]) rootPkg[key] = upstream[key];
    }
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`   version: ${oldVer} -> ${rootPkg.version}`);
    console.log(`   main: ${rootPkg.main}`);
  }

  // For mac/win: create stub main entry so forge validation passes.
  // The real code is in app.asar which we copy in packageAfterCopy.
  if (!isLinux) {
    const stubEntry = path.join(SRC, ...upstreamMain.split("/"));
    fs.mkdirSync(path.dirname(stubEntry), { recursive: true });
    fs.writeFileSync(stubEntry, "// stub - real code in app.asar\n");
    // Also need package.json in src/ for forge
    const asarPkg = path.join(asarContentDir, "package.json");
    if (fs.existsSync(asarPkg)) {
      fs.copyFileSync(asarPkg, path.join(SRC, "package.json"));
    }
  }

  // Write build mode marker for forge.config.js
  const marker = path.join(SRC, ".build-mode");
  fs.writeFileSync(marker, isLinux ? "linux" : "upstream-asar");
  console.log(`   [mode] ${isLinux ? "linux (forge packs ASAR)" : "upstream-asar (pre-built)"}`);

  console.log(`   [ok] src/ ready for ${platform} build`);
}

main();
