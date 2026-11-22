# Fly.io

```
fly launch --no-deploy                    # uses the root Dockerfile
fly volumes create auni_data --size 3
```

In `fly.toml`, point the service at the web app, mount the volume, and give moves running as it
stops their two minutes to finish (Fly kills it after 5 seconds otherwise):

```toml
kill_timeout = 150

[http_service]
  internal_port = 3000
  min_machines_running = 1
  auto_stop_machines = "off"

[mounts]
  source = "auni_data"
  destination = "/data"

[env]
  WEB_ORIGIN = "https://<your-app>.fly.dev"
```

Then `fly deploy`. In `fly ssh console`, `node apps/core/bin/auni.mjs pair` prints the link that
pairs your browser, `claude auth login` logs the brain in, and `node apps/core/bin/auni.mjs doctor`
checks the rest. Keep one machine:
Auni runs jobs and watches on its own, so it mustn't stop when idle, and a second on the same
volume can't run.
