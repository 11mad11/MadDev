#!/usr/bin/env bun
/**
 * Manual smoke test for the Windows TAP/TUN backend. Must run on a
 * Windows host with admin rights — wintun adapter creation requires
 * CAP_NET_ADMIN-equivalent (Administrator).
 *
 * Prerequisites:
 *   1. `npm run build:windows-native` succeeded
 *   2. `wintun.dll` copied to `native/windows-tap/vendor/` (see
 *      vendor/README.md), and either:
 *        - placed next to `mad_wintap.dll` so the loader finds it via
 *          the standard DLL search path, OR
 *        - the directory added to PATH for this shell
 *
 * What it tests:
 *   - bun:ffi can load mad_wintap.dll and resolve every symbol
 *   - mad_wintun_load() succeeds (wintun.dll is reachable)
 *   - mad_open()/mad_close() roundtrips with a real wintun adapter
 *   - mad_wintun_driver_version() returns non-zero while an adapter is
 *     active
 */
import { winNative } from "../src/utils/winNative";

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) {
        console.error(`FAIL: ${msg}`);
        process.exit(1);
    }
}

function main() {
    if (process.platform !== "win32") {
        console.error(`smoke-windows-native must run on Windows (you are on ${process.platform}).`);
        process.exit(2);
    }

    console.log("1. Loading wintun.dll...");
    winNative.loadWintun();
    console.log("   ok");

    console.log("2. Opening L3 adapter (mad-spike)...");
    const handle = winNative.open("spike", "l3");
    console.log(`   ok — handle=0x${handle.toString(16)}`);

    console.log("3. Querying running driver version...");
    const ver = winNative.wintunDriverVersion();
    const major = (ver >>> 16) & 0xffff;
    const minor = ver & 0xffff;
    console.log(`   ok — driver version=${major}.${minor} (raw=0x${ver.toString(16)})`);
    assert(ver !== 0, "driver version should be non-zero while an adapter is active");

    console.log("4. Closing adapter...");
    winNative.close(handle);
    console.log("   ok");

    console.log("5. Re-closing same handle (should be a no-op)...");
    winNative.close(handle);
    console.log("   ok");

    console.log("\nALL PASSED");
}

main();
