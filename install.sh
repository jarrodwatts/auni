#!/bin/sh
# Installs Auni on this machine, built from its source:
#
#   curl -fsSL https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh | sh
#
# Nothing here is a binary built by Auni's authors: Node comes from nodejs.org (checked against
# its SHASUMS256.txt), Auni's source from a release, its dependencies from npm (each checked
# against the hash pnpm-lock.yaml names), and it is built here. Everything goes in $AUNI_HOME/app;
# Auni's data, beside it in $AUNI_HOME, is never touched (apps/core/src/release/layout.ts says how
# it's laid out).
#
# A release is three files: release.txt (its version, when it was made, its commit, the SHA-256 of
# its source, and what changed), release.txt.sig (that file signed with a release key below, by
# `pnpm release`, on the project owner's machine), and source.tar.gz. Nothing is installed unless
# the signature is good, the source is the bytes release.txt names, and a release offered as the
# newest is no older than the one installed. Where the files are fetched from adds nothing to that: GitHub only
# carries them, so whoever holds the GitHub account can't make a release (RELEASING.md).
#
#   AUNI_HOME      where Auni lives; unset, ~/.auni
#   AUNI_VERSION   the release to install (v0.1.0); unset, the newest
#   AUNI_RELEASES  where releases are fetched from; unset, this repository's GitHub releases
#   AUNI_SOURCE    a tarball or folder of source to build instead: yours, so not checked
#   AUNI_CHECK     set to 1, only check the release and print its release.txt, or with
#                  AUNI_SOURCE only print the version that source is (auni update)
#
# Run again once Auni is installed, it builds the version beside the current one and switches
# nothing: `auni update`, which runs this to build, is what switches, and rolls back if it must.

set -eu

REPO=jarrodwatts/auni
# Where an installed version keeps the release.txt it was installed from (release/layout.ts).
RELEASE_FILE=.auni-release.txt

# The keys a release may be signed with, as ssh-keygen's allowed signers. "auni-release" signs
# releases now; "retired" no longer does, so a release a retired key signed is refused by name.
# Each version carries this block and checks the next release with it: a key is replaced by a
# release the old key signs that lists the new one (RELEASING.md says how). The two listed are the
# project owner's release key and its offline backup, whose fingerprints are also published off
# GitHub: `dig +short TXT _auni-release.auni.io`.
RELEASE_KEYS='
auni-release namespaces="auni-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK4KBbQDZY/SYzhw8yuRW7NCn60e7by2a/3dFRNH29xq
auni-release namespaces="auni-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFcNVQZX/3tw6ZZWcpC/zcZhV5vQW1ddmJym+hP4sOx
'

say() { printf '%s\n' "$*"; }
step() {
  if [ -t 1 ] && [ "${TERM:-}" != dumb ] && [ -z "${NO_COLOR:-}" ]; then
    printf '\n[%s/6] \033[1m%s\033[0m\n' "$1" "$2"
  else
    printf '\n[%s/6] %s\n' "$1" "$2"
  fi
}
done_() { printf '      %s\n' "$*"; }
# Stops with a sentence for the owner. Checking only, it is that sentence alone, for auni update.
fail() {
  if [ "${AUNI_CHECK:-}" = 1 ]; then printf '%s\n' "$*" >&2
  else printf '\nAuni was not installed: %s\n' "$*" >&2; fi
  exit 1
}

# Runs a command with its output in the log, which is shown only when it fails. Never reads from
# stdin, which under `curl | sh` is this script.
logged() {
  if ! "$@" >>"$LOG" 2>&1 </dev/null; then
    printf '\n' >&2
    tail -n 40 "$LOG" >&2
    fail "the step above failed. See $LOG, then retry your install command."
  fi
}

# Keep the build output in the log while showing how long this step has been running.
building() (
  label="$1"
  shift
  done_ "$label"
  if [ ! -t 1 ] || [ "${TERM:-}" = dumb ]; then
    logged "$@"
    exit
  fi
  started=$(date +%s)
  (
    while sleep 1; do
      printf '\r      %s (%ss)' "$label" "$(($(date +%s) - started))"
    done
  ) &
  timer=$!
  trap 'kill "$timer" 2>/dev/null || :; wait "$timer" 2>/dev/null || :; printf "\r      %s (%ss)\n" "$label" "$(($(date +%s) - started))"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  logged "$@"
)

