import { dlopen, FFIType } from "bun:ffi";
import { Socket } from "net";
import { PeerCred } from "./protocol";

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

let lib: ReturnType<typeof dlopen<{
    getsockopt: { args: [FFIType, FFIType, FFIType, FFIType, FFIType]; returns: FFIType }
}>> | undefined;

function libc() {
    if (lib) return lib;
    lib = dlopen("libc.so.6", {
        getsockopt: {
            args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
            returns: FFIType.i32,
        },
    });
    return lib;
}

export function getPeerCred(socket: Socket): PeerCred {
    const fd: number | undefined = (socket as any)._handle?.fd;
    if (typeof fd !== "number" || fd < 0)
        throw new Error("Socket has no accessible fd");

    const credBuf = Buffer.alloc(12);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(12, 0);

    const ret = libc().symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, credBuf, lenBuf);
    if (ret !== 0)
        throw new Error(`getsockopt(SO_PEERCRED) failed: ${ret}`);

    return {
        pid: credBuf.readInt32LE(0),
        uid: credBuf.readUInt32LE(4),
        gid: credBuf.readUInt32LE(8),
    };
}
