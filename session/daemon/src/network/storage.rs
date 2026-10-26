// SPDX-License-Identifier: GPL-3.0-or-later
//! Secret storage and profile access are independent. Cross-service migration is
//! destination-first. NM flags drive idempotent reconciliation; no recovery store.
use super::{
    Error, Settings,
    agent::Agent,
    keyring,
    nm::{self, Nm, Props, number, owned, text},
};
use serde_json::{Value as Json, json};

use zbus::zvariant::{OwnedObjectPath as Path, OwnedValue};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    System,
    User,
    Ask,
    Optional,
}
impl Mode {
    pub fn parse(value: &str) -> Result<Self, Error> {
        match value {
            "user" => Ok(Self::User),
            "system" => Ok(Self::System),
            "ask" => Ok(Self::Ask),
            _ => Err(Error::Invalid("storage must be user, system or ask".into())),
        }
    }
    pub fn flags(self) -> u32 {
        match self {
            Self::System => 0,
            Self::User => 1,
            Self::Ask => 2,
            Self::Optional => 4,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Ask => "ask",
            Self::Optional => "not-required",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub setting: String,
    pub key: String,
}
impl Key {
    pub fn flag(&self) -> String {
        if self.key.starts_with("wep-key") {
            "wep-key-flags".into()
        } else {
            format!("{}-flags", self.key)
        }
    }
    pub fn mode(&self, s: &Settings) -> Result<Mode, Error> {
        match number(s.get(&self.setting), &self.flag()) {
            0 => Ok(Mode::System),
            1 => Ok(Mode::User),
            2 => Ok(Mode::Ask),
            4 if self.setting == "802-1x" => Ok(Mode::Optional),
            _ => Err(Error::Invalid("unsupported secret storage flags".into())),
        }
    }
    pub fn label(&self) -> String {
        format!("{}.{}", self.setting, self.key)
    }
}
/// Relevant fields, including explicit optional EAP flags and binary passwords.
pub fn keys(s: &Settings) -> Vec<Key> {
    let mut out = Vec::new();
    if let Some(sec) = s.get("802-11-wireless-security") {
        let kind = text(Some(sec), "key-mgmt");
        let names: Vec<String> = match kind.as_str() {
            "wpa-psk" | "sae" => vec!["psk".into()],
            "none" => (0..4).map(|i| format!("wep-key{i}")).collect(),
            _ => Vec::new(),
        };
        out.extend(names.into_iter().map(|key| Key {
            setting: "802-11-wireless-security".into(),
            key,
        }));
        if text(Some(sec), "auth-alg") == "leap" {
            out.push(Key {
                setting: "802-11-wireless-security".into(),
                key: "leap-password".into(),
            });
        }
    }
    if let Some(eap) = s.get("802-1x") {
        let methods: Vec<String> = eap
            .get("eap")
            .and_then(|v| Vec::try_from(v.try_clone().ok()?).ok())
            .unwrap_or_default();
        for key in [
            "password",
            "password-raw",
            "private-key-password",
            "phase2-private-key-password",
            "pin",
        ] {
            let explicit = eap.contains_key(key) || eap.contains_key(&format!("{key}-flags"));
            if explicit
                || key == "password"
                    && methods.iter().any(|m| {
                        matches!(
                            m.as_str(),
                            "peap" | "ttls" | "pwd" | "leap" | "md5" | "fast"
                        )
                    })
            {
                out.push(Key {
                    setting: "802-1x".into(),
                    key: key.into(),
                });
            }
        }
    }
    out.sort_by_key(Key::label);
    out.dedup();
    out
}
pub fn validate(s: &Settings) -> Result<(), Error> {
    if text(s.get("connection"), "type") != "802-11-wireless" {
        return Err(Error::Invalid(
            "secret storage supports Wi-Fi profiles".into(),
        ));
    }
    for (setting, p) in s {
        if !super::agent::supported(setting) {
            continue;
        }
        for (key, value) in p {
            if key.ends_with("-flags") {
                let n = u32::try_from(value)
                    .map_err(|_| Error::Invalid("secret flags must be uint32".into()))?;
                if !matches!(n, 0..=2)
                    && !(n == 4
                        && setting == "802-1x"
                        && super::agent::secret_key(setting, key.trim_end_matches("-flags")))
                {
                    return Err(Error::Invalid("unsupported secret storage flags".into()));
                }
            }
        }
    }
    Ok(())
}
pub fn permissions(s: &mut Settings, all_users: bool) -> Result<(), Error> {
    let login = glib::user_name()
        .into_string()
        .map_err(|_| Error::Invalid("login is not UTF-8".into()))?;
    if login.is_empty() || login.contains(':') {
        return Err(Error::Invalid(
            "invalid login for profile permissions".into(),
        ));
    }
    let acl = if all_users {
        Vec::<String>::new()
    } else {
        vec![format!("user:{login}:")]
    };
    s.entry("connection".into())
        .or_default()
        .insert("permissions".into(), owned(acl));
    Ok(())
}
pub fn metadata(s: &Settings) -> Json {
    let permissions: Vec<String> = s
        .get("connection")
        .and_then(|p| p.get("permissions"))
        .and_then(|v| Vec::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default();
    let mut secret_storage = serde_json::Map::new();
    for key in keys(s) {
        let flags = number(s.get(&key.setting), &key.flag());
        let mode = key.mode(s).map(|m| m.name()).unwrap_or("unsupported");
        secret_storage.insert(key.label(), json!({"mode":mode,"flags":flags}));
    }
    json!({"secretStorage":secret_storage,"permissions":permissions,"allUsers":permissions.is_empty()})
}
pub fn set_mode(s: &mut Settings, mode: Mode) {
    for key in keys(s) {
        if key.mode(s).ok() == Some(Mode::Optional) {
            continue;
        }
        s.entry(key.setting.clone())
            .or_default()
            .insert(key.flag(), mode.flags().into());
    }
}
pub fn strip_secrets(s: &mut Settings) {
    for (setting, p) in s {
        p.retain(|key, _| !super::agent::secret_key(setting, key));
    }
}
pub fn allowed_user_key(s: &Settings, setting: &str, key: &str) -> bool {
    Key {
        setting: setting.into(),
        key: key.into(),
    }
    .mode(s)
    .ok()
        == Some(Mode::User)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Credential {
    Text(String),
    Bytes(Vec<u8>),
}
impl Credential {
    pub fn read(value: &OwnedValue) -> Option<Self> {
        if let Ok(s) = <&str>::try_from(value) {
            Some(Self::Text(s.into()))
        } else {
            Vec::<u8>::try_from(value.try_clone().ok()?)
                .ok()
                .map(Self::Bytes)
        }
    }
    pub fn value(&self) -> OwnedValue {
        match self {
            Self::Text(s) => owned(s.as_str()),
            Self::Bytes(b) => owned(b.clone()),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub key: Key,
    pub value: Credential,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Secrets {
    pub records: Vec<Record>,
}
impl Secrets {
    pub fn empty() -> Self {
        Self {
            records: Vec::new(),
        }
    }
    pub fn get(&self, key: &Key) -> Option<&Credential> {
        self.records
            .iter()
            .find(|r| &r.key == key)
            .map(|r| &r.value)
    }
    pub fn insert(&mut self, key: Key, value: Credential) {
        self.records.retain(|r| r.key != key);
        self.records.push(Record { key, value });
        self.records.sort_by_key(|r| r.key.label());
    }
    pub fn settings(&self, uuid: &str) -> Settings {
        let mut s = Settings::from([(
            "connection".into(),
            Props::from([("uuid".into(), owned(uuid))]),
        )]);
        for r in &self.records {
            let p = s.entry(r.key.setting.clone()).or_default();
            p.insert(r.key.key.clone(), r.value.value());
            p.insert(r.key.flag(), 1u32.into());
        }
        s
    }
}

struct Profile {
    path: Path,
    settings: Settings,
    version: u64,
}
async fn load(nm: &Nm, uuid: &str) -> Result<Profile, Error> {
    let (path, _) = nm.profile(uuid).await?;
    let before = number(Some(&nm.props(&path, nm::PROFILE).await?), "VersionId");
    if before == 0 {
        return Err(Error::Unsupported(
            "storage migration needs NetworkManager VersionId (1.44+)".into(),
        ));
    }
    let settings = nm.call(&path, nm::PROFILE, "GetSettings", &()).await?;
    let after = number(Some(&nm.props(&path, nm::PROFILE).await?), "VersionId");
    if before != after {
        return Err(Error::Conflict("profile changed while reading".into()));
    }
    validate(&settings)?;
    Ok(Profile {
        path,
        settings,
        version: after,
    })
}
async fn update(nm: &Nm, uuid: &str, old: &Profile, settings: &Settings) -> Result<Profile, Error> {
    let args = Props::from([("version-id".into(), old.version.into())]);
    let _: Props = nm
        .call_timeout(
            &old.path,
            nm::PROFILE,
            "Update2",
            &(settings, 1u32, args),
            std::time::Duration::from_secs(120),
        )
        .await?;
    load(nm, uuid).await
}
fn policy_matches(a: &Settings, b: &Settings) -> bool {
    metadata(a) == metadata(b)
}
async fn system_values(nm: &Nm, p: &Profile) -> Result<Secrets, Error> {
    let mut out = Secrets::empty();
    for setting in ["802-11-wireless-security", "802-1x"] {
        if !p.settings.contains_key(setting) {
            continue;
        }
        let response = nm
            .call::<Settings>(&p.path, nm::PROFILE, "GetSecrets", &(setting,))
            .await;
        match response {
            Ok(values) => {
                for key in keys(&p.settings)
                    .into_iter()
                    .filter(|k| k.setting == setting)
                {
                    if let Some(value) = values
                        .get(setting)
                        .and_then(|p| p.get(&key.key))
                        .and_then(Credential::read)
                    {
                        out.insert(key, value);
                    }
                }
            }
            Err(Error::Denied(e)) => return Err(Error::Denied(e)),
            Err(Error::ZBus(zbus::Error::MethodError(ref n, _, _)))
                if n.as_str().ends_with("NoSecrets") => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}
async fn user_values(queue: &keyring::Queue, uuid: &str) -> Result<Secrets, Error> {
    let mut out = Secrets::empty();
    for setting in ["802-11-wireless-security", "802-1x"] {
        let values = queue.lookup(uuid, setting).await?;
        for (key, value) in values {
            if super::agent::secret_key(setting, &key)
                && let Some(value) = Credential::read(&value)
            {
                out.insert(
                    Key {
                        setting: setting.into(),
                        key,
                    },
                    value,
                );
            }
        }
    }
    Ok(out)
}
fn include(s: &mut Settings, values: &Secrets) {
    for r in &values.records {
        s.entry(r.key.setting.clone())
            .or_default()
            .insert(r.key.key.clone(), r.value.value());
    }
}
fn select(values: &Secrets, s: &Settings, mode: Mode) -> Secrets {
    Secrets {
        records: values
            .records
            .iter()
            .filter(|r| r.key.mode(s).ok() == Some(mode))
            .cloned()
            .collect(),
    }
}
async fn confirm_user(queue: &keyring::Queue, uuid: &str, expected: &Secrets) -> Result<(), Error> {
    let actual = user_values(queue, uuid).await?;
    if expected
        .records
        .iter()
        .any(|r| actual.get(&r.key) != Some(&r.value))
    {
        return Err(Error::Failed(
            "keyring destination verification failed".into(),
        ));
    }
    Ok(())
}
async fn confirm_system(nm: &Nm, p: &Profile, expected: &Secrets) -> Result<(), Error> {
    let actual = system_values(nm, p).await?;
    if expected
        .records
        .iter()
        .any(|r| actual.get(&r.key) != Some(&r.value))
    {
        return Err(Error::Failed("NM destination verification failed".into()));
    }
    Ok(())
}

fn needs_value(key: &Key, s: &Settings, values: &Secrets) -> bool {
    if key.key.starts_with("wep-key") {
        return key.key == format!("wep-key{}", number(s.get(&key.setting), "wep-tx-keyidx"));
    }
    if key.setting == "802-1x" {
        if key.key == "password"
            && values
                .get(&Key {
                    setting: key.setting.clone(),
                    key: "password-raw".into(),
                })
                .is_some()
        {
            return false;
        }
        if key.key == "password-raw"
            && keys(s)
                .iter()
                .any(|k| k.setting == key.setting && k.key == "password")
        {
            return false;
        }
        if matches!(
            key.key.as_str(),
            "private-key-password" | "phase2-private-key-password"
        ) {
            let field = key.key.trim_end_matches("-password");
            return !nm::bytes(s.get(&key.setting), field).is_empty()
                || !text(s.get(&key.setting), field).is_empty();
        }
    }
    true
}
fn from_input(values: &Settings, known: &[Key]) -> Result<Secrets, Error> {
    let mut out = Secrets::empty();
    for (setting, p) in values {
        for (key, value) in p {
            let k = Key {
                setting: setting.clone(),
                key: key.clone(),
            };
            if !known.contains(&k) {
                return Err(Error::Invalid(
                    "only the profile's secret values may be supplied".into(),
                ));
            }
            let value = Credential::read(value)
                .ok_or_else(|| Error::Invalid("invalid secret value type".into()))?;
            if matches!(&value,Credential::Bytes(_) if key!="password-raw")
                || matches!(&value,Credential::Text(_) if key=="password-raw")
            {
                return Err(Error::Invalid(
                    "password-raw requires bytes; other secrets require text".into(),
                ));
            }
            out.insert(k, value);
        }
    }
    Ok(out)
}
fn effective(s: &Settings, sys: &Secrets, user: &Secrets) -> Secrets {
    let mut out = Secrets::empty();
    for key in keys(s) {
        let value = match key.mode(s).ok() {
            Some(Mode::System) => sys.get(&key).or_else(|| user.get(&key)),
            Some(Mode::User) => user.get(&key).or_else(|| sys.get(&key)),
            _ => None,
        };
        if let Some(value) = value {
            out.insert(key, value.clone());
        }
    }
    out
}
fn wire_settings(base: &Settings, values: &Secrets) -> Settings {
    let mut s = base.clone();
    strip_secrets(&mut s);
    include(&mut s, values);
    s
}
async fn ensure_snapshot(nm: &Nm, uuid: &str, p: &Profile) -> Result<(), Error> {
    if load(nm, uuid).await?.version != p.version {
        return Err(Error::Conflict(
            "profile changed during secret operation".into(),
        ));
    }
    Ok(())
}
async fn remove_user(
    queue: &keyring::Queue,
    uuid: &str,
    s: &Settings,
    keep: &Secrets,
) -> Result<(), Error> {
    let remove: Vec<Key> = keys(s)
        .into_iter()
        .filter(|key| key.mode(s).ok() != Some(Mode::Optional) && keep.get(key).is_none())
        .collect();
    queue.delete_keys(uuid, &remove).await?;
    let remaining = user_values(queue, uuid).await?;
    if remove.iter().any(|key| remaining.get(key).is_some()) {
        return Err(Error::Failed(
            "keyring source cleanup verification failed".into(),
        ));
    }
    Ok(())
}
/// On error, reveal locations/flags, never values. Unknown is explicit if a peer
/// cannot be read. Flags remain the recovery authority after a process restart.
async fn incomplete(nm: &Nm, queue: &keyring::Queue, uuid: &str, phase: &str) -> Error {
    let profile = load(nm, uuid).await;
    let policy = profile
        .as_ref()
        .map(|p| metadata(&p.settings))
        .unwrap_or(json!("unknown"));
    let system = if let Ok(p) = profile {
        system_values(nm, &p).await.ok().map(|v| {
            v.records
                .into_iter()
                .map(|r| r.key.label())
                .collect::<Vec<_>>()
        })
    } else {
        None
    };
    let user = user_values(queue, uuid).await.ok().map(|v| {
        v.records
            .into_iter()
            .map(|r| r.key.label())
            .collect::<Vec<_>>()
    });
    Error::Incomplete(json!({"phase":phase,"policy":policy,"nmReadableKeys":system,"keyringKeys":user,"recovery":"ReconcileSecretStorage"}).to_string())
}
async fn reconcile_inner(
    nm: &Nm,
    queue: &keyring::Queue,
    uuid: &str,
    original: Profile,
) -> Result<Profile, Error> {
    let sys = system_values(nm, &original).await?;
    let user = user_values(queue, uuid).await?;
    let values = effective(&original.settings, &sys, &user);
    let wanted_user = select(&values, &original.settings, Mode::User);
    let wanted_system = select(&values, &original.settings, Mode::System);
    // A consistent profile needs no Update2 (and therefore no extra polkit
    // authorization). Optional/irrelevant keys are outside migration's scope.
    if keys(&original.settings)
        .iter()
        .filter(|key| key.mode(&original.settings).ok() != Some(Mode::Optional))
        .all(|key| sys.get(key) == wanted_system.get(key) && user.get(key) == wanted_user.get(key))
    {
        ensure_snapshot(nm, uuid, &original).await?;
        return Ok(original);
    }
    // Reconstitute the destination first if an interrupted operation left only
    // a surplus copy in the other service. Empty profiles may still ask on activation.
    if wanted_user
        .records
        .iter()
        .any(|r| user.get(&r.key) != Some(&r.value))
    {
        queue.save(wanted_user.settings(uuid)).await?;
        confirm_user(queue, uuid, &wanted_user).await?;
    }
    ensure_snapshot(nm, uuid, &original).await?;
    // Canonical Update2 drops NM's persisted user/ask values; user values are
    // supplied with flag 1 for any NM SaveSecrets callback, without holding SS's queue.
    let mut durable = Secrets::empty();
    for r in wanted_system.records.iter().chain(&wanted_user.records) {
        durable.insert(r.key.clone(), r.value.clone());
    }
    let wire = wire_settings(&original.settings, &durable);
    let current = update(nm, uuid, &original, &wire).await?;
    if !policy_matches(&current.settings, &original.settings) {
        return Err(Error::Conflict(
            "profile policy changed while reconciling".into(),
        ));
    }
    confirm_system(nm, &current, &wanted_system).await?;
    confirm_user(queue, uuid, &wanted_user).await?;
    if remove_user(queue, uuid, &current.settings, &wanted_user)
        .await
        .is_err()
    {
        return Err(incomplete(nm, queue, uuid, "reconcile source cleanup").await);
    }
    Ok(current)
}
pub async fn reconcile(nm: &Nm, agent: &Agent, uuid: &str) -> Result<(), Error> {
    let _guard = agent.begin_storage(uuid)?;
    let queue = agent.keyring();
    reconcile_inner(nm, &queue, uuid, load(nm, uuid).await?).await?;
    Ok(())
}
async fn rollback(
    nm: &Nm,
    queue: &keyring::Queue,
    uuid: &str,
    original: &Profile,
    old_values: &Secrets,
    current: Option<&Profile>,
    touched_user: bool,
) -> Result<(), Error> {
    let old_user = select(old_values, &original.settings, Mode::User);
    let old_system = select(old_values, &original.settings, Mode::System);
    // Never remove a verified destination when restoring its old source failed.
    if touched_user || !old_user.records.is_empty() {
        queue.save(old_user.settings(uuid)).await?;
        confirm_user(queue, uuid, &old_user).await?;
    }
    let restored = if let Some(current) = current {
        let wire = wire_settings(&original.settings, old_values);
        let p = update(nm, uuid, current, &wire).await?;
        if !policy_matches(&p.settings, &original.settings) {
            return Err(Error::Conflict("rollback policy did not match".into()));
        }
        confirm_system(nm, &p, &old_system).await?;
        p
    } else {
        load(nm, uuid).await?
    };
    remove_user(queue, uuid, &restored.settings, &old_user).await
}
fn restored_error(error: Error) -> Error {
    match error {
        Error::ZBus(_) => {
            Error::Failed("secret storage change failed; original storage restored".into())
        }
        error => error,
    }
}
pub async fn change(
    nm: &Nm,
    agent: &Agent,
    uuid: &str,
    mode: &str,
    all_users: bool,
    supplied: &Settings,
) -> Result<(), Error> {
    let target = Mode::parse(mode)?;
    let _guard = agent.begin_storage(uuid)?;
    let queue = agent.keyring();
    let initial = load(nm, uuid).await?;
    let supplied = from_input(supplied, &keys(&initial.settings))?;
    let sys = system_values(nm, &initial).await?;
    let user = user_values(&queue, uuid).await?;
    let mut values = effective(&initial.settings, &sys, &user);
    for r in supplied.records {
        if let Some(existing) = values.get(&r.key)
            && existing != &r.value
        {
            return Err(Error::Invalid(
                "supplied values may only fill missing secrets".into(),
            ));
        }
        values.insert(r.key, r.value);
    }
    if target != Mode::Ask {
        let missing: Vec<_> = keys(&initial.settings)
            .into_iter()
            .filter(|key| {
                key.mode(&initial.settings).ok() != Some(Mode::Optional)
                    && values.get(key).is_none()
                    && needs_value(key, &initial.settings, &values)
            })
            .map(|k| k.label())
            .collect();
        if !missing.is_empty() {
            return Err(Error::NeedsSecrets(json!(missing).to_string()));
        }
    }
    // Missing input is refused BEFORE any reconciliation mutation.
    let original = reconcile_inner(nm, &queue, uuid, initial).await?;
    let old_sys = system_values(nm, &original).await?;
    let old_user = user_values(&queue, uuid).await?;
    let old_values = effective(&original.settings, &old_sys, &old_user);
    let mut changed = original.settings.clone();
    set_mode(&mut changed, target);
    permissions(&mut changed, all_users)?;
    let destination_user = select(&values, &changed, Mode::User);
    let destination_system = select(&values, &changed, Mode::System);
    let touched_user = !destination_user.records.is_empty();
    if touched_user
        && let Err(e) = async {
            queue.save(destination_user.settings(uuid)).await?;
            confirm_user(&queue, uuid, &destination_user).await
        }
        .await
    {
        if rollback(nm, &queue, uuid, &original, &old_values, None, true)
            .await
            .is_err()
        {
            return Err(
                incomplete(nm, &queue, uuid, "destination write and rollback failed").await,
            );
        }
        return Err(restored_error(e));
    }
    if let Err(e) = ensure_snapshot(nm, uuid, &original).await {
        if touched_user {
            return Err(incomplete(
                nm,
                &queue,
                uuid,
                "concurrent edit after keyring destination write",
            )
            .await);
        }
        return Err(restored_error(e));
    }
    let mut durable = Secrets::empty();
    for r in destination_system
        .records
        .iter()
        .chain(&destination_user.records)
    {
        durable.insert(r.key.clone(), r.value.clone());
    }
    let wire = wire_settings(&changed, &durable);
    let current = match update(nm, uuid, &original, &wire).await {
        Ok(p) => p,
        Err(e) => {
            // Only an unchanged version proves an atomic refusal. A changed
            // version may include another writer even when policy matches ours;
            // retain durable copies and reconcile instead of overwriting it.
            let readback = load(nm, uuid).await;
            let unchanged = readback
                .as_ref()
                .is_ok_and(|p| p.version == original.version);
            if !unchanged {
                return Err(incomplete(
                    nm,
                    &queue,
                    uuid,
                    "NM update outcome unknown or concurrent edit",
                )
                .await);
            }
            if rollback(nm, &queue, uuid, &original, &old_values, None, touched_user)
                .await
                .is_err()
            {
                return Err(incomplete(nm, &queue, uuid, "NM update and rollback failed").await);
            }
            return Err(restored_error(e));
        }
    };
    let confirmation = async {
        if !policy_matches(&current.settings, &changed) {
            return Err(Error::Conflict("destination policy did not match".into()));
        }
        confirm_system(nm, &current, &destination_system).await?;
        confirm_user(&queue, uuid, &destination_user).await?;
        ensure_snapshot(nm, uuid, &current).await?;
        remove_user(&queue, uuid, &changed, &destination_user).await
    }
    .await;
    if let Err(e) = confirmation {
        // Ask is an explicit request to forget. Once flag 2 commits, finish its
        // erasure on retry; never recreate an unwanted recovery copy.
        if target == Mode::Ask {
            return Err(incomplete(nm, &queue, uuid, "ask committed; cleanup incomplete").await);
        }
        if rollback(
            nm,
            &queue,
            uuid,
            &original,
            &old_values,
            Some(&current),
            touched_user,
        )
        .await
        .is_err()
        {
            return Err(incomplete(nm, &queue, uuid, "source cleanup and rollback failed").await);
        }
        return Err(restored_error(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn personal() -> Settings {
        Settings::from([
            (
                "connection".into(),
                Props::from([("type".into(), owned("802-11-wireless"))]),
            ),
            (
                "802-11-wireless-security".into(),
                Props::from([
                    ("key-mgmt".into(), owned("wpa-psk")),
                    ("psk-flags".into(), 1u32.into()),
                ]),
            ),
        ])
    }
    #[test]
    fn independent_policy_and_private_acl() {
        let mut s = personal();
        permissions(&mut s, true).unwrap();
        assert_eq!(metadata(&s)["allUsers"], true);
        set_mode(&mut s, Mode::System);
        assert_eq!(
            metadata(&s)["secretStorage"]["802-11-wireless-security.psk"]["mode"],
            "system"
        );
        permissions(&mut s, false).unwrap();
        assert_eq!(metadata(&s)["allUsers"], false);
        assert!(matches!(Mode::parse("unknown"), Err(Error::Invalid(_))));
    }
    #[test]
    fn inactive_wep_slots_are_metadata_but_not_required() {
        let mut s = personal();
        s.get_mut("802-11-wireless-security")
            .unwrap()
            .insert("key-mgmt".into(), owned("none"));
        let fields = keys(&s);
        assert_eq!(fields.len(), 4);
        let empty = Secrets::empty();
        assert_eq!(
            fields
                .iter()
                .filter(|key| needs_value(key, &s, &empty))
                .count(),
            1
        );
        assert_eq!(
            fields
                .iter()
                .find(|key| needs_value(key, &s, &empty))
                .unwrap()
                .key,
            "wep-key0"
        );
    }
    #[test]
    fn optional_eap_flags_are_preserved() {
        let mut s = personal();
        s.insert(
            "802-1x".into(),
            Props::from([("private-key-password-flags".into(), 4u32.into())]),
        );
        set_mode(&mut s, Mode::Ask);
        assert_eq!(number(s.get("802-1x"), "private-key-password-flags"), 4);
        assert!(validate(&s).is_ok());
        s.get_mut("802-11-wireless-security")
            .unwrap()
            .insert("psk-flags".into(), 4u32.into());
        assert!(validate(&s).is_err());
    }
}
