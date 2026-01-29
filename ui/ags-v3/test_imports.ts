import app from "ags/gtk4/app"
import Apps from "gi://AstalApps"

const apps = Apps.get_default()
console.log("Apps found:", apps.get_list().length)
app.quit()
