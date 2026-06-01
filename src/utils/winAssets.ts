/**
 * Bundles wintun.dll + mad_wintap.dll into the Windows mad.exe via
 * bun's `with { type: "file" }` import attribute. At runtime,
 * `extractDlls()` copies them into a stable per-user directory and
 * returns the paths so the rest of the code can dlopen() them.
 *
 * Layout at runtime:
 *   %LOCALAPPDATA%\mad\native\
 *     wintun.dll           ← redistributed from wintun.net
 *     mad_wintap.dll       ← our Rust crate
 *
 * Why a stable directory rather than `dirname(execPath)`?
 *   - bun's compile-mode temp dir is recreated on every launch, so
 *     paths shift between runs. wintun's docs recommend a stable
 *     location.
 *   - Users may install mad.exe to a path they can't write to;
 *     %LOCALAPPDATA% is always writable.
 *
 * Only imported from `winNative.ts`, which itself is only imported
 * inside a process.platform === 'win32' branch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

// Static imports — bun build embeds the bytes into mad.exe.
// In dev (bun run …), these resolve to absolute filesystem paths.
import wintunSource from "../../native/windows-tap/vendor/wintun.dll" with { type: "file" };
import madWintapSource from "../../native/windows-tap/target/x86_64-pc-windows-gnu/release/mad_wintap.dll" with { type: "file" };

if (process.platform !== "win32") {
    throw new Error("winAssets.ts imported on non-Windows platform");
}

function localAppDataNativeDir(): string {
    const root = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
    return join(root, "mad", "native");
}

function copyIfChanged(srcPath: string, dstPath: string): void {
    const src = readFileSync(srcPath);
    if (existsSync(dstPath)) {
        const dst = readFileSync(dstPath);
        if (src.length === dst.length && src.equals(dst)) return;
    }
    writeFileSync(dstPath, src);
}

interface ExtractedPaths {
    nativeDir: string;
    wintun: string;
    madWintap: string;
}

let cached: ExtractedPaths | null = null;

/**
 * Idempotent. Extracts the embedded DLLs to %LOCALAPPDATA%/mad/native
 * (creating the directory if needed) and returns the runtime paths.
 *
 * Skips the copy if both DLLs already exist with identical bytes —
 * keeps mad.exe startup cheap on repeat launches.
 */
export function extractDlls(): ExtractedPaths {
    if (cached) return cached;

    const nativeDir = localAppDataNativeDir();
    mkdirSync(nativeDir, { recursive: true });

    const wintun = join(nativeDir, "wintun.dll");
    const madWintap = join(nativeDir, "mad_wintap.dll");

    // Sanity-check that the source paths actually exist (dev mode).
    // In compile mode, bun extracts them to a temp dir before we run.
    if (!existsSync(wintunSource)) {
        throw new Error(
            `wintun.dll not bundled or not built (looked at ${wintunSource}). ` +
            `Run \`curl -L https://www.wintun.net/builds/wintun-0.14.1.zip ...\` (see vendor/README.md).`,
        );
    }
    if (!existsSync(madWintapSource)) {
        throw new Error(
            `mad_wintap.dll not bundled or not built (looked at ${madWintapSource}). ` +
            `Run \`npm run build:windows-native\`.`,
        );
    }

    copyIfChanged(wintunSource, wintun);
    copyIfChanged(madWintapSource, madWintap);

    cached = { nativeDir, wintun, madWintap };
    return cached;
}

/** For diagnostics: when were the extracted DLLs last refreshed? */
export function extractedMtime(): Date | null {
    try {
        const { madWintap } = extractDlls();
        return statSync(madWintap).mtime;
    } catch {
        return null;
    }
}
