import { createCommand } from "@commander-js/extra-typings";
import { readFileSync } from "fs";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("refresh")
        .summary("Re-sign your pubkey (from stdin) with your current mad-group memberships as principals"),
    async pty(ctx) {
        const pubkey = await ctx.inquirer.editor({ message: "Paste the public key to re-sign" });
        const r = await daemon.refreshCert(pubkey);
        ctx.output.write(r.cert + "\n");
        return false;
    },
    async run(ctx) {
        const pubkey = readFileSync(0, "utf-8");
        const r = await daemon.refreshCert(pubkey);
        ctx.output.write(r.cert + "\n");
    },
});
