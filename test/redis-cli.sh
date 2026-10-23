#!/usr/bin/env bash
# Compatibility check against the official Redis command-line tools.
# Starts emberkv, drives it with redis-cli, and fails on any unexpected reply.
# Requires redis-cli on PATH (CI installs the redis-tools package).

set -euo pipefail

PORT=${PORT:-6390}
DIR=$(mktemp -d)
node bin/emberkv.js --port "$PORT" --dir "$DIR" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; rm -rf "$DIR"' EXIT

for _ in $(seq 50); do
  redis-cli -p "$PORT" PING >/dev/null 2>&1 && break
  sleep 0.1
done

failures=0
check() {
  local expected=$1; shift
  local actual
  actual=$(redis-cli -p "$PORT" "$@" 2>&1)
  # Depending on version, non-tty redis-cli may or may not prefix errors with "(error) ".
  actual=${actual#"(error) "}
  if [[ "$actual" == "$expected" ]]; then
    echo "  ok    $*"
  else
    echo "  FAIL  $*"
    echo "        expected: $(printf %q "$expected")"
    echo "        actual:   $(printf %q "$actual")"
    failures=$((failures + 1))
  fi
}

echo "redis-cli $(redis-cli --version | awk '{print $2}') against emberkv on :$PORT"
check "PONG"                  PING
check "OK"                    SET greeting "hello world"
check "hello world"           GET greeting
check ""                      GET missing
check "1"                     INCR visits
check "11"                    INCRBY visits 10
check "3"                     RPUSH queue a b c
check $'a\nb\nc'              LRANGE queue 0 -1
check "2"                     HSET user:1 name ada lang js
check $'name\nada\nlang\njs'  HGETALL user:1
check "1"                     EXPIRE greeting 100
check "100"                   TTL greeting
check "string"                TYPE greeting
check "list"                  TYPE queue
check "WRONGTYPE Operation against a key holding the wrong kind of value" GET queue
check "ERR unknown command 'NOPE', with args beginning with: 'x' " NOPE x
check $'save\n60 1'           CONFIG GET save
check "0"                     PUBLISH news hi
check "OK"                    SAVE
check "4"                     DBSIZE

# MULTI/EXEC through a single redis-cli session
actual=$(printf 'MULTI\nINCR tx\nINCR tx\nEXEC\n' | redis-cli -p "$PORT")
expected=$'OK\nQUEUED\nQUEUED\n1\n2'
if [[ "$actual" == "$expected" ]]; then echo "  ok    MULTI/INCR/INCR/EXEC"; else echo "  FAIL  MULTI/EXEC: $(printf %q "$actual")"; failures=$((failures + 1)); fi

# Large values and binary-safety via stdin (-x reads the last argument from stdin)
head -c 100000 /dev/urandom > "$DIR/blob"
redis-cli -p "$PORT" -x SET blob < "$DIR/blob" >/dev/null
check "100000"                STRLEN blob

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all redis-cli checks passed"

echo
echo "redis-benchmark (official tool) against emberkv:"
redis-benchmark -p "$PORT" -t set,get,incr,lpush -n 100000 -P 16 -q
