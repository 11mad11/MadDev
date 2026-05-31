import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, chownSync } from "fs";
import { dirname } from "path";
import { DaemonState } from "./protocol";
import { getGroupGid } from "../groups";

const STATE_PATH = "/var/lib/mad/state.json";

const empty: DaemonState = { taps: [], otps: [], netns: [], nextSerial: 1, certs: [], revoked: [] };

export function loadState(): DaemonState {
    if (!existsSync(STATE_PATH))
        return { ...empty };
    try {
        const raw = readFileSync(STATE_PATH, "utf-8");
        const parsed = JSON.parse(raw) as Partial<DaemonState>;
        return {
            taps: parsed.taps ?? [],
            otps: parsed.otps ?? [],
            netns: parsed.netns ?? [],
            nextSerial: parsed.nextSerial ?? 1,
            certs: parsed.certs ?? [],
            revoked: parsed.revoked ?? [],
        };
    } catch {
        return { ...empty };
    }
}

export function saveState(state: DaemonState): void {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    chmodSync(STATE_PATH, 0o640);
    const madGid = getGroupGid("mad");
    if (madGid !== undefined)
        chownSync(STATE_PATH, 0, madGid);
}
