FROM node:24-bookworm-slim

RUN mkdir -p /app /config /data && chown node:node /app /data
COPY --chown=node:node dist/mcp-http-server.js /app/mcp-http-server.js
USER node
WORKDIR /app
ENV HINDSIGHT_REMOTE_CONFIG=/config/remote.json \
    HINDSIGHT_SHARED_STATE_DIR=/data/shared-memory \
    HINDSIGHT_DIAG_FILE=/data/diag.jsonl \
    HINDSIGHT_LOG_FILE=/data/plugin.log \
    HINDSIGHT_USAGE_FILE=/data/usage.jsonl
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e 'const c=JSON.parse((await import("node:fs")).readFileSync(process.env.HINDSIGHT_REMOTE_CONFIG,"utf8")); const req=(await import("node:http")).get("http://127.0.0.1:"+c.port+"/health",{headers:{Host:new URL(c.publicOrigin).host},timeout:4000},r=>{r.resume();process.exit(r.statusCode===200?0:1)});req.on("timeout",()=>req.destroy());req.on("error",()=>process.exit(1))'
ENTRYPOINT ["node", "/app/mcp-http-server.js"]
