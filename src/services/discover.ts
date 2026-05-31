import { existsSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";

export interface ServiceListing {
    group: string;
    name: string;
    socketPath: string;
    ownerUid: number;
}

/**
 * Walk /run/mad/groups/*\/*.sock and return service listings. By default
 * filters out orphan socket files — those still on disk but with no
 * process bound (sshd's StreamLocalBindUnlink unlinks only on next bind,
 * so abrupt `ssh -R` disconnect leaves a stale file). Liveness comes from
 * `ss -xlH`, which only lists sockets with a live LISTENing process.
 */
export function listServices(groupFilter?: string, includeOrphans: boolean = false): ServiceListing[] {
    const base = "/run/mad/groups";
    if (!existsSync(base)) return [];

    const live = includeOrphans ? undefined : liveUnixSockets();

    const out: ServiceListing[] = [];
    for (const group of readdirSync(base)) {
        if (groupFilter && group !== groupFilter) continue;
        const dir = `${base}/${group}`;
        try {
            const entries = readdirSync(dir);
            for (const file of entries) {
                if (!file.endsWith(".sock")) continue;
                const path = `${dir}/${file}`;
                const st = statSync(path);
                if (!st.isSocket()) continue;
                if (live && !live.has(path)) continue;
                out.push({
                    group,
                    name: file.replace(/\.sock$/, ""),
                    socketPath: path,
                    ownerUid: st.uid,
                });
            }
        } catch {
            // ignore unreadable groups (caller may not have access)
        }
    }
    return out;
}

function liveUnixSockets(): Set<string> {
    const r = spawnSync("ss", ["-xlH"], { encoding: "utf-8" });
    const set = new Set<string>();
    if (r.status !== 0) return set;
    for (const line of (r.stdout ?? "").split("\n")) {
        // ss -xlH columns: Netid State Recv-Q Send-Q LocalAddr:Port PeerAddr:Port
        // Unix listening sockets have a path-like LocalAddr.
        const match = line.match(/\s(\/\S+)\s/);
        if (match) set.add(match[1]);
    }
    return set;
}
