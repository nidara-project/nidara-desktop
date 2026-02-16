#!/bin/bash
echo "Stopping AGS..."
pkill ags
sleep 1
pkill -9 ags
sleep 1

echo "Starting AGS with debug logging..."
# Run in background and redirect output
cd /home/angel/Dev/Distroia/ui/ags-v3
ags run . > /tmp/ags.log 2>&1 &

echo "AGS restarted. Logs are being written to /tmp/ags.log"
echo "Waiting for Dock state dump..."
sleep 2

# Tail the log to show the user what's happening
tail -f /tmp/ags.log | grep -E "StateDebug|Dock|DISTROIA"
