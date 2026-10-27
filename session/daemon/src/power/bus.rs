// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
pub type Props = HashMap<String, OwnedValue>;
fn val<T: Into<Value<'static>>>(v: T) -> OwnedValue {
    v.into().try_into().expect("owned property")
}
fn opath(s: String) -> Path {
    Path::try_from(s).unwrap_or_else(|_| path("/"))
}
fn sender(header: &zbus::message::Header<'_>) -> Result<String, Error> {
    header
        .sender()
        .map(|s| s.to_string())
        .ok_or_else(|| Error::PermissionDenied("missing sender".into()))
}
fn root_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        (
            "InhibitorsMode".into(),
            val(power.property::<String>(key, "InhibitorsMode")),
        ),
        (
            "BlockInhibited".into(),
            val(power.property::<String>(key, "BlockInhibited")),
        ),
        (
            "DelayInhibited".into(),
            val(power.property::<String>(key, "DelayInhibited")),
        ),
        (
            "NCurrentInhibitors".into(),
            val(power.property::<u32>(key, "NCurrentInhibitors")),
        ),
        ("State".into(), val(power.property::<String>(key, "State"))),
        (
            "LastError".into(),
            val(power.property::<String>(key, "LastError")),
        ),
        (
            "Generation".into(),
            val(power.property::<u64>(key, "Generation")),
        ),
        (
            "ProviderStates".into(),
            val(power.property::<HashMap<String, String>>(key, "ProviderStates")),
        ),
        (
            "ProviderEpochs".into(),
            val(power.property::<HashMap<String, u64>>(key, "ProviderEpochs")),
        ),
        (
            "Capabilities".into(),
            val(power.property::<Vec<String>>(key, "Capabilities")),
        ),
        (
            "DisplayDevice".into(),
            val(opath(power.property::<String>(key, "DisplayDevice"))),
        ),
        (
            "Devices".into(),
            val(power
                .property::<Vec<String>>(key, "Devices")
                .into_iter()
                .map(opath)
                .collect::<Vec<_>>()),
        ),
        (
            "PeripheralDevices".into(),
            val(power
                .property::<Vec<String>>(key, "PeripheralDevices")
                .into_iter()
                .map(opath)
                .collect::<Vec<_>>()),
        ),
        (
            "Profiles".into(),
            val(power
                .property::<Vec<String>>(key, "Profiles")
                .into_iter()
                .map(opath)
                .collect::<Vec<_>>()),
        ),
        (
            "ActiveProfile".into(),
            val(power.property::<String>(key, "ActiveProfile")),
        ),
        (
            "ProfileHolds".into(),
            val(power
                .property::<Vec<String>>(key, "ProfileHolds")
                .into_iter()
                .map(opath)
                .collect::<Vec<_>>()),
        ),
        (
            "KeyboardBacklights".into(),
            val(power
                .property::<Vec<String>>(key, "KeyboardBacklights")
                .into_iter()
                .map(opath)
                .collect::<Vec<_>>()),
        ),
        (
            "PrimaryKeyboardBacklight".into(),
            val(opath(
                power.property::<String>(key, "PrimaryKeyboardBacklight"),
            )),
        ),
        (
            "Inhibitors".into(),
            val(power
                .property::<Vec<String>>(key, "Inhibitors")
                .into_iter()
                .map(opath)
                .collect::<Vec<_>>()),
        ),
        (
            "InhibitorsUpdatedAt".into(),
            val(power.property::<u64>(key, "InhibitorsUpdatedAt")),
        ),
        (
            "OnBatteryKnown".into(),
            val(power.property::<bool>(key, "OnBatteryKnown")),
        ),
        (
            "OnBattery".into(),
            val(power.property::<bool>(key, "OnBattery")),
        ),
        (
            "LidKnown".into(),
            val(power.property::<bool>(key, "LidKnown")),
        ),
        (
            "LidPresent".into(),
            val(power.property::<bool>(key, "LidPresent")),
        ),
        (
            "LidClosed".into(),
            val(power.property::<bool>(key, "LidClosed")),
        ),
        (
            "DockedKnown".into(),
            val(power.property::<bool>(key, "DockedKnown")),
        ),
        ("Docked".into(), val(power.property::<bool>(key, "Docked"))),
        (
            "LowActive".into(),
            val(power.property::<bool>(key, "LowActive")),
        ),
        (
            "CriticalActive".into(),
            val(power.property::<bool>(key, "CriticalActive")),
        ),
        (
            "AutomaticSaverState".into(),
            val(power.property::<String>(key, "AutomaticSaverState")),
        ),
        (
            "PolicyOwner".into(),
            val(power.property::<String>(key, "PolicyOwner")),
        ),
        (
            "PowerButtonHandling".into(),
            val(power.property::<String>(key, "PowerButtonHandling")),
        ),
        (
            "LidHandling".into(),
            val(power.property::<String>(key, "LidHandling")),
        ),
        (
            "PowerButtonAction".into(),
            val(power.property::<String>(key, "PowerButtonAction")),
        ),
        (
            "PowerButtonEffectiveAction".into(),
            val(power.property::<String>(key, "PowerButtonEffectiveAction")),
        ),
        (
            "MenuAvailable".into(),
            val(power.property::<bool>(key, "MenuAvailable")),
        ),
        (
            "CanSuspend".into(),
            val(power.property::<String>(key, "CanSuspend")),
        ),
        (
            "CanPowerOff".into(),
            val(power.property::<String>(key, "CanPowerOff")),
        ),
        (
            "EffectiveIdle".into(),
            val(power.property::<HashMap<String, u32>>(key, "EffectiveIdle")),
        ),
        (
            "AutomaticSaverEnabled".into(),
            val(power.property::<bool>(key, "AutomaticSaverEnabled")),
        ),
        (
            "ShowPercentage".into(),
            val(power.property::<bool>(key, "ShowPercentage")),
        ),
        (
            "LidActionOnBattery".into(),
            val(power.property::<String>(key, "LidActionOnBattery")),
        ),
        (
            "LidActionOnAC".into(),
            val(power.property::<String>(key, "LidActionOnAC")),
        ),
    ])
}
fn device_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        (
            "ProviderPath".into(),
            val(opath(power.property::<String>(key, "ProviderPath"))),
        ),
        ("Kind".into(), val(power.property::<u32>(key, "Kind"))),
        ("Role".into(), val(power.property::<String>(key, "Role"))),
        (
            "Vendor".into(),
            val(power.property::<String>(key, "Vendor")),
        ),
        ("Model".into(), val(power.property::<String>(key, "Model"))),
        (
            "IconName".into(),
            val(power.property::<String>(key, "IconName")),
        ),
        (
            "Present".into(),
            val(power.property::<bool>(key, "Present")),
        ),
        (
            "PowerSupply".into(),
            val(power.property::<bool>(key, "PowerSupply")),
        ),
        (
            "Rechargeable".into(),
            val(power.property::<bool>(key, "Rechargeable")),
        ),
        ("State".into(), val(power.property::<u32>(key, "State"))),
        (
            "PercentageKnown".into(),
            val(power.property::<bool>(key, "PercentageKnown")),
        ),
        (
            "Percentage".into(),
            val(power.property::<f64>(key, "Percentage")),
        ),
        (
            "TimeToEmptyKnown".into(),
            val(power.property::<bool>(key, "TimeToEmptyKnown")),
        ),
        (
            "TimeToFullKnown".into(),
            val(power.property::<bool>(key, "TimeToFullKnown")),
        ),
        (
            "TimeToEmpty".into(),
            val(power.property::<i64>(key, "TimeToEmpty")),
        ),
        (
            "TimeToFull".into(),
            val(power.property::<i64>(key, "TimeToFull")),
        ),
        (
            "WarningLevel".into(),
            val(power.property::<u32>(key, "WarningLevel")),
        ),
        (
            "BatteryLevel".into(),
            val(power.property::<u32>(key, "BatteryLevel")),
        ),
        (
            "HealthKnown".into(),
            val(power.property::<bool>(key, "HealthKnown")),
        ),
        (
            "HealthPercent".into(),
            val(power.property::<f64>(key, "HealthPercent")),
        ),
        (
            "HealthSource".into(),
            val(power.property::<String>(key, "HealthSource")),
        ),
        (
            "CyclesKnown".into(),
            val(power.property::<bool>(key, "CyclesKnown")),
        ),
        ("Cycles".into(), val(power.property::<i32>(key, "Cycles"))),
        (
            "ChargeProtectionSupported".into(),
            val(power.property::<bool>(key, "ChargeProtectionSupported")),
        ),
        (
            "ChargeProtectionEnabled".into(),
            val(power.property::<bool>(key, "ChargeProtectionEnabled")),
        ),
        (
            "StartThresholdKnown".into(),
            val(power.property::<bool>(key, "StartThresholdKnown")),
        ),
        (
            "EndThresholdKnown".into(),
            val(power.property::<bool>(key, "EndThresholdKnown")),
        ),
        (
            "StartThreshold".into(),
            val(power.property::<u32>(key, "StartThreshold")),
        ),
        (
            "EndThreshold".into(),
            val(power.property::<u32>(key, "EndThreshold")),
        ),
        (
            "Capabilities".into(),
            val(power.property::<Vec<String>>(key, "Capabilities")),
        ),
        (
            "BluetoothDevicePath".into(),
            val(opath(power.property::<String>(key, "BluetoothDevicePath"))),
        ),
        (
            "BatteryOwner".into(),
            val(power.property::<String>(key, "BatteryOwner")),
        ),
        (
            "DeduplicationState".into(),
            val(power.property::<String>(key, "DeduplicationState")),
        ),
    ])
}
fn profile_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        ("Name".into(), val(power.property::<String>(key, "Name"))),
        (
            "Driver".into(),
            val(power.property::<String>(key, "Driver")),
        ),
        (
            "Available".into(),
            val(power.property::<bool>(key, "Available")),
        ),
        (
            "PerformanceDegraded".into(),
            val(power.property::<String>(key, "PerformanceDegraded")),
        ),
        (
            "PerformanceInhibited".into(),
            val(power.property::<String>(key, "PerformanceInhibited")),
        ),
    ])
}
fn hold_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        (
            "Profile".into(),
            val(power.property::<String>(key, "Profile")),
        ),
        (
            "Reason".into(),
            val(power.property::<String>(key, "Reason")),
        ),
        (
            "ApplicationId".into(),
            val(power.property::<String>(key, "ApplicationId")),
        ),
        ("Owner".into(), val(power.property::<String>(key, "Owner"))),
        (
            "OwnedByPower1".into(),
            val(power.property::<bool>(key, "OwnedByPower1")),
        ),
        ("State".into(), val(power.property::<String>(key, "State"))),
    ])
}
fn keyboard_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        (
            "Brightness".into(),
            val(power.property::<i32>(key, "Brightness")),
        ),
        (
            "MaxBrightness".into(),
            val(power.property::<i32>(key, "MaxBrightness")),
        ),
        ("Known".into(), val(power.property::<bool>(key, "Known"))),
        (
            "LastChangeSource".into(),
            val(power.property::<String>(key, "LastChangeSource")),
        ),
        (
            "Capabilities".into(),
            val(power.property::<Vec<String>>(key, "Capabilities")),
        ),
    ])
}
fn inhibitor_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        (
            "Source".into(),
            val(power.property::<String>(key, "Source")),
        ),
        (
            "What".into(),
            val(power.property::<Vec<String>>(key, "What")),
        ),
        ("Who".into(), val(power.property::<String>(key, "Who"))),
        (
            "Reason".into(),
            val(power.property::<String>(key, "Reason")),
        ),
        (
            "ApplicationId".into(),
            val(power.property::<String>(key, "ApplicationId")),
        ),
        ("Pid".into(), val(power.property::<u32>(key, "Pid"))),
        ("Uid".into(), val(power.property::<u32>(key, "Uid"))),
        (
            "IdentityKnown".into(),
            val(power.property::<bool>(key, "IdentityKnown")),
        ),
        ("Mode".into(), val(power.property::<String>(key, "Mode"))),
        (
            "Effective".into(),
            val(power.property::<bool>(key, "Effective")),
        ),
    ])
}
fn menu_props(power: &Power, key: &str) -> Props {
    HashMap::from([
        ("Owner".into(), val(power.property::<String>(key, "Owner"))),
        (
            "ConsumerPath".into(),
            val(opath(power.property::<String>(key, "ConsumerPath"))),
        ),
        ("Active".into(), val(power.property::<bool>(key, "Active"))),
    ])
}
fn props(power: &Power, key: &str, kind: &str) -> Props {
    match kind {
        "root" => root_props(power, key),
        "device" => device_props(power, key),
        "profile" => profile_props(power, key),
        "hold" => hold_props(power, key),
        "keyboard" => keyboard_props(power, key),
        "inhibitor" => inhibitor_props(power, key),
        "menu" => menu_props(power, key),
        _ => HashMap::new(),
    }
}
fn iface(kind: &str) -> &'static str {
    match kind {
        "root" => "org.nidara.Power1",
        "device" => "org.nidara.PowerDevice1",
        "profile" => "org.nidara.PowerProfile1",
        "hold" => "org.nidara.PowerProfileHold1",
        "keyboard" => "org.nidara.PowerKeyboardBacklight1",
        "inhibitor" => "org.nidara.PowerInhibitor1",
        "menu" => "org.nidara.PowerMenuLease1",
        _ => unreachable!(),
    }
}
pub async fn publish(
    power: &Power,
    objects: BTreeMap<String, Object>,
    root: Json,
) -> Result<(), Error> {
    let previous = power.state.read().unwrap().objects.clone();
    for (key, obj) in &objects {
        if !previous.contains_key(key) {
            install(power, obj).await?;
        }
    }
    {
        let mut state = power.state.write().unwrap();
        state.objects = objects.clone();
        state.root = root;
    }
    let mut announced = power.announced.lock().await;
    for (key, kind) in std::iter::once((ROOT.to_string(), "root"))
        .chain(objects.iter().map(|(k, o)| (k.clone(), o.kind)))
    {
        let new = props(power, &key, kind);
        let old = announced.entry(key.clone()).or_default();
        let changed: Props = new
            .iter()
            .filter(|(k, v)| old.get(*k) != Some(*v))
            .map(|(k, v)| (k.clone(), v.try_clone().unwrap()))
            .collect();
        if !changed.is_empty() {
            power
                .conn
                .emit_signal(
                    None::<&str>,
                    key.as_str(),
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    &(iface(kind), changed, Vec::<String>::new()),
                )
                .await?;
        }
        *old = new;
    }
    for (key, obj) in &previous {
        if !objects.contains_key(key) {
            remove(power, key, obj.kind).await?;
            announced.remove(key);
        }
    }
    Ok(())
}
async fn install(power: &Power, obj: &Object) -> zbus::Result<()> {
    let node = Node {
        power: power.clone(),
        key: obj.path.clone(),
        initial: obj.props.clone(),
    };
    match obj.kind {
        "device" => {
            power
                .conn
                .object_server()
                .at(obj.path.as_str(), Device(node))
                .await?;
        }
        "profile" => {
            power
                .conn
                .object_server()
                .at(obj.path.as_str(), Profile(node))
                .await?;
        }
        "hold" => {
            power
                .conn
                .object_server()
                .at(obj.path.as_str(), Hold(node))
                .await?;
        }
        "keyboard" => {
            power
                .conn
                .object_server()
                .at(obj.path.as_str(), Keyboard(node))
                .await?;
        }
        "inhibitor" => {
            power
                .conn
                .object_server()
                .at(obj.path.as_str(), Inhibitor(node))
                .await?;
        }
        "menu" => {
            power
                .conn
                .object_server()
                .at(obj.path.as_str(), Menu(node))
                .await?;
        }
        _ => {}
    }
    Ok(())
}
async fn remove(power: &Power, key: &str, kind: &str) -> zbus::Result<()> {
    match kind {
        "device" => {
            power.conn.object_server().remove::<Device, _>(key).await?;
        }
        "profile" => {
            power.conn.object_server().remove::<Profile, _>(key).await?;
        }
        "hold" => {
            power.conn.object_server().remove::<Hold, _>(key).await?;
        }
        "keyboard" => {
            power
                .conn
                .object_server()
                .remove::<Keyboard, _>(key)
                .await?;
        }
        "inhibitor" => {
            power
                .conn
                .object_server()
                .remove::<Inhibitor, _>(key)
                .await?;
        }
        "menu" => {
            power.conn.object_server().remove::<Menu, _>(key).await?;
        }
        _ => {}
    }
    Ok(())
}
#[derive(Clone)]
struct Node {
    power: Power,
    key: String,
    initial: Json,
}
impl Node {
    fn property<T: serde::de::DeserializeOwned + Default>(&self, key: &str, name: &str) -> T {
        let state = self.power.state.read().unwrap();
        state
            .objects
            .get(key)
            .map(|o| &o.props)
            .unwrap_or(&self.initial)
            .get(name)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }
}
#[derive(Clone)]
pub struct Root(pub Power);
#[zbus::interface(name = "org.nidara.Power1")]
impl Root {
    #[zbus(property)]
    fn state(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "State")
    }
    #[zbus(property)]
    fn last_error(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "LastError")
    }
    #[zbus(property)]
    fn generation(&self) -> u64 {
        let key = ROOT;
        self.0.property::<u64>(key, "Generation")
    }
    #[zbus(property)]
    fn provider_states(&self) -> HashMap<String, String> {
        let key = ROOT;
        self.0
            .property::<HashMap<String, String>>(key, "ProviderStates")
    }
    #[zbus(property)]
    fn provider_epochs(&self) -> HashMap<String, u64> {
        let key = ROOT;
        self.0
            .property::<HashMap<String, u64>>(key, "ProviderEpochs")
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        let key = ROOT;
        self.0.property::<Vec<String>>(key, "Capabilities")
    }
    #[zbus(property)]
    fn display_device(&self) -> Path {
        let key = ROOT;
        opath(self.0.property::<String>(key, "DisplayDevice"))
    }
    #[zbus(property)]
    fn devices(&self) -> Vec<Path> {
        let key = ROOT;
        self.0
            .property::<Vec<String>>(key, "Devices")
            .into_iter()
            .map(opath)
            .collect::<Vec<_>>()
    }
    #[zbus(property)]
    fn peripheral_devices(&self) -> Vec<Path> {
        let key = ROOT;
        self.0
            .property::<Vec<String>>(key, "PeripheralDevices")
            .into_iter()
            .map(opath)
            .collect::<Vec<_>>()
    }
    #[zbus(property)]
    fn profiles(&self) -> Vec<Path> {
        let key = ROOT;
        self.0
            .property::<Vec<String>>(key, "Profiles")
            .into_iter()
            .map(opath)
            .collect::<Vec<_>>()
    }
    #[zbus(property)]
    fn active_profile(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "ActiveProfile")
    }
    #[zbus(property)]
    fn profile_holds(&self) -> Vec<Path> {
        let key = ROOT;
        self.0
            .property::<Vec<String>>(key, "ProfileHolds")
            .into_iter()
            .map(opath)
            .collect::<Vec<_>>()
    }
    #[zbus(property)]
    fn keyboard_backlights(&self) -> Vec<Path> {
        let key = ROOT;
        self.0
            .property::<Vec<String>>(key, "KeyboardBacklights")
            .into_iter()
            .map(opath)
            .collect::<Vec<_>>()
    }
    #[zbus(property)]
    fn primary_keyboard_backlight(&self) -> Path {
        let key = ROOT;
        opath(self.0.property::<String>(key, "PrimaryKeyboardBacklight"))
    }
    #[zbus(property)]
    fn inhibitors(&self) -> Vec<Path> {
        let key = ROOT;
        self.0
            .property::<Vec<String>>(key, "Inhibitors")
            .into_iter()
            .map(opath)
            .collect::<Vec<_>>()
    }
    #[zbus(property)]
    fn inhibitors_updated_at(&self) -> u64 {
        let key = ROOT;
        self.0.property::<u64>(key, "InhibitorsUpdatedAt")
    }
    #[zbus(property)]
    fn on_battery_known(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "OnBatteryKnown")
    }
    #[zbus(property)]
    fn on_battery(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "OnBattery")
    }
    #[zbus(property)]
    fn lid_known(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "LidKnown")
    }
    #[zbus(property)]
    fn lid_present(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "LidPresent")
    }
    #[zbus(property)]
    fn lid_closed(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "LidClosed")
    }
    #[zbus(property)]
    fn docked_known(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "DockedKnown")
    }
    #[zbus(property)]
    fn docked(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "Docked")
    }
    #[zbus(property)]
    fn low_active(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "LowActive")
    }
    #[zbus(property)]
    fn critical_active(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "CriticalActive")
    }
    #[zbus(property)]
    fn automatic_saver_state(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "AutomaticSaverState")
    }
    #[zbus(property)]
    fn policy_owner(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "PolicyOwner")
    }
    #[zbus(property)]
    fn power_button_handling(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "PowerButtonHandling")
    }
    #[zbus(property)]
    fn lid_handling(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "LidHandling")
    }
    #[zbus(property)]
    fn power_button_action(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "PowerButtonAction")
    }
    #[zbus(property)]
    fn power_button_effective_action(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "PowerButtonEffectiveAction")
    }
    #[zbus(property)]
    fn menu_available(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "MenuAvailable")
    }
    #[zbus(property)]
    fn can_suspend(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "CanSuspend")
    }
    #[zbus(property)]
    fn can_power_off(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "CanPowerOff")
    }
    #[zbus(property)]
    fn effective_idle(&self) -> HashMap<String, u32> {
        let key = ROOT;
        self.0
            .property::<HashMap<String, u32>>(key, "EffectiveIdle")
    }
    #[zbus(property)]
    fn automatic_saver_enabled(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "AutomaticSaverEnabled")
    }
    #[zbus(property)]
    fn show_percentage(&self) -> bool {
        let key = ROOT;
        self.0.property::<bool>(key, "ShowPercentage")
    }
    #[zbus(property)]
    fn lid_action_on_battery(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "LidActionOnBattery")
    }
    #[zbus(property)]
    fn lid_action_on_ac(&self) -> String {
        let key = ROOT;
        self.0.property::<String>(key, "LidActionOnAC")
    }
    #[zbus(property)]
    fn inhibitors_mode(&self) -> String {
        self.0.property(ROOT, "InhibitorsMode")
    }
    #[zbus(property)]
    fn block_inhibited(&self) -> String {
        self.0.property(ROOT, "BlockInhibited")
    }
    #[zbus(property)]
    fn delay_inhibited(&self) -> String {
        self.0.property(ROOT, "DelayInhibited")
    }
    #[zbus(property)]
    fn n_current_inhibitors(&self) -> u32 {
        self.0.property(ROOT, "NCurrentInhibitors")
    }
    async fn set_profile(&self, profile: String) -> Result<(), Error> {
        self.0.profile(profile).await
    }
    async fn hold_profile(
        &self,
        profile: String,
        reason: String,
        application_id: String,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<Path, Error> {
        self.0
            .hold(sender(&header)?, profile, reason, application_id, false)
            .await
    }
    async fn set_charge_protection(&self, battery: Path, enabled: bool) -> Result<(), Error> {
        self.0.charge(battery, enabled).await
    }
    async fn set_keyboard_brightness(&self, keyboard: Path, level: i32) -> Result<(), Error> {
        self.0.keyboard(keyboard, level).await
    }
    async fn step_primary_keyboard_brightness(&self, direction: i32) -> Result<(), Error> {
        self.0.keyboard_step(direction).await
    }
    async fn power_button_pressed(&self) -> Result<(), Error> {
        self.0.power_button().await
    }
    async fn suspend(&self, interactive: bool) -> Result<(), Error> {
        self.0.action("suspend", interactive).await
    }
    async fn power_off(&self, interactive: bool) -> Result<(), Error> {
        self.0.action("poweroff", interactive).await
    }
    async fn lock_session(&self) -> Result<(), Error> {
        self.0.action("lock", false).await
    }
    async fn register_menu_consumer(
        &self,
        consumer: Path,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<Path, Error> {
        self.0.register_menu(sender(&header)?, consumer).await
    }
    async fn refresh_inhibitors(&self) -> Result<u64, Error> {
        self.0.refresh().await?;
        Ok(self.0.property(ROOT, "InhibitorsUpdatedAt"))
    }
    #[zbus(signal)]
    async fn battery_alert(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        device: Path,
        severity: &str,
        percentage: f64,
        episode: u64,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn action_failed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        action: &str,
        target: Path,
        error_name: &str,
        detail: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn automatic_saver_changed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        state: &str,
        reason: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn keyboard_brightness_changed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        keyboard: Path,
        value: i32,
        source: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn menu_requested(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        request_id: u64,
    ) -> zbus::Result<()>;
}
#[derive(Clone)]
struct Device(Node);
#[zbus::interface(name = "org.nidara.PowerDevice1")]
impl Device {
    #[zbus(property)]
    fn provider_path(&self) -> Path {
        let key = self.0.key.as_str();
        opath(self.0.property::<String>(key, "ProviderPath"))
    }
    #[zbus(property)]
    fn kind(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "Kind")
    }
    #[zbus(property)]
    fn role(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Role")
    }
    #[zbus(property)]
    fn vendor(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Vendor")
    }
    #[zbus(property)]
    fn model(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Model")
    }
    #[zbus(property)]
    fn icon_name(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "IconName")
    }
    #[zbus(property)]
    fn present(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "Present")
    }
    #[zbus(property)]
    fn power_supply(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "PowerSupply")
    }
    #[zbus(property)]
    fn rechargeable(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "Rechargeable")
    }
    #[zbus(property)]
    fn state(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "State")
    }
    #[zbus(property)]
    fn percentage_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "PercentageKnown")
    }
    #[zbus(property)]
    fn percentage(&self) -> f64 {
        let key = self.0.key.as_str();
        self.0.property::<f64>(key, "Percentage")
    }
    #[zbus(property)]
    fn time_to_empty_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "TimeToEmptyKnown")
    }
    #[zbus(property)]
    fn time_to_full_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "TimeToFullKnown")
    }
    #[zbus(property)]
    fn time_to_empty(&self) -> i64 {
        let key = self.0.key.as_str();
        self.0.property::<i64>(key, "TimeToEmpty")
    }
    #[zbus(property)]
    fn time_to_full(&self) -> i64 {
        let key = self.0.key.as_str();
        self.0.property::<i64>(key, "TimeToFull")
    }
    #[zbus(property)]
    fn warning_level(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "WarningLevel")
    }
    #[zbus(property)]
    fn battery_level(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "BatteryLevel")
    }
    #[zbus(property)]
    fn health_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "HealthKnown")
    }
    #[zbus(property)]
    fn health_percent(&self) -> f64 {
        let key = self.0.key.as_str();
        self.0.property::<f64>(key, "HealthPercent")
    }
    #[zbus(property)]
    fn health_source(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "HealthSource")
    }
    #[zbus(property)]
    fn cycles_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "CyclesKnown")
    }
    #[zbus(property)]
    fn cycles(&self) -> i32 {
        let key = self.0.key.as_str();
        self.0.property::<i32>(key, "Cycles")
    }
    #[zbus(property)]
    fn charge_protection_supported(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "ChargeProtectionSupported")
    }
    #[zbus(property)]
    fn charge_protection_enabled(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "ChargeProtectionEnabled")
    }
    #[zbus(property)]
    fn start_threshold_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "StartThresholdKnown")
    }
    #[zbus(property)]
    fn end_threshold_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "EndThresholdKnown")
    }
    #[zbus(property)]
    fn start_threshold(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "StartThreshold")
    }
    #[zbus(property)]
    fn end_threshold(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "EndThreshold")
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        let key = self.0.key.as_str();
        self.0.property::<Vec<String>>(key, "Capabilities")
    }
    #[zbus(property)]
    fn bluetooth_device_path(&self) -> Path {
        let key = self.0.key.as_str();
        opath(self.0.property::<String>(key, "BluetoothDevicePath"))
    }
    #[zbus(property)]
    fn battery_owner(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "BatteryOwner")
    }
    #[zbus(property)]
    fn deduplication_state(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "DeduplicationState")
    }
}
#[derive(Clone)]
struct Profile(Node);
#[zbus::interface(name = "org.nidara.PowerProfile1")]
impl Profile {
    #[zbus(property)]
    fn name(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Name")
    }
    #[zbus(property)]
    fn driver(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Driver")
    }
    #[zbus(property)]
    fn available(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "Available")
    }
    #[zbus(property)]
    fn performance_degraded(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "PerformanceDegraded")
    }
    #[zbus(property)]
    fn performance_inhibited(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "PerformanceInhibited")
    }
}
#[derive(Clone)]
struct Hold(Node);
#[zbus::interface(name = "org.nidara.PowerProfileHold1")]
impl Hold {
    #[zbus(property)]
    fn profile(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Profile")
    }
    #[zbus(property)]
    fn reason(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Reason")
    }
    #[zbus(property)]
    fn application_id(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "ApplicationId")
    }
    #[zbus(property)]
    fn owner(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Owner")
    }
    #[zbus(property)]
    fn owned_by_power1(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "OwnedByPower1")
    }
    #[zbus(property)]
    fn state(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "State")
    }
    async fn release(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<(), Error> {
        self.0
            .power
            .release(&self.0.key, Some(&sender(&header)?))
            .await
    }
    #[zbus(signal)]
    async fn ended(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        reason: &str,
    ) -> zbus::Result<()>;
}
#[derive(Clone)]
struct Keyboard(Node);
#[zbus::interface(name = "org.nidara.PowerKeyboardBacklight1")]
impl Keyboard {
    #[zbus(property)]
    fn brightness(&self) -> i32 {
        let key = self.0.key.as_str();
        self.0.property::<i32>(key, "Brightness")
    }
    #[zbus(property)]
    fn max_brightness(&self) -> i32 {
        let key = self.0.key.as_str();
        self.0.property::<i32>(key, "MaxBrightness")
    }
    #[zbus(property)]
    fn known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "Known")
    }
    #[zbus(property)]
    fn last_change_source(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "LastChangeSource")
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        let key = self.0.key.as_str();
        self.0.property::<Vec<String>>(key, "Capabilities")
    }
}
#[derive(Clone)]
struct Inhibitor(Node);
#[zbus::interface(name = "org.nidara.PowerInhibitor1")]
impl Inhibitor {
    #[zbus(property)]
    fn source(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Source")
    }
    #[zbus(property)]
    fn what(&self) -> Vec<String> {
        let key = self.0.key.as_str();
        self.0.property::<Vec<String>>(key, "What")
    }
    #[zbus(property)]
    fn who(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Who")
    }
    #[zbus(property)]
    fn reason(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Reason")
    }
    #[zbus(property)]
    fn application_id(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "ApplicationId")
    }
    #[zbus(property)]
    fn pid(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "Pid")
    }
    #[zbus(property)]
    fn uid(&self) -> u32 {
        let key = self.0.key.as_str();
        self.0.property::<u32>(key, "Uid")
    }
    #[zbus(property)]
    fn identity_known(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "IdentityKnown")
    }
    #[zbus(property)]
    fn mode(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Mode")
    }
    #[zbus(property)]
    fn effective(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "Effective")
    }
}
#[derive(Clone)]
struct Menu(Node);
#[zbus::interface(name = "org.nidara.PowerMenuLease1")]
impl Menu {
    #[zbus(property)]
    fn owner(&self) -> String {
        let key = self.0.key.as_str();
        self.0.property::<String>(key, "Owner")
    }
    #[zbus(property)]
    fn consumer_path(&self) -> Path {
        let key = self.0.key.as_str();
        opath(self.0.property::<String>(key, "ConsumerPath"))
    }
    #[zbus(property)]
    fn active(&self) -> bool {
        let key = self.0.key.as_str();
        self.0.property::<bool>(key, "Active")
    }
    async fn menu_shown(
        &self,
        request_id: u64,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<(), Error> {
        self.0
            .power
            .menu_shown(&self.0.key, request_id, &sender(&header)?)
            .await
    }
    async fn release(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<(), Error> {
        self.0
            .power
            .menu_release(&self.0.key, &sender(&header)?)
            .await
    }
}
