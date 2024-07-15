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
import { CommandManager } from "./command";

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

export class SSHGateway {

    envMap = new WeakMap<Connection, Record<string, string>>();

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
    commands = new CommandManager(this);

    constructor(
    ) {

    }

    listenOn(server: Server) {
        server.on("connection", this.onConnection.bind(this));

        server.on("error", (e) => {
            console.error(e);
        });

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
            client.on("error", (e) => {
                console.error(e);
            })
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
                this.commands.exec(user, a(), i.command);
            })
        });

        client.on('tcpip', (a, r, i) => {
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