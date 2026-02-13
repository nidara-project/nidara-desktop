# AGS Utilities Guide

## File Functions
```tsx
import { readFile, readFileAsync, writeFile, writeFileAsync, monitorFile } from "ags/file"
```
- `readFile(path)`: Sync read.
- `readFileAsync(path)`: Async read (Promise).
- `writeFile(path, content)`: Sync write.
- `monitorFile(path, callback)`: Monitor for changes (recursive if directory).

## Timeouts and Intervals
```tsx
import { timeout, interval, idle } from "ags/time"
```
- `interval(ms, cb)`: Immediate execute + every `ms`. Returns a `Timer`.
- `timeout(ms, cb)`: Execute once after `ms`.
- `idle(cb)`: Execute when no higher priority events.
- **Timer Methods**: `.connect("now", cb)`, `.cancel()`.

## Process Functions
```tsx
import { exec, execAsync, subprocess } from "ags/process"
```
- `execAsync(cmd)`: Preferred for non-blocking execution.
- `subprocess(cmd, onOut, onErr)`: Full control over stdout/stderr signals.
- **Note**: These do NOT run in a shell by default (no `$HOME` or `&&`). Use `bash -c '...'` for shell features.

## createPoll & createSubprocess
- `createPoll(init, ms, cmdOrFn)`: Create an Accessor that polls.
- `createSubprocess(init, cmd)`: Start process on first subscriber, kill on last.
```tsx
const cpu = createPoll("0", 1000, "top -bn1 | grep 'Cpu(s)'")
const log = createSubprocess("", "journalctl -f")
```
