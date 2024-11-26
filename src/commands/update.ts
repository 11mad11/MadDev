import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../shell";
import { GitResponseError, PullFailedResult, simpleGit } from "simple-git";


export default cmdDef({
    cmd: () => createCommand("update").summary("Update server files").option('-c', "Exit the server process"),
    perm(ctx) {
        return ctx.user.permission.canUpdateServer()
    },
    async pty(ctx) {
        return [[] as const, {
            c: await ctx.inquirer.confirm({ message: "Should we exit the server? Depending on how the server was run, it may not restart." })
        }]
    },
    async run(ctx, opts) {
        const git = simpleGit({
            baseDir: process.cwd()
        });
        try {
            const rep = await git.pull("origin", "main");
            ctx.output.write("Success!\n");
            ctx.output.write(JSON.stringify(rep, undefined, 2) + "\n");
            if (opts.c)
                process.exit(0);
        } catch (e) {
            ctx.output.write("Error!\n");
            ctx.output.write(JSON.stringify(e, undefined, 2) + "\n");
        }
    },
});