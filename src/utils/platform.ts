/**
 * Platform guards used by server-only subcommands.
 *
 * The same `mad` binary runs on Linux (gateway + client) and on macOS /
 * Windows (client only). Server-only commands — anything that talks to
 * the daemon as root, manipulates /etc/passwd or sshd config, or
 * requires CAP_NET_ADMIN — fail fast with a clear message on the wrong
 * platform.
 */

export function isLinux(): boolean {
    return process.platform === "linux";
}

export function isRoot(): boolean {
    return typeof process.getuid === "function" && process.getuid() === 0;
}

export function isLinuxRoot(): boolean {
    return isLinux() && isRoot();
}

export function requireLinuxRoot(cmd: string): void {
    if (!isLinux()) {
        process.stderr.write(`${cmd} requires Linux (you are on ${process.platform}).\n`);
        process.exit(2);
    }
    if (!isRoot()) {
        process.stderr.write(`${cmd} requires root (try sudo ${cmd}).\n`);
        process.exit(2);
    }
}

export function requireLinux(cmd: string): void {
    if (!isLinux()) {
        process.stderr.write(`${cmd} requires Linux (you are on ${process.platform}).\n`);
        process.exit(2);
    }
}
