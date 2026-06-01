import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("leave")
        .summary("Close a TAP tunnel previously opened by `tap join`")
        .argument("<gw/group>"),
    async pty(ctx) {
        const spec = await ctx.inquirer.input({ message: "<gateway>/<group>" });
        return [[spec] as const, {}];
    },
    async run(_ctx, _opts, spec) {
        const { tunLeave } = await import("../tunClient");
        await tunLeave(spec);
    },
});
