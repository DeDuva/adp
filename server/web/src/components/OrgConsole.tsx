import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type Connection,
  type LandRequirement,
  type OrgDetail,
  type OrgQuota,
  type OrgRepoPolicy,
  type PolicyLayer,
} from "../api.js";

// M4-7 — the org policy console (docs/m4-readiness-review.md §4).
//
// The question this view exists to answer is "what is actually being enforced
// in this org, and who decided it?". Before it, answering that meant reading a
// policy.yaml out of one repo, an adp.yaml out of another, knowing that the
// instance floor exists at all, and knowing that the three are unioned rather
// than overridden. Every one of those is knowable and none of them is visible.
//
// Two design rules, both inherited rather than invented here:
//
//   1. The floor is not editable from this screen. An org's floor is a file in
//      a repo (M4-2), so it changes by landing a change to that file — signed,
//      reviewed, in the operation log, like code. A "save" button here would be
//      a second and weaker path to the same outcome.
//   2. The kill switch IS operable here, because it is a row column rather than
//      a file, and because it is what someone reaches for during an incident.
//      Until M4-7 there was no way to throw it outside of `psql`.

// Exhaustive over LandRequirement by type: when the server enum grows and
// api.ts's LAND_REQUIREMENTS follows (its binding test forces that), this
// Record fails to compile until the new requirement gets a label — the
// alternative was rendering it as blank text, which is how a fail-closed
// policy looked like an enforced-but-nameless one.
const REQUIREMENT_LABEL: Record<LandRequirement, string> = {
  gates_green: "gates green",
  one_approval: "one approval",
  gates_confident: "gates confident",
};

const LAYER_LABEL: Record<PolicyLayer, string> = {
  instance: "instance",
  org: "org",
  repo: "repo",
};

function Quota({ label, quota }: { label: string; quota: OrgQuota }) {
  const unlimited = quota.limit === null;
  // "at" rather than "over": the enforcement paths refuse at >= limit, so a
  // quota sitting exactly on its limit is already refusing, and showing that
  // as merely "used up" would understate it.
  const at = !unlimited && quota.used >= (quota.limit ?? 0);

  return (
    <div className="quota">
      <span className="quota-label">{label}</span>
      <span className={`quota-value mono ${at ? "at-limit" : ""}`}>
        {quota.used} / {unlimited ? "∞" : quota.limit}
      </span>
      {at && <span className="pill failure">at limit</span>}
    </div>
  );
}

function FloorSource({ detail }: { detail: OrgDetail }) {
  const { source } = detail.org_floor;

  if (source === "malformed") {
    return (
      <div className="error-banner">
        <strong>This org's policy.yaml did not parse.</strong> Every known requirement is being enforced
        while that is true — a broken policy file fails closed rather than quietly enforcing nothing. The
        floor below is that fallback, not a choice anyone made. Fix{" "}
        <code>
          {detail.policy_repo?.owner}/{detail.policy_repo?.name}
        </code>
        's <code>policy.yaml</code> to restore the intended floor.
      </div>
    );
  }

  if (source === "no_policy_repo") {
    return (
      <div className="note-banner">
        No policy repo is designated for this org, so it contributes nothing to the floor. Repos in it are
        governed by the instance floor and their own <code>adp.yaml</code> alone.
      </div>
    );
  }

  if (source === "no_policy_file") {
    return (
      <div className="note-banner">
        The policy repo has no <code>policy.yaml</code> on <code>{detail.policy_repo?.default_branch}</code>,
        so this org contributes nothing to the floor. That is an empty floor, not an error.
      </div>
    );
  }

  return null;
}

