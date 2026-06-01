import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { listServices } from "../../services/discover";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ls")
        .summary("List visible services (filters orphan sockets; fans out across mad gateways by default)")
        .argument("[group]")
        .option("--gateway <alias>", "Query a single gateway instead of all")
        .option("--local-only", "Skip the fan-out; just read /run/mad/groups here")
        .option("--json", "Emit JSON for scripting / cross-gateway fanout")
        .option("--orphans", "Include orphan socket files (no live listener)"),
    async pty() { return [[undefined as any] as const, {}] as any; },
    async run(ctx, opts, group) {
        const { listMadGateways } = await import("../../utils/sshConfig");
        const { listServicesAcross } = await import("../../services/discoverRemote");

        const fanoutTargets = opts.localOnly
            ? []
            : (opts.gateway
                ? listMadGateways().filter(g => g.alias === opts.gateway)
                : listMadGateways());

        if (fanoutTargets.length === 0) {
            const list = listServices(group, !!opts.orphans);
            if (opts.json) { ctx.output.write(JSON.stringify(list) + "\n"); return; }
            if (!list.length) { ctx.output.write("(none visible)\n"); return; }
            for (const s of list) ctx.output.write(`${s.group}/${s.name}\t${s.socketPath}\n`);
            return;
        }

        const result = await listServicesAcross(fanoutTargets, group);
        if (opts.json) { ctx.output.write(JSON.stringify(result) + "\n"); return; }
        if (result.services.length === 0 && result.errors.length === 0) {
            ctx.output.write("(none visible)\n");
        }
        for (const s of result.services) {
            ctx.output.write(`${s.gateway}/${s.group}/${s.name}\t${s.socketPath}\n`);
        }
        for (const e of result.errors) {
            process.stderr.write(`! ${e.gateway}: ${e.error}\n`);
        }
    },
});
