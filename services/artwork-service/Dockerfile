# Optional reproducible container; the service runs natively on Omarchy.
FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.11.15 /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    ARTWORK_DATA_DIR=/data \
    ARTWORK_HOST=127.0.0.1 \
    ARTWORK_PORT=8766

WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

RUN useradd --system --uid 10001 artwork && mkdir -p /data && chown artwork /data
USER artwork
VOLUME ["/data"]
EXPOSE 8766

CMD ["/app/.venv/bin/python", "-m", "artwork_service", "serve"]
