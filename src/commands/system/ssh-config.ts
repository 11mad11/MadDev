import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { currentUsername } from "../../groups";
import { gatewayHost, sshConfigBlock } from "../../utils/sshConfig";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ssh-config")
        .summary("Print an ssh_config Host block (paste into ~/.ssh/config)")
        .option("--alias <name>", "Host alias", "mad")
        .option("--host <hostname>", "Override the gateway hostname"),
    async pty(ctx) {
        const alias = await ctx.inquirer.input({ message: "Host alias", default: "mad" });
        const host = await ctx.inquirer.input({ message: "Gateway hostname (blank = auto)", default: "" });
        return [[] as const, { alias, host: host || undefined }];
    },
    async run(ctx, opts) {
        const o = opts as any;
        const host = gatewayHost(o.host);
        ctx.output.write(sshConfigBlock(o.alias ?? "mad", host, currentUsername()));
    },
});
