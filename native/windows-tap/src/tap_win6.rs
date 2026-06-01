//! TAP-Windows6 (L2) backend.
//!
//! TAP-Windows6 is the OpenVPN kernel driver. Each adapter exposes a
//! device file at `\\.\Global\<NetCfgInstanceId>.tap`. After opening
//! with FILE_FLAG_OVERLAPPED, we have to call
//! IOCTL_TAP_WIN_IOCTL_SET_MEDIA_STATUS(1) before the adapter goes
//! "connected" — otherwise Windows shows it as cable-unplugged and
//! refuses to route traffic through it.
//!
//! Read/write are overlapped: we keep exactly one ReadFile in flight
//! at all times. The recv_wait_handle exposed to the pump is the
//! ReadFile's completion event; `try_recv` polls it, completes the
//! transfer when signaled, copies the frame out, and re-issues. This
//! mirrors wintun's drain-then-wait loop one packet per iteration.
//!
//! Adapter discovery uses the Net-class registry path rather than
//! SetupAPI — the registry approach is simpler and the keys we need
//! ARE under user-readable HKLM paths.

use std::ffi::OsStr;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr::null_mut;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_NO_MORE_ITEMS as WIN_ERROR_NO_MORE_ITEMS,
    ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_SYSTEM, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
    KEY_READ, REG_SZ,
};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows_sys::Win32::System::IO::{DeviceIoControl, GetOverlappedResult, OVERLAPPED};

use crate::backend::Backend;

// CTL_CODE macro evaluated for the TAP-Windows6 IOCTL we need:
//   CTL_CODE(FILE_DEVICE_UNKNOWN=0x22, function, METHOD_BUFFERED=0, FILE_ANY_ACCESS=0)
//   = (DeviceType << 16) | (Access << 14) | (Function << 2) | Method
const TAP_WIN_IOCTL_SET_MEDIA_STATUS: u32 = (0x22u32 << 16) | (6u32 << 2);

// Net class GUID. All NDIS adapters (wintun, TAP-Windows6, real NICs)
// register under here in the registry. We enumerate, filter to TAP.
const NET_CLASS_KEY: &str =
    r"SYSTEM\CurrentControlSet\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}";

pub struct TapWin6Adapter {
    name: String,
    device: HANDLE,
    read: Mutex<ReadState>,
    // Reused per send. CreateEvent isn't free but cheap enough that
    // we recreate per call rather than juggle reset semantics.
    write: Mutex<()>,
}

struct ReadState {
    overlapped: OVERLAPPED,
    event: HANDLE,
    buf: Vec<u8>,
    pending: bool,
}

// SAFETY: all handles are kernel HANDLEs that are safe to share between
// threads as long as we serialize access via the inner Mutexes.
unsafe impl Send for TapWin6Adapter {}
unsafe impl Sync for TapWin6Adapter {}

impl Drop for TapWin6Adapter {
    fn drop(&mut self) {
        unsafe {
            // Close the device first — that cancels any in-flight I/O.
            if !self.device.is_null() && self.device != INVALID_HANDLE_VALUE {
                CloseHandle(self.device);
            }
            let read = self.read.lock().unwrap();
            if !read.event.is_null() {
                CloseHandle(read.event);
            }
        }
    }
}

impl Backend for TapWin6Adapter {
    fn try_recv(&self, out_buf: &mut [u8]) -> Result<Option<usize>, String> {
        let mut read = self.read.lock().unwrap();
        unsafe {
            // First call: prime an overlapped ReadFile so the event
            // gets signaled when a frame arrives.
            if !read.pending {
                issue_read(self.device, &mut read)?;
                if !read.pending {
                    return Ok(None);
                }
            }

            // Cheap poll — doesn't enter the kernel for normal cases.
            let wait = WaitForSingleObject(read.event, 0);
            if wait == WAIT_TIMEOUT {
                return Ok(None);
            }
            if wait != WAIT_OBJECT_0 {
                return Err(format!("tap_win6: WaitForSingleObject returned {wait}"));
            }

            let mut transferred: u32 = 0;
            if GetOverlappedResult(self.device, &read.overlapped, &mut transferred, 0) == 0 {
                let err = GetLastError();
                return Err(format!("tap_win6: GetOverlappedResult: GetLastError={err}"));
            }
            let len = transferred as usize;
            if len > out_buf.len() {
                // Re-issue so we keep draining; report the error.
                read.pending = false;
                issue_read(self.device, &mut read).ok();
                return Err(format!("tap_win6: frame {len}B > buf {}B", out_buf.len()));
            }
            out_buf[..len].copy_from_slice(&read.buf[..len]);
            read.pending = false;
            issue_read(self.device, &mut read)?;
            Ok(Some(len))
        }
    }

