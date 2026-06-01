import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";
import { UsageAggregate, UsageFilter, UsageKind } from "../../daemon/protocol";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

function parseTs(v: string | undefined): number | undefined {
    if (!v) return undefined;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new Error(`bad timestamp: ${v}`);
    return t;
}

function parseKind(v: string | undefined): UsageKind | undefined {
    if (!v) return undefined;
    if (v === "tap" || v === "tun" || v === "svc-publish" || v === "svc-consume") return v;
    throw new Error(`bad kind: ${v}`);
}

function buildFilter(opts: any): UsageFilter {
    return {
        since: parseTs(opts.since),
        until: parseTs(opts.until),
        uid: opts.uid !== undefined ? Number(opts.uid) : undefined,
        group: opts.group,
        kind: parseKind(opts.kind),
    };
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(2)}${units[i]}`;
}

export const usageReport = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("report")
        .summary("Per-user × per-group usage totals (admin view)")
        .option("--since <iso|epoch>", "Window start (ISO date or epoch s/ms)")
        .option("--until <iso|epoch>", "Window end (ISO date or epoch s/ms)")
        .option("--user <name>", "Filter by username")
        .option("--uid <uid>", "Filter by uid")
        .option("--group <g>", "Filter by group")
        .option("--kind <k>", "tap | tun | svc-publish | svc-consume")
        .option("--bytes", "Show raw byte counts instead of human-readable"),
    async pty() { return [[] as const, {}] as any; },
    async run(ctx, opts) {
        const filter = buildFilter(opts);
        let rows = await daemon.usageQuery(filter);
        if ((opts as any).user) rows = rows.filter(r => r.username === (opts as any).user);
        if (rows.length === 0) { ctx.output.write("(no usage in window)\n"); return; }
        const human = !(opts as any).bytes;
        ctx.output.write(`user\tgroup\tkind\trx\ttx\trx_pkts\ttx_pkts\tfirst\tlast\n`);
        for (const r of rows) {
            const rx = human ? fmtBytes(r.rxBytes) : String(r.rxBytes);
            const tx = human ? fmtBytes(r.txBytes) : String(r.txBytes);
            ctx.output.write(
                `${r.username}\t${r.group}\t${r.kind}\t${rx}\t${tx}\t${r.rxPackets}\t${r.txPackets}\t`
                + `${new Date(r.firstSeen).toISOString().slice(0, 19)}\t${new Date(r.lastSeen).toISOString().slice(0, 19)}\n`
            );
        }
    },
} satisfies Cmd<[]>);

export const usageExport = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("export")
        .summary("Machine-readable usage dump for downstream billing")
        .option("--since <iso|epoch>", "Window start")
        .option("--until <iso|epoch>", "Window end")
        .option("--user <name>", "Filter by username")
        .option("--uid <uid>", "Filter by uid")
        .option("--group <g>", "Filter by group")
        .option("--kind <k>", "tap | tun | svc-publish | svc-consume")
        .option("--format <fmt>", "json | csv", "json"),
    async pty() { return [[] as const, {}] as any; },
    async run(ctx, opts) {
        const filter = buildFilter(opts);
        let rows: UsageAggregate[] = await daemon.usageQuery(filter);
        if ((opts as any).user) rows = rows.filter(r => r.username === (opts as any).user);
        const fmt = (opts as any).format ?? "json";
        if (fmt === "csv") {
            ctx.output.write("kind,uid,username,group,rx_bytes,tx_bytes,rx_packets,tx_packets,first_seen_ms,last_seen_ms\n");
            for (const r of rows) {
                ctx.output.write(`${r.kind},${r.uid},${r.username},${r.group},${r.rxBytes},${r.txBytes},${r.rxPackets},${r.txPackets},${r.firstSeen},${r.lastSeen}\n`);
            }
        } else if (fmt === "json") {
            ctx.output.write(JSON.stringify(rows) + "\n");
        } else {
            throw new Error(`bad --format: ${fmt}`);
        }
    },
} satisfies Cmd<[]>);

export default {
    text: "Usage",
    cliName: "usage",
    children: [usageReport, usageExport],
};
