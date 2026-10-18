# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY apps/server/package*.json apps/server/
COPY apps/web/package*.json apps/web/
RUN npm --prefix apps/server ci --ignore-scripts --omit=optional --no-audit --no-fund \
 && npm --prefix apps/web ci --no-audit --no-fund
COPY lib/ lib/
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/
RUN npm --prefix apps/server run build \
 && npm --prefix apps/web run build \
 && npm --prefix apps/server prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production FLEET_DATA_DIR=/var/lib/farhelm \
    FLEET_HOST=0.0.0.0 FLEET_PORT=8443 FLEET_AGENT_PORT=8444 FLEET_WEB_ENABLED=1 \
    FLEET_DEVICE_ACCESS=agent-ssh FLEET_WEB_PROTOCOL=https \
    FLEET_WEB_DIST=/opt/farhelm/apps/web/dist FLEET_AGENT_DIST_DIR=/var/lib/farhelm/agent-dist \
    FLEET_SSH_HOST=0.0.0.0 FLEET_SSH_PORT=2222 \
    FLEET_ACME_ENABLED=1 FLEET_ACME_HTTP_HOST=0.0.0.0 FLEET_ACME_HTTP_PORT=8080
WORKDIR /opt/farhelm
COPY --from=build /build/apps/server/dist apps/server/dist/
COPY --from=build /build/apps/server/node_modules apps/server/node_modules/
COPY --from=build /build/apps/server/package.json apps/server/package.json
COPY apps/server/migrations/ apps/server/migrations/
COPY apps/server/resources/ apps/server/resources/
COPY --from=build /build/apps/web/dist apps/web/dist/
COPY lib/ lib/
COPY deploy/server/bootstrap.mjs deploy/server/healthcheck.mjs deploy/server/
COPY contracts/v1/*.schema.json contracts/v1/
COPY skills/farhelm-api/ skills/farhelm-api/
RUN mkdir -p /var/lib/farhelm && chown node:node /var/lib/farhelm && chmod 700 /var/lib/farhelm
USER node
EXPOSE 8443 8444 2222 8080
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 CMD ["node", "deploy/server/healthcheck.mjs"]
CMD ["node", "deploy/server/bootstrap.mjs"]
