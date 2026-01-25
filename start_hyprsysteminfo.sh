#!/bin/bash
export LD_LIBRARY_PATH=$HOME/Dev/MiDistroIA/local/lib:$LD_LIBRARY_PATH
export XDG_DATA_DIRS=$HOME/Dev/MiDistroIA/local/share:$XDG_DATA_DIRS
exec $HOME/Dev/MiDistroIA/local/bin/hyprsysteminfo "$@"
