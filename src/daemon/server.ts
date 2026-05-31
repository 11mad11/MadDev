import { createServer, Server, Socket } from "net";
import { existsSync, unlinkSync, mkdirSync, chmodSync, chownSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline";
import { CA } from "../ca";
import { getGroupGid } from "../groups";
import { handle, writeKrlFile } from "./handlers";
import { getPeerCred } from "./peercred";
import { loadState } from "./state";
import { DAEMON_ROOT_SOCKET, DAEMON_SOCKET, Request } from "./protocol";

const CA_KEY_PATH = "/etc/mad/ca/ca.key";

export async function runDaemon(): Promise<void> {
    if (process.getuid?.() !== 0)
        throw new Error("daemon must run as root");

    mkdirSync(dirname(DAEMON_SOCKET), { recursive: true });
    chmodSync(dirname(DAEMON_SOCKET), 0o750);
    const madGid = getGroupGid("mad");
    if (madGid !== undefined)
        chownSync(dirname(DAEMON_SOCKET), 0, madGid);

    const state = loadState();
    const ca = new CA(CA_KEY_PATH);

    // Make sure /etc/ssh/mad_krl is in sync with state.json on every daemon
    // boot so sshd's RevokedKeys file is always present + correct.
    try { writeKrlFile({ state, ca, peer: { pid: 0, uid: 0, gid: 0 }, isRootSocket: true }); }
    catch (e) { console.error("KRL bootstrap:", e); }

    const userServer = bind(DAEMON_SOCKET, 0o660, madGid, (sock) => handleConn(sock, false, state, ca));
    const rootServer = bind(DAEMON_ROOT_SOCKET, 0o600, 0, (sock) => handleConn(sock, true, state, ca));

    process.on("SIGINT", () => shutdown(userServer, rootServer));
    process.on("SIGTERM", () => shutdown(userServer, rootServer));

    console.log(`mad daemon listening on ${DAEMON_SOCKET} and ${DAEMON_ROOT_SOCKET}`);
}

function bind(path: string, mode: number, gid: number | undefined, onConn: (s: Socket) => void): Server {
    if (existsSync(path))
        unlinkSync(path);
    const server = createServer(onConn);
    server.listen(path, () => {
        chmodSync(path, mode);
        if (gid !== undefined)
            chownSync(path, 0, gid);
    });
    server.on("error", (e) => console.error(`server ${path}:`, e));
    return server;
}

function handleConn(sock: Socket, isRootSocket: boolean, state: ReturnType<typeof loadState>, ca: CA) {
    let peer;
    try {
        peer = getPeerCred(sock);
    } catch (e: any) {
        sock.end(JSON.stringify({ ok: false, error: `peer-cred: ${e?.message}` }) + "\n");
        return;
    }

    const rl = createInterface({ input: sock });
    rl.on("line", (line) => {
        let req: Request;
        try {
            req = JSON.parse(line);
        } catch (e: any) {
            sock.write(JSON.stringify({ ok: false, error: `bad json: ${e?.message}` }) + "\n");
            return;
        }
        const resp = handle(req, { state, ca, peer, isRootSocket });
        sock.write(JSON.stringify(resp) + "\n");
    });
    rl.on("close", () => sock.end());
    sock.on("error", () => sock.destroy());
}

function shutdown(...servers: Server[]) {
    for (const s of servers) s.close();
    process.exit(0);
}
