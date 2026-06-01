/**
 * bun:ffi shim for the Windows TAP/TUN backend.
 *
 * Only imported from `windowsTunClient.ts` when
 * `process.platform === "win32"`. Importing elsewhere throws.
 *
 * Startup sequence (one-time per process):
 *   1. winAssets.extractDlls() copies the bundled wintun.dll +
 *      mad_wintap.dll out of the compiled exe into a stable per-user
 *      directory.
 *   2. dlopen() loads mad_wintap.dll from there.
 *   3. mad_set_dll_dir(nativeDir) tells Windows where to look for
 *      wintun.dll when LoadLibraryW("wintun.dll") fires from inside
 *      Rust on the first mad_wintun_load call.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

import { extractDlls } from "./winAssets";

if (process.platform !== "win32") {
    throw new Error("winNative.ts imported on non-Windows platform — guard the import with process.platform check");
}

const MODE_L2 = 0;
const MODE_L3 = 1;

const { nativeDir, madWintap } = extractDlls();

const lib = dlopen(madWintap, {
    mad_set_dll_dir: { args: [FFIType.cstring], returns: FFIType.i32 },
    mad_wintun_load: { args: [], returns: FFIType.i32 },
    mad_wintun_driver_version: { args: [], returns: FFIType.u32 },
    mad_wintun_delete_adapter: { args: [FFIType.cstring], returns: FFIType.i32 },
    mad_l2_driver_installed: { args: [], returns: FFIType.i32 },
    mad_l2_driver_install: { args: [FFIType.cstring], returns: FFIType.i32 },
    mad_l2_create_adapter: { args: [FFIType.cstring], returns: FFIType.i32 },
    mad_open: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.u64 },
    mad_close: { args: [FFIType.u64], returns: FFIType.i32 },
    mad_pump_start_ssh: { args: [FFIType.u64, FFIType.cstring, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    mad_pump_wait_handshake: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    mad_pump_is_running: { args: [FFIType.u64], returns: FFIType.i32 },
    mad_pump_stop: { args: [FFIType.u64], returns: FFIType.i32 },
    mad_last_error: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
});

const symbols = lib.symbols;

function cstr(s: string): Buffer {
    return Buffer.from(s + "\0", "utf-8");
}

function readLastError(handle: bigint | number): string {
    const cap = 512;
    const buf = new Uint8Array(cap);
    const needed = symbols.mad_last_error(BigInt(handle), buf, cap);
    const len = Math.min(Number(needed), cap);
    return new TextDecoder().decode(buf.subarray(0, len));
}

// Tell Rust where to find sibling DLLs (wintun.dll). Must run before
// any code path that triggers LoadLibraryW("wintun.dll").
{
    const rc = symbols.mad_set_dll_dir(cstr(nativeDir));
    if (rc !== 0) {
        throw new Error(`mad_set_dll_dir(${nativeDir}): ${readLastError(0n) || "unknown error"}`);
    }
}

function marshalArgv(argv: string[]): { ptrs: BigInt64Array; data: Buffer } {
    const buffers = argv.map(cstr);
    const data = Buffer.concat(buffers);
    const ptrs = new BigInt64Array(argv.length);
    let offset = 0;
    for (let i = 0; i < argv.length; i++) {
        ptrs[i] = BigInt(ptr(data) + offset);
        offset += buffers[i].length;
    }
    return { ptrs, data };
}

export interface HandshakeFields {
    raw: string;
    ifname: string;
    ip: string;
    peerIp: string;
    group: string;
    mode: "l2" | "l3";
}

export function parseHandshakeLine(line: string): HandshakeFields | null {
    const m = line.match(/MAD_TUN_OK\s+(\S+)\s+(\S+)\s+peer=(\S+)\s+group=(\S+)\s+mode=(l2|l3)/);
    if (!m) return null;
    return {
        raw: line,
        ifname: m[1],
        ip: m[2],
        peerIp: m[3],
        group: m[4],
        mode: m[5] as "l2" | "l3",
    };
}

export const winNative = {
    loadWintun(): void {
        const rc = symbols.mad_wintun_load();
        if (rc !== 0) {
            throw new Error(`mad_wintun_load: ${readLastError(0n) || "unknown error"}`);
        }
    },

    wintunDriverVersion(): number {
        return symbols.mad_wintun_driver_version();
    },

    /**
     * Open + close a wintun adapter by name, which deletes it.
     * Returns true if an adapter was deleted, false if none existed.
     * Used by the startup stale-adapter sweep.
     */
    deleteWintunAdapter(adapterName: string): boolean {
        const rc = symbols.mad_wintun_delete_adapter(cstr(adapterName));
        if (rc < 0) {
            throw new Error(`mad_wintun_delete_adapter(${adapterName}): ${readLastError(0n) || "unknown"}`);
        }
        return rc === 1;
    },

    /** 1 if TAP-Windows6 kernel driver is installed, 0 otherwise. */
    isL2DriverInstalled(): boolean {
        return symbols.mad_l2_driver_installed() === 1;
    },

    /**
     * Run the TAP-Windows6 installer at `installerPath` with UAC.
     * Blocks until the installer exits. Returns the installer's
     * exit code on success, throws on launch failure (user declined
     * UAC, file missing, etc.).
     */
    installL2Driver(installerPath: string): number {
        const rc = symbols.mad_l2_driver_install(cstr(installerPath));
        if (rc < 0) {
            throw new Error(`mad_l2_driver_install: ${readLastError(0n) || "unknown error"}`);
        }
        return rc;
    },

    /**
     * Create a TAP-Windows6 adapter and rename to `mad-<group>`.
     * Idempotent. Throws if the driver isn't installed, tapinstall.exe
     * can't be found, or netsh rename failed.
     */
    createL2Adapter(group: string): void {
        const rc = symbols.mad_l2_create_adapter(cstr(group));
        if (rc !== 0) {
            throw new Error(`mad_l2_create_adapter(${group}): ${readLastError(0n) || "unknown error"}`);
        }
    },

    open(group: string, mode: "l2" | "l3"): bigint {
        const modeNum = mode === "l2" ? MODE_L2 : MODE_L3;
        const handle = symbols.mad_open(cstr(group), modeNum);
        if (handle === 0n) {
            throw new Error(`mad_open(${group}, ${mode}): ${readLastError(0n) || "unknown error"}`);
        }
        return handle;
    },

    close(handle: bigint): void {
        symbols.mad_close(handle);
    },

    pumpStartSsh(handle: bigint, sshExe: string, sshArgs: string[]): void {
        const { ptrs } = marshalArgv(sshArgs);
        const rc = symbols.mad_pump_start_ssh(handle, cstr(sshExe), ptrs, sshArgs.length);
        if (rc !== 0) {
            throw new Error(`mad_pump_start_ssh: ${readLastError(handle) || "unknown error"}`);
        }
    },

    pumpWaitHandshake(handle: bigint, timeoutMs: number): HandshakeFields | null {
        const cap = 1024;
        const buf = new Uint8Array(cap);
        const rc = symbols.mad_pump_wait_handshake(handle, buf, cap, timeoutMs);
        if (rc <= 0) return null;
        const len = Math.min(rc, cap);
        const line = new TextDecoder().decode(buf.subarray(0, len));
        return parseHandshakeLine(line);
    },

    pumpIsRunning(handle: bigint): boolean {
        return symbols.mad_pump_is_running(handle) === 1;
    },

    pumpStop(handle: bigint): void {
        symbols.mad_pump_stop(handle);
    },
};
