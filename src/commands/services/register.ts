import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";

function splitSpec(spec: string): { alias: string; group: string; name: string } {
    const parts = spec.split("/");
    const alias = parts.length === 3 ? parts[0] : "mad";
    const group = parts.length === 3 ? parts[1] : parts[0];
    const name = parts.length === 3 ? parts[2] : parts[1];
    if (!group || !name) throw new Error("expected <gateway>/<group>/<name> or <group>/<name>");
    return { alias, group, name };
}

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("register")
        .summary("Print the ssh -R command to register a service")
        .argument("<spec>", "gateway/group/name or group/name")
        .argument("<target>", "local addr:port"),
    async pty(ctx) {
        const spec = await ctx.inquirer.input({ message: "<gateway>/<group>/<name> (or <group>/<name>)" });
        const target = await ctx.inquirer.input({ message: "Local target (host:port)", default: "localhost:8080" });
        return [[spec, target] as const, {}];
    },
    async run(ctx, _opts, spec, target) {
        const { alias, group, name } = splitSpec(spec);
        ctx.output.write(`ssh -R /run/mad/groups/${group}/${name}.sock:${target} ${alias} service hold ${group}/${name}\n`);
    },
});
