declare module "gi://AstalHyprland" {
    import AstalHyprland from "astal/hyprland";
    export default AstalHyprland;
}

declare module "gi://AstalApps" {
    import AstalApps from "astal/apps";
    export default AstalApps;
}

declare namespace Apps {
    import AstalApps from "astal/apps";
    export type Application = AstalApps.Application;
}
