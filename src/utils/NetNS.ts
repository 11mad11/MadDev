import { openSync, readlinkSync } from "fs";
import ffi from "../ffi";
import { NetLink } from "../../native";

export class NetNS<C = void> {

    private fd: number;
    public ctx: C;

    constructor(fn?: (ns: NetNS<C>) => C) {
        const result = ffi.libc.unshare(ffi.libc.CLONE_NEWNET);
        console.log(result);
        this.fd = NetNS.openCurrentNS();
        this.ctx = fn?.(this);
        ffi.libc.setns(originalNetFd, ffi.libc.CLONE_NEWNET);
    }

    runWithNS(fn: (ns: NetNS<C>) => void) {
        ffi.libc.setns(this.fd, ffi.libc.CLONE_NEWNET);
        fn(this);
        ffi.libc.setns(originalNetFd, ffi.libc.CLONE_NEWNET);
    }

    static debugCurrentNS() {
        console.log("current net namespace", readlinkSync("/proc/self/ns/net"));
    }

    static openCurrentNS() {
        return openSync("/proc/self/ns/net", "r");
    }

}

const originalNetFd = NetNS.openCurrentNS();
