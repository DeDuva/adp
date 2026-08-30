#!/usr/bin/env bash
# Take a bare Debian/Ubuntu system to "can run the ADP test suite".
#
#   bash scripts/dev/bootstrap.sh                # provision everything
#   bash scripts/dev/bootstrap.sh --skip-docker  # host manages Docker itself
#   bash scripts/dev/bootstrap.sh --skip-deps    # system packages only
#
# This is the script a tester runs once on a fresh WSL distro, and the script
# .github/workflows/clean-room.yml runs on a bare container every push — which
# is the only thing that keeps it working. A bootstrap script CI does not
# execute is a work of fiction within a month.
#
# Idempotent: every step checks before it acts, so re-running is cheap and safe.
# It installs system packages, so it needs root or passwordless sudo.
set -euo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SKIP_DOCKER=0
SKIP_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --skip-docker) SKIP_DOCKER=1 ;;
    --skip-deps)   SKIP_DEPS=1 ;;
    -h|--help)     sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $arg"; exit 1 ;;
  esac
done

section "privileges"
# SUDO_E is the environment-preserving form, needed by the NodeSource script.
# Both are empty when already root — writing `$SUDO -E` unconditionally would
# expand to `-E bash -` and fail with "-E: command not found", which is exactly
# what happened the first time this ran in a container.
SUDO=""
SUDO_E=""
if [ "$(id -u)" = "0" ]; then
  ok "running as root"
elif have sudo && sudo -n true 2>/dev/null; then
  SUDO="sudo"
  SUDO_E="sudo -E"
  ok "passwordless sudo available"
else
  fail "need root or passwordless sudo to install system packages"
  hint "run as root (the default in a fresh 'wsl --import' distro), or"
  hint "re-run under sudo:  sudo -E bash scripts/dev/bootstrap.sh"
  exit 1
fi

section "platform"
if ! have apt-get; then
  fail "this script provisions Debian/Ubuntu systems (no apt-get found)"
  hint "on another distribution, install by hand: git (with git-http-backend),"
  hint "curl, openssl, make, docker, and Node $ADP_NODE_MAJOR — then 'make doctor'"
  exit 1
fi
ok "$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo "Debian-family system")"

# Package presence, not command presence. `command -v ca-certificates` is always
# false — it is a package with no binary — so a command-based check reinstalled
# it on every run and quietly made this script non-idempotent.
pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "ok installed"
}

APT_UPDATED=0
apt_update_once() {
  [ "$APT_UPDATED" = "1" ] && return 0
  info "apt-get update"
  $SUDO apt-get update -qq
  APT_UPDATED=1
}

apt_install() {
  apt_update_once
  info "installing: $*"
  # -qq quiets apt but not dpkg, which narrates every unpack. Drop stdout and
  # keep stderr, so a genuine failure is still visible.
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends "$@" >/dev/null
}

section "system packages"
# git for the repo and for git-http-backend (the smart-HTTP routes delegate to
# it); curl and openssl for conformance/run.sh; make for the entrypoint;
# ca-certificates so both can do TLS at all.
missing=()
for pkg in git curl ca-certificates openssl make; do
  pkg_installed "$pkg" || missing+=("$pkg")
done
# git-http-backend ships inside the git package but lives in the exec-path, and
# some minimal images strip it — reinstalling git is the fix, so check it too.
if have git && [ ! -x "$(git --exec-path)/git-http-backend" ]; then
  warn "git present but git-http-backend missing — reinstalling git"
  missing+=(git)
