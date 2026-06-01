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
    async pty() { return false; },
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
