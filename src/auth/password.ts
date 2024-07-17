import { Connection, ClientInfo, AuthContext } from "ssh2";
import { AuthProvider, SSHGateway, User } from "../gateway";
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export class PasswordAuthProvider implements AuthProvider {

    method = "password" as const

    private otps = new Map<string, Buffer>();
    //private expired = new Set<string>();

    constructor(public gateway: SSHGateway) { }

    auth(client: Connection, info: ClientInfo, ctx: AuthContext) {
        if (ctx.method !== "password")
            throw new Error("Method not password")

        const user = this.gateway.users.users[ctx.username];
        if (user && user.password) {
            const salt = user.password.slice(64);
            const originalPassHash = user.password.slice(0, 64);
            const currentPassHash = this.encryptPassword(ctx.password, salt);
            if (originalPassHash === currentPassHash) //No need for timingSafeEqual since we are comparing hashes
                return;
        }

        const otp = this.otps.get(ctx.username);
        if (!otp)
            throw new Error("No User found")
        if (!checkValue(Buffer.from(ctx.password), otp))
            throw new Error("Bad password")
        this.otps.delete(ctx.username);
        if (this.gateway.authsProvider.publickey.acceptNext(client, info, ctx.username))
            ctx.reject(["publickey"], true);
    }

    encryptPassword(password: string, salt: string = randomBytes(16).toString('hex')) {
        return scryptSync(password, salt, 32).toString('hex');
    }

    setPassword(username: string, password: string) {
        this.gateway.users.getOrCreateUser(username).password = this.encryptPassword(password);
    }

    setOTPUser(username: string): string {
        const otp = createNumericalChain(6);
        this.otps.set(username, Buffer.from(otp));
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