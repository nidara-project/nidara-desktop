import Apps from "gi://AstalApps"
const apps = new Apps.Apps()
apps.list.forEach(a => {
    console.log(`ID: ${a.id} | Name: ${a.name} | WMClass: ${a.wm_class}`)
})
process.exit(0)
