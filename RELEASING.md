# Releasing Auni

An owner's Auni only ever becomes a release that this project's owner made, because each release
is signed with a key that never goes near GitHub. GitHub only carries the files. Whoever gets into
the GitHub account can't make a release Auni would take.

## What a release is

`pnpm release` makes three files. GitHub's release page carries them.

| File              | What it is                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `source.tar.gz`   | The source of the commit released (`git archive`). Auni is built from it on the owner's machine; the project ships no binaries. |
| `release.txt`     | The version, when it was made, the commit, the SHA-256 of `source.tar.gz`, and then what changed, in plain words.               |
| `release.txt.sig` | `release.txt` signed with the release key (`ssh-keygen -Y sign`, namespace `auni-release`).                                     |

```
  your machine                           GitHub                 an owner's machine
  ------------                           ------                 ------------------
  release key --signs--> release.txt --->  release  ---> install.sh of the Auni they run:
                         (names the       (carries       1. the signature is by a key it lists
                          source's         the three     2. the source is the bytes release.txt names
                          SHA-256)         files)        3. the newest offered is not older than theirs
                                                         4. auni update says the version, the day it
                                                            was made and what changed, and asks
```

Each version carries the keys it trusts, in the `RELEASE_KEYS` block at the top of `install.sh`,
and checks the next release with them. The first install has nothing to check with yet, so it
trusts the `install.sh` it downloads from GitHub. `README.md` says how a careful person checks
that file first.

The version has one source: `version` in the root `package.json`. The tag is `v` and that version.

## The keys and the repository

- **Two release keys**, each with a passphrase: `~/.ssh/auni-release` signs releases, and
  `auni-release-backup` is for when the first is lost or stolen. Keep the backup offline, such as
  on a USB stick in a drawer, with its passphrase written down somewhere apart from it, so that
  one stolen machine never holds both.
- **Both are listed in `install.sh`**, one `auni-release` line each in `RELEASE_KEYS`: the word,
  the namespace, then the first two fields of the key's `.pub` file.
- **Their fingerprints are published off GitHub**, as DNS records that a stolen GitHub login
  can't change. `dig +short TXT _auni-release.auni.io` answers:

  ```
  "auni-release SHA256:c8utSSyxGQjj8K1xGhb1xkgE9ig9lI+p721qru7jZWQ"
  "auni-release-backup SHA256:mEefqOCVrBeQSokn/s7rlcyV62QRsG7aTonm5SruiOA"
  ```

  `README.md` tells a careful person to compare them with the keys the installer lists.

- **The repository's settings** are a second wall: releases are immutable (once published, nobody
  can change their files or move their tag, and the tag name can't be used again), a tag ruleset
  named `releases` stops any `v*` tag being moved or deleted, and the GitHub account signs in with
  two factors. A stolen login could switch these off. The signature is what holds without them.
- **Optional:** add `~/.ssh/auni-release.pub` to your GitHub account as a _signing_ key
  (Settings, SSH and GPG keys). GitHub then shows each release's tag as Verified. That key is the
  public half, so nothing secret goes to GitHub.

You also need `gh` signed in (`gh auth login`), as for any other GitHub work.

## Each release

1. Raise `version` in the root `package.json`, such as `0.1.0` to `0.2.0`, in a normal commit
   that reaches `main`.
2. Write what changed, in plain words for an owner. Say what they will notice, not how the code
   changed. Owners read this in `auni update` before they say yes. Save it in a file outside
   the repo, such as `~/notes.txt`. `pnpm release` refuses a checkout holding any file git
   doesn't have committed, a new one too, so a notes file inside the repo stops it.
3. From an up-to-date `main`, with nothing uncommitted:

   ```
   pnpm release --notes ~/notes.txt --key ~/.ssh/auni-release.pub --dry-run
   ```

   This makes the three files in `.release/download/v0.2.0/`. Then the `install.sh` inside the
   release checks them, the same way an owner's Auni will. Nothing is pushed.

4. Run it again without `--dry-run`. It makes the files again, asks, and then publishes:
   - a tag signed with the same key, pushed;
   - a draft GitHub release with the three files, published once they are all attached.

The key's passphrase is asked for at each signature: once for `release.txt` on a dry run, then
once for `release.txt` and once for the tag on the real one. With the key added to an SSH agent
(`ssh-add ~/.ssh/auni-release`), it is asked for once, by `ssh-add`.

`pnpm release` refuses to make a release when:

- the checkout has changes;
- it isn't `main`, or isn't the same as `origin/main`;
- the version is released already, or is older than the newest release;
- the notes are empty;
- the key isn't listed in `install.sh`.

`AUNI_RELEASE_KEY` may hold the key's path instead of `--key`.

## Replacing a key

**Replacing a key on purpose, or because the backup is now the one you use:**

1. Make the new key.
2. In `install.sh`, add the new key as an `auni-release` line.
3. Release that, signed with a key that is still listed. Every Auni that updates to it now
   trusts the new key too.
4. In a later release, move the old key's line under the word `retired`. Releases are only ever
   signed with listed keys, so this is safe.

**Retiring a key:** change its first word from `auni-release` to `retired` and release that. Once
an owner's Auni runs that release, it refuses anything the old key signs, and says the key was
retired.

**If a key is stolen,** do this at once with the other key:

1. Retire the stolen key and add a new one.
2. Release that.
3. Tell owners to update.

Until an owner updates, the stolen key can still sign a release their Auni would take. It would
still need to be published on GitHub, where they would see it. So keep two keys, and keep the
backup offline.

**If both keys are lost,** no Auni can be updated any more. Every owner must install again with
the install line, which trusts the new `install.sh` as a first install does. So keep the backup
key safe.
