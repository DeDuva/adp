import { useEffect, useState } from "react";
import { clearConnection, loadConnection, type Connection } from "./api.js";
import Connect from "./components/Connect.js";
import IssueList from "./components/IssueList.js";
import IssueDetail from "./components/IssueDetail.js";
import ProposalList from "./components/ProposalList.js";
import ProposalDetail from "./components/ProposalDetail.js";
import OperationsLog from "./components/OperationsLog.js";
import EvidenceView from "./components/EvidenceView.js";
import { CandidateSetList, CandidateSetDetailView } from "./components/CandidateSets.js";
import OrgConsole from "./components/OrgConsole.js";
import RunList from "./components/Runs.js";
import RunDetailView from "./components/RunDetail.js";
import SessionDetailView from "./components/SessionDetail.js";

type Route =
  | { view: "issues" }
  | { view: "issue"; number: number }
  | { view: "proposals" }
  | { view: "proposal"; number: number }
  | { view: "operations" }
  // #156: the M3 surface. `back` is carried rather than assumed because a
  // session is reached from a run, from a trajectory event, and from another
  // session's lineage — three parents, and guessing wrong strands the reader.
  | { view: "runs" }
  | { view: "run"; id: string }
  | { view: "session"; id: string; back: Route }
  | { view: "candidate-sets" }
  | { view: "candidate-set"; id: string }
  | { view: "organization" }
  | { view: "evidence"; sha: string; back: Route };

export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => loadConnection());
  const [route, setRoute] = useState<Route>({ view: "issues" });

  useEffect(() => {
    setRoute({ view: "issues" });
  }, [conn]);

  if (!conn) return <Connect onConnected={setConn} />;

  const tab =
    route.view === "issue"
      ? "issues"
      : route.view === "proposal"
        ? "proposals"
        : route.view === "candidate-set"
          ? "candidate-sets"
          : route.view === "run" || route.view === "session"
            ? "runs"
            : route.view === "evidence"
              ? null
              : route.view;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          adp / supervise
          <span className="repo">
            {conn.owner}/{conn.repo}
          </span>
        </div>
        <nav className="nav">
          <button className={tab === "issues" ? "active" : ""} onClick={() => setRoute({ view: "issues" })}>
            Issues
          </button>
          <button className={tab === "proposals" ? "active" : ""} onClick={() => setRoute({ view: "proposals" })}>
            Pull requests
          </button>
          {/* #156. Above candidate sets because a run is the coarser unit: a
              candidate set is N proposals against one intent, a run is one
              attempt and everything it did. */}
          <button className={tab === "runs" ? "active" : ""} onClick={() => setRoute({ view: "runs" })}>
            Runs
          </button>
          <button
            className={tab === "candidate-sets" ? "active" : ""}
            onClick={() => setRoute({ view: "candidate-sets" })}
          >
            Candidate sets
          </button>
          <button className={tab === "operations" ? "active" : ""} onClick={() => setRoute({ view: "operations" })}>
            Operation log
          </button>
          {/* M4-7. The only org-scoped view here — everything above is about
              the one repo named in the connection, this one is about the org
              that repo belongs to. */}
          <button
            className={tab === "organization" ? "active" : ""}
            onClick={() => setRoute({ view: "organization" })}
          >
            Organization
          </button>
        </nav>
        <button
          className="disconnect"
          onClick={() => {
            clearConnection();
            setConn(null);
          }}
        >
          Disconnect
        </button>
      </aside>

      <main>
        {route.view === "issues" && <IssueList conn={conn} onOpen={(number) => setRoute({ view: "issue", number })} />}
        {route.view === "issue" && (
          <IssueDetail
            conn={conn}
            number={route.number}
            onBack={() => setRoute({ view: "issues" })}
            onOpenRun={(id) => setRoute({ view: "run", id })}
          />
        )}
        {route.view === "proposals" && (
          <ProposalList conn={conn} onOpen={(number) => setRoute({ view: "proposal", number })} />
        )}
        {route.view === "proposal" && (
          <ProposalDetail
            conn={conn}
            number={route.number}
            onBack={() => setRoute({ view: "proposals" })}
            onViewEvidence={(sha) => setRoute({ view: "evidence", sha, back: route })}
          />
        )}
        {route.view === "runs" && <RunList conn={conn} onOpen={(id) => setRoute({ view: "run", id })} />}
        {route.view === "run" && (
          <RunDetailView
            conn={conn}
            runId={route.id}
            onBack={() => setRoute({ view: "runs" })}
            onOpenSession={(id) => setRoute({ view: "session", id, back: route })}
            onViewEvidence={(sha) => setRoute({ view: "evidence", sha, back: route })}
            onOpenIssue={(number) => setRoute({ view: "issue", number })}
          />
        )}
        {route.view === "session" && (
          <SessionDetailView
            conn={conn}
            sessionId={route.id}
            onBack={() => setRoute(route.back)}
            onOpenSession={(id) => setRoute({ view: "session", id, back: route })}
            onViewEvidence={(sha) => setRoute({ view: "evidence", sha, back: route })}
          />
        )}
        {route.view === "candidate-sets" && (
          <CandidateSetList conn={conn} onOpen={(id) => setRoute({ view: "candidate-set", id })} />
        )}
        {route.view === "candidate-set" && (
          <CandidateSetDetailView
            conn={conn}
            id={route.id}
            onBack={() => setRoute({ view: "candidate-sets" })}
            onViewEvidence={(sha) => setRoute({ view: "evidence", sha, back: route })}
          />
        )}
        {route.view === "operations" && (
          <OperationsLog conn={conn} onViewEvidence={(sha) => setRoute({ view: "evidence", sha, back: route })} />
        )}
        {route.view === "organization" && <OrgConsole conn={conn} />}
        {route.view === "evidence" && (
          <EvidenceView
            conn={conn}
            sha={route.sha}
            onBack={() => setRoute(route.back)}
            // #157: every edge out of a commit carries `back` so the reader can
            // return to where they came from rather than to a guess. Following
            // evidence → run → session → evidence is a path, and a path you
            // cannot walk backwards is a maze.
            onOpenIssue={(number) => setRoute({ view: "issue", number })}
            onOpenRun={(id) => setRoute({ view: "run", id })}
            onOpenSession={(id) => setRoute({ view: "session", id, back: route })}
            onOpenProposal={(number) => setRoute({ view: "proposal", number })}
          />
        )}
      </main>
    </div>
  );
}
