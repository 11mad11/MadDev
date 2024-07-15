import { AcceptConnection, AuthContext, ClientInfo, Connection, Server, ServerChannel, TcpipBindInfo, TcpipRequestInfo } from "ssh2";
import { Server as NetServer } from "net";
import { Permissions } from "./permission";
import { PasswordAuthProvider } from "./auth/password";
import { PublicKeyAuthProvider } from "./auth/publickey";
import { SSHService } from "./services/ssh";
import { TCPService } from "./services/tcp";
import { CA } from "./ca";
import { Settings } from "./settings";
import { Users } from "./user";
import { TunService } from "./services/tun";

export interface User {
    username: string
    permission: Permissions
    client: Connection
    info: ClientInfo
}

export interface AuthProvider {

    readonly method: AuthContext["method"]

    /**
     * 
     * @param ctx 
     */
    auth(client: Connection, info: ClientInfo, ctx: AuthContext): Promise<void> | void
}

export interface Service<U = void> {
    register(ctx: {
        user: User,
        info: TcpipBindInfo
    }): Promise<void>;

    use(ctx: {
        user: User,
        accept: AcceptConnection<ServerChannel>,
        info: TcpipRequestInfo
    }): Promise<U>;
}

export abstract class Command {
    abstract execute(this: SSHGateway, user: User, parts: string[], channel: ServerChannel): Promise<void> | void
}

export class SSHGateway {

    envMap = new WeakMap<Connection, Record<string, string>>();
    commands = new Map<string, Command>();

    services = {
        1: new TCPService(),
        2: new TunService(),
        22: new SSHService(),
    } as const satisfies Record<number, Service<any>>;

    authsProvider = {
        password: new PasswordAuthProvider(this),
        publickey: new PublicKeyAuthProvider(this),
        none: null,
        "keyboard-interactive": null,
        hostbased: null
    } as const satisfies Record<AuthContext["method"], AuthProvider | null>;

    setting = new Settings();
    ca = new CA(this);
    users = new Users(this);

    constructor(
    ) {
        this.addCommand("otp", import("./commands/otp"));
        this.addCommand("signsshkey", import("./commands/signsshkey"));
        this.addCommand("sshca", import("./commands/sshca"));
        this.addCommand("sshhelp", import("./commands/sshhelp"));
    }

    addCommand(name: string, cmd: Command | Promise<Command> | Promise<{ default: Command }>) {
        Promise.resolve(cmd).then((cmd) => {
            this.commands.set(name, "default" in cmd ? cmd.default : cmd);
        });
    }

    listenOn(server: Server) {
        server.on("connection", this.onConnection.bind(this));

        (server as NetServer).on("close", () => {

        });
    }

    auth(client: Connection, info: ClientInfo) {
        return new Promise<string>((resolve, reject) => {
            const errors: any[] = [];

            client.on("authentication", async (ctx) => {
                if (!this.authsProvider[ctx.method])
                    return ctx.reject();

                try {
                    await this.authsProvider[ctx.method]!.auth(client, info, ctx);
                    resolve(ctx.username);
                    ctx.accept();
                } catch (err) {
                    errors.push(err);
                    ctx.reject();
                    if (errors.length > 5)
                        client.end();
                }
            });

            client.on("end", () => {
                reject(errors);
            })
        })
    }

    async onConnection(client: Connection, info: ClientInfo) {
        try {
            const username = await this.auth(client, info);

            const user: User = {
                client, info, username, permission: Permissions.withDefault(this.users.resolvePermission(username))
            }

            this.registerCallback(user);
        } catch (err) {
            console.error(err);
        }
    }

    registerCallback(user: User) {
        const client = user.client;

        client.on("session", (a) => {
            const session = a();
            session.on("exec", (a, r, i) => {
                console.log(a, r, i);

                const parts = i.command.split(" ");
                const cmd = this.commands.get(parts[0]);

                if (!cmd)
                    return r();

                cmd.execute.call(this, user, parts, a());
            })
        });

        client.on('tcpip', (a, r, i) => {
            console.log(i);
            if (!user.permission.canUseService(i.destPort, i.destIP))
                return r();
            const result = this.services[i.destPort]?.use({
                user,
                accept: a!,
                info: i
            });
            result?.catch(r)
        })

        client.on('request', (a, r, t, i) => {
            if (
                t !== "tcpip-forward"
            )
                return r?.();

            switch (t) {
                case "tcpip-forward":
                    console.log(i);
                    if (!user.permission.canRegisterService(i.bindPort, i.bindAddr))
                        return r?.();
                    const result = this.services[i.bindPort]?.register({
                        user,
                        info: i
                    });
                    return result?.then(() => a!()).catch(r);
                default:
                    return r?.();
            }
        })
    }

}