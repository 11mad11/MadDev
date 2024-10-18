import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../shell";


export default cmdDef({
    perm(ctx) {
        return ctx.user.permission.canGenerateOTP()
    },
    cmd: () => createCommand("otp").summary("Generate a One Time Password").argument("<name>").option("-k", "Save ssh key"),
    async pty(ctx) {
        return [
            [await ctx.inquirer.input({ message: "Username" })] as const,
            {
                k: await ctx.inquirer.confirm({ message: "Should we register the ssh key used with the OTP" })
            }
        ]
    },
    async run(ctx, opts, username) {
        const otp = ctx.gateway.authsProvider.password.setOTPUser(username, opts.k);
        ctx.output.write("Here's the one time password: " + otp + "\n");
    },
});