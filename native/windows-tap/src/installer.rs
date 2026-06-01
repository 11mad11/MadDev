//! TAP-Windows6 driver lifecycle. The driver is a kernel component,
//! installed once per machine via a signed installer that ships from
//! the OpenVPN project. mad doesn't bundle the installer (3 MB is a
//! lot of dead weight if you only ever use L3); instead, the JS-side
//! `mad doctor --install-l2-driver` command downloads it to %TEMP%
//! and calls into this module to run it elevated.
//!
//! Driver-presence detection: check
//! `HKLM\SYSTEM\CurrentControlSet\Services\tap0901`. The installer
//! creates that key, the uninstaller removes it.

use std::ffi::OsStr;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, GetLastError, WAIT_OBJECT_0};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
};
use windows_sys::Win32::System::Threading::WaitForSingleObject;
use windows_sys::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const TAP_SERVICE_KEY: &str = r"SYSTEM\CurrentControlSet\Services\tap0901";

pub fn is_installed() -> bool {
    let wide: Vec<u16> = OsStr::new(TAP_SERVICE_KEY)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide.as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if rc == ERROR_SUCCESS {
        unsafe { RegCloseKey(hkey) };
        true
    } else {
        false
    }
}

/// Spawn the bundled (or downloaded) TAP-Windows6 installer with
/// elevation (UAC prompts). Blocks until the installer process
/// exits.
///
/// Returns the installer's exit code on success (0 = success per
/// most installers' conventions), or a string error if we couldn't
/// even launch it (user declined UAC → ERROR_CANCELLED, missing
/// file, etc.).
pub fn run_installer(installer_path: &str) -> Result<i32, String> {
    // Pass `/S` for silent mode — tap-windows-9.x.x.exe is an NSIS
    // installer that supports it. Even silent it still requires
    // UAC (driver install is a system change).
    let exe_wide: Vec<u16> = OsStr::new(installer_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb_wide: Vec<u16> = OsStr::new("runas").encode_wide().chain(std::iter::once(0)).collect();
    let args_wide: Vec<u16> = OsStr::new("/S").encode_wide().chain(std::iter::once(0)).collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { zeroed() };
    info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.hwnd = null_mut();
    info.lpVerb = verb_wide.as_ptr();
    info.lpFile = exe_wide.as_ptr();
    info.lpParameters = args_wide.as_ptr();
    info.lpDirectory = std::ptr::null();
    info.nShow = SW_SHOWNORMAL as _;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        // ERROR_CANCELLED (1223) = user declined UAC.
        if err == 1223 {
            return Err("UAC prompt declined — installer not run".into());
        }
        return Err(format!("ShellExecuteExW failed: GetLastError={err}"));
    }
    if info.hProcess.is_null() {
        // Installer ran but didn't return a process handle (some apps
        // skip the handle for child-spawned helpers). Best-effort
        // return 0 since we have no way to wait.
        return Ok(0);
    }

    // Wait for the installer process to exit (up to 10 min).
    const TEN_MINUTES_MS: u32 = 10 * 60 * 1000;
    let wait = unsafe { WaitForSingleObject(info.hProcess, TEN_MINUTES_MS) };
    if wait != WAIT_OBJECT_0 {
        unsafe { CloseHandle(info.hProcess) };
        return Err(format!("installer wait returned {wait}"));
    }
    let mut exit: u32 = 0;
    let ok2 = unsafe {
        windows_sys::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut exit)
    };
    unsafe { CloseHandle(info.hProcess) };
    if ok2 == 0 {
        return Err(format!(
            "GetExitCodeProcess failed: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(exit as i32)
}
