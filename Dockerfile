# Auni in one image: core, its jobs, its own Postgres and the web app, as `auni` runs them
# on a laptop. Everything it keeps lives in the /data volume. How to run it: hosts/docker.md.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# `pnpm fetch` reads only the lockfile, so this layer survives day-to-day source edits. The root
# package.json comes along for its packageManager pin.
FROM base AS fetched
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# The web app, built once here so a container starts at once (`auni` would build it first).
FROM fetched AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile && node apps/core/bin/auni.mjs build \
  && rm -rf apps/web/.next/cache

# What runs: production dependencies only, the source, and the built web app.
FROM fetched AS runtime-deps
COPY apps/core/package.json apps/core/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod

FROM node:24-bookworm-slim
# Claude Code's sandbox on Linux: bubblewrap, and socat for its network.
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-deps /app ./
COPY . .
COPY --from=build /app/apps/web/.next apps/web/.next
# The Claude Code that Auni's Agent SDK bundles, as `claude`, to log in with (hosts/docker.md).
RUN ln -s "$(find /app/node_modules/.pnpm -path '*claude-agent-sdk-linux-*/claude' -type f | head -1)" \
  /usr/local/bin/claude

# The volume holds Auni's data folder (its Postgres, keys, secrets), the agent's scratch folder
# beside it, and a home for the brain CLIs' logins.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV AUNI_HOME=/data/auni
ENV HOME=/data/home
USER node

# The web app answers from outside the container; core stays on 127.0.0.1 inside it, reached
# through the web app's /core rewrite like anywhere else.
ENV WEB_HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/core/bin/auni.mjs", "--no-open"]
