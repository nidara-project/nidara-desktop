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
