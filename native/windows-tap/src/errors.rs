//! Per-adapter last-error string, queryable via the C ABI. We key by
//! handle so an FFI caller can correlate failures, with handle=0
//! reserved for "global" errors (the ones that happen during
//! `mad_open` before a handle exists) and for the most recent error
//! on any thread.
//!
//! Global Mutex rather than thread_local because pump threads set
//! errors that the JS thread later reads via `mad_last_error`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static ERRORS: LazyLock<Mutex<HashMap<u64, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn set_last_error(handle: u64, msg: String) {
    let mut map = ERRORS.lock().unwrap();
    // Also mirror to the global slot so callers that don't know the
    // handle (e.g. during mad_open) can still surface the message.
    map.insert(0, msg.clone());
    if handle != 0 {
        map.insert(handle, msg);
    }
}

pub fn clear_error(handle: u64) {
    let mut map = ERRORS.lock().unwrap();
    map.remove(&handle);
}

pub fn with_last_error<R>(handle: u64, f: impl FnOnce(&str) -> R) -> R {
    let map = ERRORS.lock().unwrap();
    let msg = map.get(&handle).map(String::as_str).unwrap_or("");
    f(msg)
}
