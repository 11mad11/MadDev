import { openSync, readlinkSync } from "fs";
import ffi from "../ffi";
import { restorePointer } from "ffi-rs";
import { RtNetlinkSocket, createNl80211, createRtNetlink, rt } from "netlink";
import { nextTick } from "process";
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

const ns = new NetNS(() => {
    return {
        netlink: new NetLink()
    }
});

new NetLink().dumpLinks().then((v)=>console.log(v,"ori"))

NetNS.debugCurrentNS();
ns.runWithNS(() => {
    NetNS.debugCurrentNS();
});

(async ()=>{
    await ns.ctx.netlink.dumpLinks().then((v)=>console.log(v,"ns"));
    const bridge = await ns.ctx.netlink.createBridge("br0lololo");
    await bridge.up();
    await ns.ctx.netlink.dumpLinks().then((v)=>console.log(v,"ns"));
})();

setTimeout(() => {
    process.exit(0);
}, 10000);
//process.exit(0);