/**
 * mad doctor — diagnose + repair client-side install state.
 *
 * Today's main job: drive the TAP-Windows6 driver install on Windows
 * without making the user dig around in the OpenVPN downloads page.
 * The Rust side does the elevated launch (ShellExecuteW + verb=runas
 * → UAC), this file owns the discovery, download, and reporting.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";

interface DoctorOpts {
    installL2Driver?: boolean;
}

const TAP_WINDOWS_URL = "https://build.openvpn.net/downloads/releases/tap-windows-9.27.10.exe";

async function downloadInstaller(destDir: string): Promise<string> {
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, "tap-windows-9.27.10.exe");

    if (existsSync(dest) && statSync(dest).size > 100_000) {
        process.stdout.write(`installer already cached at ${dest}\n`);
        return dest;
    }

    process.stdout.write(`downloading ${TAP_WINDOWS_URL}…\n`);
    const res = await fetch(TAP_WINDOWS_URL);
    if (!res.ok) {
        throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100_000) {
        throw new Error(`downloaded file is suspiciously small (${bytes.length} bytes) — bad URL or redirect?`);
    }
    writeFileSync(dest, bytes);
    process.stdout.write(`saved ${bytes.length.toLocaleString()} bytes to ${dest}\n`);
    return dest;
}

export async function runDoctor(opts: DoctorOpts): Promise<void> {
    if (process.platform !== "win32") {
        process.stdout.write("mad doctor: nothing to do on this platform (Windows-only checks)\n");
        return;
    }

    const { winNative } = await import("../utils/winNative");

    // Always report L3 (wintun) status.
    try {
        winNative.loadWintun();
        process.stdout.write("✓ wintun.dll loads (L3 available)\n");
    } catch (e: any) {
        process.stdout.write(`✗ wintun.dll load failed: ${e.message}\n`);
    }

    // L2 driver state.
    const l2Installed = winNative.isL2DriverInstalled();
    if (l2Installed) {
        process.stdout.write("✓ TAP-Windows6 driver installed (L2 available)\n");
    } else {
        process.stdout.write("✗ TAP-Windows6 driver NOT installed (L2 unavailable)\n");
    }

    if (!opts.installL2Driver) {
        if (!l2Installed) {
            process.stdout.write("\nRe-run with --install-l2-driver to install it now (will UAC-prompt).\n");
        }
        return;
    }

    if (l2Installed) {
        process.stdout.write("\nL2 driver is already installed — nothing to do.\n");
        return;
    }

    // Download + run.
    const tmp = process.env.TEMP ?? "C:\\Windows\\Temp";
    const dest = await downloadInstaller(join(tmp, "mad-doctor"));

    process.stdout.write("\nlaunching installer (UAC will prompt)…\n");
    const exit = winNative.installL2Driver(dest);
    process.stdout.write(`installer exit code: ${exit}\n`);

    // Verify.
    const after = winNative.isL2DriverInstalled();
    if (after) {
        process.stdout.write("✓ TAP-Windows6 driver now installed.\n");
    } else {
        process.stdout.write("✗ Installer reported success but driver still isn't detected. Check Device Manager.\n");
        process.exit(1);
    }
}
