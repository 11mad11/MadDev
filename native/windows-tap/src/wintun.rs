//! Wintun (L3) backend.
//!
//! Loads wintun.dll at runtime — we don't link wintun.lib at build
//! time. The shipped wintun.dll is extracted by mad's bun startup
//! code and we LoadLibraryW it from there. Wintun C API reference:
//! https://www.wintun.net/builds/wintun.zip

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{FARPROC, HANDLE, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

use crate::backend::Backend;

// Opaque wintun handles.
type WintunAdapterHandle = *mut std::ffi::c_void;
type WintunSessionHandle = *mut std::ffi::c_void;

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

type FnCreateAdapter = unsafe extern "system" fn(
    name: *const u16,
    tunnel_type: *const u16,
    requested_guid: *const Guid,
) -> WintunAdapterHandle;
type FnOpenAdapter = unsafe extern "system" fn(name: *const u16) -> WintunAdapterHandle;
type FnCloseAdapter = unsafe extern "system" fn(adapter: WintunAdapterHandle);
type FnStartSession = unsafe extern "system" fn(
    adapter: WintunAdapterHandle,
    capacity: u32,
) -> WintunSessionHandle;
type FnEndSession = unsafe extern "system" fn(session: WintunSessionHandle);
type FnGetRunningDriverVersion = unsafe extern "system" fn() -> u32;
type FnGetReadWaitEvent = unsafe extern "system" fn(session: WintunSessionHandle) -> HANDLE;
type FnReceivePacket = unsafe extern "system" fn(
    session: WintunSessionHandle,
    packet_size: *mut u32,
) -> *mut u8;
type FnReleaseReceivePacket =
    unsafe extern "system" fn(session: WintunSessionHandle, packet: *const u8);
type FnAllocateSendPacket =
    unsafe extern "system" fn(session: WintunSessionHandle, packet_size: u32) -> *mut u8;
type FnSendPacket = unsafe extern "system" fn(session: WintunSessionHandle, packet: *const u8);

struct WintunApi {
    _module: HMODULE,
    create_adapter: FnCreateAdapter,
    open_adapter_by_name: FnOpenAdapter,
    close_adapter: FnCloseAdapter,
    start_session: FnStartSession,
    end_session: FnEndSession,
    get_running_driver_version: FnGetRunningDriverVersion,
    get_read_wait_event: FnGetReadWaitEvent,
    receive_packet: FnReceivePacket,
    release_receive_packet: FnReleaseReceivePacket,
    allocate_send_packet: FnAllocateSendPacket,
    send_packet: FnSendPacket,
}

unsafe impl Send for WintunApi {}
unsafe impl Sync for WintunApi {}

static API: OnceLock<WintunApi> = OnceLock::new();

pub fn ensure_loaded() -> Result<(), String> {
    if API.get().is_some() {
        return Ok(());
    }
    let api = unsafe { load_api() }?;
    let _ = API.set(api);
    Ok(())
}

fn api() -> Result<&'static WintunApi, String> {
    API.get().ok_or_else(|| "wintun not loaded".to_string())
}

unsafe fn load_api() -> Result<WintunApi, String> {
    let wide = to_wide("wintun.dll");
    let module = LoadLibraryW(wide.as_ptr());
    if module.is_null() {
        return Err("LoadLibraryW(wintun.dll) failed — is the DLL on the search path?".into());
    }
    Ok(WintunApi {
        _module: module,
        create_adapter: transmute_proc(resolve(module, b"WintunCreateAdapter\0")?),
        open_adapter_by_name: transmute_proc(resolve(module, b"WintunOpenAdapter\0")?),
        close_adapter: transmute_proc(resolve(module, b"WintunCloseAdapter\0")?),
        start_session: transmute_proc(resolve(module, b"WintunStartSession\0")?),
        end_session: transmute_proc(resolve(module, b"WintunEndSession\0")?),
        get_running_driver_version: transmute_proc(resolve(
            module,
            b"WintunGetRunningDriverVersion\0",
        )?),
        get_read_wait_event: transmute_proc(resolve(module, b"WintunGetReadWaitEvent\0")?),
        receive_packet: transmute_proc(resolve(module, b"WintunReceivePacket\0")?),
        release_receive_packet: transmute_proc(resolve(module, b"WintunReleaseReceivePacket\0")?),
        allocate_send_packet: transmute_proc(resolve(module, b"WintunAllocateSendPacket\0")?),
        send_packet: transmute_proc(resolve(module, b"WintunSendPacket\0")?),
    })
}

unsafe fn resolve(module: HMODULE, name_nul: &[u8]) -> Result<FARPROC, String> {
    let ptr = GetProcAddress(module, name_nul.as_ptr());
    if ptr.is_none() {
        let name = std::str::from_utf8(&name_nul[..name_nul.len() - 1]).unwrap_or("?");
        return Err(format!("GetProcAddress({name}) returned null"));
    }
    Ok(ptr)
}

