#!/usr/bin/env bash
# Remove build workspaces from completed Dagu runs after the retention window.
# Run metadata (a_*/status.jsonl), artifacts, and Dagu logs are preserved.
set -euo pipefail

readonly RUNS_ROOT=/var/lib/alpha-lab/dagu/data/dag-runs
readonly RETENTION_DAYS=7

if [[ ! -d "$RUNS_ROOT" ]]; then
  printf 'Dagu runs directory does not exist: %s\n' "$RUNS_ROOT"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required to identify active Dagu runs; refusing cleanup\n' >&2
  exit 1
fi

removed=0
skipped_active=0
skipped_unknown=0

# The expected layout is:
# <workflow>/dag-runs/<year>/<month>/<day>/<run-id>/work
while IFS= read -r -d '' work_dir; do
  [[ -d "$work_dir" && ! -L "$work_dir" ]] || continue

  run_dir=${work_dir%/work}
  status_files=("$run_dir"/a_*/status.jsonl)
  status_count=0
  active=0

  for status_file in "${status_files[@]}"; do
    [[ -f "$status_file" ]] || continue
    status_count=$((status_count + 1))

    # Dagu appends status snapshots to status.jsonl. Only the final valid
    # snapshot determines whether this attempt completed.
    final_status="$(
      jq -r 'select(type == "object" and (.status? != null)) | .status' \
        "$status_file" 2>/dev/null | tail -n 1 || true
    )"
    case "$final_status" in
      2|3|4|5) ;;
      *) active=1 ;;
    esac
  done

  if (( status_count == 0 )); then
    skipped_unknown=$((skipped_unknown + 1))
    printf 'SKIP no status metadata: %s\n' "$work_dir"
    continue
  fi

  if (( active )); then
    skipped_active=$((skipped_active + 1))
    printf 'SKIP active or incomplete run: %s\n' "$work_dir"
    continue
  fi

  printf 'DELETE completed run workdir: %s\n' "$work_dir"
  rm -rf -- "$work_dir"
  removed=$((removed + 1))
done < <(
  find "$RUNS_ROOT" -xdev -ignore_readdir_race \
    -mindepth 7 -maxdepth 7 -type d -name work -mtime +"$RETENTION_DAYS" \
    -print0
)

printf 'Dagu workdir cleanup complete: removed=%d skipped_active=%d skipped_unknown=%d retention_days=%d\n' \
  "$removed" "$skipped_active" "$skipped_unknown" "$RETENTION_DAYS"