# Stops, saying how to install it, when the command $1 (from the package $2) is missing.
need() {
  command -v "$1" >/dev/null 2>&1 && return
  if [ "$os" = linux ]; then
    fail "$1 is required. Install it with: sudo apt-get install $2 (or your system's package manager)."
  fi
  fail "$1 is required. Install Xcode command line tools with: xcode-select --install"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Whether release $1 is older than release $2 (v0.9.3 is older than v0.10.0): the same rule as
# apps/core/src/release/tags.ts.
older() {
  printf '%s\n%s\n' "$1" "$2" | awk -F'[v.]' '
    { key[NR] = sprintf("x%09d%09d%09d", $2, $3, $4) }
    END { exit !(key[1] < key[2]) }'
}

# Whether $1 is a release tag, v<major>.<minor>.<patch> and nothing more: the same rule as
# apps/core/src/release/tags.ts, so a pre-release such as v0.2.0-rc.1 is never one.
is_tag() {
  case "$1" in
    v*[!0-9.]* | v.* | *..* | *. | *.*.*.*) return 1 ;; # anything but digits, or a part empty
    v*.*.*) return 0 ;;
    *) return 1 ;;
  esac
}

# The version in the package.json of the source in $1: "0.1.0".
version_of() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1
}

# Unpacks AUNI_SOURCE into $staged, and sets $tag: AUNI_VERSION, or what its package.json says.
stage_source() {
  staged="$TMP/source"
  mkdir -p "$staged"
  if [ -d "$AUNI_SOURCE" ]; then
    (cd "$AUNI_SOURCE" && tar --exclude=node_modules --exclude=.next --exclude=.git -cf - .) |
      (cd "$staged" && tar -xf -)
    # A working folder's own settings stay with it: the owner's live in $AUNI_HOME/.env.
    find "$staged" -name '.env*' ! -name .env.example -exec rm -rf {} +
  elif [ -f "$AUNI_SOURCE" ]; then
    tar -C "$staged" --strip-components=1 -xzf "$AUNI_SOURCE"
  else
    fail "AUNI_SOURCE is neither a folder nor a tarball: $AUNI_SOURCE"
  fi
  [ -f "$staged/package.json" ] || fail "AUNI_SOURCE holds no Auni source: $AUNI_SOURCE"
  tag="${AUNI_VERSION:-v$(version_of "$staged")}"
  is_tag "$tag" || fail "$tag isn't a version such as v0.1.0."
}

# A field of release.txt's first lines, before the blank line the notes follow.
field() { sed '/^$/q' "$TMP/release.txt" | sed -n "s/^$1 //p" | head -n 1; }

