//! Local Windows pipe I/O with one deadline covering connection, write and read.
use std::{
    fs::File,
    io::{self, Read, Write},
    time::{Duration, Instant},
};
#[cfg(windows)]
use std::{
    fs::OpenOptions,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    ptr,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_IO_PENDING},
    Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED},
    System::{
        Threading::CreateEventW,
        IO::{CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED},
    },
};

pub struct DeadlinePipe {
    file: File,
    deadline: Instant,
}

impl DeadlinePipe {
    pub fn connect(path: &str, timeout: Duration) -> io::Result<Self> {
        let deadline = Instant::now() + timeout;
        loop {
            #[cfg(windows)]
            let result = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(FILE_FLAG_OVERLAPPED)
                .open(path);
            #[cfg(not(windows))]
            let result = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path);
            match result {
                Ok(file) => return Ok(Self { file, deadline }),
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                Err(error) => return Err(error),
            }
        }
    }

    #[cfg(windows)]
    fn transfer(&self, buffer: *mut u8, length: usize, write: bool) -> io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "mpv IPC 请求超时"))?;
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        let handle = self.file.as_raw_handle();
        let mut transferred = 0;
        let started = unsafe {
            if write {
                WriteFile(
                    handle,
                    buffer,
                    length.min(u32::MAX as usize) as u32,
                    &mut transferred,
                    &mut overlapped,
                )
            } else {
                ReadFile(
                    handle,
                    buffer,
                    length.min(u32::MAX as usize) as u32,
                    &mut transferred,
                    &mut overlapped,
                )
            }
        };
        let result = if started != 0 {
            Ok(transferred as usize)
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                Err(error)
            } else {
                let done = unsafe {
                    GetOverlappedResultEx(
                        handle,
                        &overlapped,
                        &mut transferred,
                        remaining.as_millis().clamp(1, u32::MAX as u128 - 1) as u32,
                        0,
                    )
                };
                if done != 0 {
                    Ok(transferred as usize)
                } else {
                    let error = io::Error::last_os_error();
                    // OVERLAPPED and its buffer must remain alive until cancellation completes.
                    unsafe {
                        CancelIoEx(handle, &overlapped);
                        GetOverlappedResult(handle, &overlapped, &mut transferred, 1);
                    }
                    if Instant::now() >= self.deadline {
                        Err(io::Error::new(io::ErrorKind::TimedOut, "mpv IPC 请求超时"))
                    } else {
                        Err(error)
                    }
                }
            }
        };
        unsafe {
            CloseHandle(event);
        }
        result
    }
}

impl Read for DeadlinePipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        #[cfg(windows)]
        {
            self.transfer(buffer.as_mut_ptr(), buffer.len(), false)
        }
        #[cfg(not(windows))]
        {
            self.file.read(buffer)
        }
    }
}
impl Write for DeadlinePipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        #[cfg(windows)]
        {
            self.transfer(buffer.as_ptr() as *mut u8, buffer.len(), true)
        }
        #[cfg(not(windows))]
        {
            self.file.write(buffer)
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::Pipes::{ConnectNamedPipe, CreateNamedPipeW},
    };

    #[test]
    fn silent_local_peer_times_out_and_cancels_pending_read() {
        let path = format!(r"\\.\pipe\king-audit-timeout-{}", std::process::id());
        let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let handle =
            unsafe { CreateNamedPipeW(wide.as_ptr(), 3, 0, 1, 4096, 4096, 0, std::ptr::null()) };
        assert!(handle != INVALID_HANDLE_VALUE);
        let mut server = unsafe { File::from_raw_handle(handle) };
        let peer = std::thread::spawn(move || {
            unsafe {
                ConnectNamedPipe(server.as_raw_handle(), std::ptr::null_mut());
            }
            let mut bytes = [0; 16];
            let _ = server.read(&mut bytes);
            std::thread::sleep(Duration::from_millis(600));
        });
        let start = Instant::now();
        let mut client = DeadlinePipe::connect(&path, Duration::from_millis(150)).unwrap();
        client.write_all(b"request\n").unwrap();
        let error = client.read(&mut [0; 16]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_millis(500));
        peer.join().unwrap();
    }
}
