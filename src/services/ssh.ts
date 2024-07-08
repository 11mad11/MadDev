import { TcpipBindInfo, AcceptConnection, ServerChannel, TcpipRequestInfo } from "ssh2";
import { Service, User } from "../gateway";
import { TCPService } from "./tcp";

export class SSHService implements Service {
    tcpService = new TCPService();

    constructor() {
    }

    async register(ctx: { user: User; info: TcpipBindInfo; }) {
        await this.tcpService.register(ctx);
    }

    async use(ctx: { user: User; accept: AcceptConnection<ServerChannel>; refuse: () => void; info: TcpipRequestInfo; }) {
        await this.tcpService.use(ctx);
    }
}