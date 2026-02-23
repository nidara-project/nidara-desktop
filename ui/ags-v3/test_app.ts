import app from "gi://Astal?version=3.0"
console.log("App keys:", Object.keys(app))
console.log("App configDir:", (app as any).configDir)
console.log("App config_dir:", (app as any).config_dir)
console.log("App directory:", (app as any).directory)
process.exit(0)
