# Rebrand distribution & auto-update continuity — decision

**Date:** 2026-07-21
**Status:** Decided
**Applies to:** the localflow → saiife rename (appId `dev.hrrobinson.localflow` → `dev.hrrobinson.saiife`)

## Question

Changing `appId` makes the renamed build a different application to the OS and
to any updater. Can existing installs cross the change, or does this need a
final release under the old identity that points users at the new download?

## Evidence

Measured on 2026-07-21 against `main`:

- `electron-updater` and `update-electron-app` appear in neither `package.json`
  nor `package-lock.json`.
- `grep -rn 'autoUpdater' src` returns nothing. The app contains no update code.
- `electron-builder.yml` has no `publish:` key.
- `.github/workflows/release.yml` builds with `--publish never` on both jobs and
  attaches the artifacts to a GitHub Release with `gh release upload`.
- `README.md` tells users to download the `.dmg` / `.AppImage` / `.deb` from the
  Releases page by hand.

## Decision

**There is no auto-updater to preserve.** Distribution is manual download from
GitHub Releases, so the `appId` change cannot break an update channel — none
exists. No final release under the old identity is required, and no updater
migration work is in scope.

Two real consequences remain, and both are release-note items rather than code:

1. **macOS installs a second app.** `saiife.app` does not replace `localflow.app`;
   both sit in /Applications until the user deletes the old one. The userData
   carry-over means the new app starts with the old app's data, and the old
   directory is left intact, so deleting the old bundle is safe and loses
   nothing.
2. **Linux `.deb` is a new package.** electron-builder derives the package name
   from `productName`, so `saiife_<version>_amd64.deb` installs alongside the
   still-registered `localflow` package instead of upgrading it. Users should
   `sudo apt remove localflow` after installing saiife. The AppImage is a plain
   file rename with no package manager involved.

## Release-note lines this produces

- saiife replaces localflow. Your settings, sessions, flows, themes and captures
  are copied across automatically on first launch; the old data is left where it
  was, so nothing is lost if you go back.
- macOS: the old localflow app is not removed. Drag it to the Trash once saiife
  starts up correctly.
- Linux (deb): run `sudo apt remove localflow` after installing saiife — the two
  are separate packages.

## What would invalidate this

Adding `electron-updater`, a `publish:` block in `electron-builder.yml`, or any
`--publish` value other than `never`. If any of those land, redo this decision
before the first saiife release.
