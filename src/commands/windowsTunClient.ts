/**
 * Windows-specific `mad tap/tun join` flow. Mirrors the structure of
 * tunClient.ts but uses the Rust native module (mad_wintap.dll) to
 * own the adapter creation + ssh subprocess + frame pump.
 *
 * The mad.exe process stays in the foreground for the lifetime of
 * the tunnel — same UX as Linux/macOS. Ctrl+C / SIGINT triggers a
 * clean teardown.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import chalk from "chalk";

import type { TunMode } from "./tunClient";

// Shape mirrors src/commands/tunClient.ts::TunStateEntry so `mad tap ls`
// and `mad tap leave` (which read the same file via tunClient) work
// uniformly across platforms. On Windows `sshPid` holds the mad.exe
// process owning the tunnel — killing it triggers our cleanup
// handler which tears down the wintun adapter.
interface WinTunStateEntry {
    gateway: string;
    group: string;
    localIfname: string;   // wintun adapter name, e.g. "mad-stress"
    localIp: string;
    peerIp: string;
    sshPid: number;        // mad.exe pid on Windows
    startedAt: number;
}
interface WinTunState { entries: WinTunStateEntry[]; }

const STATE_DIR = join(homedir(), ".config", "mad");
const STATE_FILE = join(STATE_DIR, "tun-state.json");

function loadState(): WinTunState {
    if (!existsSync(STATE_FILE)) return { entries: [] };
    try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
    catch { return { entries: [] }; }
}
function saveState(s: WinTunState): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/**
 * On Windows the user must be a local Administrator to create a
 * wintun adapter (driver install + adapter add both require it).
 * We can't check this perfectly from a non-elevated shell, but
 * `net session` exits non-zero unless we're elevated, which is the
 * canonical probe.
 */
function isElevated(): boolean {
    const r = spawnSync("net", ["session"], { stdio: ["ignore", "ignore", "ignore"] });
    return r.status === 0;
}

function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

/**
 * Resolve the ssh.exe to use. Windows ships Microsoft OpenSSH at
 * C:\Windows\System32\OpenSSH\ssh.exe, but it treats stdin in text
 * mode (CRLF translation + 0x1A-as-EOF) which silently corrupts the
 * binary frame stream our pump produces. Git for Windows ships an
 * MSYS-based ssh.exe that handles binary stdin correctly. We prefer
 * Git's, fall back to whatever's on PATH, and let users override via
 * `MAD_SSH`.
 */
