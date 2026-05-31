import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export default cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("otp").summary("Mint a 15-min OTP for a user (ensures the account exists; sets the OTP as their Linux password)").argument("<username>"),
    async pty(ctx) {
        const username = await ctx.inquirer.input({ message: "Username (created if missing)" });
        return [[username] as const, {}];
    },
    async run(ctx, _opts, username) {
        const r = await daemon.createOtp(username);
        ctx.output.write(`OTP for ${username}: ${r.otp}\n`);
        ctx.output.write(`expires at: ${new Date(r.expiresAt).toISOString()}\n`);
        ctx.output.write(`\nHand off to the user. They then run from their client:\n`);
        ctx.output.write(`  ssh ${username}@<server> enroll\n`);
    },
} satisfies Cmd<[string]>);
