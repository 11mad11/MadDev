import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../menu";
import { daemon } from "../daemon/client";

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(2)}${units[i]}`;
}

function parseTs(v: string | undefined): number | undefined {
    if (!v) return undefined;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new Error(`bad timestamp: ${v}`);
    return t;
}

/**
 * Self-serve usage report. Non-admin callers see only their own rows
 * (daemon-side filter pins to ctx.peer.uid). With no flags, shows
 * lifetime totals across all groups the caller has used.
 *
 * NOTE on option naming: this leaf shares its Commander node with the
 * admin `usage report`/`export` subcommands (see menuToTree's
 * leaf-then-reuse logic). Defining the same flag here AND there makes
 * Commander silently drop the child's parse, so any toggle the admin
 * subtree needs (`--bytes`) MUST NOT be redeclared on this leaf.
 */
export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("usage")
        .summary("Show your usage (bytes + packets) per group")
        .option("--since <iso|epoch>", "Window start")
        .option("--until <iso|epoch>", "Window end")
        .option("--group <g>", "Filter by group"),
    async pty() { return [[] as const, {}] as any; },
    async run(ctx, opts) {
        const rows = await daemon.usageQuery({
            since: parseTs((opts as any).since),
            until: parseTs((opts as any).until),
            group: (opts as any).group,
        });
        if (rows.length === 0) { ctx.output.write("(no usage in window)\n"); return; }
        ctx.output.write(`group\tkind\trx\ttx\trx_pkts\ttx_pkts\tfirst\tlast\n`);
        for (const r of rows) {
            ctx.output.write(
                `${r.group}\t${r.kind}\t${fmtBytes(r.rxBytes)}\t${fmtBytes(r.txBytes)}\t${r.rxPackets}\t${r.txPackets}\t`
                + `${new Date(r.firstSeen).toISOString().slice(0, 19)}\t${new Date(r.lastSeen).toISOString().slice(0, 19)}\n`
            );
        }
    },
});
