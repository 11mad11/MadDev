import { existsSync, readdirSync, statSync } from "fs";

export interface ServiceListing {
    group: string;
    name: string;
    socketPath: string;
    ownerUid: number;
}

export function listServices(groupFilter?: string): ServiceListing[] {
    const base = "/run/mad/groups";
    if (!existsSync(base)) return [];
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