# Fetches the release (AUNI_VERSION, or the newest) and checks it is one a release key signed and
# no older than what's installed. Sets $tag and $sum, the SHA-256 its source must have.
check_release() {
  releases="${AUNI_RELEASES:-https://github.com/$REPO/releases}"
  if [ -n "${AUNI_VERSION:-}" ]; then
    named="release $AUNI_VERSION"
    where="$releases/download/$AUNI_VERSION"
  else
    named="the newest release"
    where="$releases/latest/download"
  fi
  curl -fsL -o "$TMP/release.txt" "$where/release.txt" ||
    fail "$named couldn't be fetched from $releases. Is it a release, and is this machine online?"
  tag="$(field version)"
  is_tag "$tag" || fail "$named has no version in its release.txt, so it isn't an Auni release."
  curl -fsL -o "$TMP/release.txt.sig" "$where/release.txt.sig" ||
    fail "release $tag has no signature, so nothing shows it is a release Auni's owner made."

  printf '%s\n' "$RELEASE_KEYS" | grep -v '^[[:space:]]*$' >"$TMP/keys" || true
  [ -s "$TMP/keys" ] ||
    fail "this installer lists no release key yet, so no release can be checked. AUNI_SOURCE builds source you name."
  # Exit 0 only for a signature by a key listed under that name, over these exact bytes.
  verify() {
    ssh-keygen -Y verify -f "$TMP/keys" -I "$1" -n auni-release -s "$TMP/release.txt.sig" \
      <"$TMP/release.txt" 2>/dev/null
  }
  if ! verify auni-release >/dev/null; then
    verify retired >/dev/null &&
      fail "release $tag is signed with a release key that has been retired, so it isn't a release Auni makes any more."
    fail "release $tag isn't signed by Auni's release key: its release.txt was changed after it was signed, or someone else signed it."
  fi

  if [ -n "${AUNI_VERSION:-}" ] && [ "$tag" != "$AUNI_VERSION" ]; then
    fail "the release fetched as $AUNI_VERSION says it is $tag, so it wasn't used."
  fi
  # Offered as the newest, an older release is someone holding back a fix. Named, it is the owner
  # going back on purpose (db/embedded.ts says when that's needed).
  current="$(readlink "$APP/current" 2>/dev/null | sed 's#.*/##' || true)"
  if [ -z "${AUNI_VERSION:-}" ] && [ -n "$current" ] && older "$tag" "$current"; then
    fail "the newest release offered is $tag, older than $current installed here, so it wasn't used."
  fi
  sum="$(field source)"
  case "$sum" in
    [0-9a-f]*) [ "${#sum}" -eq 64 ] || fail "release $tag names no SHA-256 for its source." ;;
    *) fail "release $tag names no SHA-256 for its source." ;;
  esac
  made="$(field made)"
}

