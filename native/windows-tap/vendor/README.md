# wintun.dll vendor directory

The signed `wintun.dll` redistributable goes here. It is **not** checked
in — drop it manually for local builds, and CI fetches it via the
`build:vendor` script.

## Where to get it

Official download: https://www.wintun.net/builds/wintun-0.14.1.zip
(GPG-signed by Jason A. Donenfeld; see https://www.wintun.net/ for the
public key.)

```
wintun-0.14.1.zip
  └── wintun/
      ├── bin/amd64/wintun.dll    ← we want this one for x86_64-pc-windows-*
      ├── bin/arm64/wintun.dll
      ├── bin/x86/wintun.dll
      └── bin/arm/wintun.dll
```

Copy `bin/amd64/wintun.dll` into this directory:

```sh
curl -L https://www.wintun.net/builds/wintun-0.14.1.zip -o /tmp/wintun.zip
unzip -j /tmp/wintun.zip 'wintun/bin/amd64/wintun.dll' -d native/windows-tap/vendor/
```

## What we do with it

The DLL is loaded at runtime via `LoadLibraryW("wintun.dll")` from
`src/wintun.rs` — we do **not** link against `wintun.lib` at build
time, so cross-compiling from Linux only needs the standard Windows
target, not the SDK.

At distribution time `bun build --compile --target=bun-windows-x64`
embeds this DLL into `mad.exe` via the asset-import pipeline. On
first run mad extracts it to a temp directory next to the executable
and that directory is added to the DLL search path before any
wintun call.

## Licensing

Wintun is GPL-2.0. We load it dynamically (no static linkage) and ship
it as an unmodified redistributable, which is consistent with the
wintun project's own redistribution guidance. See
https://www.wintun.net/ for the project's stance.
