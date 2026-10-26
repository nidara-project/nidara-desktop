# Network1

The Rust session's NetworkManager client and Wi-Fi secret agent (#959). Start with
`nidara-sessiond --network`; it serves `org.nidara.Network` at `/org/nidara/Network`,
interface `org.nidara.Network1`. **Never enable this flag in the daily TypeScript
session**: that shell already registers an agent for the same user's NetworkManager.
The Rust agent identifier is `org.nidara.Session.NetworkAgent`, distinct from TS.
`--network-read-only` exports the snapshot and refuses writes without exporting or
registering a secret agent. Neither flag is enabled by the normal sessiond command.

## Wire contract

The interface grows within v1. `Snapshot() -> (t epoch, t revision, s JSON)` and
`Updated(t epoch, t revision, s JSON)` carry a complete `schemaVersion: 1` document.
Subscribe first, target the unique service owner, then take Snapshot. Reject older
revisions and discard all state on owner replacement; do not replay stale buffered
signals into a new epoch. Identical state does not advance revision. Reconciliation
follows NM signals with a two-second fallback for lost signals and startup ordering.
An NM owner change first clears devices, profiles and activations, withdraws pending
questions, then reads the new owner. Every NM operation pins its unique owner.

JSON includes availability, radio/hardware flags, NM state/connectivity, devices by
object path (type, interface, state/reason, autoconnect, active connection, IP/DNS),
Wi-Fi APs (raw SSID bytes plus display label, strength, frequency, BSSID, security
flags and `needsEnterprise`), saved profiles by UUID (including hidden and VPN),
and activations. It contains no connection settings or secret values. The strongest
AP for a given SSID and the preferred adapter are client presentation choices; the
service exposes all devices and APs. SSID bytes preserve non-UTF-8 identities.

| Method | Input | Output / meaning |
|---|---|---|
| SetWifiEnabled | `b enabled` | NM radio property |
| Scan | `o device` | RequestScan, including its errors |
| Connect | `o device, o AP, s UUID` | `o active`; empty UUID finds a compatible saved profile or completes one from the AP |
| ConnectProfile | `o device, o AP, a{sa{sv}} settings` | `o active`; explicitly configured Wi-Fi profile, including existing TS enterprise/hidden flows |
| Activate | `s UUID, o device` | `o active`; saved hidden/Wi-Fi/wired/VPN/WireGuard; `/` lets NM pick the device |
| Deactivate | `o active` | NM DeactivateConnection |
| Disconnect | `o device` | NM Disconnect; allowed while Connect is pending |
| Forget | `s UUID` | Delete that saved profile |
| SetWiredEnabled | `o device, b enabled` | Persist/restore autoconnect, NM user mark, unblock device, activate with carrier |
| GetIp | `s UUID` | `s form JSON`; empty UUID returns the defaults for a new profile |
| ApplyIp | `s UUID, o device, s form JSON` | Update existing profile or create Ethernet profile if UUID empty; `/` means no live device |
| Renew | `o device` | Reactivate the device's current profile |
| RegisterSecretsUi | none | Reserve the renderer slot for the calling unique sender |
| SubmitSecrets | `t id, a{sa{sv}} values` | Answer the pending question from that renderer |
| CancelSecrets | `t id` | Explicit user cancellation from that renderer |
| TakeUserCancel | `s UUID` | `b`; consume the last explicit cancellation once, within 30 seconds |

Connect/ConnectProfile/Activate answer after NM reports ACTIVATED, not merely after
accepting the activation request. Failed newly created connections are deleted;
failed saved profiles remain. An explicit secret cancellation becomes `Cancelled`.
Without a supplied/saved profile, hidden/enterprise connections answer `NeedsProfile`;
the service never invents EAP credentials. ConnectProfile is the transport for a
profile supplied by the renderer, not a new editor or a new authentication policy.
Other errors include `Unavailable`, `Invalid`, `Denied`, `Failed`, and NM's own
D-Bus failures. No operation invokes nmcli or puts credentials in process arguments.

The IP form has `v4`/`v6` objects (`method`, `address`, `prefix`, `gateway`) and
`dns`/`search` strings. IPv4 accepts a prefix or contiguous dotted mask. Methods,
addresses and DNS are validated before writing. Manual edits keep further existing
addresses and unrelated settings; automatic mode clears manual address/gateway.
Custom DNS replaces automatic DNS. Update is followed by Reapply only for the same
active profile; a refused Reapply reactivates it. A failed application remains a
reported error even if saving the profile succeeded.

## Secret lifecycle

Only NM's current unique **system-bus** owner may Get/Save/Delete/Cancel secrets.
The scope matches TS: `802-11-wireless-security` and `802-1x`; no VPN plugin agent.
There is one pending request and one session-bus renderer. A second live renderer
is refused and its PID is logged, without request or secret data. A vanished
renderer releases the slot and cancels its question. This prevents accidental
replacement, not malicious code running as the same user.

`SecretsRequested(t id, s metadata JSON)` and `SecretsClosed(t id, s reason)` are
unicast to that renderer. Metadata is an allowlist of non-secret connection fields,
SSID, setting, hints and retry status; the full NM request can contain system-owned
secrets and must never be serialized. Replies accept only secret keys and types for
the requested setting. IDs cannot answer a different request, or a request already
closed. NM cancellation, owner change, renderer loss and the 120-second deadline
withdraw the question. Only explicit UI cancellation creates a cancellation record.

Secret Service writes the existing NM attributes `connection-uuid`, `setting-name`,
`setting-key` and `xdg:schema=org.freedesktop.NetworkManager.Connection`, matching
libsecret's stored attributes so CreateItem(replace=true) replaces its item rather
than creating a duplicate. Search/delete omit the schema constraint, like TS's
DONT_MATCH_NAME, to keep older entries without it readable and removable. If multiple
items share a setting-key, lookup selects the greatest Item.Modified value, with
object path as a stable tie-breaker, independent of hash iteration order.

Only agent-owned string secrets are saved; `not-saved` values are not persisted.
Keyring unlock/creation prompts use Secret Service's own prompt protocol. Save,
lookup and delete use one ordered chain per UUID; different UUIDs are independent.
GetSecrets queues its save before replying to NM. Failed new-profile cleanup deletes
its keyring entries after that save, so a delayed save cannot resurrect an orphan.
Store work after UI submission remains asynchronous and a failure logs a generic
message. No key is stored in sessiond's JSON or notification cache. Keyring calls
never fall back to a file.

## Validation

`cargo test --manifest-path session/Cargo.toml --locked` includes the private-bus
integration in `scripts/ci/sessiond-network-test.py`, using the existing Python/Gio
and dbus-daemon dependencies. NM and Secret Service are separate peer connections;
all mutations and registrations go to those peers. The test includes the real
120-second unanswered-request timeout. No new CI job or step is needed.

Nested check: `scripts/dev/rust-session.sh --network COMMAND...`, with a **private**
`DBUS_SYSTEM_BUS_ADDRESS` and the fake peer started inside the nested session bus.
Build this checkout's release sessiond first. Use isolated XDG state, terminate the
nested compositor, and check its private runtime for surviving processes afterward.
The runner's normal invocation has no `--network`. Never register the Rust agent or
change the host's radio, profiles, connections or keyring without the owner's direct
permission. For host interface comparison, at most run `--network-read-only` on a
private session bus; it only reads the real NM and never claims an agent path there.

Wire references: NetworkManager's installed `/usr/share/dbus-1/interfaces` XML and
[API reference](https://www.networkmanager.dev/docs/api/latest/), plus the
[Secret Service specification](https://specifications.freedesktop.org/secret-service/latest/).
