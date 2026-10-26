# Metal Craft artwork service

Local processing service for the Metal Admin production workflow: traces each
product's first catalog image once into a reusable vector master, sizes masters
to millimetres, checks fit, and runs nesting/DXF export jobs. It runs on the
Omarchy Linux PC, bound to `127.0.0.1`. Interfaces are fixed in
[`CONTRACT.md`](CONTRACT.md); tracing qualification is recorded in
[`docs/real-fixture-qualification.md`](docs/real-fixture-qualification.md).

## Layout

| Module | Role |
|---|---|
| `api.py`, `auth.py`, `contracts.py` | FastAPI routes, bearer token + business scoping + edit permission, idempotency, request validation |
| `storage.py` | SQLite schema (WAL), job state trigger, content-addressed artifact files |
| `jobs.py`, `worker.py` | Durable queue (leases, heartbeats, attempts, cancellation, recovery) and worker processes |
| `catalog_source.py` | HTTPS fetch of first images from allowlisted media hosts with SSRF protection and limits |
| `tracing.py`, `geometry.py` | Deterministic image → vector master tracing (`opencv-contours` engine behind an adapter) |
| `sizing.py` | Aspect-locked sizing, usable-sheet fit checks, feature-width checks |
| `products.py`, `batches.py` | Preparation/master cache and the trace job; batch snapshots and the nest job |
| `nesting.py`, `gap_fill.py`, `validation.py`, `dxf_export.py` | Nesting, gap filling, independent layout validation and DXF/ZIP export (separate work unit; imported lazily by the nest job) |

## Requirements

