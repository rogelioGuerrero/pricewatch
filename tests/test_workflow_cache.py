"""Keep the historical Actions cache compatible with the pre-migration release."""
import re
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/daily.yml"
# Ordered inputs from 8c1f7bd: changing these changes the Actions cache version.
LEGACY_CATALOG_PATHS = (
    "data/prices.db",
    "data/siman.db",
    "data/snapshots/",
    "data/siman_snapshots/",
    "data/events.jsonl",
    "data/siman_events.jsonl",
)


def _steps():
    return re.split(r"(?m)^      - ", WORKFLOW.read_text(encoding="utf-8"))[1:]


def _cache_step(action, prefix):
    matches = [
        step for step in _steps()
        if f"uses: actions/cache/{action}@v4" in step
        and f"\n          key: {prefix}" in step
    ]
    assert len(matches) == 1
    return matches[0]


def _paths(step):
    match = re.search(r"(?m)^          path: (.+)$", step)
    assert match
    value = match[1].strip()
    if value != "|":
        return (value,)
    result = []
    for line in step[match.end():].splitlines():
        if line.startswith("            "):
            result.append(line.strip())
        elif line.strip():
            break
    return tuple(result)


def test_catalog_cache_preserves_original_ordered_paths_and_prefix():
    for action in ("restore", "save"):
        step = _cache_step(action, "pwdata-")
        assert _paths(step) == LEGACY_CATALOG_PATHS
    assert "restore-keys: pwdata-" in _cache_step("restore", "pwdata-")


def test_notification_receipts_use_their_own_cache_and_survive_delivery_failure():
    restore = _cache_step("restore", "pwnotify-")
    save = _cache_step("save", "pwnotify-")
    for step in (restore, save):
        assert _paths(step) == ("data/notifications.json",)
    assert "restore-keys: pwnotify-" in restore
    assert "always() && steps.health.outcome == 'success'" in save
    assert "hashFiles('data/notifications.json') != ''" in save


def test_receipts_restore_after_backup_and_never_overwrite_existing_receipts():
    steps = _steps()
    backup = next(
        step for step in steps
        if "run: python scripts/data_health.py restore-github" in step
    )
    receipts = _cache_step("restore", "pwnotify-")
    assert steps.index(backup) < steps.index(receipts)
    assert "if: hashFiles('data/notifications.json') == ''" in receipts
