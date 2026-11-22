# Railway

1. New project, from this repo: Railway builds the root `Dockerfile`.
2. Add a volume mounted at `/data`.
3. Variables: `WEB_ORIGIN` = the service's public URL (`https://<your-service>.up.railway.app`),
   `PORT=4000`: Railway hands the service a `PORT` of its own, which is core's setting here, so
   pin it, and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=150`, so moves running as it stops get their
   two minutes to finish (Railway kills it at once otherwise). Under Networking, generate a
   domain with target port `3000` (the web app).
4. Deploy. In `railway ssh`, `node apps/core/bin/auni.mjs pair` prints the link that pairs your
   browser, `claude auth login` logs the brain in, and `node apps/core/bin/auni.mjs doctor` checks
   the rest.

One replica only: a second Auni on the same database says it is already running and stops.
