import { DataType, load, open } from "ffi-rs";

// Initialize APIs
try {
    open({ library: 'libc', path: '/lib/x86_64-linux-gnu/libc.so.6' });
} catch (error) {
    console.error('Failed to load:', error);
    process.exit(1);
}

const def = {
    library: "libc",
    errno: false,
    freeResultMemory: false,
    runInNewThread: false
} as const;

export default {
    /** Network namespace*/
    CLONE_NEWNET: 0x40000000 as const,

    unshare(flag: number) {
        const result = load({
            ...def,
            funcName: "unshare",
            paramsType: [DataType.I32],
            retType: DataType.I32,
            paramsValue: [flag],
        });
        return result;
    },
    setns(fd: number, flag: number) {
        const result = load({
            ...def,
            funcName: "setns",
            paramsType: [DataType.I32, DataType.I32],
            retType: DataType.I32,
            paramsValue: [fd, flag],
        });
        return result;
    }
}