//! Backend-agnostic frame pump.
//!
//! Spawns ssh as a child process, then runs three threads:
//!   1. tap-to-ssh: wait on (backend recv-event | stop-event), drain
//!      via backend.try_recv, write length-prefixed to ssh.stdin.
//!   2. ssh-to-tap: read 2-byte BE length + payload from ssh.stdout,
//!      backend.send each frame.
//!   3. stderr-scanner: line-buffered reader on ssh.stderr, passes
//!      every line through to our stderr and notifies the handshake
//!      condvar when MAD_TUN_OK shows up.
//!
//! Stopping: set the AtomicBool, SetEvent on the stop handle (wakes
//! tap-to-ssh), kill the ssh child (closes the pipes → ssh-to-tap and
//! stderr-scanner see EOF). Join all three threads.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE,
};

use crate::backend::Backend;
use crate::errors::set_last_error;

type AdapterId = u64;

#[derive(Clone, Copy)]
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

pub struct HandshakeSync {
    state: Mutex<HandshakeState>,
    cond: Condvar,
}

#[derive(Default)]
struct HandshakeState {
    line: Option<String>,
    eof: bool,
}

impl HandshakeSync {
    pub fn wait(&self, timeout: Duration) -> Option<String> {
        let mut guard = self.state.lock().unwrap();
        loop {
            if let Some(line) = guard.line.clone() {
                return Some(line);
            }
            if guard.eof {
                return None;
            }
            let (g, res) = self.cond.wait_timeout(guard, timeout).unwrap();
            guard = g;
            if res.timed_out() {
                return guard.line.clone();
            }
        }
    }
}

pub struct Pump {
    child: Arc<Mutex<Option<Child>>>,
    threads: Vec<JoinHandle<()>>,
    stop_event: SendHandle,
    stop_flag: Arc<AtomicBool>,
    handshake: Arc<HandshakeSync>,
    stopped: bool,
}

impl Pump {
    pub fn start(
        adapter_id: AdapterId,
        backend: Arc<dyn Backend>,
        ssh_exe: &str,
        ssh_args: &[String],
    ) -> Result<Self, String> {
        let mut cmd = Command::new(ssh_exe);
        cmd.args(ssh_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn ssh: {e}"))?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        // Manual-reset event — used to wake the tap-to-ssh thread out
        // of WaitForMultipleObjects so it can notice the stop flag.
        let stop_event = unsafe {
            let h = CreateEventW(std::ptr::null(), 1, 0, std::ptr::null());
            if h.is_null() {
                return Err("CreateEventW(stop) failed".into());
            }
            SendHandle(h)
        };

        let recv_event = SendHandle(backend.recv_wait_handle()?);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let handshake = Arc::new(HandshakeSync {
            state: Mutex::new(HandshakeState::default()),
            cond: Condvar::new(),
        });
        let child_holder = Arc::new(Mutex::new(Some(child)));

        let mut threads = Vec::with_capacity(3);

        // 1. backend → ssh.stdin
        threads.push({
            let backend = backend.clone();
            let stop_flag = stop_flag.clone();
            thread::Builder::new()
                .name("mad-pump-tx".into())
                .spawn(move || {
                    tap_to_ssh(adapter_id, backend, recv_event, stop_event, stop_flag, stdin);
                })
                .expect("spawn tx thread")
        });

        // 2. ssh.stdout → backend
        threads.push({
            let backend = backend.clone();
            let stop_flag = stop_flag.clone();
            thread::Builder::new()
                .name("mad-pump-rx".into())
                .spawn(move || {
                    ssh_to_tap(adapter_id, backend, stop_flag, stdout);
                })
                .expect("spawn rx thread")
        });

        // 3. stderr scanner
        threads.push({
            let stop_flag = stop_flag.clone();
            let handshake = handshake.clone();
            thread::Builder::new()
                .name("mad-pump-err".into())
                .spawn(move || {
                    stderr_scanner(stop_flag, handshake, stderr);
                })
                .expect("spawn stderr thread")
        });

        Ok(Self {
            child: child_holder,
            threads,
            stop_event,
            stop_flag,
            handshake,
            stopped: false,
        })
    }

    pub fn handshake(&self) -> Arc<HandshakeSync> {
        self.handshake.clone()
    }

    pub fn is_running(&self) -> bool {
        if self.stopped {
            return false;
        }
        let mut child = self.child.lock().unwrap();
        let Some(child) = child.as_mut() else { return false };
        matches!(child.try_wait(), Ok(None))
    }

    /// Idempotent. Sets the stop flag, kills ssh, joins threads.
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;

        self.stop_flag.store(true, Ordering::SeqCst);
        unsafe { SetEvent(self.stop_event.0) };

        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        {
            let mut state = self.handshake.state.lock().unwrap();
            state.eof = true;
            self.handshake.cond.notify_all();
        }

        for h in self.threads.drain(..) {
            let _ = h.join();
        }

        unsafe { CloseHandle(self.stop_event.0) };
    }
}

