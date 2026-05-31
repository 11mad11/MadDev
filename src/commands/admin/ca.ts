import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export const caPubkey = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ca-pubkey").summary("Show the CA public key"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const r = await daemon.caPubkey();
        ctx.output.write(r.pubkey + "\n");
    },
});

export const caSign = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("ca-sign").summary("Sign an SSH public key for a user").argument("<username>"),
    async pty(ctx) {
        const username = await ctx.inquirer.input({ message: "Username the cert is for" });
        const pubkey = await ctx.inquirer.editor({ message: "Paste the public key" });
        const r = await daemon.caSign(pubkey, username);
        ctx.output.write(r.cert + "\n");
        return false;
    },
    async run(ctx, _opts, username) {
        const pubkey = await ctx.inquirer.editor({ message: "Paste the public key" });
        const r = await daemon.caSign(pubkey, username);
        ctx.output.write(r.cert + "\n");
    },
});

export const certList = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("cert-ls").summary("List certs (yours, or all if admin)"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const certs = await daemon.listCerts();
        const revoked = new Set((await daemon.listRevoked()).map(r => r.serial));
        if (certs.length === 0) { ctx.output.write("(none)\n"); return; }
        const now = Date.now();
        for (const c of certs) {
            const status = revoked.has(c.serial) ? "revoked" : c.expiresAt < now ? "expired" : "active";
            ctx.output.write(`${c.serial}\t${c.username}\t${status}\t${new Date(c.issuedAt).toISOString().slice(0, 10)}..${new Date(c.expiresAt).toISOString().slice(0, 10)}\n`);
        }
    },
});

export const certRevoke = cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("cert-revoke").summary("Revoke certs by user or serial"),
    async pty(ctx) {
        const mode = await ctx.inquirer.select({
            message: "Revoke by",
            choices: [{ name: "username (all their currently-issued certs)", value: "user" }, { name: "single serial", value: "serial" }],
        });
        const value = await ctx.inquirer.input({ message: mode === "user" ? "Username" : "Serial" });
        const reason = await ctx.inquirer.input({ message: "Reason (optional)", default: "" });
        const r = await daemon.revokeCert(
            mode === "user"
                ? { username: value, reason: reason || undefined }
                : { serial: parseInt(value, 10), reason: reason || undefined }
        );
        ctx.output.write(`revoked ${r.revoked.length} cert(s)\n`);
        return false;
    },
    async run() { /* CLI path uses non-menu subcommand */ },
});

export default {
    text: "CA",
    children: [caPubkey, caSign, certList, certRevoke],
};
