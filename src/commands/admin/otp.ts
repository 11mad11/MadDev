import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export default cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("otp").summary("Create an enrollment OTP").argument("<username>"),
    async pty(ctx) {
        const username = await ctx.inquirer.input({ message: "Username for the new account" });
        return [[username] as const, {}];
    },
    async run(ctx, _opts, username) {
        const r = await daemon.createOtp(username);
        ctx.output.write(`OTP for ${username}: ${r.otp}\n`);
        ctx.output.write(`expires at: ${new Date(r.expiresAt).toISOString()}\n`);
    },
} satisfies Cmd<[string]>);
