#!/bin/sh
# Can another type checker replace tsgo for this project?
#
# Two hard requirements, in order:
#   1. EVALUATE the type-level program: conditional types, template-literal
#      `infer`, tail recursion with a tuple accumulator, variadic tuples,
#      indexed access, and default type parameters.
#   2. RETURN the resolved type as text, so the host can read the result back.
#      The driver uses checker.getTypeFromTypeNode + typeToString(NoTruncation)
#      (see packages/playground/evaluate/ts.ts). A diagnostics-only checker can
#      at best leak a TRUNCATED type through an error message, which cannot
#      carry doom's ~4MB memory state. See ./print-type.mjs for requirement 2.
#
# This script tests requirement 1 only, in a formatting-independent way: each
# feature has an ok.ts (asserts the correct value) and a bad.ts (asserts a wrong
# one). A tool PASSes only if ok.ts is clean AND bad.ts reports an error, which
# means it actually computed the value rather than skipping or guessing.
#
# Usage: ./run-all.sh              # every candidate
#        ./run-all.sh tsgo ezno    # a subset
cd "$(dirname "$0")" || exit 1
CANDS=${*:-$(ls candidates)}
TESTS=$(ls -d tests/t*/ | sed 's|tests/||;s|/$||')
printf '%-12s' CANDIDATE; for t in $TESTS; do printf '%-11s' "$(echo "$t" | cut -c1-10)"; done; printf ' %s\n' NOTE
for c in $CANDS; do
  A=candidates/$c/adapter.sh
  [ -x "$A" ] || continue
  P=$("$A" --probe 2>&1)
  case "$P" in
    AVAILABLE*)
      printf '%-12s' "$c"
      for t in $TESTS; do
        ok=$("$A" "tests/$t/ok" 2>&1);  bad=$("$A" "tests/$t/bad" 2>&1)
        ok_clean=$(printf '%s' "$ok"  | grep -ciE 'error( TS[0-9]+)?:' || true)
        bad_err=$(printf '%s' "$bad" | grep -ciE 'error( TS[0-9]+)?:' || true)
        if [ "$ok_clean" -eq 0 ] && [ "$bad_err" -gt 0 ]; then printf '%-11s' PASS
        elif [ "$ok_clean" -gt 0 ] && [ "$bad_err" -gt 0 ]; then printf '%-11s' 'FAIL(ok!)'
        else printf '%-11s' 'FAIL(blind)'; fi
      done
      printf ' %s\n' "${P#AVAILABLE }" ;;
    *)
      printf '%-12s' "$c"; for t in $TESTS; do printf '%-11s' n/a; done; printf ' %s\n' "$P" ;;
  esac
done
cat <<'TXT'

Legend: PASS = evaluated correctly. FAIL(ok!) = rejected valid code.
        FAIL(blind) = accepted the wrong answer, i.e. did not evaluate.
Requirement 2 (resolve + print a type) is checked by ./print-type.mjs.
TXT