    fn send(&self, frame: &[u8]) -> Result<bool, String> {
        let _g = self.write.lock().unwrap();
        unsafe {
            let event = create_event()?;
            let mut overlapped: OVERLAPPED = zeroed();
            overlapped.hEvent = event;
            let mut transferred: u32 = 0;
            let ok = WriteFile(
                self.device,
                frame.as_ptr(),
                frame.len() as u32,
                &mut transferred,
                &mut overlapped,
            );
            if ok == 0 {
                let err = GetLastError();
                if err != ERROR_IO_PENDING {
                    CloseHandle(event);
                    return Err(format!("tap_win6: WriteFile: GetLastError={err}"));
                }
                // Wait for completion.
                let wait = WaitForSingleObject(event, 0xFFFFFFFF);
                if wait != WAIT_OBJECT_0 {
                    CloseHandle(event);
                    return Err(format!("tap_win6: write wait returned {wait}"));
                }
                if GetOverlappedResult(self.device, &overlapped, &mut transferred, 0) == 0 {
                    let err = GetLastError();
                    CloseHandle(event);
                    return Err(format!(
                        "tap_win6: GetOverlappedResult(write): GetLastError={err}"
                    ));
                }
            }
            CloseHandle(event);
            Ok(transferred as usize == frame.len())
        }
    }

    fn recv_wait_handle(&self) -> Result<HANDLE, String> {
        let read = self.read.lock().unwrap();
        Ok(read.event)
    }

    fn adapter_name(&self) -> &str {
        &self.name
    }
}

/// Issue (or re-issue) the in-flight ReadFile against the device.
/// Sets `read.pending` to true on success (covers both the
/// "completed synchronously" and "ERROR_IO_PENDING" cases).
unsafe fn issue_read(device: HANDLE, read: &mut ReadState) -> Result<(), String> {
    // Re-zero the overlapped and re-set the event handle. The event
    // is auto-reset on a successful Wait so we don't strictly need
    // to clear it, but doing so guards against races on partial-completion.
    let event = read.event;
    read.overlapped = zeroed();
    read.overlapped.hEvent = event;
    let mut transferred: u32 = 0;
    let ok = ReadFile(
        device,
        read.buf.as_mut_ptr(),
        read.buf.len() as u32,
        &mut transferred,
        &mut read.overlapped,
    );
    if ok == 0 {
        let err = GetLastError();
        if err != ERROR_IO_PENDING {
            return Err(format!("tap_win6: ReadFile: GetLastError={err}"));
        }
    }
    read.pending = true;
    Ok(())
}

unsafe fn create_event() -> Result<HANDLE, String> {
    // Manual-reset, initially unsignaled — matches how Windows
    // overlapped I/O signals completion.
    let h = CreateEventW(null_mut(), 1, 0, null_mut());
    if h.is_null() {
        return Err(format!("CreateEventW failed: {}", GetLastError()));
    }
    Ok(h)
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Enumerate Net-class adapters and look for one whose `\Connection`
/// "Name" REG_SZ value matches our requested adapter name. Returns
/// the NetCfgInstanceId GUID string (no braces handling — the
/// registry keys ARE the braced GUIDs).
fn find_adapter_by_name(want_name: &str) -> Option<String> {
    let class_key_wide = to_wide(NET_CLASS_KEY);
    let mut class_hkey: HKEY = null_mut();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            class_key_wide.as_ptr(),
            0,
            KEY_READ,
            &mut class_hkey,
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }

    let mut found: Option<String> = None;
    let mut index = 0u32;
    loop {
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(
                class_hkey,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        if rc == WIN_ERROR_NO_MORE_ITEMS {
            break;
        }
        if rc != ERROR_SUCCESS {
            break;
        }
        index += 1;
        let subkey_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        // Each subkey of the Net class IS a NetCfgInstanceId in the form "{GUID}".
        // We open its \Connection child and read "Name".
        let conn_path = format!("{}\\{}\\Connection", NET_CLASS_KEY, subkey_name);
        let conn_wide = to_wide(&conn_path);
        let mut conn_hkey: HKEY = null_mut();
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                conn_wide.as_ptr(),
                0,
                KEY_READ,
                &mut conn_hkey,
            )
        };
        if rc != ERROR_SUCCESS {
            continue;
        }
        let name_val = to_wide("Name");
        let mut data = [0u16; 256];
        let mut data_size = (data.len() * size_of::<u16>()) as u32;
        let mut value_type: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(
                conn_hkey,
                name_val.as_ptr(),
                null_mut(),
                &mut value_type,
                data.as_mut_ptr() as *mut u8,
                &mut data_size,
            )
        };
        unsafe { RegCloseKey(conn_hkey) };
        if rc != ERROR_SUCCESS || value_type != REG_SZ {
            continue;
        }
        // Trim trailing nulls.
        let chars = (data_size as usize) / size_of::<u16>();
        let mut friendly = String::from_utf16_lossy(&data[..chars]);
        if let Some(pos) = friendly.find('\0') {
            friendly.truncate(pos);
        }
        if friendly == want_name {
            found = Some(subkey_name);
            break;
        }
    }
    unsafe { RegCloseKey(class_hkey) };
    found
}

