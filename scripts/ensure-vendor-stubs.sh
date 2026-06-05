#!/usr/bin/env bash
# Create empty stub DLL files at the paths winAssetsEmbed.ts imports, so
# that bun build --compile can resolve them on Linux/macOS hosts where
# the real Windows-toolchain artifacts don't exist. The stubs are inert
# at runtime — winAssets.ts is only loaded on win32 (see winNative.ts
# import guard).
#
# On Windows builds the real DLLs are produced/vendored before this
# script runs (build:windows-native + the CI wintun.dll download), and
# this script's `-e` test leaves them alone.
set -euo pipefail
mkdir -p native/windows-tap/vendor
[ -e native/windows-tap/vendor/wintun.dll ] || touch native/windows-tap/vendor/wintun.dll
mkdir -p native/windows-tap/target/x86_64-pc-windows-gnu/release
[ -e native/windows-tap/target/x86_64-pc-windows-gnu/release/mad_wintap.dll ] \
    || touch native/windows-tap/target/x86_64-pc-windows-gnu/release/mad_wintap.dll
