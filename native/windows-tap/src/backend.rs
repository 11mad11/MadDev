//! Backend-agnostic interface for the frame pump. Implementations:
//!   - wintun.rs           (L3, layer-3 IP packets)
//!   - tap_win6.rs         (L2, full Ethernet — phase 3 stub)
//!
//! The trait keeps copying simple: callers own the receive buffer
//! and the backend copies into it. We pay one extra memcpy per
//! frame compared to wintun's zero-copy borrow, but it makes both
//! backends pluggable behind the same pump and the copy hits L1
//! cache anyway since the next thing we do is write the bytes to
//! ssh.stdin.

use windows_sys::Win32::Foundation::HANDLE;

pub trait Backend: Send + Sync {
    /// Non-blocking receive. Copies one frame into `buf` and returns
    /// its length. `Ok(None)` means the ring is empty — caller should
    /// wait on `recv_wait_handle()`. `Err` is a fatal-for-this-pump
    /// error.
    fn try_recv(&self, buf: &mut [u8]) -> Result<Option<usize>, String>;

    /// Send a frame to the adapter. `Ok(false)` means the send ring
    /// is full (caller should drop and continue — TCP will catch up).
    fn send(&self, frame: &[u8]) -> Result<bool, String>;

    /// A Win32 HANDLE that's signaled whenever the next `try_recv`
    /// might return `Some(_)`. Used in the pump's
    /// `WaitForMultipleObjects` so we don't busy-poll.
    fn recv_wait_handle(&self) -> Result<HANDLE, String>;

    /// Human-readable adapter name (used in error messages and the
    /// Windows Network Connections panel). Format: `mad-<group>`.
    fn adapter_name(&self) -> &str;
}
