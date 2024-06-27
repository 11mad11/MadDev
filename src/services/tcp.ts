import { Connection, TcpipBindInfo, AcceptConnection, ServerChannel, TcpipRequestInfo } from "ssh2";
import { Service, User } from "../gateway";

type U = { remote: User, user: User };

export class TCPService implements Service<U> {
    services = new Map<string, User>();
    async register(ctx: { user: User; info: TcpipBindInfo; }) {
        this.services.set(ctx.info.bindAddr, ctx.user);
    }

    use(ctx: {
        user: User,
        accept: AcceptConnection<ServerChannel>,
        info: TcpipRequestInfo
    }) {
        const remote = this.services.get(ctx.info.destIP);
        if (!remote)
            throw new Error();

        return new Promise<U>((resolve, reject) => {
            remote.client.forwardOut(ctx.info.destIP, ctx.info.destPort, ctx.info.srcIP, ctx.info.srcPort, (err, channel) => {
                if (err) {
                    console.error(err);
                    return reject(new Error());
                }
                const pipe = ctx.accept();
                pipe.pipe(channel);
                channel.pipe(pipe);
                resolve({
                    user: ctx.user, remote
                });
            });
        })
    }

}