//! mad_wintap — Windows TAP/TUN backend for mad.
//!
//! Mirrors the openTap/pump shape used by src/utils/tapPipe.ts on
//! Linux/macOS, expressed as a small C ABI loaded via `bun:ffi`.

#![cfg(windows)]

mod backend;
mod errors;
mod handle;
mod installer;
mod pump;
mod tap_win6;
mod wintun;

use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_uint};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use backend::Backend;
use errors::{clear_error, set_last_error, with_last_error};
use handle::{HandleRegistry, Slot};
use pump::Pump;

static REGISTRY: LazyLock<Mutex<HandleRegistry>> =
    LazyLock::new(|| Mutex::new(HandleRegistry::new()));

const MODE_L2: u32 = 0;
const MODE_L3: u32 = 1;

/// Add `path` to the DLL search list so subsequent LoadLibraryW
/// calls (notably `wintun.dll` from our own code) resolve against
/// the directory mad's bun startup extracted assets into. Call this
/// once, before `mad_wintun_load`.
///
/// # Safety
/// `path_utf8` must be a NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn mad_set_dll_dir(path_utf8: *const c_char) -> c_int {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW;

    if path_utf8.is_null() {
        set_last_error(0, "set_dll_dir: null path".into());
        return -1;
    }
    let path = match CStr::from_ptr(path_utf8).to_str() {
        Ok(s) => s,
        Err(_) => {
            set_last_error(0, "set_dll_dir: path is not valid UTF-8".into());
            return -1;
        }
    };
    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = SetDllDirectoryW(wide.as_ptr());
    if ok == 0 {
        let err = windows_sys::Win32::Foundation::GetLastError();
        set_last_error(0, format!("SetDllDirectoryW failed: GetLastError={err}"));
        return -1;
    }
    0
}

/// Load wintun.dll. Idempotent.
#[no_mangle]
pub extern "C" fn mad_wintun_load() -> c_int {
    match wintun::ensure_loaded() {
        Ok(()) => 0,
        Err(e) => {
            set_last_error(0, e);
            -1
        }
    }
}

/// Wintun's reported driver version, 0 if no adapter is active.
#[no_mangle]
pub extern "C" fn mad_wintun_driver_version() -> c_uint {
    match wintun::ensure_loaded() {
        Ok(()) => wintun::driver_version(),
        Err(_) => 0,
    }
}

/// Open an existing wintun adapter by name (e.g. "mad-stress") and
/// immediately close it, which deletes it. Used by the startup
/// stale-adapter sweep. Returns 1 if an adapter was deleted, 0 if
/// none existed, -1 on error.
///
/// # Safety
/// `name_utf8` must be a NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn mad_wintun_delete_adapter(name_utf8: *const c_char) -> c_int {
    if name_utf8.is_null() {
        set_last_error(0, "delete_adapter: null name".into());
        return -1;
    }
    let name = match CStr::from_ptr(name_utf8).to_str() {
        Ok(s) => s,
        Err(_) => {
            set_last_error(0, "delete_adapter: name is not valid UTF-8".into());
            return -1;
        }
    };
    match wintun::delete_adapter_if_present(name) {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(e) => {
            set_last_error(0, e);
            -1
        }
    }
}

/// 1 if the TAP-Windows6 kernel driver is installed on this machine,
/// 0 otherwise. The JS side calls this before attempting L2 to decide
/// whether to prompt for installation.
#[no_mangle]
pub extern "C" fn mad_l2_driver_installed() -> c_int {
    if installer::is_installed() {
        1
    } else {
        0
    }
}

