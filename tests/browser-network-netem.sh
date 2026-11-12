#!/usr/bin/env bash
# Optional Linux acceptance check. All interface changes occur in a NEW namespace.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1-}" != "--inside" ]]; then
  for executable in unshare ip tc node curl; do
    command -v "$executable" >/dev/null || { echo "Missing test prerequisite: $executable" >&2; exit 1; }
  done
  export SU_TEST_HOST_NETNS="$(readlink /proc/self/ns/net)"
  exec unshare --user --map-root-user --net bash "$0" --inside
fi
# A PostgreSQL Unix socket stays accessible inside the isolated network namespace.
: "${SU_TEST_DATABASE_URL:?Set a test PostgreSQL URL using an accessible Unix-domain socket}"
ip link set lo up
mkdir -p output/playwright/network
SU_TEST_SERVER_PORT=2573
SU_TEST_SERVER_PORT="$SU_TEST_SERVER_PORT" node --import tsx tests/helpers/persistent-test-server.ts >output/playwright/network/netem-server.log 2>&1 &
SU_TEST_SERVER_PID=$!
cleanup() {
  kill "$SU_TEST_SERVER_PID" 2>/dev/null || true
  wait "$SU_TEST_SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for attempt in {1..100}; do
  if curl --silent --fail "http://127.0.0.1:$SU_TEST_SERVER_PORT/health/ready" >/dev/null; then break; fi
  if ! kill -0 "$SU_TEST_SERVER_PID" 2>/dev/null; then cat output/playwright/network/netem-server.log; exit 1; fi
  sleep 0.1
done
curl --silent --fail "http://127.0.0.1:$SU_TEST_SERVER_PORT/health/ready" >/dev/null
# The browser runner applies netem after loading its local resources. Its guard
# verifies that this process is in a different namespace from the invoking shell.
SU_TEST_URL="http://127.0.0.1:$SU_TEST_SERVER_PORT" SU_TEST_PROFILE=rtt200-loss1 SU_TEST_NETWORK_MODE=netem node --import tsx tests/browser-network.ts
tc -s qdisc show dev lo >output/playwright/network/netem-counters.txt
