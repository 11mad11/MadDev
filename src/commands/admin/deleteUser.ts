import { createCommand } from "@commander-js/extra-typings";
import { Cmd, cmdDef } from "../../shell";


export default cmdDef({
    perm(ctx) {
        return ctx.user.permission.canDeleteUser()
    },
    cmd: () => createCommand("deluser").summary("Delete a user").argument("<name>"),
    async pty(ctx) {
        return [
            [await ctx.inquirer.input({ message: "Username" })] as const,
            {
            }
        ]
    },
    async run(ctx, opts, username) {
        ctx.gateway.users.removeUser(username);
        ctx.output.write("Deleted user: " + username + "\n");
    },
});