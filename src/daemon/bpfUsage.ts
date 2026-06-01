/**
 * Phase 2 — service-forward (AF_UNIX) usage collector.
 *
 * AF_UNIX byte counts are NOT observable from inside mad:
 * `mad service hold` only sleeps and `mad service ping` only polls
 * liveness — the bytes flow user-service → sshd → connected unix-socket
 * pair → consumer, with no mad process in the path. The only way to
 * meter them from this codebase is at the kernel.
 *
 * This module spawns the bpftrace program at
 * `native/usage-bpf/usage_unix.bt`, parses its line-framed stdout,
 * resolves each path to (group, service, owner uid), and persists
 * `svc-publish` / `svc-consume` aggregates into the same usage.db that
 * Phase 1's TAP/TUN producer writes to.
 *
 * Production path: a libbpf/aya rewrite of the .bt script keeping the
 * same MAD_USAGE_TICK / MAD_USAGE_END framing would be a drop-in
 * replacement. See native/usage-bpf/README.md.
 */
import { ChildProcess, spawn, spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { resolve as resolvePath } from "path";
import { recordEvents, UsageEventRow } from "./usage";

const BPFTRACE_BIN = "bpftrace";
const SCRIPT_PATH = resolvePath(__dirname, "../../native/usage-bpf/usage_unix.bt");

let proc: ChildProcess | undefined;
let lastWindowStart = 0;

interface ParseState {
    buf: string;
    // Per-tick state: paths keyed by sk pointer, byte deltas keyed
    // by the same pointer. We join paths[sk] ⨝ tx[sk]/rx[sk] at
    // MAD_USAGE_END to produce path-tagged byte counts.
    paths: Map<string, string>;
    tx: Map<string, number>;
    rx: Map<string, number>;
}

/**
 * Spawn bpftrace and wire its stdout into the parser. Failures here
 * (binary missing, permission denied) just log and return — the daemon
 * keeps running and Phase 1 (TAP/TUN) metering still works.
 */
export function startBpfUsageCollector(): void {
    if (proc) return;
    if (!hasBpftrace()) {
        console.error("bpfUsage: bpftrace not in PATH — service-forward metering disabled");
        return;
    }
    if (!existsSync(SCRIPT_PATH)) {
        console.error(`bpfUsage: script missing at ${SCRIPT_PATH} — service-forward metering disabled`);
        return;
    }

    // bpftrace must run as root. The daemon already does.
    // -B line: force line-buffered stdout. Default is full block
    // buffering when piped, which holds back our framed output for
    // minutes at low load and breaks the per-tick parser contract.
    // BPFTRACE_MAX_MAP_KEYS: default is 4096 per map. On a busy host
    // @path fills past that within minutes (every unix-socket connect
    // anywhere on the box gets a slot) and new entries — including the
    // ones we actually care about under /run/mad/groups/ — silently
    // fail to write. 131072 is enough for any plausible single-day run.
    proc = spawn(BPFTRACE_BIN, ["-B", "line", SCRIPT_PATH], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BPFTRACE_MAX_MAP_KEYS: "131072" },
    });

    const state: ParseState = { buf: "", paths: new Map(), tx: new Map(), rx: new Map() };
    lastWindowStart = Date.now();

    proc.stdout?.on("data", (chunk: Buffer) => {
        state.buf += chunk.toString("utf-8");
        let nl: number;
        while ((nl = state.buf.indexOf("\n")) !== -1) {
            const line = state.buf.slice(0, nl);
            state.buf = state.buf.slice(nl + 1);
            try { handleLine(line, state); } catch (e) { console.error("bpfUsage parse:", e); }
        }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf-8").trim();
        if (s) console.error(`bpfUsage[bpftrace]: ${s}`);
    });
    proc.on("exit", (code, sig) => {
        console.error(`bpfUsage: bpftrace exited code=${code} sig=${sig}`);
        proc = undefined;
    });
    console.log(`bpfUsage: started (script=${SCRIPT_PATH})`);
}

export function stopBpfUsageCollector(): void {
    if (proc) {
        try { proc.kill("SIGTERM"); } catch {}
        proc = undefined;
    }
}

function hasBpftrace(): boolean {
    const r = spawnSync("which", [BPFTRACE_BIN], { stdio: "ignore" });
    return r.status === 0;
}

/**
 * Bpftrace prints map dumps in three sections per interval tick:
 *
 *     MAD_USAGE_TICK <nsecs>
 *     @path[<sk_pointer>]: /run/mad/groups/<g>/<n>.sock
 *     @bytes_tx[<sk_pointer>]: 12345
 *     @bytes_rx[<sk_pointer>]: 678
 *     MAD_USAGE_END
 *
 * The sk_pointer key joins @path (sk → path) with @bytes_tx / @bytes_rx
 * (sk → byte delta) at MAD_USAGE_END time. Storing the path inside the
 * BPF probes would blow the 512-byte BPF stack limit, so the join lives
 * here in user-space instead.
 *
 * Anything outside the markers is informational (e.g. MAD_USAGE_BPF_READY).
 */
