import * as v from 'valibot';

export interface Permissions {
    canRegisterService(type: number, name: string): boolean
    canUseService(type: number, name: string): boolean
    canGenerateOTP(): boolean
    canDeleteUser(): boolean
    canChangeRole(): boolean
    canChangeAuth(): boolean
}

export const Permissions = {
    default: {
        canRegisterService: () => false,
        canUseService: () => false,
        canGenerateOTP: () => false,
        canDeleteUser: () => false,
        canChangeRole: ()=> false,
        canChangeAuth: ()=> false
    } satisfies Permissions,
    withDefault: (perm: Partial<Permissions> | undefined): Permissions => ({ ...Permissions.default, ...(perm ?? {}) }),
    schema: {
        canRegisterService: v.record(v.string(), v.record(v.string(), v.boolean())),
        canUseService: v.record(v.string(), v.record(v.string(), v.boolean())),
        canGenerateOTP: v.boolean(),
        canDeleteUser: v.boolean(),
        canChangeRole: v.boolean(),
        canChangeAuth: v.boolean()
    } satisfies { [k in keyof Permissions] }
}
