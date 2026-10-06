#!/bin/sh
# CMake compiler launcher: hot-path-launcher.sh <opt> <colon-separated dirs> <compiler> <args...>
# Replaces the size optimization flag with -<opt> for sources under one of the absolute
# directories, so speed-critical libraries can be optimized for speed while the rest of the
# module stays size-optimized. Function attributes carry the level through LTO.
set -eu
opt=$1
dirs=$2
shift 2

hot=0
for arg in "$@"; do
	case $arg in
	*.c | *.cc | *.cpp)
		old_ifs=$IFS
		IFS=:
		for dir in $dirs; do
			case $arg in
			"$dir"/*) hot=1 ;;
			esac
		done
		IFS=$old_ifs
		;;
	esac
done

if [ "$hot" = 1 ]; then
	for arg in "$@"; do
		shift
		case $arg in
		-Oz | -Os) set -- "$@" "-$opt" ;;
		*) set -- "$@" "$arg" ;;
		esac
	done
fi
exec "$@"