/// Locate `tapinstall.exe` from the TAP-Windows6 install. The
/// installer drops it at a stable path under Program Files. If the
/// user installed somewhere non-standard, they can override via the
/// MAD_TAPINSTALL env var.
fn tapinstall_path() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("MAD_TAPINSTALL") {
        let p = PathBuf::from(env);
        if p.exists() {
            return Some(p);
        }
    }
    for c in [
        r"C:\Program Files\TAP-Windows\bin\tapinstall.exe",
        r"C:\Program Files (x86)\TAP-Windows\bin\tapinstall.exe",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn tap_inf_path() -> Option<PathBuf> {
    for c in [
        r"C:\Program Files\TAP-Windows\driver\OemVista.inf",
        r"C:\Program Files (x86)\TAP-Windows\driver\OemVista.inf",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Enumerate every TAP-Windows6 adapter's friendly name. Used by
/// `create_and_rename_adapter` to spot the one that's new after
/// tapinstall runs.
fn enumerate_tap_adapter_names() -> Vec<String> {
    let class_key_wide = to_wide(NET_CLASS_KEY);
    let mut class_hkey: HKEY = null_mut();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            class_key_wide.as_ptr(),
            0,
            KEY_READ,
            &mut class_hkey,
        )
    };
    if rc != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(
                class_hkey,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        if rc == WIN_ERROR_NO_MORE_ITEMS {
            break;
        }
        if rc != ERROR_SUCCESS {
            break;
        }
        index += 1;
        let subkey_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let conn_path = format!("{}\\{}\\Connection", NET_CLASS_KEY, subkey_name);
        let conn_wide = to_wide(&conn_path);
        let mut conn_hkey: HKEY = null_mut();
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                conn_wide.as_ptr(),
                0,
                KEY_READ,
                &mut conn_hkey,
            )
        };
        if rc != ERROR_SUCCESS {
            continue;
        }
        let name_val = to_wide("Name");
        let mut data = [0u16; 256];
        let mut data_size = (data.len() * size_of::<u16>()) as u32;
        let mut value_type: u32 = 0;
        let rc = unsafe {
            RegQueryValueExW(
                conn_hkey,
                name_val.as_ptr(),
                null_mut(),
                &mut value_type,
                data.as_mut_ptr() as *mut u8,
                &mut data_size,
            )
        };
        unsafe { RegCloseKey(conn_hkey) };
        if rc != ERROR_SUCCESS || value_type != REG_SZ {
            continue;
        }
        let chars = (data_size as usize) / size_of::<u16>();
        let mut friendly = String::from_utf16_lossy(&data[..chars]);
        if let Some(pos) = friendly.find('\0') {
            friendly.truncate(pos);
        }
        // TAP-Windows6 default adapter names start with "TAP-Windows Adapter V9"
        if friendly.starts_with("TAP-Windows Adapter") || friendly.starts_with("mad-") {
            names.push(friendly);
        }
    }
    unsafe { RegCloseKey(class_hkey) };
    names
}

