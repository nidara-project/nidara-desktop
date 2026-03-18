#!/bin/bash

# Script to restore invisible Antigravity conversation history
# Reconstructs missing .pbtxt annotation files in ~/.gemini/antigravity/annotations/

CONVERSATIONS_DIR="$HOME/.gemini/antigravity/conversations"
ANNOTATIONS_DIR="$HOME/.gemini/antigravity/annotations"

mkdir -p "$ANNOTATIONS_DIR"

echo "Scanning for orphaned conversations in $CONVERSATIONS_DIR..."

cd "$CONVERSATIONS_DIR" || exit 1

for pb_file in *.pb; do
    # Extract session ID (filename without extension)
    session_id="${pb_file%.*}"
    annotation_file="$ANNOTATIONS_DIR/$session_id.pbtxt"
    
    if [ ! -f "$annotation_file" ]; then
        echo "Restoring visibility for session: $session_id"
        # Get last modification time of the .pb file in seconds
        mod_time=$(stat -c %Y "$pb_file")
        # Generate the .pbtxt file
        echo "last_user_view_time:{seconds:$mod_time nanos:0}" > "$annotation_file"
    else
        echo "Session $session_id is already indexed."
    fi
done

echo "Restoration complete. Please restart Antigravity if the history doesn't refresh automatically."
