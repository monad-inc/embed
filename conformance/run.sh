#!/usr/bin/env bash
# Run the conformance suite against one or more routers.
#   ./run.sh              # all: python go ts
#   ./run.sh python go    # a subset
set -uo pipefail
cd "$(dirname "$0")"

PY=.venv/bin/python
ROUTERS="${*:-python go ts}"

# The TS router runs from its built standalone package.
if [[ " $ROUTERS " == *" ts "* ]]; then
	echo "=== building @monad-inc/embed-server (for ts router) ==="
	(cd ../routers/typescript && pnpm build >/dev/null)
fi

rc=0
for r in $ROUTERS; do
	echo ""
	echo "======================== conformance: $r ========================"
	if ROUTER="$r" "$PY" -m pytest -q; then
		echo "--- $r: PASS ---"
	else
		echo "--- $r: FAIL ---"
		rc=1
	fi
done
exit $rc
