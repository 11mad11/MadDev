import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { currentUsername } from "../../groups";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("install")
        .summary("Print install script: auto-forward a local service to mad via systemd")
        .argument("<groupname>", "<group>/<name>")
        .argument("<target>", "local addr:port")
        .option("--scope <scope>", "user | system", "user")
        .option("--server-host <host>", "mad server hostname for ssh_config")
        .option("--server-user <user>", "mad username on the server"),
    async pty(ctx) {
        const groupname = await ctx.inquirer.input({
            message: "group/name (where to publish the service)",
            validate: (v: string) => /^[^/]+\/[^/]+$/.test(v.trim()) || "expected <group>/<name>",
        });
        const target = await ctx.inquirer.input({
            message: "local addr:port the service runs on (e.g. 127.0.0.1:8080)",
            validate: (v: string) => /^\S+:\d+$/.test(v.trim()) || "expected addr:port",
        });
        return [[groupname.trim(), target.trim()] as const, {}] as any;
    },
    async run(ctx, opts, groupname, target) {
        const { forwardingScript } = await import("../install");
        const [g, n] = groupname.split("/");
        if (!g || !n) throw new Error("expected <group>/<name>");
        const fromOriginal = (process.env.SSH_CONNECTION ?? "").split(" ")[2] || "mad-server";
        const sshUser = (opts as any).serverUser ?? currentUsername();
        ctx.output.write(forwardingScript({
            group: g, name: n, target,
            serverHost: (opts as any).serverHost ?? fromOriginal,
            sshUser,
            scope: ((opts as any).scope as "user" | "system"),
        }));
    },
});
