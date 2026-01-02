#!/bin/bash
# Zenity wrapper - intercepts file selection dialogs and redirects to custom picker
# Install: sudo mv /usr/bin/zenity /usr/bin/zenity.real && sudo cp zenity-wrapper.sh /usr/bin/zenity && sudo chmod +x /usr/bin/zenity

# IMPORTANT: Update this path to your actual file manager location
APP_PATH="/home/tomiwaf/.local/share/transparent-file-manager"

if [[ "$*" == *"--file-selection"* ]]; then
    MODE="open"
    ARGS=(--picker)
    
    # Parse zenity arguments
    if [[ "$*" == *"--save"* ]]; then
        MODE="save"
        ARGS+=(--mode=save)
        
        # Extract default filename if provided
        for arg in "$@"; do
            if [[ "$arg" == --filename=* ]]; then
                ARGS+=("$arg")
            fi
        done
    elif [[ "$*" == *"--directory"* ]]; then
        MODE="directory"
        ARGS+=(--mode=directory)
    fi
    
    if [[ "$*" == *"--multiple"* ]]; then
        ARGS+=(--multiple)
    fi
    
    # Launch Electron file picker
    cd "$APP_PATH"
    npx electron . "${ARGS[@]}"
    exit $?
else
    # Fallback to real zenity for non-file-selection dialogs (info, warning, etc)
    if [ -f /usr/bin/zenity.real ]; then
        exec /usr/bin/zenity.real "$@"
    else
        echo "Error: Real zenity not found at /usr/bin/zenity.real" >&2
        echo "Please reinstall zenity or restore the original binary" >&2
        exit 1
    fi
fi
