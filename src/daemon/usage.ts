/**
 * Per-user × per-group usage metering store.
 *
 * Producers (Phase 1 TAP/TUN pump in `mad tun-attach`, Phase 2 BPF
 * collector for AF_UNIX service forwards) flush 60s windows here via
 * the daemon's `usage-record` op. The store keeps every window forever
 * (rotation/retention is a separate ops concern) so SUM-over-period
 * queries can roll up into billing intervals at query time.
 *
 * Schema lives in `usage` (one row = one window for one
 * {kind,uid,group,ifname?,service?}). The three composite indexes
 * cover the natural filter shapes: per-user, per-group, and recent-window.
 */
import { chmodSync, chownSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Database } from "bun:sqlite";
import { getGroupGid } from "../groups";

export const USAGE_DB_PATH = "/var/lib/mad/usage.db";

export type UsageKind = "tap" | "tun" | "svc-publish" | "svc-consume";

export interface UsageEventRow {
    kind: UsageKind;
    uid: number;
    username: string;
    group: string;
    ifname?: string;
    mode?: "l2" | "l3";
    service?: string;
    windowStart: number;
    windowEnd: number;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
}

export interface UsageFilter {
    since?: number;
    until?: number;
    uid?: number;
    group?: string;
    kind?: UsageKind;
}

export interface UsageAggregate {
    kind: UsageKind;
    uid: number;
    username: string;
    group: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    firstSeen: number;
    lastSeen: number;
}

let db: Database | undefined;
let insertStmt: ReturnType<Database["prepare"]> | undefined;
let insertTxn: ((events: UsageEventRow[]) => void) | undefined;

function openDb(): Database {
    if (db) return db;
    mkdirSync(dirname(USAGE_DB_PATH), { recursive: true });
    const fresh = !existsSync(USAGE_DB_PATH);
    db = new Database(USAGE_DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS usage (
            id           INTEGER PRIMARY KEY,
            kind         TEXT NOT NULL CHECK(kind IN ('tap','tun','svc-publish','svc-consume')),
            uid          INTEGER NOT NULL,
            username     TEXT NOT NULL,
            "group"      TEXT NOT NULL,
            ifname       TEXT,
            mode         TEXT,
            service      TEXT,
            window_start INTEGER NOT NULL,
            window_end   INTEGER NOT NULL,
            rx_bytes     INTEGER NOT NULL DEFAULT 0,
            tx_bytes     INTEGER NOT NULL DEFAULT 0,
            rx_packets   INTEGER NOT NULL DEFAULT 0,
            tx_packets   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_uid_end   ON usage(uid, window_end);
        CREATE INDEX IF NOT EXISTS idx_usage_group_end ON usage("group", window_end);
        CREATE INDEX IF NOT EXISTS idx_usage_end       ON usage(window_end);
    `);
    if (fresh) {
        try { chmodSync(USAGE_DB_PATH, 0o640); } catch {}
        const madGid = getGroupGid("mad");
        if (madGid !== undefined) try { chownSync(USAGE_DB_PATH, 0, madGid); } catch {}
    }
    insertStmt = db.prepare(`
        INSERT INTO usage (
            kind, uid, username, "group", ifname, mode, service,
            window_start, window_end,
            rx_bytes, tx_bytes, rx_packets, tx_packets
        ) VALUES (
            $kind, $uid, $username, $group, $ifname, $mode, $service,
            $windowStart, $windowEnd,
            $rxBytes, $txBytes, $rxPackets, $txPackets
        )
    `);
    insertTxn = db.transaction((events: UsageEventRow[]) => {
        for (const e of events) {
            insertStmt!.run({
                $kind: e.kind,
                $uid: e.uid,
                $username: e.username,
                $group: e.group,
                $ifname: e.ifname ?? null,
                $mode: e.mode ?? null,
                $service: e.service ?? null,
                $windowStart: e.windowStart,
                $windowEnd: e.windowEnd,
                $rxBytes: e.rxBytes,
                $txBytes: e.txBytes,
                $rxPackets: e.rxPackets,
                $txPackets: e.txPackets,
            });
        }
    });
    return db;
}

export function recordEvents(events: UsageEventRow[]): void {
    if (events.length === 0) return;
    openDb();
    insertTxn!(events);
}

export function queryUsage(filter: UsageFilter = {}): UsageAggregate[] {
    const conn = openDb();
    const where: string[] = [];
    const params: Record<string, any> = {};
    if (filter.since !== undefined) { where.push("window_end >= $since"); params.$since = filter.since; }
    if (filter.until !== undefined) { where.push("window_start <= $until"); params.$until = filter.until; }
    if (filter.uid !== undefined)   { where.push("uid = $uid");             params.$uid = filter.uid; }
    if (filter.group !== undefined) { where.push('"group" = $group');       params.$group = filter.group; }
    if (filter.kind !== undefined)  { where.push("kind = $kind");           params.$kind = filter.kind; }
    const sql = `
        SELECT kind, uid, username, "group" AS grp,
               SUM(rx_bytes)   AS rxBytes,
               SUM(tx_bytes)   AS txBytes,
               SUM(rx_packets) AS rxPackets,
               SUM(tx_packets) AS txPackets,
               MIN(window_start) AS firstSeen,
               MAX(window_end)   AS lastSeen
          FROM usage
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        GROUP BY kind, uid, username, "group"
        ORDER BY lastSeen DESC
    `;
    const rows = conn.query(sql).all(params) as any[];
    return rows.map(r => ({
        kind: r.kind as UsageKind,
        uid: r.uid,
        username: r.username,
        group: r.grp,
        rxBytes: Number(r.rxBytes ?? 0),
        txBytes: Number(r.txBytes ?? 0),
        rxPackets: Number(r.rxPackets ?? 0),
        txPackets: Number(r.txPackets ?? 0),
        firstSeen: r.firstSeen ?? 0,
        lastSeen: r.lastSeen ?? 0,
    }));
}

export function closeUsage(): void {
    if (db) { db.close(false); db = undefined; insertStmt = undefined; insertTxn = undefined; }
}
