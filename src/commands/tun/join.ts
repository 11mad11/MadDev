import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("join")
        .summary("Open an L3 TUN tunnel into <gateway>/<group> (root required)")
        .argument("<gw/group>"),
    async pty(ctx) {
        const spec = await ctx.inquirer.input({ message: "<gateway>/<group>" });
        return [[spec] as const, {}];
    },
    async run(_ctx, _opts, spec) {
        const { tunJoin } = await import("../tunClient");
        await tunJoin(spec, "l3");
    },
});
