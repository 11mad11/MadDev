/**
 * socat over an SSH byte stream loses Ethernet-frame boundaries: when a
 * burst of frames lands in the pipe, the receiver socat reads them
 * concatenated and writes the whole blob to /dev/net/tun, which only
 * accepts ONE frame per write — the rest is silently dropped. We
 * measured 17% c1→hub loss on iperf3 bursts vs 2% on small ACKs, exactly
 * matching the asymmetry between bursty data and single-packet ACKs.
 *
 * This module replaces socat with an explicit length-prefix framing
 * over the byte stream:
 *
 *   uint16-BE  payload length
 *   payload    one Ethernet frame
 *
 * 16 bits is enough — TAP MTU caps at 65535 anyway.
 *
 * `openTap(ifname)` opens /dev/net/tun, attaches to a pre-created
 * (persistent, user-owned) TAP via TUNSETIFF, and returns the fd. The
 * daemon's `ip tuntap add user <uid>` makes this work for marc without
 * CAP_NET_ADMIN.
 *
 * `pump({fd, remoteIn, remoteOut})` runs the two halves of the frame
 * proxy concurrently and resolves only when both sides hit EOF or one
 * errors.
 */
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { closeSync, createReadStream, openSync, writeSync } from "fs";
import type { Readable, Writable } from "stream";

const libc = dlopen(`libc.${suffix}.6`, {
    ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

// _IOW('T', 202, int) → 0x400454CA on x86_64 Linux.
const TUNSETIFF = 0x400454CA;
const IFF_TUN = 0x0001;
const IFF_TAP = 0x0002;
const IFF_NO_PI = 0x1000;

export function openTap(ifname: string, mode: "l2" | "l3" = "l2"): number {
    if (ifname.length >= 16) throw new Error(`ifname too long: ${ifname}`);

    // struct ifreq is 40 bytes on x86_64 Linux (ifr_name[16] + 24-byte union).
    const ifreq = new Uint8Array(40);
    const nameBytes = Buffer.from(ifname, "utf-8");
    ifreq.set(nameBytes, 0);              // ifr_name (null-padded)
    const flags = (mode === "l2" ? IFF_TAP : IFF_TUN) | IFF_NO_PI;
    ifreq[16] = flags & 0xff;
    ifreq[17] = (flags >> 8) & 0xff;

    const fd = openSync("/dev/net/tun", "r+");
    const rc = libc.symbols.ioctl(fd, BigInt(TUNSETIFF), ptr(ifreq));
    if (rc !== 0) {
        closeSync(fd);
        throw new Error(`TUNSETIFF on ${ifname}: ioctl returned ${rc}`);
    }
    return fd;
}

/**
 * Read raw frames from the TUN fd and write length-prefixed frames to
 * remoteOut. createReadStream gives us non-blocking reads via libuv;
 * each TUN read returns exactly one frame.
 *
 * Backpressure: highWaterMark is sized for one MTU-ish frame, so the
 * stream stops reading the moment ssh's stdin can't keep up. Combining
 * the 2-byte prefix and the body into one write keeps Node's queue
 * from inflating with tiny prefix buffers.
 */
function pumpTunToRemote(fd: number, remoteOut: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
        const stream = createReadStream("" as any, { fd, autoClose: false, highWaterMark: 2048 });
        stream.on("data", (chunk: Buffer) => {
            const out = Buffer.allocUnsafe(2 + chunk.length);
            out.writeUInt16BE(chunk.length, 0);
            chunk.copy(out, 2);
            if (!remoteOut.write(out)) {
                stream.pause();
                remoteOut.once("drain", () => stream.resume());
            }
        });
        stream.on("end", resolve);
        stream.on("error", reject);
    });
}

/**
 * Read length-prefixed frames from remoteIn and write each to the TUN
 * fd as one syscall. Buffers across chunk boundaries.
 */
function pumpRemoteToTun(fd: number, remoteIn: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        remoteIn.on("data", (chunk: Buffer) => {
            buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
            try {
                while (buf.length >= 2) {
                    const len = buf.readUInt16BE(0);
                    if (buf.length < 2 + len) break;
                    const frame = buf.subarray(2, 2 + len);
                    writeSync(fd, frame);
                    buf = buf.subarray(2 + len);
                }
            } catch (e) { reject(e); }
        });
        remoteIn.on("end", resolve);
        remoteIn.on("error", reject);
    });
}

export async function pump(opts: { fd: number; remoteIn: Readable; remoteOut: Writable }): Promise<void> {
    await Promise.race([
        pumpTunToRemote(opts.fd, opts.remoteOut),
        pumpRemoteToTun(opts.fd, opts.remoteIn),
    ]);
}
