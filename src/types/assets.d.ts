// Type declarations for binary asset imports used with bun's
// `with { type: "file" }` attribute. The default export is the
// runtime path of the file (the actual filesystem path in dev, the
// extracted temp path inside a `bun build --compile` binary).

declare module "*.dll" {
    const path: string;
    export default path;
}

declare module "*.exe" {
    const path: string;
    export default path;
}
