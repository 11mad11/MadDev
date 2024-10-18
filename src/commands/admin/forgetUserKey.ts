import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../shell";


export default cmdDef({
    perm(ctx) {
        return ctx.user.permission.canChangeAuth()
    },
    cmd: () => createCommand("forget").summary("Forget a user keys").argument("<name>"),
    async pty(ctx) {
        return [
            [
                await ctx.inquirer.input({
                    message: "Username",
                    validate: (value) => !!ctx.gateway.users.users[value] || "User does not exist"
                })
            ] as const,
            {
            }
        ]
    },
    async run(ctx, opts, username) {
        ctx.gateway.users.users[username].publicKeys = []
        ctx.gateway.users.usersConfig.save();
    },
});