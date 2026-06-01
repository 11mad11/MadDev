import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { daemon } from "../../daemon/client";

const isAdmin = (ctx: { groups: string[] }) => ctx.groups.includes("mad-admin");

export default cmdDef({
    perm: isAdmin,
    cmd: () => createCommand("unrevoke").summary("Un-revoke a cert by serial (admin)").argument("<serial>"),
    async pty(ctx) {
        const serial = await ctx.inquirer.input({ message: "Serial to un-revoke" });
        await daemon.unrevokeCert(parseInt(serial, 10));
        ctx.output.write(`unrevoked serial ${serial}\n`);
        return false;
    },
    async run(ctx, _opts, serialStr) {
        const serial = parseInt(serialStr, 10);
        await daemon.unrevokeCert(serial);
        ctx.output.write(`unrevoked serial ${serial}\n`);
    },
});
