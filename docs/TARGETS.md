# ChatGPTDesktop-Rebuild Distribution Targets

## Scope

This fork publishes only:

- Windows x64
- Linux ARM64

Linux ARM64 builds must run on a native ARM64 runner. Cross-building native Node modules on an x64 runner is not accepted as a release path.

## Required Capabilities

Every release must be checked against this matrix.

| Capability | Windows x64 | Linux ARM64 |
|------------|-------------|-------------|
| CPA/custom API provider | Required | Required |
| Shared session history | Required | Required |
| GPT-5.6 model menu | Required | Required |
| low/medium/high/xhigh/ultra/max reasoning efforts | Required | Required |
| Fast mode, Standard by default | Required | Required |
| Plugin marketplace search | Required | Required |
| GitHub plugin visibility | Required | Required |
| Browser integration | Required | Required |
| Chrome extension integration | Required | Required |
| Computer Use integration | Required | Required |
| Chinese input method | Native Windows IME | fcitx5 |
| Minimize/maximize/window focus | Required | Required |

## Release Validation

Before publishing a release:

1. Build the target on its native architecture.
2. Confirm the packaged Codex CLI starts and reports the expected version.
3. Run an ephemeral API smoke request without recording credentials.
4. Verify the model and reasoning menus in the GUI.
5. Verify plugin marketplace search and the GitHub plugin.
6. Verify Browser, Chrome, and Computer Use exposure.
7. On Linux ARM64, verify fcitx5 input and standard window-manager actions.
8. Remove staging directories and large temporary build caches after validation.

## Upstream Policy

- `origin` is the MAE5 fork.
- `upstream` is `Haleclipse/CodexDesktop-Rebuild`.
- Merge upstream changes intentionally; do not overwrite MAE5 patches with a forced sync.
- Keep local installation directories separate from this source checkout.
- Never commit API keys, login tokens, cookies, local profiles, or session databases.
- Version-specific UI gates must be implemented in repository patch scripts and covered by post-build checks.