function resolveSshExe(): string {
    const override = process.env.MAD_SSH;
    if (override) return override;

    const candidates = [
        "C:\\Program Files\\Git\\usr\\bin\\ssh.exe",
        "C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe",
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    process.stderr.write(
        "warning: Git for Windows' ssh.exe not found — falling back to system ssh, which mangles binary stdin and will likely drop most frames. " +
        "Install Git for Windows (https://git-scm.com/download/win) or set MAD_SSH=<path> to a binary-safe ssh.\n",
    );
    return "ssh";
}

/**
 * Sweep stale entries from the state file: any tunnel whose owning
 * process is no longer alive. Attempts to delete the leftover wintun
 * adapter (no-op if wintun already reclaimed it after its 1-minute
 * abandon timeout), then prunes the state record.
 */
function sweepStaleAdapters(winNativeApi: { deleteWintunAdapter(name: string): boolean }): void {
    const state = loadState();
    const alive: WinTunStateEntry[] = [];
    const reaped: string[] = [];
    for (const e of state.entries) {
        if (pidAlive(e.sshPid)) {
            alive.push(e);
            continue;
        }
        try {
            const deleted = winNativeApi.deleteWintunAdapter(e.localIfname);
            if (deleted) reaped.push(e.localIfname);
        } catch (err) {
            process.stderr.write(`mad: failed to clean up stale adapter ${e.localIfname}: ${err}\n`);
            // Still drop the state entry — better to forget than to
            // accumulate.
        }
    }
    if (reaped.length > 0) {
        process.stdout.write(`reaped stale wintun adapters: ${reaped.join(", ")}\n`);
    }
    if (alive.length !== state.entries.length) {
        saveState({ entries: alive });
    }
}

export async function windowsTunJoin(gwGroup: string, requestedMode?: TunMode): Promise<void> {
    if (!isElevated()) {
        process.stderr.write("mad tap/tun join requires an Administrator shell on Windows.\n");
        process.stderr.write("  Right-click your terminal and choose \"Run as Administrator\", then retry.\n");
        process.exit(2);
    }

    const mode: TunMode = requestedMode ?? "l3";

    const parts = gwGroup.split("/");
    if (parts.length !== 2) throw new Error("expected <gateway>/<group>");
    const [gateway, group] = parts;

    const { winNative } = await import("../utils/winNative");

    // 1. Load the right backend for the requested mode.
    //    L3 needs wintun.dll loaded; L2 needs TAP-Windows6 driver +
    //    a mad-<group> adapter to exist (we auto-create it if not).
    if (mode === "l3") {
        winNative.loadWintun();
    } else {
        if (!winNative.isL2DriverInstalled()) {
            process.stderr.write(
                "L2 (TAP) on Windows requires the TAP-Windows6 driver to be installed.\n" +
                "  Run `sudo mad doctor --install-l2-driver` to install it (UAC prompt),\n" +
                "  or install it manually from\n" +
                "    https://build.openvpn.net/downloads/releases/tap-windows-9.24.7-I601-Win10.exe\n",
            );
            process.exit(2);
        }
        // Create + rename the adapter if it doesn't exist. Requires
        // admin (which we already verified above via `net session`).
        process.stdout.write(`ensuring TAP-Windows6 adapter mad-${group} exists…\n`);
        winNative.createL2Adapter(group);
    }

    // 1b. Sweep any wintun adapters left behind by a prior mad.exe
    //     process that crashed without cleanup. Wintun itself reaps
    //     abandoned adapters after ~60s, but explicit deletion is
    //     faster + keeps the state file clean.
    sweepStaleAdapters(winNative);

    // 2. Acquire the adapter. L3 creates a fresh wintun adapter;
    //    L2 opens an existing TAP-Windows6 adapter named `mad-<group>`.
    const backendLabel = mode === "l3" ? "wintun (L3)" : "TAP-Windows6 (L2)";
    process.stdout.write(`opening ${backendLabel} adapter mad-${group}…\n`);
    const handle = winNative.open(group, mode);

    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { winNative.pumpStop(handle); } catch {}
        try { winNative.close(handle); } catch {}
        const state = loadState();
        state.entries = state.entries.filter(e => !(e.gateway === gateway && e.group === group && e.sshPid === process.pid));
        saveState(state);
    };
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("exit", cleanup);

    try {
        // 3. Spawn ssh + start the pump in Rust. SSH_ORIGINAL_COMMAND
        //    only carries the subcommand — ForceCommand prepends the
        //    binary path on the gateway side.
        const modeFlag = mode === "l3" ? "--l3" : "";
        const sshArgs = [
            "-T",                     // no tty
            "-e", "none",             // no escape character processing
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            gateway,
            "tun-attach", group, modeFlag,
        ].filter(Boolean);
        // Pick an ssh client that handles binary stdin correctly.
        // Microsoft's bundled OpenSSH (C:\Windows\System32\OpenSSH\ssh.exe)
        // does CRLF translation and treats 0x1A as EOF on its stdin
        // handle, which silently corrupts our binary frame stream.
        // Git for Windows' MSYS-based ssh.exe doesn't have that
        // problem. Override with MAD_SSH if neither candidate fits.
        const sshExe = resolveSshExe();
        process.stdout.write(`using ssh: ${sshExe}\n`);
        winNative.pumpStartSsh(handle, sshExe, sshArgs);

        // 4. Wait for MAD_TUN_OK from ssh's stderr (Rust's stderr
        //    scanner thread surfaces the line).
        const handshake = winNative.pumpWaitHandshake(handle, 15_000);
        if (!handshake) {
            throw new Error("timed out waiting for MAD_TUN_OK from gateway");
        }

        // peerIp is "<ours>/<prefix>" per daemon convention (the
        // gateway labels what's on the peer's end of the tunnel).
        const ourCidr = handshake.peerIp;
        const ourIp = ourCidr.split("/")[0];

        // 5. Assign IP via netsh. Wintun is L3 (no ARP), so a /24 on
        //    the adapter is the right model: tells Windows the whole
        //    group subnet is reachable through us, and the gateway
        //    handles routing the rest of the way. The daemon's
        //    advertised /32+peer model is preserved on the gateway
        //    side; the client just needs reachability.
        //
        //    TODO(l3-peer): netsh doesn't expose Linux's peer-addr
        //    semantics. If we need stricter point-to-point semantics
        //    on Windows, switch to a /32 + explicit route via
        //    netsh interface ipv4 add route.
        process.stdout.write(`assigning ${ourIp}/24 to mad-${group}…\n`);
        const setAddr = spawnSync("netsh", [
            "interface", "ipv4", "set", "address",
            `name=mad-${group}`, "static", ourIp, "255.255.255.0",
        ], { stdio: "inherit" });
        if (setAddr.status !== 0) {
            throw new Error(`netsh failed (exit ${setAddr.status}) — adapter mad-${group} won't have an IP`);
        }

        // 6. Record state for `mad tun ls` (and external cleanup).
        const state = loadState();
        state.entries.push({
            gateway, group,
            localIfname: `mad-${group}`,
            localIp: ourCidr,
            peerIp: handshake.ip,
            sshPid: process.pid,
            startedAt: Date.now(),
        });
        saveState(state);

        process.stdout.write("\n" + chalk.green(`✔ ${gateway}/${group} mad-${group} ${ourIp} (L3, wintun)`) + "\n");
        process.stdout.write(`  pid ${process.pid} — leave with: ${chalk.yellow(`mad tun leave ${gateway}/${group}`)} (or Ctrl+C)\n`);

        // 7. Block until the pump exits. Poll instead of blocking the
        //    event loop — bun:ffi calls are synchronous and would
        //    starve other timers/signals.
        await new Promise<void>(resolve => {
            const timer = setInterval(() => {
                if (!winNative.pumpIsRunning(handle)) {
                    clearInterval(timer);
                    resolve();
                }
            }, 500);
        });

        process.stdout.write(chalk.yellow(`pump exited — tunnel closed.\n`));
    } finally {
        cleanup();
    }
}
