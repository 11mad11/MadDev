/**
 * Windows-only embed point for the bundled DLLs. Kept isolated from
 * `winAssets.ts` so that a Linux `bun build --compile` (which never
 * has the Windows DLLs available) can skip this module entirely.
 *
 * Loaded dynamically with a non-literal module specifier so Bun's
 * static bundler does NOT pull this file in on non-Windows builds.
 * See `winAssets.ts` for the runtime guard.
 */
import wintunSource from "../../native/windows-tap/vendor/wintun.dll" with { type: "file" };
import madWintapSource from "../../native/windows-tap/target/x86_64-pc-windows-gnu/release/mad_wintap.dll" with { type: "file" };

export { wintunSource, madWintapSource };