- Python 3.12 managed by [uv](https://docs.astral.sh/uv/) (`uv python install 3.12`).
  Never install into the system Python (3.14 on Omarchy).
- Dependencies are pinned in `pyproject.toml` and locked in `uv.lock`.

```sh
cd services/artwork-service
uv sync                 # creates .venv with the locked dependencies
uv run pytest -q        # full test suite (~65 s); real fixtures: -m real
(cd tests/js && npm ci) # optional: enables the JavaScript DXF read-back test
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ARTWORK_SERVICE_TOKEN` | — (required, ≥16 chars) | Shared bearer token; the same value is a Metal Admin server secret |
| `ARTWORK_DATA_DIR` | `/home/echo/.local/share/metal-craft-artwork/dev` | SQLite database, artifacts, cached source images |
| `ARTWORK_HOST` / `ARTWORK_PORT` | `127.0.0.1` / `8766` | Bind address; keep loopback |
| `ARTWORK_WORKERS` | `1` | Worker processes (CPU jobs run one per process) |
| `ARTWORK_LEASE_SECONDS` | `30` | Job lease; an expired lease is recovered |
| `ARTWORK_MAX_ATTEMPTS` | `3` | Leases per job before it fails with `TIMEOUT` |
| `ARTWORK_TRACE_TIMEOUT_S` | `300` | Per trace job; nest jobs get budget × groups + 600 s |
| `ARTWORK_MIN_FREE_BYTES` | `268435456` | Free space to keep; below it jobs fail with `INSUFFICIENT_DISK` |
| `ARTWORK_FETCH_MAX_BYTES` | `41943040` | Maximum source image size |
| `ARTWORK_ALLOWED_SOURCES` | `convex.echoray.io/api/storage/,cdn.echoray.io` | `host[/path-prefix]` list the fetcher may contact (HTTPS, port 443 only) |
| `ARTWORK_TEST_FIXTURE_DIR` | unset | **Acceptance testing only.** Serves `test-fixture://local/<name>` source URLs from this directory; unset, such URLs fail with `SOURCE_HOST_NOT_ALLOWED`. Logged as a warning at start. Never set it in production |

Use separate data directories for development, tests (pytest uses temporary
directories) and production, e.g. `.../metal-craft-artwork/dev` and
`.../metal-craft-artwork/prod`. Keep the data directory outside the checkout.

## Start, stop, logs

```sh
export ARTWORK_SERVICE_TOKEN="$(cat ~/.config/metal-craft-artwork/token)"   # any secret ≥16 chars
scripts/run-dev.sh                       # = uv run python -m artwork_service serve
```

`serve` starts the API on `127.0.0.1:8766` and `ARTWORK_WORKERS` worker
processes. At start it requeues jobs left `running` by a previous run (so a
crash or reboot resumes work; attempts are counted). Stop with Ctrl-C or
`SIGTERM`: the API shuts down gracefully and workers get 10 s to finish; a job
interrupted mid-way is requeued at the next start. Do not run two `serve`
instances against one data directory.

Logs go to stdout/stderr (run under `systemd --user` or a terminal to keep
them). Requests are not access-logged; tokens and signed URL query strings
are never logged.

Health check:

```sh
curl -s -H "Authorization: Bearer $ARTWORK_SERVICE_TOKEN" -H "X-Artwork-Business-Id: <business>" \
  http://127.0.0.1:8766/v1/health
```

`worker_ready` is true while at least one worker heartbeat is fresher than 30 s.

Diagnostic trace of a local file (does not touch the database; not an API path):

```sh
uv run python -m artwork_service trace-file tests/fixtures/real/flower.png /tmp/flower-trace
```

## Acceptance run

```sh
(cd tests/js && npm ci)                  # independent JS DXF reader (dxf-parser), test-only
uv run python scripts/acceptance.py      # ~5 min; needs port 8766 free
```

The script creates a fresh `~/.local/share/metal-craft-artwork/acceptance`,
starts the service there with a random token and the test fixture source,
drives plan section 13 over HTTP (including `kill -9` and restart of the
service), and writes `acceptance-report.json` plus downloaded packages under
`evidence/`. Results are recorded in
[`docs/artwork-production-acceptance.md`](../../docs/artwork-production-acceptance.md).

## Backup and restore

Masters and completed batches are immutable and are never re-derived by
retracing, so the backup must keep the database and files together.

```sh
uv run python -m artwork_service backup /path/to/backups/artwork-2026-10-25
```

This takes a consistent SQLite online backup, then copies `artifacts/` and
`sources/`. Files are written (and fsynced) before the database rows that
reference them commit, so every file referenced by the snapshot is copied.
Backups can be taken while the service runs.

Restore (service stopped):

```sh
mv "$ARTWORK_DATA_DIR" "$ARTWORK_DATA_DIR.old"
mkdir -p "$ARTWORK_DATA_DIR"
cp -a /path/to/backups/artwork-2026-10-25/. "$ARTWORK_DATA_DIR/"
scripts/run-dev.sh   # running jobs from the snapshot are requeued at start
```

Verify with `GET /v1/masters/{id}` and `GET /v1/batches/{id}` for known IDs;
artifact files are content-addressed (`artifacts/<sha[:2]>/<sha256>`), so
`sha256sum` of any file must equal its name.

## Behaviour notes

- **Trace once.** Masters are cached by `business + source SHA-256 + engine/version + settings hash`
  with a unique constraint, and a build claim makes concurrent duplicate
  prepares wait for one trace. `reprocess: true` refetches the source; if the
  bytes and settings are unchanged it reuses the existing master (tracing is
  deterministic), otherwise it creates a new master revision. Older masters
  and batches are never modified.
- **Stale masters.** `/v1/products/status` reports `stale` when the catalog's
  first-image identity/version differs from the active master's source. A
  software upgrade (new tracer version) does not retrace existing masters.
- **Fit before nesting.** Batch creation fails lines that cannot fit the usable
  sheet (sheet minus margins) in any allowed rotation, with dimensions.
- **Completed means complete.** A batch is `completed`, with downloadable DXFs
  and ZIP, only when every requested instance is placed on an independently
  validated layout and every DXF passed read-back verification. Otherwise it
  is `incomplete` (SVG previews and counts only), `failed` or `cancelled`.
- **Fabrication profiles** start with unknown feature limits; batch lines then
  report `feature_check.status = "unknown"`, never a pass.

## Container (optional)

`Dockerfile` builds the same locked environment for reproducibility and a
later VPS move; it is not needed on Omarchy or Windows.

```sh
docker build -t metal-craft-artwork services/artwork-service
docker run --rm -p 127.0.0.1:8766:8766 -e ARTWORK_SERVICE_TOKEN=... \
  -e ARTWORK_HOST=0.0.0.0 -v metal-craft-artwork:/data metal-craft-artwork
```