function handleLine(line: string, s: ParseState): void {
    const trimmed = line.trim();
    if (trimmed === "" ) return;
    if (trimmed.startsWith("MAD_USAGE_BPF_READY")) return;

    if (trimmed.startsWith("MAD_USAGE_TICK")) {
        s.paths.clear(); s.tx.clear(); s.rx.clear();
        return;
    }
    if (trimmed.startsWith("MAD_USAGE_END")) {
        flushTick(s);
        return;
    }

    // String-valued map (@path): bpftrace prints with the value as a
    // possibly-quoted string. The key is the sk pointer as a signed int.
    const pathMatch = trimmed.match(/^@path\[(-?\d+)\]:\s*(.+?)\s*$/);
    if (pathMatch) {
        const [, sk, raw] = pathMatch;
        // strip surrounding quotes if bpftrace added them
        const path = raw.replace(/^"(.*)"$/, "$1");
        if (path.startsWith("/run/mad/groups/")) s.paths.set(sk, path);
        return;
    }

    const m = trimmed.match(/^@(bytes_tx|bytes_rx)\[(-?\d+)\]:\s*(\d+)\s*$/);
    if (!m) return;
    const [, which, sk, num] = m;
    const target = which === "bytes_tx" ? s.tx : s.rx;
    target.set(sk, (target.get(sk) ?? 0) + Number(num));
}

function flushTick(s: ParseState): void {
    const now = Date.now();
    const windowStart = lastWindowStart;
    const windowEnd = now;
    lastWindowStart = now;

    if (s.tx.size === 0 && s.rx.size === 0) return;

    // Aggregate sk-keyed bytes back into path-keyed totals. Multiple sk
    // pointers can map to the same path (e.g. two concurrent ssh -L
    // connections to /run/mad/groups/ga/web.sock).
    const txByPath = new Map<string, number>();
    const rxByPath = new Map<string, number>();
    for (const [sk, n] of s.tx) {
        const path = s.paths.get(sk);
        if (!path) continue;
        txByPath.set(path, (txByPath.get(path) ?? 0) + n);
    }
    for (const [sk, n] of s.rx) {
        const path = s.paths.get(sk);
        if (!path) continue;
        rxByPath.set(path, (rxByPath.get(path) ?? 0) + n);
    }

    const paths = new Set<string>([...txByPath.keys(), ...rxByPath.keys()]);
    const events: UsageEventRow[] = [];

    for (const path of paths) {
        const info = resolveServicePath(path);
        if (!info) continue;
        const tx = txByPath.get(path) ?? 0;
        const rx = rxByPath.get(path) ?? 0;
        // svc-publish: bytes attributed to the user who registered the
        // service (the listener's owner). bpftrace counts both directions
        // on the consumer's connected socket, so:
        //   tx (consumer→listener) is the publisher's RX.
        //   rx (listener→consumer) is the publisher's TX.
        events.push({
            kind: "svc-publish",
            uid: info.ownerUid,
            username: info.ownerUsername,
            group: info.group,
            service: info.name,
            windowStart, windowEnd,
            rxBytes: tx, txBytes: rx,
            rxPackets: 0, txPackets: 0,
        });
    }

    if (events.length === 0) return;
    try { recordEvents(events); }
    catch (e) { console.error("bpfUsage: recordEvents:", e); }
}

interface ServiceInfo {
    group: string;
    name: string;
    ownerUid: number;
    ownerUsername: string;
}

const uidNameCache = new Map<number, string>();
function usernameFor(uid: number): string {
    const cached = uidNameCache.get(uid);
    if (cached) return cached;
    const r = spawnSync("id", ["-nu", String(uid)], { encoding: "utf-8" });
    const name = (r.status === 0 ? (r.stdout ?? "").trim() : "") || `uid-${uid}`;
    uidNameCache.set(uid, name);
    return name;
}

function resolveServicePath(path: string): ServiceInfo | undefined {
    // /run/mad/groups/<group>/<service>.sock
    const m = path.match(/^\/run\/mad\/groups\/([^/]+)\/([^/]+)\.sock$/);
    if (!m) return undefined;
    const [, group, name] = m;
    try {
        const st = statSync(path);
        return { group, name, ownerUid: st.uid, ownerUsername: usernameFor(st.uid) };
    } catch {
        return undefined;
    }
}
