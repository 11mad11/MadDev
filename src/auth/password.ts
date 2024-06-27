import { timingSafeEqual } from "crypto";
import { Connection, ClientInfo, AuthContext } from "ssh2";
import { AuthProvider, SSHGateway, User } from "../gateway";

export class PasswordAuthProvider implements AuthProvider {

    method = "password" as const

    private users = new Map<string, { pass: Buffer, cb?: (client: Connection, info: ClientInfo, ctx: AuthContext) => void }>();
    //private expired = new Set<string>();

    constructor(public gateway: SSHGateway) { }

    auth(client: Connection, info: ClientInfo, ctx: AuthContext) {
        if (ctx.method !== "password")
            throw new Error("Method not password")

        const pass = this.users.get(ctx.username);
        if (!pass)
            throw new Error("No User found")

        if (!checkValue(Buffer.from(ctx.password), pass.pass))
            throw new Error("Bad password")

        /*if (this.expired.has(ctx.username)) {
            ctx.requestChange("Change password:", (password) => {
                pass.pass = Buffer.from(password);
                this.expired.delete(ctx.username);
            });
        }*/

        pass.cb?.(client, info, ctx);
    }

    setUser(username: string, password: string) {
        this.users.set(username, { pass: Buffer.from(password) });
    }

    setOTPUser(username: string): string {
        const otp = createNumericalChain(6);
        this.users.set(username, {
            pass: Buffer.from(otp),
            cb: (client, info, ctx) => {
                this.users.delete(username);
                if (this.gateway.authsProvider.publickey.acceptNext(client, info, ctx.username))
                    ctx.reject(["publickey"], true);
            }
        });
        return otp;
    }
}

////helper

function checkValue(input, allowed) {
    const autoReject = (input.length !== allowed.length);
    if (autoReject) {
        // Prevent leaking length information by always making a comparison with the
        // same input when lengths don't match what we expect ...
        allowed = input;
    }
    const isMatch = timingSafeEqual(input, allowed);
    return (!autoReject && isMatch);
}

function createNumericalChain(length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10).toString();
    }
    return result;
}