main() {
  AUNI_HOME="${AUNI_HOME:-$HOME/.auni}"
  APP="$AUNI_HOME/app"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/auni-install.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT

  if [ "${AUNI_CHECK:-}" = 1 ] && [ -n "${AUNI_SOURCE:-}" ]; then
    # What `auni update` reads of a source before it asks: its version, and nothing written.
    stage_source
    say "$tag"
    return
  fi
  if [ "${AUNI_CHECK:-}" = 1 ]; then
    # What `auni update` reads before it asks: the release as checked, and nothing written.
    command -v ssh-keygen >/dev/null 2>&1 || fail "it needs ssh-keygen, which comes with OpenSSH."
    check_release
    cat "$TMP/release.txt"
    return
  fi

  mkdir -p "$APP/versions" "$APP/node" "$APP/bin"
  chmod 700 "$AUNI_HOME"
  LOG="$APP/install.log"
  : >"$LOG"

  say "Installing Auni"

  step 1 "This machine"
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows, Auni runs inside WSL: run install.ps1 in PowerShell." ;;
    *) fail "Auni runs on Linux and macOS, not $(uname -s)." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "Auni runs on x64 and arm64 machines, not $(uname -m)." ;;
  esac
  need curl curl
  need tar tar
  command -v sha256sum >/dev/null 2>&1 || need shasum coreutils
  [ -n "${AUNI_SOURCE:-}" ] || need ssh-keygen openssh-client
  done_ "$os $arch"

  step 2 "Release"
  if [ -n "${AUNI_SOURCE:-}" ]; then
    stage_source
    done_ "$tag from the source you supplied (unsigned)"
  else
    check_release
    done_ "$tag ($made), signature verified"
  fi
  dir="$APP/versions/$tag"

  if [ -f "$dir/.auni-built" ]; then
    step 3 "Source"
    done_ "$tag is already built"
    step 4 "Node"
    done_ "$(readlink "$dir/.node" | sed 's#.*/##')"
    step 5 "Build"
    done_ "Already built"
  else
    step 3 "Source"
    # A folder without .auni-built is a build that didn't finish: it starts over.
    rm -rf "$dir"
    if [ -n "${AUNI_SOURCE:-}" ]; then
      mv "$staged" "$dir"
      done_ "Source ready"
    else
      logged curl -fsSL -o "$TMP/source.tar.gz" "$releases/download/$tag/source.tar.gz"
      [ "$(sha256 "$TMP/source.tar.gz")" = "$sum" ] ||
        fail "the source downloaded for $tag isn't the one its release names (its SHA-256 differs), so it wasn't used."
      mkdir -p "$TMP/source"
      logged tar -C "$TMP/source" --strip-components=1 -xzf "$TMP/source.tar.gz"
      [ "v$(version_of "$TMP/source")" = "$tag" ] ||
        fail "the source of $tag says it is v$(version_of "$TMP/source"), so it wasn't used."
      # Kept with the version, so it can say which release it is: its commit and what changed.
      cp "$TMP/release.txt" "$TMP/source/$RELEASE_FILE"
      mv "$TMP/source" "$dir"
      done_ "Source verified"
    fi

    step 4 "Node"
    [ -f "$dir/.node-version" ] || fail "$tag names no Node version (.node-version)."
    node="$(tr -d ' \r\n' <"$dir/.node-version" | sed 's/^v//')"
    if [ ! -x "$APP/node/$node/bin/node" ]; then
      file="node-v$node-$os-$arch.tar.gz"
      logged curl -fsSL -o "$TMP/$file" "https://nodejs.org/dist/v$node/$file"
      logged curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$node/SHASUMS256.txt"
      expected="$(awk -v f="$file" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")"
      [ -n "$expected" ] && [ "$(sha256 "$TMP/$file")" = "$expected" ] ||
        fail "the Node download doesn't match nodejs.org's checksum, so it wasn't used."
      rm -rf "$APP/node/$node.incoming"
      mkdir -p "$APP/node/$node.incoming"
      logged tar -C "$APP/node/$node.incoming" --strip-components=1 -xzf "$TMP/$file"
      mv "$APP/node/$node.incoming" "$APP/node/$node"
      done_ "Node $node verified"
    else
      done_ "Node $node ready"
    fi
    ln -sfn "../../node/$node" "$dir/.node"

    step 5 "Build"
    # pnpm as package.json pins it, through corepack, with what both keep inside app/.
    (
      cd "$dir"
      PATH="$dir/.node/bin:$PATH"
      export PATH COREPACK_HOME="$APP/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 AUNI_HOME
      done_ "Allow about 5 minutes for a fresh build. Slower machines may take longer."
      building "Installing packages" "$dir/.node/bin/corepack" pnpm install --frozen-lockfile --store-dir "$APP/pnpm-store"
      # The version's own build, so how a version builds can change without a new install.sh.
      building "Building the web app" "$dir/.node/bin/node" apps/core/bin/auni.mjs build
    )
    touch "$dir/.auni-built"
    done_ "Build complete"
  fi

  step 6 "The auni command"
  launcher="$APP/bin/auni"
  home_quoted="$(printf '%s' "$AUNI_HOME" | sed "s/'/'\\\\''/g")"
  cat >"$launcher" <<EOF
#!/bin/sh
# Auni's launcher, written by install.sh: runs the current version on its own Node.
if [ -z "\${AUNI_HOME:-}" ]; then AUNI_HOME='$home_quoted'; fi
export AUNI_HOME
app="\$AUNI_HOME/app/current"
# The Node it runs on comes first, as the brain's SDK starts \`node\` by name.
PATH="\$app/.node/bin:\$PATH"
export PATH
exec "\$app/.node/bin/node" "\$app/apps/core/bin/auni.mjs" "\$@"
EOF
  chmod 755 "$launcher"
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$launcher" "$HOME/.local/bin/auni"

  current="$(readlink "$APP/current" 2>/dev/null | sed 's#.*/##' || true)"
  if [ -z "$current" ]; then
    ln -s "versions/$tag" "$APP/current"
    current="$tag"
  fi
  done_ "Command ready"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
      say ""
      say "Add Auni to your PATH now and in your shell profile:"
      say '  export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac

  printf '\n'
  if [ "$current" != "$tag" ]; then
    say "Auni $tag is built. $current is still the active version."
    say "Switch to it with: auni update --version $tag"
    return
  fi
  say "Done. Auni $tag is installed."
  say "Run auni to start Auni and open it in your browser."
  say "Run auni demo to try it with fake money."
}

main "$@"
