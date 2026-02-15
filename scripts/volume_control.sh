#!/bin/bash
LOG_FILE="/tmp/ags-volume.log"
exec 1>>"$LOG_FILE" 2>&1

echo "[$(date)] Volume control called with args: $@"

CMD=$1
VAL=$2

if [ "$CMD" == "set" ]; then
    # wpctl expects 0.0-1.0
    # ensure ./ is replaced if passed? no, JS passes float usually 0.5
    # or ensure LC_NUMERIC match? 
    # lets FORCE dot decimal
    export LC_NUMERIC="C"
    
    # wpctl hangs/fails. Switch to pactl for reliability 🛡️
    # Convert 0.55 -> 55%
    PCT=$(echo "$VAL * 100" | awk '{printf "%.0f", $1}')
    
    # Check if pactl exists
    PACTL=$(which pactl)
    if [ -z "$PACTL" ]; then
        echo "Error: pactl not found"
        notify-send "Volume Error" "pactl not found"
        exit 1
    fi
    
    echo "Executing: $PACTL set-sink-volume @DEFAULT_SINK@ ${PCT}%"
    $PACTL set-sink-volume @DEFAULT_SINK@ "${PCT}%"
    RET=$?
    echo "Exit code: $RET"
    exit $RET
    
elif [ "$CMD" == "get" ]; then
    WPCTL=$(which wpctl)
     out=$($WPCTL get-volume @DEFAULT_AUDIO_SINK@)
     echo "Output: $out"
     echo "$out" # Print to stdout for capturing
fi
