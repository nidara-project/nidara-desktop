#!/bin/bash
# Master launcher for DistroIA

# Check if running in Development Mode (User's home)
if [ -d "$HOME/Dev/DistroIA" ]; then
    echo "🔧 Running in Development Mode..."
    bash "$HOME/Dev/DistroIA/scripts/start_dock.sh" &
    bash "$HOME/Dev/DistroIA/scripts/start_topbar.sh" &
else
    # Fallback to System Install (/opt)
    echo "🚀 Running in System Mode..."
    if [ -x "/opt/midistroia/scripts/start_dock.sh" ]; then
        /opt/midistroia/scripts/start_dock.sh &
    fi
    if [ -x "/opt/midistroia/scripts/start_topbar.sh" ]; then
        /opt/midistroia/scripts/start_topbar.sh &
    fi
fi
