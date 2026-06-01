import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("use")
        .summary("Print the ssh -L command to use a service")
        .argument("<spec>", "gateway/group/name or group/name")
        .argument("<localport>"),
    async pty(ctx) {
        const spec = await ctx.inquirer.input({ message: "<gateway>/<group>/<name> (or <group>/<name>)" });
        const localport = await ctx.inquirer.input({ message: "Local port to listen on", default: "9000" });
        return [[spec, localport] as const, {}];
    },
    async run(ctx, _opts, spec, localport) {
        const parts = spec.split("/");
        const alias = parts.length === 3 ? parts[0] : "mad";
        const g = parts.length === 3 ? parts[1] : parts[0];
        const n = parts.length === 3 ? parts[2] : parts[1];
        if (!g || !n) throw new Error("expected <gateway>/<group>/<name> or <group>/<name>");
        ctx.output.write(`ssh -L ${localport}:/run/mad/groups/${g}/${n}.sock ${alias} service ping ${g}/${n}\n`);
    },
});
