#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1-}" != "--inside" ]]; then
  for executable in unshare ip tc node; do
    command -v "$executable" >/dev/null || { echo "Missing test prerequisite: $executable" >&2; exit 1; }
  done
  export SU_TEST_HOST_NETNS="$(readlink /proc/self/ns/net)"
  exec unshare --user --map-root-user --net bash "$0" --inside
fi
: "${SU_TEST_DATABASE_URL:?Set a test PostgreSQL URL using an accessible Unix-domain socket}"
ip link set lo up
export SU_STREAMING_NETEM=1
export SU_STREAMING_RTT=200
export SU_STREAMING_OUTPUT="${SU_STREAMING_OUTPUT:-output/large-map/l5/netem}"
exec node --import tsx tests/streaming-load.ts
