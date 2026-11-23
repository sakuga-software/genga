# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t genga .
# The two images must use the same Alpine release: the final image runs the node binary of the first.
ARG NODE_IMAGE=node:22-alpine3.24
ARG ALPINE_IMAGE=alpine:3.24

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.15.0
RUN npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/genga/package.json packages/genga/
COPY apps/server/package.json apps/server/
COPY examples/react-router/package.json examples/react-router/
RUN pnpm install --frozen-lockfile --filter "genga-server..."
COPY packages/genga packages/genga
COPY apps/server apps/server
RUN pnpm --filter genga build \
  && pnpm --filter genga-server build \
  && pnpm --filter genga-server deploy --prod /out \
  && mkdir -p /out/node_modules/genga \
  && cp -r packages/genga/package.json packages/genga/bin packages/genga/migrations /out/node_modules/genga/ \
  && cp -r apps/server/build apps/server/server.mjs /out/

FROM ${ALPINE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="Genga" \
  org.opencontainers.image.description="Genga headless CMS: admin, public JSON API and live preview for any site." \
  org.opencontainers.image.source="https://github.com/sakuga-software/genga" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="${VERSION}"
# The runtime needs the node binary only: no npm, corepack or yarn.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++ tini \
  && node --version \
  && addgroup -S -g 10001 genga \
  && adduser -S -D -H -u 10001 -G genga genga \
  && mkdir -p /data/media /config \
  && chown -R genga:genga /data
WORKDIR /app
COPY --from=build --chown=root:root /out/package.json /out/server.mjs ./
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/build ./build
ENV NODE_ENV=production \
  PORT=3000 \
  GENGA_MEDIA_DIR=/data/media
USER genga
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node node_modules/genga/bin/genga-migrate.mjs && exec node server.mjs"]
