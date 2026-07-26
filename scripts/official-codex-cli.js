#!/usr/bin/env node
/**
 * Resolve and download a verified official Codex CLI binary.
 *
 * Rebuild used to replace the upstream CLI with @cometix/codex. That makes
 * desktop builds lag whenever the fork's npm package lags upstream. This
 * helper makes the official release the default bundled CLI source instead.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const RELEASES_URL = "https://github.com/openai/codex/releases";
const VERSION_FILE = path.join(__dirname, ".versions.json");

const TARGETS = {
  "mac-arm64": {
    triple: "aarch64-apple-darwin",
    binaryName: "codex",
    codeModeHostName: "codex-code-mode-host",
    rgName: "rg",
  },
  "mac-x64": {
    triple: "x86_64-apple-darwin",
    binaryName: "codex",
    codeModeHostName: "codex-code-mode-host",
    rgName: "rg",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    binaryName: "codex",
    codeModeHostName: "codex-code-mode-host",
    rgName: "rg",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    binaryName: "codex",
    codeModeHostName: "codex-code-mode-host",
    rgName: "rg",
  },
  win: {
    triple: "x86_64-pc-windows-msvc",
    binaryName: "codex.exe",
    codeModeHostName: "codex-code-mode-host.exe",
    rgName: "rg.exe",
  },
};

function normalizeVersion(value) {
  const match = String(value || "").trim()
    .match(/^(?:rust-v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match ? match[1] : null;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolveOfficialCodexRelease(requestedVersion = process.env.CODEX_CLI_VERSION) {
  const requested = normalizeVersion(requestedVersion);
  if (requested) return { version: requested, tag: `rust-v${requested}` };

  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const effectiveUrl = execFileSync("curl", [
    "--fail", "--silent", "--show-error", "--location",
    "--output", nullDevice,
    "--write-out", "%{url_effective}",
    `${RELEASES_URL}/latest`,
  ], { encoding: "utf-8" }).trim();
  const tagMatch = effectiveUrl.match(/\/releases\/tag\/(rust-v[^/?#]+)$/);
  const version = normalizeVersion(tagMatch?.[1]);
  if (!version) throw new Error(`Unable to resolve the latest stable Codex release from ${effectiveUrl}`);
  return { version, tag: `rust-v${version}` };
}

function releaseAssetUrl(tag, assetName) {
  return `${RELEASES_URL}/download/${tag}/${assetName}`;
}

function downloadOfficialReleaseAsset(version, assetName, cacheNamespace = "official-codex-cli") {
  const { version: resolvedVersion, tag } = resolveOfficialCodexRelease(version);
  const sums = execFileSync("curl", [
    "--fail", "--silent", "--show-error", "--location", "--retry", "3", "--retry-delay", "2",
    releaseAssetUrl(tag, "codex-package_SHA256SUMS"),
  ], { encoding: "utf-8", maxBuffer: 1024 * 1024 });
  const sumLine = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${assetName}`));
  const expectedHash = sumLine?.match(/^([0-9a-f]{64})\s+/i)?.[1]?.toLowerCase();
  if (!expectedHash) throw new Error(`Official ${tag} checksums do not include ${assetName}`);
  const cacheRoot = process.env.CODEX_CLI_CACHE_DIR
    || path.join(os.tmpdir(), cacheNamespace, resolvedVersion);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const archivePath = path.join(cacheRoot, assetName);

  if (!fs.existsSync(archivePath) || sha256File(archivePath) !== expectedHash) {
    const partialPath = `${archivePath}.partial-${process.pid}`;
    fs.rmSync(partialPath, { force: true });
    try {
      execFileSync("curl", [
        "--fail", "--location", "--retry", "3", "--retry-delay", "2",
        "-o", partialPath,
        releaseAssetUrl(tag, assetName),
      ], { stdio: "inherit" });
      const actualHash = sha256File(partialPath);
      if (actualHash !== expectedHash) {
        throw new Error(`SHA-256 mismatch for ${assetName}: ${actualHash}`);
      }
      fs.rmSync(archivePath, { force: true });
      fs.renameSync(partialPath, archivePath);
    } finally {
      fs.rmSync(partialPath, { force: true });
    }
  }

  return { version: resolvedVersion, tag, archivePath, assetName, expectedHash };
}

function resolveOfficialCodexBinary(platform, requestedVersion = process.env.CODEX_CLI_VERSION) {
  const target = TARGETS[platform];
  if (!target) throw new Error(`Unsupported Codex CLI platform: ${platform}`);

  const assetName = `codex-package-${target.triple}.tar.gz`;
  const downloaded = downloadOfficialReleaseAsset(requestedVersion, assetName);
  const extractDir = path.join(path.dirname(downloaded.archivePath), target.triple);
  const metadataPath = path.join(extractDir, "metadata.json");
  const binaryPath = path.join(extractDir, "bin", target.binaryName);
  const codeModeHostPath = path.join(extractDir, "bin", target.codeModeHostName);
  const rgPath = path.join(extractDir, "codex-path", target.rgName);
  const bwrapPath = path.join(extractDir, "codex-resources", "bwrap");
  let metadata = null;
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")); } catch {}
  const cacheIsValid = metadata?.version === downloaded.version
    && metadata?.sha256 === downloaded.expectedHash
    && fs.existsSync(binaryPath);

  if (!cacheIsValid) {
    const pendingDir = `${extractDir}.pending-${process.pid}`;
    fs.rmSync(pendingDir, { recursive: true, force: true });
    fs.mkdirSync(pendingDir, { recursive: true });
    try {
      execFileSync("tar", ["xzf", downloaded.archivePath, "-C", pendingDir], { stdio: "pipe" });
      const pendingBinary = path.join(pendingDir, "bin", target.binaryName);
      if (!fs.existsSync(pendingBinary)) throw new Error(`Unable to find ${pendingBinary} in ${downloaded.assetName}`);
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.renameSync(pendingDir, extractDir);
      fs.writeFileSync(metadataPath, `${JSON.stringify({
        version: downloaded.version,
        tag: downloaded.tag,
        assetName: downloaded.assetName,
        sha256: downloaded.expectedHash,
      }, null, 2)}\n`);
    } finally {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
  }

  const requiredFiles = [binaryPath, codeModeHostPath, rgPath];
  if (requiredFiles.some((filePath) => !fs.existsSync(filePath) || fs.statSync(filePath).size === 0)) {
    throw new Error(`Official ${downloaded.tag} package is missing required runtime files for ${platform}`);
  }
  try { fs.chmodSync(binaryPath, 0o755); } catch {}
  for (const filePath of [codeModeHostPath, rgPath, bwrapPath]) {
    try { fs.chmodSync(filePath, 0o755); } catch {}
  }
  return {
    ...downloaded,
    platform,
    triple: target.triple,
    binaryPath,
    codeModeHostPath: fs.existsSync(codeModeHostPath) ? codeModeHostPath : null,
    rgPath: fs.existsSync(rgPath) ? rgPath : null,
    bwrapPath: fs.existsSync(bwrapPath) ? bwrapPath : null,
  };
}

function saveResolvedVersion(version) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch {}
  saved["Codex CLI"] = { version, checkedAt: new Date().toISOString() };
  fs.writeFileSync(VERSION_FILE, `${JSON.stringify(saved, null, 2)}\n`);
}

module.exports = {
  downloadOfficialReleaseAsset,
  normalizeVersion,
  resolveOfficialCodexBinary,
  resolveOfficialCodexRelease,
};

if (require.main === module) {
  try {
    const release = resolveOfficialCodexRelease();
    if (process.argv.includes("--save")) saveResolvedVersion(release.version);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ version: release.version, tag: release.tag }));
    else if (!process.argv.includes("--quiet")) console.log(`${release.version} (${release.tag})`);
  } catch (error) {
    console.error(`Failed to resolve official Codex CLI: ${error.message}`);
    process.exit(2);
  }
}