/// Run the TAP-Windows6 installer at `installer_path_utf8` with
/// elevation (UAC). Blocks until the installer exits. Returns the
/// installer's exit code on success, -1 on launch failure.
///
/// # Safety
/// `installer_path_utf8` must be a NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn mad_l2_driver_install(installer_path_utf8: *const c_char) -> c_int {
    if installer_path_utf8.is_null() {
        set_last_error(0, "install: null path".into());
        return -1;
    }
    let path = match CStr::from_ptr(installer_path_utf8).to_str() {
        Ok(s) => s,
        Err(_) => {
            set_last_error(0, "install: path is not valid UTF-8".into());
            return -1;
        }
    };
    match installer::run_installer(path) {
        Ok(code) => code,
        Err(e) => {
            set_last_error(0, e);
            -1
        }
    }
}

/// Create a TAP-Windows6 adapter and rename it to `mad-<group>`.
/// Idempotent: returns 0 if the adapter already exists. Returns -1
/// on error (driver not installed, tapinstall.exe missing, netsh
/// rename failed, etc.) — call `mad_last_error(0, …)` for details.
///
/// # Safety
/// `group_name_utf8` must be a NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn mad_l2_create_adapter(group_name_utf8: *const c_char) -> c_int {
    if group_name_utf8.is_null() {
        set_last_error(0, "create_adapter: null group".into());
        return -1;
    }
    let name = match CStr::from_ptr(group_name_utf8).to_str() {
        Ok(s) => s,
        Err(_) => {
            set_last_error(0, "create_adapter: group not valid UTF-8".into());
            return -1;
        }
    };
    match tap_win6::create_and_rename_adapter(name) {
        Ok(()) => 0,
        Err(e) => {
            set_last_error(0, e);
            -1
        }
    }
}

/// Open a TAP (mode=0) or TUN (mode=1) adapter named `mad-<group>`.
/// Returns a non-zero opaque handle on success, 0 on error.
///
/// # Safety
/// `group_name_utf8` must be a NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn mad_open(group_name_utf8: *const c_char, mode: c_uint) -> u64 {
    if group_name_utf8.is_null() {
        set_last_error(0, "group_name is null".into());
        return 0;
    }
    let name = match CStr::from_ptr(group_name_utf8).to_str() {
        Ok(s) => s,
        Err(_) => {
            set_last_error(0, "group_name is not valid UTF-8".into());
            return 0;
        }
    };
    let backend: Arc<dyn Backend> = match mode {
        MODE_L3 => match wintun::open_adapter(name) {
            Ok(a) => Arc::new(a),
            Err(e) => {
                set_last_error(0, e);
                return 0;
            }
        },
        MODE_L2 => {
            if !installer::is_installed() {
                set_last_error(
                    0,
                    "TAP-Windows6 driver not installed — run `mad doctor --install-l2-driver` or install tap-windows-9.x.x.exe manually".into(),
                );
                return 0;
            }
            match tap_win6::open_adapter(name) {
                Ok(a) => Arc::new(a),
                Err(e) => {
                    set_last_error(0, e);
                    return 0;
                }
            }
        }
        other => {
            set_last_error(0, format!("invalid mode: {other}"));
            return 0;
        }
    };

    let mut reg = REGISTRY.lock().unwrap();
    reg.insert(Slot::new(backend))
}

/// Close the adapter. Stops the pump first if one is running.
#[no_mangle]
pub extern "C" fn mad_close(handle: u64) -> c_int {
    if handle == 0 {
        return 0;
    }
    let slot = {
        let mut reg = REGISTRY.lock().unwrap();
        reg.remove(handle)
    };
    if let Some(mut slot) = slot {
        if let Some(mut pump) = slot.take_pump() {
            pump.stop();
        }
        drop(slot);
    }
    clear_error(handle);
    0
}

