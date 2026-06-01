import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("krl")
        .summary("Print the current signed KRL (base64-encoded; --raw for binary)")
        .option("--raw", "Emit raw binary KRL instead of base64", false),
    async pty() { return [[] as const, {}]; },
    async run(ctx, opts) {
        const r = await daemon.caKrl();
        if ((opts as any).raw) ctx.output.write(Buffer.from(r.krl, "base64") as any);
        else ctx.output.write(r.krl + "\n");
    },
});
