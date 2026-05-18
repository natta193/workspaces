#!/bin/bash
# Open Firefox in a specific workspace.
# Usage: open-workspace.sh "Workspace Name"
#
# The extension intercepts the URL and opens the named workspace.
# If Firefox is already running, it opens in the existing instance.

NAME="${1:?Usage: open-workspace.sh <workspace-name>}"
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$NAME" 2>/dev/null \
          || printf '%s' "$NAME" | sed 's/ /%20/g;s/&/%26/g')
firefox "https://workspaces.firefox.ext/open/${ENCODED}" &