function KillSwitch({
  conn,
  detail,
  onChanged,
}: {
  conn: Connection;
  detail: OrgDetail;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const turningOn = !detail.kill_switch;
    // A confirm() rather than a bespoke modal: this refuses every land in the
    // org, and the honest thing is to say so in words before it happens. The
    // UI has no other action with this blast radius to borrow a pattern from.
    const message = turningOn
      ? `Turn ON the kill switch for "${detail.name}"?\n\nEvery land attempt in every repo in this org will be refused until it is turned off.`
      : `Turn OFF the kill switch for "${detail.name}"?\n\nLands in this org will be allowed again, subject to the usual policy.`;
    if (!window.confirm(message)) return;

    setBusy(true);
    setError(null);
    try {
      await api.setOrgKillSwitch(conn, detail.id, turningOn);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`kill-switch ${detail.kill_switch ? "engaged" : ""}`}>
      <div>
        <div className="kill-switch-state">
          Kill switch{" "}
          <span className={`pill ${detail.kill_switch ? "failure" : "success"}`}>
            {detail.kill_switch ? "engaged" : "off"}
          </span>
        </div>
        <div className="meta">
          {detail.kill_switch
            ? "Every land attempt in this org is being refused. Opening proposals still works."
            : "Lands proceed under the resolved policy below."}
        </div>
      </div>
      <button className={`btn ${detail.kill_switch ? "" : "danger"}`} onClick={toggle} disabled={busy}>
        {busy ? "Working…" : detail.kill_switch ? "Turn off" : "Engage"}
      </button>
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

function RepoPolicyTable({ repos }: { repos: OrgRepoPolicy[] }) {
  if (repos.length === 0) {
    return <div className="empty">This org has no repos yet.</div>;
  }

  return (
    <table className="gate-table">
      <thead>
        <tr>
          <th>Repo</th>
          <th>Requires to land</th>
          <th>Imposed by</th>
        </tr>
      </thead>
      <tbody>
        {repos.map((repo) => (
          <tr key={repo.id}>
            <td className="mono">
              {repo.owner}/{repo.name}
              {repo.is_policy_repo && <span className="pill merged">policy repo</span>}
            </td>
            <td>
              {repo.resolved.length === 0 ? (
                <span className="meta">nothing — any change can land</span>
              ) : (
                repo.resolved.map((r) => (
                  <span key={r.requirement} className="pill open">
                    {REQUIREMENT_LABEL[r.requirement]}
                  </span>
                ))
              )}
            </td>
            <td className="meta">
              {repo.resolved.map((r) => (
                <div key={r.requirement}>
                  <span className="mono">{REQUIREMENT_LABEL[r.requirement]}</span>{" "}
                  {r.from.map((layer) => LAYER_LABEL[layer]).join(" + ")}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OrgConsole({ conn }: { conn: Connection }) {
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [repos, setRepos] = useState<OrgRepoPolicy[] | null>(null);
  const [noOrg, setNoOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const orgs = await api.listOrgs(conn);
      if (orgs.length === 0) {
        setNoOrg(true);
        return;
      }
      setNoOrg(false);
      const [orgDetail, orgRepos] = await Promise.all([
        api.getOrg(conn, orgs[0]!.id),
        api.listOrgRepos(conn, orgs[0]!.id),
      ]);
      setDetail(orgDetail);
      setRepos(orgRepos);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [conn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="error-banner">{error}</div>;

  if (noOrg) {
    return (
      <>
        <h1>Organization</h1>
        <div className="empty">
          This token is not scoped to an organization, so there is no org policy to show. Access is carried
          by the token rather than by your memberships — mint an org-scoped token to use this view.
        </div>
      </>
    );
  }

  if (!detail || !repos) return <div className="empty">Loading…</div>;

  return (
    <div className="org-console">
      <h1>{detail.name}</h1>

      <KillSwitch conn={conn} detail={detail} onChanged={load} />

      <h2>Land policy</h2>
      <FloorSource detail={detail} />
      <div className="layers">
        <div className="layer">
          <div className="layer-name">Instance floor</div>
          <div className="layer-body">
            {detail.instance_floor.length === 0 ? (
              <span className="meta">empty</span>
            ) : (
              detail.instance_floor.map((r) => (
                <span key={r} className="pill open">
                  {REQUIREMENT_LABEL[r]}
                </span>
              ))
            )}
            <div className="meta">Set by the operator of this instance. No org or repo can remove it.</div>
          </div>
        </div>

        <div className="layer">
          <div className="layer-name">Org floor</div>
          <div className="layer-body">
            {detail.org_floor.require.length === 0 ? (
              <span className="meta">empty</span>
            ) : (
              detail.org_floor.require.map((r) => (
                <span key={r} className="pill open">
                  {REQUIREMENT_LABEL[r]}
                </span>
              ))
            )}
            <div className="meta">
              {detail.policy_repo ? (
                <>
                  From <code>policy.yaml</code> on <code>{detail.policy_repo.default_branch}</code> of{" "}
                  <code>
                    {detail.policy_repo.owner}/{detail.policy_repo.name}
                  </code>
                  . Change it by landing a change to that file — policy travels the same signed, reviewed
                  path as code.
                </>
              ) : (
                <>No policy repo designated.</>
              )}
            </div>
          </div>
        </div>

        <div className="layer">
          <div className="layer-name">Per repo</div>
          <div className="layer-body">
            <span className="meta">
              Each repo's own <code>adp.yaml</code> adds to the two layers above. A repo can require more
              than its org, never less — the table below is the union that results.
            </span>
          </div>
        </div>
      </div>

      <h2>Resolved policy, by repo</h2>
      <RepoPolicyTable repos={repos} />

      <h2>Quotas</h2>
      <div className="quotas">
        <Quota label="Repos" quota={detail.quotas.max_repos} />
        <Quota label="Live workspaces" quota={detail.quotas.max_concurrent_workspaces} />
        <Quota label="Running gate jobs" quota={detail.quotas.max_concurrent_gate_jobs} />
      </div>
    </div>
  );
}
