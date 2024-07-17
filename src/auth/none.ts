import { Connection, ClientInfo, AuthContext } from "ssh2";
import { AuthProvider, SSHGateway, User } from "../gateway";

export class NoneAuthProvider implements AuthProvider {

    method = "none" as const

    private otps = new Map<string, Buffer>();
    //private expired = new Set<string>();

    constructor(public gateway: SSHGateway) { }

    auth(client: Connection, info: ClientInfo, ctx: AuthContext) {
        if (ctx.method !== "none")
            throw new Error("Method not none")

        if(ctx.username==="none")
            return;

        const user = this.gateway.users.users[ctx.username];
        if(user && user.none)
            return;
        throw new Error();
    }
}