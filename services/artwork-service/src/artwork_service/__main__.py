"""Command line entry point.

    python -m artwork_service serve              # API + worker processes
    python -m artwork_service worker             # worker processes only
    python -m artwork_service backup DEST        # consistent DB + artifact snapshot
    python -m artwork_service trace-file IMG OUT # diagnostic trace of a local file (no database)
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import signal
import sqlite3
import sys
import threading
import time
from pathlib import Path

from .config import Config, ConfigError

log = logging.getLogger("artwork_service")


def _setup_logging() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(processName)s[%(process)d] %(name)s: %(message)s")


def _recover_at_startup(config: Config) -> None:
    from . import jobs
    from .storage import Database

    db = Database(config.db_path)
    db.init()
    with db.tx() as conn:
        recovered = jobs.recover_expired(conn, all_running=True)
        conn.execute("DELETE FROM workers")
    if recovered:
        log.info("recovered %d job(s) abandoned by a previous run", recovered)


def _exit_on_signal(signum: int, _frame: object) -> None:
    raise SystemExit(128 + signum)


def cmd_serve(config: Config) -> None:
    import uvicorn

    from .api import create_app
    from .worker import Supervisor

    config.ensure_dirs()
    _recover_at_startup(config)
    app = create_app(config)
    supervisor = Supervisor(config)
    supervisor.start()
    log.info("artwork service on http://%s:%d (data dir %s, %d worker(s))", config.host, config.port,
             config.data_dir, config.worker_concurrency)
    # uvicorn re-raises SIGTERM after its graceful shutdown; turning it into
    # SystemExit lets the finally block stop the workers cleanly.
    signal.signal(signal.SIGTERM, _exit_on_signal)
    try:
        uvicorn.run(app, host=config.host, port=config.port, log_level="info", access_log=False)
    finally:
        log.info("stopping workers")
        supervisor.stop()


def cmd_worker(config: Config) -> None:
    from .worker import Supervisor

    config.ensure_dirs()
    _recover_at_startup(config)
    supervisor = Supervisor(config)
    supervisor.start()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    supervisor.stop()


def cmd_backup(config: Config, dest: Path) -> None:
    """Snapshot the database with SQLite's online backup, then copy the
    content-addressed files. Files are written before the rows that reference
    them commit, so every file the snapshot references already exists."""
    dest.mkdir(parents=True, exist_ok=False)
    src = sqlite3.connect(config.db_path)
    out = sqlite3.connect(dest / config.db_path.name)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    for sub in (config.artifacts_dir, config.sources_dir):
        if sub.exists():
            shutil.copytree(sub, dest / sub.name, dirs_exist_ok=True)
    print(json.dumps({"backup": str(dest), "database": str(dest / config.db_path.name)}))


def cmd_trace_file(image: Path, out_dir: Path) -> None:
    import resource

    from .tracing import TraceError, trace_image

    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    try:
        result = trace_image(image.read_bytes())
    except TraceError as exc:
        print(json.dumps({"status": "failed", "error": exc.to_dict()}, indent=2))
        sys.exit(2)
    stem = image.stem
    (out_dir / f"{stem}.master.json").write_text(json.dumps(result.master_document()))
    (out_dir / f"{stem}.svg").write_text(result.svg)
    (out_dir / f"{stem}-overlay.png").write_bytes(result.overlay_png)
    (out_dir / f"{stem}-solid.png").write_bytes(result.solid_png)
    print(json.dumps({
        "status": "ok", "components": len(result.components), "holes": result.holes,
        "vertex_count": result.vertex_count, "aspect_ratio": result.aspect_ratio,
        "runtime_s": round(time.perf_counter() - started, 3),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "warnings": [w["code"] for w in result.diagnostics["warnings"]],
    }, indent=2))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="artwork-service")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve", help="run the API and worker processes")
    sub.add_parser("worker", help="run worker processes only")
    backup = sub.add_parser("backup", help="write a consistent backup to a new directory")
    backup.add_argument("dest", type=Path)
    trace = sub.add_parser("trace-file", help="diagnostic trace of a local image (does not touch the database)")
    trace.add_argument("image", type=Path)
    trace.add_argument("out_dir", type=Path)
    args = parser.parse_args(argv)
    _setup_logging()
    if args.command == "trace-file":
        cmd_trace_file(args.image, args.out_dir)
        return
    try:
        config = Config.from_env()
    except ConfigError as exc:
        parser.error(str(exc))
    if args.command == "serve":
        cmd_serve(config)
    elif args.command == "worker":
        cmd_worker(config)
    elif args.command == "backup":
        cmd_backup(config, args.dest)


if __name__ == "__main__":
    main()
