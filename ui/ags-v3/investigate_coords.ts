import AstalHyprland from "gi://AstalHyprland"
const hyprland = AstalHyprland.get_default()
const monitors = hyprland.get_monitors()
const clients = hyprland.get_clients()

monitors.forEach(m => {
    console.log(`Monitor ${m.id} (${m.name}):`)
    console.log(`  Geometry: ${m.x},${m.y} ${m.width}x${m.height}`)
    console.log(`  Reserved Array: ${JSON.stringify(m.reserved)}`)

    // Check clients in WS 1 for this monitor
    const ws1Clients = clients.filter(c => c.workspace.id === 1 && c.monitor === m.id)
    console.log(`  WS 1 Clients (${ws1Clients.length}):`)
    ws1Clients.forEach(c => {
        console.log(`    - ${c.title}: x=${c.x}, y=${c.y}, w=${c.width}, h=${c.height}`)
    })
})