impl Drop for Pump {
    fn drop(&mut self) {
        self.stop();
    }
}

fn tap_to_ssh(
    adapter_id: AdapterId,
    backend: Arc<dyn Backend>,
    recv_event: SendHandle,
    stop_event: SendHandle,
    stop_flag: Arc<AtomicBool>,
    mut stdin: ChildStdin,
) {
    let mut frame = vec![0u8; 65536];
    let mut hdr = [0u8; 2];
    let handles: [HANDLE; 2] = [recv_event.0, stop_event.0];

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }
        // Drain everything that's ready, only wait when empty.
        loop {
            match backend.try_recv(&mut frame) {
                Ok(Some(len)) => {
                    if len > u16::MAX as usize {
                        eprintln!("mad pump tx: dropping {len}-byte frame (too large for 16-bit length)");
                        continue;
                    }
                    hdr[0] = (len >> 8) as u8;
                    hdr[1] = (len & 0xff) as u8;
                    // Single write so neither header nor body can be split
                    // by any pipe-buffering layer. The flush keeps ssh
                    // from sitting on partial frames under low traffic.
                    let mut out = Vec::with_capacity(2 + len);
                    out.extend_from_slice(&hdr);
                    out.extend_from_slice(&frame[..len]);
                    if let Err(e) = stdin.write_all(&out) {
                        set_last_error(adapter_id, format!("tx: write to ssh.stdin failed: {e}"));
                        return;
                    }
                    let _ = stdin.flush();
                }
                Ok(None) => break,
                Err(e) => {
                    set_last_error(adapter_id, format!("tx: try_recv: {e}"));
                    return;
                }
            }
        }
        let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        let stop_obj = WAIT_OBJECT_0 + 1;
        if wait == stop_obj {
            return;
        }
        if wait != WAIT_OBJECT_0 {
            set_last_error(adapter_id, format!("tx: WaitForMultipleObjects returned {wait}"));
            return;
        }
    }
}

fn ssh_to_tap(
    adapter_id: AdapterId,
    backend: Arc<dyn Backend>,
    stop_flag: Arc<AtomicBool>,
    mut stdout: ChildStdout,
) {
    let mut hdr = [0u8; 2];
    let mut frame = vec![0u8; 65536];

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }
        if let Err(e) = stdout.read_exact(&mut hdr) {
            // EOF is the normal teardown path — ssh died or stop()
            // killed it. Don't noise the error slot for that.
            if e.kind() != std::io::ErrorKind::UnexpectedEof {
                set_last_error(adapter_id, format!("rx: header read: {e}"));
            }
            return;
        }
        let len = ((hdr[0] as usize) << 8) | (hdr[1] as usize);
        if len == 0 || len > frame.len() {
            set_last_error(adapter_id, format!("rx: bad frame length {len}"));
            return;
        }
        if let Err(e) = stdout.read_exact(&mut frame[..len]) {
            set_last_error(adapter_id, format!("rx: body read: {e}"));
            return;
        }
        match backend.send(&frame[..len]) {
            Ok(true) => {}
            Ok(false) => {
                // Send ring full — drop the frame; TCP will retransmit.
                // Matches the Linux tap queue's drop-on-overflow under load.
            }
            Err(e) => {
                set_last_error(adapter_id, format!("rx: send: {e}"));
                return;
            }
        }
    }
}

fn stderr_scanner(
    _stop_flag: Arc<AtomicBool>,
    handshake: Arc<HandshakeSync>,
    stderr: ChildStderr,
) {
    let mut reader = BufReader::new(stderr);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => {
                let mut state = handshake.state.lock().unwrap();
                state.eof = true;
                handshake.cond.notify_all();
                return;
            }
            Ok(_) => {
                let _ = std::io::stderr().write_all(buf.as_bytes());
                if buf.contains("MAD_TUN_OK") {
                    let trimmed = buf.trim_end_matches(['\r', '\n']).to_string();
                    let mut state = handshake.state.lock().unwrap();
                    if state.line.is_none() {
                        state.line = Some(trimmed);
                        handshake.cond.notify_all();
                    }
                }
            }
            Err(_) => {
                let mut state = handshake.state.lock().unwrap();
                state.eof = true;
                handshake.cond.notify_all();
                return;
            }
        }
    }
}
