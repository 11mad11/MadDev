import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ls")
        .summary("List certs issued by the CA")
        .option("--user <user>", "Filter by username"),
    async pty() { return [[] as const, {}]; },
    async run(ctx, opts) {
        const certs = await daemon.listCerts((opts as any).user);
        const revoked = new Set((await daemon.listRevoked()).map(r => r.serial));
        if (certs.length === 0) { ctx.output.write("(none)\n"); return; }
        const now = Date.now();
        for (const c of certs) {
            const expired = c.expiresAt < now;
            const status = revoked.has(c.serial) ? "revoked" : expired ? "expired" : "active";
            ctx.output.write(`${c.serial}\t${c.username}\t${status}\t${new Date(c.issuedAt).toISOString().slice(0, 10)}..${new Date(c.expiresAt).toISOString().slice(0, 10)}\t${c.fingerprint}\n`);
        }
    },
});
