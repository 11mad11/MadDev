import * as v from 'valibot';
import { SSHGateway } from "./gateway";
import { Permissions } from "./permission";

type MappedPerm = {
    [key in keyof Permissions]: MapType<Parameters<Permissions[key]>, ReturnType<Permissions[key]>>
}

type MapType<P extends any[], R> = P extends [infer K, ...infer L] ? Record<string, MapType<L, R>> : R

export class Users {

    usersConfig = this.gateway.setting.load("users.json", v.object({
        users: v.record(v.string(), v.strictObject({
            permissions: v.partial(v.strictObject(Permissions.schema)),
            role: v.optional(v.string()),
            password: v.optional(v.string()),
            publicKeys: v.optional(v.array(v.string()))
        }))
    }), () => ({ users: {} }));

    get users(){
        return this.usersConfig.data.users
    }
    roles = new Map<string | undefined, Partial<Permissions>>();

    constructor(
        public gateway: SSHGateway
    ) {
    }

    resolvePermission(username: string): Partial<Permissions> | undefined {
        const user = this.users[username];
        if (!user)
            return Permissions.default;

        const role = this.roles.get(user.role);

        function check<K extends keyof Permissions>(n: K, vals: Parameters<Permissions[K]>) {
            let cur: any = user?.permissions[n];
            let stack = [...vals].reverse();
            while (cur && stack.length) {
                const k = String(stack.pop());
                if (k in cur)
                    cur = cur[k];
                else if ("*" in cur)
                    cur = cur["*"]
                else
                    cur = undefined
            }
            if (cur !== undefined)
                return cur;

            if (role && n in role)
                return role[n]?.call(undefined, ...vals);

            return Permissions.default[n].call(undefined, ...vals);
        }

        return Object.fromEntries(Object.keys(Permissions.default).map(k => {
            return [k, (...args) => check(k as any, args)]
        }));
    }

    setUser(username: string, perm: typeof this.users[string]) {
        this.users[username] = perm;
        this.usersConfig.save();
    }

    removeUser(username: string) {
        delete this.users[username];
        this.usersConfig.save();
    }

    setRole(role: string, perm: Partial<Permissions>) {
        this.roles.set(role, perm);
    }

    removeRole(role: string) {
        this.roles.delete(role);
    }

}