FROM oven/bun:1.3.12

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DEDUP_DB_PATH=/app/data/dedup.sqlite

# All runtime imports are built into Bun; no npm dependencies are required.
COPY --chown=bun:bun index.ts package.json ./
COPY --chown=bun:bun public ./public
RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/dedup/config`); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "index.ts"]
