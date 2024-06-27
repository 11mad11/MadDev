
export interface Permissions {
    canRegisterService(type: number, name: string): boolean
    canUseService(type: number, name: string): boolean
    canGenerateOTP(): boolean
}

export const Permissions = {
    default: {
        canRegisterService: () => false,
        canUseService: () => false,
        canGenerateOTP: () => false
    } satisfies Permissions,
    withDefault: (perm: Partial<Permissions> | undefined): Permissions => ({ ...Permissions.default, ...(perm ?? {}) })
}