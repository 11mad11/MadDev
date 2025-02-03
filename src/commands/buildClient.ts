import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../shell";
import { GitResponseError, PullFailedResult, simpleGit } from "simple-git";
import { execSync } from "child_process";


export default cmdDef({
    cmd: () => createCommand("buildclient").summary("Build client"),
    perm(ctx) {
        return ctx.user.permission.canUpdateServer()
    },
    async pty(ctx) {
        return [[] as const, {
        }]
    },
    async run(ctx, opts) {
        try {
            const rep = execSync("npm run build:client");
            ctx.output.write("Success!\n");
            ctx.output.write(JSON.stringify(rep, undefined, 2) + "\n");
        } catch (e) {
            ctx.output.write("Error!\n");
            ctx.output.write(JSON.stringify(e, undefined, 2) + "\n");
        }
    },
});