fi
if [ ${#missing[@]} -gt 0 ]; then
  apt_install "${missing[@]}"
  ok "installed: ${missing[*]}"
else
  ok "all present: git curl ca-certificates openssl make"
fi

section "node $ADP_NODE_MAJOR"
current_major=""
have node && current_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$current_major" = "$ADP_NODE_MAJOR" ]; then
  ok "node $(node -v) already matches the pin"
else
  [ -n "$current_major" ] && info "node v$current_major present, replacing with $ADP_NODE_MAJOR"
  # NodeSource rather than fnm/nvm: this installs system-wide, so it is on PATH
  # for every later shell, service and CI step without a shell hook. Developers
  # juggling several Node versions should use fnm instead — the repo's .nvmrc
  # makes `fnm use` do the right thing — but a provisioning script wants the
  # boring system-wide answer.
  pkg_installed gnupg || apt_install gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${ADP_NODE_MAJOR}.x" | $SUDO_E bash - >/dev/null
  # Not apt_install: nodejs from NodeSource pulls recommends we want, and the
  # repo list was just rewritten so the cached index is stale.
  APT_UPDATED=0
  apt_update_once
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq nodejs >/dev/null
  ok "installed node $(node -v)"
fi

section "docker"
if [ "$SKIP_DOCKER" = "1" ]; then
  info "skipped (--skip-docker)"
else
  docker_status=0
  docker_state || docker_status=$?
  case $docker_status in
    0) ok "docker daemon already reachable" ;;
    1|2)
      # Install when the *daemon* is missing — never infer that from the client.
      #
      # On a WSL distro with Docker Desktop integration enabled, /usr/bin/docker
      # is a symlink into /mnt/wsl/docker-desktop/, a mount that exists only
      # while Docker Desktop is running. Stop Desktop and the client is still on
      # PATH but the symlink dangles, so "client present, daemon unreachable"
      # looks identical to "engine installed but stopped" — and this branch went
      # on to start a dockerd that had never been installed. Observed on a real
      # machine after Docker Desktop failed to launch.
      #
      # Distribution docker.io, not Docker Desktop: it lives inside this
      # machine, starts when this script says so, and dies with it. That is what
      # makes a disposable WSL distro a real teardown boundary rather than a
      # hope (docs/test-environment-automation.md §3).
      if ! have dockerd; then
        apt_install docker.io
        ok "installed docker.io"
      fi
      # WSL images generally have no systemd, so `service` is the portable
      # entrypoint; on a systemd host it forwards to systemctl anyway.
      info "starting the docker daemon"
      if ! $SUDO service docker start >/dev/null 2>&1; then
        info "no service manager available; launching dockerd directly"
        # The inner shell backgrounds dockerd and exits immediately, so this
        # script never becomes its parent and never inherits a wait on it.
        #
        # Writing `... || $SUDO dockerd ... &` instead is a trap worth naming:
        # the daemon ends up a child this script blocks in wait() forever, and
        # it inherits our stdout — so a caller that pipes our output (GitHub
        # Actions does) never sees EOF and hangs until the job timeout. Both
        # failure modes were observed before this was written this way.
        $SUDO sh -c 'nohup dockerd >/var/log/dockerd.log 2>&1 </dev/null & exit 0'
      fi
      for _ in $(seq 1 30); do
        docker_state && break
        sleep 1
      done
      if docker_state; then
        ok "docker daemon reachable"
      else
        fail "docker daemon did not come up"
        # Show the log rather than naming it — and name it correctly. This
        # printed the wrong path (docker.log, not dockerd.log) the first time it
        # actually fired, which is exactly when a wrong hint costs the most.
        for log in /var/log/dockerd.log /var/log/docker.log; do
          if [ -s "$log" ]; then
            hint "last lines of $log:"
            $SUDO tail -n 15 "$log" 2>/dev/null | sed 's/^/        /'
            break
          fi
        done
        hint "some WSL kernels need iptables-legacy:"
        hint "  sudo update-alternatives --set iptables /usr/sbin/iptables-legacy"
        exit 1
      fi
      # Without this, every docker call needs sudo.
      #
      # The user to add is whoever will actually run `docker` afterwards, which
      # is NOT `$USER` when this script was invoked as `sudo bash bootstrap.sh`
      # — sudo sets USER=root, so the earlier version keyed on `$USER` and
      # `$SUDO` being non-empty skipped this branch entirely and left the human
      # unable to use the daemon it had just installed. `$SUDO_USER` is the
      # invoking account and is only set under sudo, so this covers all three
      # cases: sudo (use SUDO_USER), plain user with passwordless sudo (USER),
      # and a genuine root shell such as a container (no one to add).
      TARGET_USER="${SUDO_USER:-${USER:-}}"
      if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] \
         && ! id -nG "$TARGET_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        $SUDO usermod -aG docker "$TARGET_USER" || true
        warn "added $TARGET_USER to the docker group — not active in this shell yet"
        hint "start a new login shell, or run: newgrp docker"
        hint "in WSL, 'wsl --shutdown' from Windows then reopening the terminal also works"
      fi
      ;;
  esac

  # The compose plugin ships separately from the engine and is checked
  # unconditionally, not inside the install branch above: a machine can have a
  # perfectly working daemon and no `docker compose` at all. Ubuntu's docker.io
  # is exactly that case — it installs the engine and CLI but not the plugin, so
  # bootstrap reported success and `make up` then failed on the first compose
  # call. deploy/docker-compose.test.yml needs v2 (the plugin), never the
  # long-deprecated standalone docker-compose v1.
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
  else
    apt_install docker-compose-v2
    if docker compose version >/dev/null 2>&1; then
      ok "installed docker compose $(docker compose version --short 2>/dev/null)"
    else
      fail "'docker compose' still unavailable after installing docker-compose-v2"
      hint "on Debian or a non-distro engine, the package is 'docker-compose-plugin'"
      exit 1
    fi
  fi
fi

section "project dependencies"
if [ "$SKIP_DEPS" = "1" ]; then
  info "skipped (--skip-deps)"
else
  # Through deps.sh rather than five `npm ci` lines of its own — it is the same
  # five trees `make deps` and `make check-deps` speak about, and this file
  # used to be the third place that list was written down. `npm ci` not
  # `npm install`, there as here: the lockfile is the pin, and a provisioning
  # script that silently resolves different versions than CI defeats its own
  # purpose.
  if bash "$ADP_REPO_ROOT/scripts/dev/deps.sh" install; then
    ok "project dependencies installed"
  else
    fail "npm ci failed — see above"
  fi

  # These `npm ci` calls have no $SUDO prefix, so they normally run as
  # whoever invoked this script — except when that *is* root (either a
  # genuine root shell, or `sudo bash bootstrap.sh`), in which case every
  # node_modules just got created root-owned. The human who runs `make up`/
  # `make acceptance`/a bare `npm ci` afterward is the invoking user, not
  # root, and can't so much as rmdir a root-owned node_modules/.bin on the
  # next `npm ci` (EACCES). Same TARGET_USER derivation as the docker-group
  # fix-up above, and the same reasoning: a genuine root shell has no one to
  # chown to and is left alone.
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    for pkg in $ADP_DEP_PACKAGES; do
      chown -R "$SUDO_USER:$SUDO_USER" "$ADP_REPO_ROOT/$pkg/node_modules"
    done
    ok "node_modules ownership handed back to $SUDO_USER"
  fi
fi

printf '\n'
adp_summary "bootstrap" || exit 1
hint "next:  make doctor && make up && make test-all && make down"