/// Spawn `ssh ssh_argv...`, wire its stdio into the pump, start
/// pumping in background threads.
///
/// # Safety
/// `ssh_argv` must point to `argc` NUL-terminated UTF-8 strings.
#[no_mangle]
pub unsafe extern "C" fn mad_pump_start_ssh(
    handle: u64,
    ssh_exe_utf8: *const c_char,
    ssh_argv: *const *const c_char,
    argc: c_uint,
) -> c_int {
    if ssh_exe_utf8.is_null() || ssh_argv.is_null() {
        set_last_error(handle, "pump_start: null ssh exe or argv".into());
        return -1;
    }
    let ssh_exe = match CStr::from_ptr(ssh_exe_utf8).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => {
            set_last_error(handle, "pump_start: ssh_exe is not valid UTF-8".into());
            return -1;
        }
    };
    let mut args = Vec::with_capacity(argc as usize);
    for i in 0..argc as isize {
        let ptr = *ssh_argv.offset(i);
        if ptr.is_null() {
            set_last_error(handle, format!("pump_start: argv[{i}] is null"));
            return -1;
        }
        match CStr::from_ptr(ptr).to_str() {
            Ok(s) => args.push(s.to_string()),
            Err(_) => {
                set_last_error(handle, format!("pump_start: argv[{i}] is not valid UTF-8"));
                return -1;
            }
        }
    }

    let mut reg = REGISTRY.lock().unwrap();
    let slot = match reg.get_mut(handle) {
        Some(s) => s,
        None => {
            set_last_error(handle, "pump_start: unknown handle".into());
            return -1;
        }
    };
    if slot.has_pump() {
        set_last_error(handle, "pump_start: pump already running for this handle".into());
        return -1;
    }
    let backend = slot.backend();
    match Pump::start(handle, backend, &ssh_exe, &args) {
        Ok(p) => {
            slot.set_pump(p);
            0
        }
        Err(e) => {
            set_last_error(handle, e);
            -1
        }
    }
}

/// Block up to `timeout_ms` for MAD_TUN_OK. Returns line length on
/// success (truncated to cap on copy), 0 on timeout, -1 on error.
///
/// # Safety
/// `out_buf` must point to at least `cap` bytes (may be null only if
/// `cap == 0`).
#[no_mangle]
pub unsafe extern "C" fn mad_pump_wait_handshake(
    handle: u64,
    out_buf: *mut u8,
    cap: c_uint,
    timeout_ms: c_uint,
) -> c_int {
    let reg = REGISTRY.lock().unwrap();
    let Some(slot) = reg.get(handle) else {
        set_last_error(handle, "wait_handshake: unknown handle".into());
        return -1;
    };
    let Some(pump) = slot.pump() else {
        set_last_error(handle, "wait_handshake: pump not started".into());
        return -1;
    };
    let handshake = pump.handshake();
    drop(reg);

    match handshake.wait(Duration::from_millis(timeout_ms as u64)) {
        Some(line) => {
            let bytes = line.as_bytes();
            let n = bytes.len().min(cap as usize);
            if !out_buf.is_null() && cap > 0 {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, n);
            }
            bytes.len() as c_int
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn mad_pump_is_running(handle: u64) -> c_int {
    let reg = REGISTRY.lock().unwrap();
    let Some(slot) = reg.get(handle) else { return 0 };
    let Some(pump) = slot.pump() else { return 0 };
    if pump.is_running() { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn mad_pump_stop(handle: u64) -> c_int {
    let pump = {
        let mut reg = REGISTRY.lock().unwrap();
        match reg.get_mut(handle) {
            Some(slot) => slot.take_pump(),
            None => None,
        }
    };
    if let Some(mut p) = pump {
        p.stop();
    }
    0
}

/// Copy the last error for `handle` into `out_buf` (UTF-8). Returns
/// the message's full byte length (snprintf-style).
///
/// # Safety
/// `out_buf` must point to at least `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn mad_last_error(handle: u64, out_buf: *mut u8, cap: c_uint) -> c_uint {
    with_last_error(handle, |msg| {
        let bytes = msg.as_bytes();
        let n = bytes.len().min(cap as usize);
        if !out_buf.is_null() && cap > 0 {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, n);
            if n < cap as usize {
                *out_buf.add(n) = 0;
            }
        }
        bytes.len() as c_uint
    })
}
