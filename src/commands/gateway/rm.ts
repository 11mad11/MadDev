import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { removeHostBlock } from "../../utils/sshConfig";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("rm").summary("Remove a gateway's Host block").argument("<alias>"),
    async pty(ctx) {
        const alias = await ctx.inquirer.input({ message: "Alias to remove" });
        return [[alias] as const, {}];
    },
    async run(ctx, _opts, alias) {
        const ok = removeHostBlock(alias);
        ctx.output.write(ok ? `removed Host ${alias}\n` : `no Host '${alias}' found\n`);
    },
});
