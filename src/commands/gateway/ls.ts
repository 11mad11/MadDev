import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { listMadGateways } from "../../utils/sshConfig";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ls").summary("List the mad gateways in ssh_config"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const gws = listMadGateways();
        if (!gws.length) { ctx.output.write("(no gateways — add one with `mad gateway add user@host`)\n"); return; }
        for (const g of gws) ctx.output.write(`${g.alias}\t${g.user}@${g.hostName}\n`);
    },
});
