# Port selection for the test harnesses. Sourced, never executed.
#
# Why this exists: `server/conformance/run.sh` and `server/acceptance/run.sh`
# each stand up a server, a TLS proxy, and (in acceptance) a webhook listener
# on randomly chosen ports. Those ranges were picked to avoid the well-known
# ports and nothing else, which put them on top of the kernel's *ephemeral*
# range — the pool every outbound connection on the machine draws from. The TLS
# proxy's range (40000-59999) sat inside it completely.
#
# The failure that produces is not a flaky test, it is a lost race: an outbound
# socket holds the port, `listen()` gets EADDRINUSE, the proxy dies at startup,
# and the run continues for several more minutes before failing with
# `connection refused` somewhere that has nothing to do with the cause. It cost
# three full local runs across two pull requests before anyone chased it.
#
# Two fixes, both here:
#
#   1. Pick below the ephemeral floor, read from the kernel rather than
#      assumed, so the allocator that was competing for these ports cannot
#      reach them at all.
#   2. Give the callers a way to WAIT for a listener, so a process that fails
#      to bind anyway (a genuinely concurrent second test run) is caught at the
#      point of failure with its own log, not minutes later.
#
# Functions only — no output, no side effects, and nothing named `fail`,
# `info` or `pass`. Same rule as config.sh, for the same reason: conformance/
# run.sh sources this next to its own `fail()` and must keep it.

# The lowest port the kernel will hand out to an outbound connection. Linux
# publishes it; elsewhere, fall back to the IANA dynamic range's floor, which
# is what macOS and the BSDs use.
adp_ephemeral_floor() {
	if [ -r /proc/sys/net/ipv4/ip_local_port_range ]; then
		awk '{print $1}' /proc/sys/net/ipv4/ip_local_port_range
	else
		echo 49152
	fi
}

# True when nothing is *listening* on the port. Deliberately a connect probe:
# bash cannot bind, so this cannot detect a port held by someone else's
# established outbound connection — which is exactly why adp_pick_port stays
# below the ephemeral floor instead of relying on this check to catch it. What
# it does catch is another test run's listener, the one case left.
adp_port_is_free() {
	local port="$1"
	# The subshell closes the descriptor on exit; a successful connect means
	# something is there, so the port is not free.
	(exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && return 1
	return 0
}

# Echo a free port in [low, ephemeral floor). Default low bound leaves the
# registered-port range below 20000 alone.
adp_pick_port() {
	local low="${1:-20000}" high span attempt port
	high=$(($(adp_ephemeral_floor) - 1))
	# A machine configured with a very low ephemeral floor would leave no
	# window; take one above it rather than returning nothing, and accept the
	# collision risk that this file exists to avoid — a harness that cannot
	# start is worse than one that occasionally races.
	if [ "$high" -le "$((low + 1024))" ]; then
		low=$((high + 1))
		high=$((low + 8192))
	fi
	span=$((high - low))

	for attempt in $(seq 1 50); do
		port=$((low + RANDOM % span))
		if adp_port_is_free "$port"; then
			printf '%s\n' "$port"
			return 0
		fi
	done
	return 1
}

# Block until something is listening on the port. Returns non-zero if nothing
# ever does, so the caller can print the process's own log and fail there.
#
# Note what this can and cannot prove: that the port answers, not that the
# process you started is the one answering. Where that distinction matters, use
# adp_wait_for_log_line instead — a squatter on the port would satisfy this one
# while the process that was supposed to bind lay dead.
adp_wait_for_port() {
	local port="$1" tries="${2:-40}" attempt
	for attempt in $(seq 1 "$tries"); do
		adp_port_is_free "$port" || return 0
		sleep 0.25
	done
	return 1
}

# Wait for a backgrounded process to announce readiness in its own log, giving
# up immediately if it exits first. This is the strong form of the check above
# and the one to reach for when a process binds a port: the announcement is
# printed from the listen callback, so it means *this* process is serving —
# where a port probe only means someone is.
#
# Found by testing the failure path rather than the happy one: an earlier
# version of this fix waited on the port, and a deliberately squatted port
# sailed through it and failed 40 seconds later as an invalid-token error from
# `gh` talking to the squatter.
adp_wait_for_log_line() {
	local log="$1" pattern="$2" pid="$3" tries="${4:-40}" attempt
	for attempt in $(seq 1 "$tries"); do
		grep -q "$pattern" "$log" 2>/dev/null && return 0
		kill -0 "$pid" 2>/dev/null || return 1
		sleep 0.25
	done
	return 1
}
