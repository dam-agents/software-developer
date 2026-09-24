#!/usr/bin/env bash
# run.sh — offline test runner. Discovers and runs every scripts/tests/test_*.sh;
# a test file exits non-zero on failure.
#
# Each test sandboxes its own $HOME under a temp dir, never touching a real
# work/, and stubs gh and curl by prepending scripts/tests/bin to PATH, so the
# suite needs no network and no credentials. A behavior change in a script
# updates its test case in the same PR.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
pass=0; fail=0
for t in "$DIR"/test_*.sh; do
  [ -e "$t" ] || { echo "no tests found in $DIR"; exit 0; }
  name="$(basename "$t")"
  if bash "$t"; then
    echo "PASS  $name"; pass=$((pass + 1))
  else
    echo "FAIL  $name"; fail=$((fail + 1))
  fi
done
echo "tests: $pass pass, $fail fail"
[ "$fail" -eq 0 ] || exit 1
