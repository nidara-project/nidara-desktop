//! The virtual terminals: which one is shown.

const VT_ACTIVATE: libc::c_ulong = 0x5606;
const VT_WAITACTIVE: libc::c_ulong = 0x5607;

/// Brings VT `n` to the front and waits until it is.
pub fn activate(n: u32) -> std::io::Result<()> {
    let fd = unsafe {
        libc::open(
            c"/dev/tty0".as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let rc = unsafe { libc::ioctl(fd, VT_ACTIVATE, n as libc::c_ulong) };
    let rc = if rc == 0 {
        unsafe { libc::ioctl(fd, VT_WAITACTIVE, n as libc::c_ulong) }
    } else {
        rc
    };
    let err = std::io::Error::last_os_error();
    unsafe { libc::close(fd) };
    if rc < 0 { Err(err) } else { Ok(()) }
}

const VT_OPENQRY: libc::c_ulong = 0x5600;

/// The first VT nobody has open, for a second login screen while a session holds the first
/// (#1195 D8: switching user).
pub fn free() -> std::io::Result<u32> {
    let fd = unsafe {
        libc::open(
            c"/dev/tty0".as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut n: libc::c_int = -1;
    let rc = unsafe { libc::ioctl(fd, VT_OPENQRY, &mut n as *mut libc::c_int) };
    let err = std::io::Error::last_os_error();
    unsafe { libc::close(fd) };
    match rc {
        _ if rc < 0 => Err(err),
        _ if n < 1 => Err(std::io::Error::other("every VT is in use")),
        _ => Ok(n as u32),
    }
}