/// Create a fresh TAP-Windows6 adapter and rename it to
/// `mad-<group>`. Idempotent: if the named adapter already exists,
/// just returns. Requires admin (tapinstall.exe + netsh both do).
pub fn create_and_rename_adapter(group: &str) -> Result<(), String> {
    if !crate::installer::is_installed() {
        return Err(
            "TAP-Windows6 driver not installed — run `mad doctor --install-l2-driver` first".into(),
        );
    }
    let want_name = format!("mad-{group}");
    if find_adapter_by_name(&want_name).is_some() {
        return Ok(());
    }

    let tapinstall = tapinstall_path().ok_or_else(|| {
        "couldn't find tapinstall.exe — driver may be installed in a non-standard location; set MAD_TAPINSTALL to point to it".to_string()
    })?;
    let inf = tap_inf_path().ok_or_else(|| {
        "couldn't find TAP-Windows6 OemVista.inf".to_string()
    })?;

    // tapinstall names new adapters "TAP-Windows Adapter V9 #N" where
    // N is the next free integer. We snapshot the pre-install set so
    // we can spot which one was just added.
    let before: std::collections::HashSet<String> =
        enumerate_tap_adapter_names().into_iter().collect();

    let output = Command::new(&tapinstall)
        .arg("install")
        .arg(&inf)
        .arg("tap0901")
        .output()
        .map_err(|e| format!("tapinstall.exe install: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tapinstall.exe install failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Find what's new.
    let after: std::collections::HashSet<String> =
        enumerate_tap_adapter_names().into_iter().collect();
    let new_name = after.difference(&before).next().cloned().ok_or_else(|| {
        "tapinstall succeeded but no new TAP adapter appeared — try again or check Device Manager".to_string()
    })?;

    // Rename via netsh — Win32 SetNetCfgInterfaceName works too but
    // netsh is one less code path to maintain.
    let rename = Command::new("netsh")
        .args(["interface", "set", "interface"])
        .arg(format!("name={new_name}"))
        .arg(format!("newname={want_name}"))
        .output()
        .map_err(|e| format!("netsh rename: {e}"))?;
    if !rename.status.success() {
        return Err(format!(
            "netsh rename {new_name} -> {want_name} failed: {}",
            String::from_utf8_lossy(&rename.stderr)
        ));
    }

    Ok(())
}

/// Open the TAP-Windows6 adapter named `mad-<group>`. If the
/// adapter doesn't exist yet, creates one via `create_and_rename_adapter`.
pub fn open_adapter(group: &str) -> Result<TapWin6Adapter, String> {
    if !crate::installer::is_installed() {
        return Err(
            "TAP-Windows6 driver not installed — run `mad doctor --install-l2-driver` or install tap-windows-9.x.x.exe manually".into(),
        );
    }
    let name = format!("mad-{group}");

    // Auto-create on first use.
    if find_adapter_by_name(&name).is_none() {
        create_and_rename_adapter(group)?;
    }
    let instance_id = find_adapter_by_name(&name).ok_or_else(|| {
        format!("created adapter but couldn't find it under '{name}' afterwards")
    })?;

    // Strip braces are NOT stripped — TAP-Windows6 expects the GUID
    // with its braces in the device path.
    let path = format!(r"\\.\Global\{}.tap", instance_id);
    let wide_path = to_wide(&path);

    let device = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_SYSTEM | FILE_FLAG_OVERLAPPED,
            null_mut(),
        )
    };
    if device == INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        return Err(format!(
            "CreateFile({path}) failed: GetLastError={err} (busy? need admin?)"
        ));
    }

    // Tell the driver the cable is plugged in. Without this the
    // adapter shows "Network cable unplugged" and Windows refuses
    // to route traffic through it.
    let media_status: u32 = 1;
    let mut bytes_returned: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            device,
            TAP_WIN_IOCTL_SET_MEDIA_STATUS,
            &media_status as *const _ as *const _,
            size_of::<u32>() as u32,
            &media_status as *const _ as *mut _,
            size_of::<u32>() as u32,
            &mut bytes_returned,
            null_mut(),
        )
    };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        unsafe { CloseHandle(device) };
        return Err(format!(
            "TAP_WIN_IOCTL_SET_MEDIA_STATUS failed: GetLastError={err}"
        ));
    }

    // Prime the read state with an in-flight ReadFile so the pump's
    // first WaitForMultipleObjects has an event to wait on.
    let event = unsafe { create_event() }?;
    let mut read = ReadState {
        overlapped: unsafe { zeroed() },
        event,
        buf: vec![0u8; 65536],
        pending: false,
    };
    if let Err(e) = unsafe { issue_read(device, &mut read) } {
        unsafe {
            CloseHandle(event);
            CloseHandle(device);
        }
        return Err(e);
    }

    Ok(TapWin6Adapter {
        name,
        device,
        read: Mutex::new(read),
        write: Mutex::new(()),
    })
}
