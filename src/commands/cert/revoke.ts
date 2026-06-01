import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export default cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("revoke")
        .summary("Revoke a cert by serial, or all certs for a user (admin)")
        .option("--serial <n>", "Cert serial to revoke")
        .option("--user <user>", "Revoke all currently-issued certs for this user")
        .option("--reason <text>", "Free-text reason"),
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
        for (const rec of r.revoked) ctx.output.write(`  serial=${rec.serial} user=${rec.username}\n`);
        return false;
    },
    async run(ctx, opts) {
        const o = opts as any;
        if (!o.serial && !o.user) throw new Error("pass --serial or --user");
        const r = await daemon.revokeCert({
            serial: o.serial ? parseInt(o.serial as string, 10) : undefined,
            username: o.user,
            reason: o.reason,
        });
        ctx.output.write(`revoked ${r.revoked.length} cert(s):\n`);
        for (const rec of r.revoked) ctx.output.write(`  serial=${rec.serial} user=${rec.username}\n`);
    },
});
