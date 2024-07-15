import { TcpipBindInfo, AcceptConnection, ServerChannel, TcpipRequestInfo } from "ssh2";
import { Service, User } from "../gateway";
import { utils } from "iproute";
import { createServer } from "net";
import { execFileSync, spawn } from "child_process";
import { chmodSync, existsSync, unlinkSync } from "fs";

utils.ipForwarding.v4.enable().then(r => console.log("ipforward", "good", r)).catch(r => console.log("ipforward", "bad", r))

export class TunService implements Service<TUN> {
    services = new Map<string, Bridge>();
    async register(ctx: { user: User; info: TcpipBindInfo; }) {
        throw new Error();
    }

    async addNetwork(name: string, subnet: string) {
        if (name.indexOf(" ") !== -1)
            throw new Error("no space in name")
        this.services.set(name, new Bridge(name, subnet));
    }

    async use(ctx: {
        user: User,
        accept: AcceptConnection<ServerChannel>,
        info: TcpipRequestInfo
    }) {
        const s = this.services.get(ctx.info.destIP)
        if (!s)
            throw new Error("no tun service by this name: " + ctx.info.destIP)
        s.connect(ctx.user.username, ctx.accept());
        return {} as any
    }

}

class Bridge {

    dev: string
    proc: import("child_process").ChildProcessWithoutNullStreams;

    constructor(
        public readonly name: string,
        public readonly subnet: string
    ) {
        this.dev = "br" + name;
        this.proc = spawn("./src/bash/setupBridge.sh", [
            this.dev, ...subnet.split("/") //TODO sanatize
        ], {
            shell: true,
        });
        this.proc.stderr.pipe(process.stderr);
        this.proc.stdout.pipe(process.stdout);
        this.proc.on("error", (e) => console.error(this.dev, e));
        this.proc.on("close", (c, s) => console.log(this.dev, c, s));
        this.proc.on("exit", (c, s) => console.log(this.dev, c, s));
    }

    connect(username: string, channel: ServerChannel) {
        const tun = new TUN(username, channel, this);
    }

}

class TUN {
    private static cnt = 0;

    socat: import("child_process").ChildProcessWithoutNullStreams;
    dev: string;

    constructor(
        public readonly name: string,
        channel: ServerChannel
        , bridge: Bridge
    ) {
        this.dev = `tap${TUN.cnt++}${name}`;

        const socketPath = `./sockets/${this.dev}.sock`;
        if (existsSync(socketPath))
            unlinkSync(socketPath);

        const server = createServer(socket => {
            console.log('Client connected');
            channel.pipe(socket)
            socket.pipe(channel);
        });

        // Listen for connections on the Unix socket path
        server.listen(socketPath, () => {
            console.log(`Unix socket server listening on ${socketPath}`);
        });

        // Handle server errors
        server.on('error', err => {
            console.error('Server error:', err.message);
        });

        // Handle server close
        server.on('close', () => {
            console.log('Server closed');
        });

        // Optional: Set permissions on the Unix socket file
        chmodSync(socketPath, '777'); // TODO adjust permissions

        this.socat = spawn(`socat TUN,iff-no-pi,up,tun-type=tap,tun-name=${this.dev} UNIX-CONNECT:${socketPath}`, [], {
            shell: true
        });
        this.socat.stderr.pipe(process.stderr);
        this.socat.stdout.pipe(process.stderr);
        this.socat.on("error", (e) => console.error(this.dev, e));
        this.socat.on("close", (c, s) => console.log(this.dev, c, s));
        this.socat.on("exit", (c, s) => console.log(this.dev, c, s));

        setTimeout(() => {
            execFileSync("ip", ["link", "set", this.dev, "master", bridge.dev])
        }, 1000);
    }


}