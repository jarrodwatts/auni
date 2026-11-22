# Docker

One image runs all of Auni: core, its jobs, its own Postgres and the web app. Everything it keeps
is in the `/data` volume: its data folder (`AUNI_HOME=/data/auni`: your `.env`, the database, the wallet's keys, its
secrets), the agent's scratch folder, and a home for the brain CLIs' logins (`/data/home`). Lose
the volume and you lose the keys: back it up, or keep the keys Settings shows.

```
docker build -t auni .
docker run -d --name auni --stop-timeout 150 -v auni:/data -p 127.0.0.1:3000:3000 auni
docker exec auni node apps/core/bin/auni.mjs pair  # the link that pairs your browser
docker exec -it auni claude auth login             # the brain, once; kept in the volume
docker exec auni node apps/core/bin/auni.mjs doctor
```

`-p 127.0.0.1:3000:3000` keeps the app on this machine; open http://localhost:3000.
`--stop-timeout 150` gives moves running as it stops their two minutes to finish; `docker stop`
otherwise kills it after 10 seconds. Settings go
in as environment variables (`-e RPC_URL_MONAD=…`, the names in `apps/core/.env.example`); set
`WEB_ORIGIN` when the browser opens it at another address.

The image carries Claude Code (the one Auni's Agent SDK bundles) as `claude`. Codex isn't in it:
build an image `FROM auni` that runs `npm install -g @openai/codex`, then
`docker exec -it auni codex login --device-auth`.

The brain's box is Claude Code's sandbox, bubblewrap, which needs user namespaces. Docker's
default seccomp profile refuses them, so if `doctor`'s brain line or a turn says the sandbox
can't start, run with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined`
(not `--privileged`). Not yet tried in a container: no Docker was at hand when this was written.
