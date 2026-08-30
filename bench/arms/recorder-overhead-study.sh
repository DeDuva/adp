#!/usr/bin/env bash
# One sitting of arm 5, paired: every (task, rep) run in both conditions.
#
# Sequential on purpose. The measurement is per-trial cost and wall clock, and
# running two agents at once on one machine would put contention into the wall
# clock of whichever pair happened to overlap — a variable this arm is not
# measuring and cannot subtract afterwards.
#
# Ordered condition-inner rather than condition-outer, so `off` and `on` for a
# given (task, rep) are adjacent in time. Anything that drifts over the sitting
# — a model update, a machine getting busier — then lands on both halves of a
# pair rather than on one column.
set -euo pipefail

REPS=${REPS:-10}
COHORT=${COHORT:-study}
TASKS=${TASKS:-"clamp titlecase"}
ROOT=${ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/adp-arm5-XXXXXX")}
OUT_DIR=${OUT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../runs" && pwd)}

: "${ADP_SERVER_URL:?set it — see scripts/dev/local.sh}"
: "${ADP_TOKEN:?set it}"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
echo "arm5 cohort=$COHORT reps=$REPS tasks='$TASKS' root=$ROOT"

for rep in $(seq 1 "$REPS"); do
  for task in $TASKS; do
    for condition in off on; do
      out="$OUT_DIR/recorder-overhead-$COHORT-$condition-$task-r$rep.json"
      if [ -f "$out" ]; then
        echo "skip $condition $task r$rep (already recorded)"
        continue
      fi
      # A failed trial does not stop the sitting: the arm is stochastic, and a
      # crashed trial is a missing record rather than a reason to discard the
      # ones already paid for. The report counts what it finds.
      node "$here/recorder-overhead.mjs" \
        --condition="$condition" --task="$task" --rep="$rep" --cohort="$COHORT" \
        --root="$ROOT" --out="$out" "$@" || echo "  trial failed: $condition $task r$rep"
    done
  done
done

echo "arm5 done — $(ls "$OUT_DIR" | grep -c "recorder-overhead-$COHORT-") record(s)"
