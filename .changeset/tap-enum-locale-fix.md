---
"mad": patch
---

Fix `mad tap join` on non-English Windows installs failing with `mad_l2_create_adapter(...): tapinstall succeeded but no new TAP adapter appeared`.

The Rust `enumerate_tap_adapter_names()` filtered TAP-Windows6 adapters by the friendly Name's English prefix (`"TAP-Windows Adapter"` / `"mad-"`). On French/German/Spanish/etc. Windows the friendly Name is localized (`"Connexion au réseau local"`, `"LAN-Verbindung"`, …) so every TAP adapter was filtered out, the before/after set-difference was empty, and the create-and-rename step bailed even though `tapinstall.exe` had successfully created the new adapter.

Now filters by the device's HardwareID (`tap0901`) read via `Connection.PnpInstanceID` → `Enum\<PnpInstanceID>.HardwareID`. HardwareID is set by the driver and is locale-independent. Verified end-to-end on French Windows 10 (`192.168.2.14`): with several orphan TAP adapters present from earlier failed runs, `mad tap join dev/smb` now reaches the SSH-to-gateway step.
