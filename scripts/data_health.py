"""Validate catalog data and manage bounded-retention, checksummed backups."""

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import time
import zipfile
from contextlib import closing
from datetime import date
from pathlib import Path

import requests
from common import today_sv

FILES = ("prices.db", "siman.db", "events.jsonl", "siman_events.jsonl",
         "quality.json", "notifications.json")
SNAPSHOTS = ("snapshots", "siman_snapshots")
MAX_BYTES = 512 * 1024 * 1024


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=True, indent=2),
                   encoding="utf-8")
    os.replace(tmp, path)


def inspect_data(data_dir, expected_date=None, *, require_runtime=False):
    """Read-only health checks; an empty Siman watchlist is valid."""
    root = Path(data_dir)
    result = {"schema_version": 1, "checked_at": today_sv(), "sources": {}}
    for source, filename, required in (
            ("pricesmart", "prices.db", {"prices", "products"}),
            ("siman", "siman.db", {"prices", "items"})):
        state = {"ok": False, "observed_at": "", "rows": 0, "problems": []}
        result["sources"][source] = state
        path = root / filename
        if not path.is_file():
            state["problems"].append("database missing")
            continue
        try:
            with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro",
                                         uri=True)) as con:
                if con.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise ValueError("SQLite quick_check failed")
                tables = {r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'")}
                if not required <= tables:
                    raise ValueError("required tables missing")
                price_columns = ({"sku", "date", "price", "sign_price",
                                  "saving", "in_stock"}
                                 if source == "pricesmart" else
                                 {"itemId", "date", "price", "list", "qty",
                                  "avail", "card"})
                if not price_columns <= {r[1] for r in con.execute(
                        "PRAGMA table_info(prices)")}:
                    raise ValueError("required price columns missing")
                catalog = "products" if source == "pricesmart" else "items"
                catalog_columns = (
                    {"sku", "title", "brand", "category", "slug", "image"}
                    if source == "pricesmart" else
                    {"itemId", "pid", "title", "brand", "link", "image",
                     "vname", "watch", "talla", "first_seen", "last_seen"})
                if not catalog_columns <= {r[1] for r in con.execute(
                        f"PRAGMA table_info({catalog})")}:
                    raise ValueError("required catalog columns missing")
                observed, count = con.execute(
                    "SELECT MAX(date), COUNT(*) FROM prices").fetchone()
                state["observed_at"], state["rows"] = observed or "", count
                empty_watchlist = False
                if source == "siman" and "sweep_runs" in tables:
                    run = con.execute(
                        "SELECT date, watches FROM sweep_runs "
                        "ORDER BY date DESC LIMIT 1").fetchone()
                    if run:
                        state["observed_at"] = run[0]
                        watches = json.loads(run[1])
                        if not isinstance(watches, list):
                            raise ValueError("invalid watchlist")
                        empty_watchlist = not watches
                if not state["observed_at"] or (not count and not empty_watchlist):
                    raise ValueError("no observations")
                date.fromisoformat(state["observed_at"])
                if (expected_date
                        and state["observed_at"] != expected_date):
                    raise ValueError("source is not current")
                # A metadata date cannot make an old observation fresh.
                if expected_date and not empty_watchlist:
                    current = con.execute(
                        "SELECT COUNT(*) FROM prices WHERE date = ?",
                        (expected_date,)).fetchone()[0]
                    if not current:
                        raise ValueError("no observations for expected date")
                if require_runtime:
                    folder, field, log = (
                        ("snapshots", "products", "events.jsonl")
                        if source == "pricesmart" else
                        ("siman_snapshots", "items", "siman_events.jsonl"))
                    snapshot = root / folder / (state["observed_at"] + ".json")
                    snap = json.loads(snapshot.read_text("utf-8"))
                    if (snap.get("date") != state["observed_at"]
                            or not isinstance(snap.get(field), dict)
                            or (source == "pricesmart" and not snap[field])):
                        raise ValueError("snapshot schema/date invalid")
                    # Empty logs are valid on the first observation. Truncated
                    # writes are not promoted as a new good cache/backup.
                    with (root / log).open(encoding="utf-8") as events:
                        for line in events:
                            if not line.strip():
                                continue
                            event = json.loads(line)
                            if (not isinstance(event, dict)
                                    or not event.get("type")
                                    or not (event.get("sku") or event.get("iid"))):
                                raise ValueError("invalid event log row")
                            date.fromisoformat(event["date"])
                state["ok"] = True
        except (sqlite3.Error, ValueError, OSError, KeyError, TypeError) as exc:
            state["problems"].append(str(exc))
    result["ok"] = all(s["ok"] for s in result["sources"].values())
    return result


def _allowed(name):
    if name in FILES:
        return True
    return any(re.fullmatch(rf"{folder}/\d{{4}}-\d{{2}}-\d{{2}}\.json", name)
               for folder in SNAPSHOTS)


def create_backup(data_dir, output):
    """Use SQLite's backup API, not a potentially torn copy of a live DB."""
    root, output = Path(data_dir), Path(output)
    if output.exists():
        raise ValueError("backup output already exists; choose a new versioned path")
    health = inspect_data(root)
    if not health["ok"]:
        raise ValueError("refusing to back up invalid data")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pricewatch-backup-") as folder:
        stage = Path(folder)
        for name in FILES:
            src, dst = root / name, stage / name
            if not src.is_file():
                continue
            if name.endswith(".db"):
                with closing(sqlite3.connect(src.resolve().as_uri() + "?mode=ro",
                                             uri=True)) as db, closing(
                        sqlite3.connect(dst)) as copy:
                    db.backup(copy)
                    copy.commit()
            else:
                shutil.copyfile(src, dst)
        for name in SNAPSHOTS:
            if (root / name).is_dir():
                for src in (root / name).glob("*.json"):
                    relative = name + "/" + src.name
                    if _allowed(relative):
                        dst = stage / relative
                        dst.parent.mkdir(exist_ok=True)
                        shutil.copyfile(src, dst)
        files = {p.relative_to(stage).as_posix():
                 hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in stage.rglob("*") if p.is_file()}
        atomic_json(stage / "manifest.json",
                    {"schema_version": 1, "created_at": today_sv(),
                     "health": health, "files": files})
        tmp = output.with_name(output.name + ".tmp")
        with tarfile.open(tmp, "w:gz") as archive:
            for p in sorted(stage.rglob("*")):
                if p.is_file():
                    archive.add(p, arcname=p.relative_to(stage).as_posix())
        # Exercise the exact archive before publishing it as a recovery point.
        with tempfile.TemporaryDirectory(prefix="pricewatch-backup-check-") as check:
            restore_backup(tmp, Path(check) / "restored")
        os.replace(tmp, output)
    return output


def restore_backup(archive_path, data_dir):
    """Restore only into an empty runtime, after all hashes/DBs validate."""
    target = Path(data_dir)
    if any((target / name).exists() for name in (*FILES, *SNAPSHOTS)):
        raise ValueError("restore target already has runtime data; not overwriting")
    with tempfile.TemporaryDirectory(prefix="pricewatch-restore-") as folder:
        stage = Path(folder)
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if (sum(m.size for m in members) > MAX_BYTES
                    or len({m.name for m in members}) != len(members)
                    or any(not m.isfile() or not
                           (m.name == "manifest.json" or _allowed(m.name))
                           for m in members)):
                raise ValueError("invalid backup members")
            # Explicit extraction avoids links, traversal and platform surprises.
            for member in members:
                dst = stage / member.name
                dst.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as src, dst.open("wb") as out:
                    shutil.copyfileobj(src, out)
        manifest = json.loads((stage / "manifest.json").read_text("utf-8"))
        hashes = manifest.get("files")
        actual = {p.relative_to(stage).as_posix() for p in stage.rglob("*")
                  if p.is_file() and p.name != "manifest.json"}
        if (manifest.get("schema_version") != 1 or not isinstance(hashes, dict)
                or set(hashes) != actual):
            raise ValueError("invalid backup manifest")
        for name, digest in hashes.items():
            if hashlib.sha256((stage / name).read_bytes()).hexdigest() != digest:
                raise ValueError("backup checksum mismatch")
        if not inspect_data(stage)["ok"]:
            raise ValueError("restored databases failed validation")
        target.mkdir(parents=True, exist_ok=True)
        for name in hashes:
            dst = target / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(stage / name, dst)
    return manifest


def restore_github(data_dir):
    """Read-only Actions API; only trusted Daily runs on main are candidates."""
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    if not repository or not token:
        raise ValueError("GitHub repository/token missing for backup recovery")
    api = f"https://api.github.com/repos/{repository}/actions"
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    response = requests.get(f"{api}/artifacts?per_page=100",
                            headers=headers, timeout=30)
    response.raise_for_status()
    candidates = sorted(
        (a for a in response.json().get("artifacts", [])
         if a["name"].startswith("pricewatch-backup-") and not a["expired"]),
        key=lambda a: a["created_at"], reverse=True)
    for artifact in candidates:
        run = requests.get(f"{api}/runs/{artifact['workflow_run']['id']}",
                           headers=headers, timeout=30)
        run.raise_for_status()
        metadata = run.json()
        if (metadata.get("head_branch") != "main"
                or metadata.get("event") not in ("schedule", "workflow_dispatch")
                or metadata.get("path") != ".github/workflows/daily.yml"):
            continue
        try:
            response = requests.get(artifact["archive_download_url"],
                                    headers=headers, timeout=60)
            response.raise_for_status()
            if len(response.content) > MAX_BYTES:
                raise ValueError("backup download too large")
            with zipfile.ZipFile(io.BytesIO(response.content)) as outer:
                info = outer.getinfo("pricewatch-backup.tar.gz")
                if info.file_size > MAX_BYTES:
                    raise ValueError("backup wrapper too large")
                with tempfile.TemporaryDirectory(
                        prefix="pricewatch-download-") as folder:
                    archive = Path(folder) / "backup.tar.gz"
                    archive.write_bytes(outer.read(info))
                    restore_backup(archive, data_dir)
        except (ValueError, KeyError, zipfile.BadZipFile, tarfile.TarError):
            # Hash/member/schema failures happen before restore writes anything.
            # Never overwrite a runtime, or silently discard a download/I/O error.
            if any((Path(data_dir) / name).exists() for name in (*FILES, *SNAPSHOTS)):
                raise
            print("Rejected invalid backup; trying an older retained artifact")
            continue
        print("Recovered validated data from independent Actions backup")
        return True
    if candidates:
        raise ValueError("retained backups could not be restored; "
                         "refusing cold overwrite")
    print("No retained backup available; cold bootstrap required")
    return False


def verify_site(url, version_path):
    expected = json.loads(Path(version_path).read_text("utf-8"))["built"]
    for attempt in range(8):
        try:
            response = requests.get(url.rstrip("/") + "/version.json",
                                    params={"expected": expected},
                                    headers={"Cache-Control": "no-cache"},
                                    timeout=20)
            response.raise_for_status()
            if response.json().get("built") == expected:
                return True
        except (requests.RequestException, ValueError):
            pass
        if attempt < 7:
            time.sleep(15)
    raise ValueError("published version does not match build; alerts suppressed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "backup", "restore",
                                            "restore-github", "verify-site"))
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--output")
    parser.add_argument("--archive")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--url")
    parser.add_argument("--version", default="docs/version.json")
    args = parser.parse_args()
    if args.command == "check":
        health = inspect_data(args.data_dir, today_sv() if args.fresh else None,
                              require_runtime=True)
        if args.output:
            atomic_json(args.output, health)
        print(json.dumps(health))
        if not health["ok"]:
            raise SystemExit(1)
    elif args.command == "backup":
        if not args.output:
            parser.error("backup requires --output")
        create_backup(args.data_dir, args.output)
    elif args.command == "restore":
        if not args.archive:
            parser.error("restore requires --archive")
        restore_backup(args.archive, args.data_dir)
    elif args.command == "restore-github":
        restore_github(args.data_dir)
    elif args.command == "verify-site":
        if not args.url:
            parser.error("verify-site requires --url")
        verify_site(args.url, args.version)


if __name__ == "__main__":
    main()