unsafe fn transmute_proc<T: Copy>(proc: FARPROC) -> T {
    debug_assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<FARPROC>());
    std::mem::transmute_copy::<FARPROC, T>(&proc)
}

pub fn driver_version() -> u32 {
    let Ok(api) = api() else { return 0 };
    unsafe { (api.get_running_driver_version)() }
}

/// L3 backend implementation. Drop closes the session and adapter
/// (in that order, per wintun's lifecycle docs).
pub struct WintunAdapter {
    name: String,
    adapter: WintunAdapterHandle,
    session: WintunSessionHandle,
}

unsafe impl Send for WintunAdapter {}
unsafe impl Sync for WintunAdapter {}

impl Drop for WintunAdapter {
    fn drop(&mut self) {
        let Some(api) = API.get() else { return };
        unsafe {
            if !self.session.is_null() {
                (api.end_session)(self.session);
            }
            if !self.adapter.is_null() {
                (api.close_adapter)(self.adapter);
            }
        }
    }
}

impl Backend for WintunAdapter {
    fn try_recv(&self, buf: &mut [u8]) -> Result<Option<usize>, String> {
        let api = api()?;
        let mut size: u32 = 0;
        let ptr = unsafe { (api.receive_packet)(self.session, &mut size) };
        if ptr.is_null() {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            const ERROR_NO_MORE_ITEMS: u32 = 259;
            if err == ERROR_NO_MORE_ITEMS {
                return Ok(None);
            }
            return Err(format!("WintunReceivePacket failed: GetLastError={err}"));
        }
        let len = size as usize;
        if len > buf.len() {
            unsafe { (api.release_receive_packet)(self.session, ptr) };
            return Err(format!("recv buf too small: frame={len}, buf={}", buf.len()));
        }
        unsafe {
            std::ptr::copy_nonoverlapping(ptr, buf.as_mut_ptr(), len);
            (api.release_receive_packet)(self.session, ptr);
        }
        Ok(Some(len))
    }

    fn send(&self, frame: &[u8]) -> Result<bool, String> {
        let api = api()?;
        let len = frame.len();
        if len == 0 || len > u32::MAX as usize {
            return Err(format!("send: invalid len {len}"));
        }
        let dst = unsafe { (api.allocate_send_packet)(self.session, len as u32) };
        if dst.is_null() {
            let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            const ERROR_BUFFER_OVERFLOW: u32 = 111;
            if err == ERROR_BUFFER_OVERFLOW {
                return Ok(false);
            }
            return Err(format!("WintunAllocateSendPacket failed: GetLastError={err}"));
        }
        unsafe {
            std::ptr::copy_nonoverlapping(frame.as_ptr(), dst, len);
            (api.send_packet)(self.session, dst);
        }
        Ok(true)
    }

    fn recv_wait_handle(&self) -> Result<HANDLE, String> {
        let api = api()?;
        Ok(unsafe { (api.get_read_wait_event)(self.session) })
    }

    fn adapter_name(&self) -> &str {
        &self.name
    }
}

pub fn open_adapter(group: &str) -> Result<WintunAdapter, String> {
    ensure_loaded()?;
    let api = api()?;

    let name = format!("mad-{group}");
    let adapter_name = to_wide(&name);
    let tunnel_type = to_wide("mad");

    let adapter = unsafe {
        (api.create_adapter)(adapter_name.as_ptr(), tunnel_type.as_ptr(), std::ptr::null())
    };
    if adapter.is_null() {
        return Err(format!(
            "WintunCreateAdapter({name}) failed — GetLastError={}",
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        ));
    }

    // 2 MiB ring buffer (power of two between 128 KiB and 64 MiB —
    // wintun's own example default).
    const CAPACITY: u32 = 0x20_0000;
    let session = unsafe { (api.start_session)(adapter, CAPACITY) };
    if session.is_null() {
        unsafe { (api.close_adapter)(adapter) };
        return Err(format!(
            "WintunStartSession failed — GetLastError={}",
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        ));
    }

    Ok(WintunAdapter { name, adapter, session })
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Open an existing adapter by name and immediately close it, which
/// deletes it. Used by the stale-adapter sweep at startup — if a
/// prior mad.exe crashed without cleaning up its `mad-<group>`
/// adapter, this reclaims it. Returns `Ok(true)` if an adapter was
/// found and deleted, `Ok(false)` if no such adapter exists.
pub fn delete_adapter_if_present(name: &str) -> Result<bool, String> {
    ensure_loaded()?;
    let api = api()?;
    let wide = to_wide(name);
    let h = unsafe { (api.open_adapter_by_name)(wide.as_ptr()) };
    if h.is_null() {
        return Ok(false);
    }
    unsafe { (api.close_adapter)(h) };
    Ok(true)
}
