# Hosts

Auni is one program (`auni`), so running it anywhere is running that program and keeping its
data folder (`AUNI_HOME`). Pick a recipe:

| Where                   | Recipe                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This machine, always on | `auni service install`: a systemd user service on Linux (`systemd/auni.service`), a launchd agent on a Mac (`launchd/io.auni.plist`), running `auni --no-open`, so `auni update` updates it and `auni stop` stops it. `auni service uninstall` removes it. |
| A container             | [docker.md](docker.md): the root `Dockerfile`, one image, a `/data` volume                                                                                                                                                                                 |
| Railway                 | [railway.md](railway.md): that image, with a volume                                                                                                                                                                                                        |
| Fly.io                  | [fly.md](fly.md): that image, with a volume                                                                                                                                                                                                                |

Wherever it runs, `auni doctor` says what works and what to fix. With no browser on the machine,
Auni says where it is as it starts, and `auni pair` prints the link that pairs a browser.

On a server, the web app is the one door in: set `WEB_ORIGIN` to the address the browser opens
(`https://auni.example.com`), so pairing links point there and the app accepts its requests, and
put HTTPS in front of it (the platform's, or a proxy of your own). Core stays on 127.0.0.1 inside.

## Always on, through Tailscale

The first-class way to keep Auni running and reach it from every device you own: a machine that
stays on (a home server, a Mac mini, a VPS), signed in to Tailscale as you, with HTTPS
certificates turned on for your tailnet (the DNS page of Tailscale's admin console). On it, run:

```
auni up --always-on [--port <n>] [--json]
```

It is safe to run again, and each run does what is left:

1. Reads `tailscale status --json`: this machine must be your own (not a tagged device), with
   HTTPS on. Your login there is the owner from now on.
2. Picks the port: `--port`, else the one Auni's door is served on already, else 443, else the
   first of 8443, 8444... that Tailscale serves nothing else on, and says which. The address
   carries it (`https://<machine>.<tailnet>.ts.net:8444`), so open the one it reports.
3. Writes `TAILSCALE_OWNER` (that login) and `WEB_ORIGIN` (`https://<machine>.<tailnet>.ts.net`,
   with `:<port>` unless it is 443) into `~/.auni/.env`.
4. Stops the Auni running here, if one is, and installs and starts it as a service.
5. On Linux, turns on lingering (`loginctl enable-linger`), so the service starts at boot and
   runs with nobody logged in.
6. Runs `tailscale serve --bg --https=<port> unix:~/.auni/serve/auni.sock`. Serving a unix
   socket takes root, so it asks for your password here; with `--json`, or with no terminal, it
   asks nothing and reports the `sudo` command for you to run.
7. Waits for `WEB_ORIGIN/core/health` to answer through Tailscale.

`--json` prints one object, and the exit code is 0 only when nothing is left to fix:

```
{
  "ok": false,
  "address": "https://box.tailnet-example.ts.net",
  "owner": "you@example.com",
  "machine": "box",
  "steps": [
    { "step": "tailscale", "status": "done", "says": "On your tailnet as box.tailnet-example.ts.net." },
    ...
    { "step": "serve", "status": "fix", "says": "...", "run": "sudo tailscale serve --bg --https=443 unix:/home/you/.auni/serve/auni.sock" }
  ],
  "staysOn": { "stays": true, "laptop": false, "says": "Auni starts when this machine does, and keeps running." }
}
```

Each step is `tailscale`, `port`, `settings`, `service`, `linger` (Linux), `serve` or `reaches`,
and its `status` is `done`, `note` or `fix`; a `fix` may carry the command that does it (`run`).
A step that fails before the settings are written (`tailscale`, `port`) changes nothing. A
handover (`auni take-over`) runs it with `--port` set to the one it told the laptop, so the
laptop's page sends the owner to the very address this reports.

Once it is up, Auni answers only requests that `tailscale serve` brings to that socket, which sits
in a folder only you and root can open: one `Tailscale-User-Login`, yours, from another of your
devices. Nothing pairs, no cookie counts, and core's own port answers no owner route. A request
from the machine itself is refused, since Tailscale would name you as its sender whichever
process here made it, so open Auni from your phone or laptop. A device you remove from your
tailnet is out at once. `auni doctor` checks that Tailscale still sends the address to Auni, that
the machine is still yours on it, and whether the machine keeps Auni running.
