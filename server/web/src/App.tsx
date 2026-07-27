import { useEffect, useState } from "react";
import { clearConnection, loadConnection, type Connection } from "./api.js";
import Connect from "./components/Connect.js";
import IssueList from "./components/IssueList.js";
import IssueDetail from "./components/IssueDetail.js";
import ProposalList from "./components/ProposalList.js";
import ProposalDetail from "./components/ProposalDetail.js";
import OperationsLog from "./components/OperationsLog.js";
import EvidenceView from "./components/EvidenceView.js";

type Route =
  | { view: "issues" }
  | { view: "issue"; number: number }
  | { view: "proposals" }
  | { view: "proposal"; number: number }
  | { view: "operations" }
  | { view: "evidence"; sha: string; back: Route };

export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => loadConnection());
  const [route, setRoute] = useState<Route>({ view: "issues" });

  useEffect(() => {
    setRoute({ view: "issues" });
  }, [conn]);

  if (!conn) return <Connect onConnected={setConn} />;

  const tab = route.view === "issue" ? "issues" : route.view === "proposal" ? "proposals" : route.view === "evidence" ? null : route.view;

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
          <button className={tab === "operations" ? "active" : ""} onClick={() => setRoute({ view: "operations" })}>
            Operation log
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
          <IssueDetail conn={conn} number={route.number} onBack={() => setRoute({ view: "issues" })} />
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
        {route.view === "operations" && (
          <OperationsLog conn={conn} onViewEvidence={(sha) => setRoute({ view: "evidence", sha, back: route })} />
        )}
        {route.view === "evidence" && (
          <EvidenceView conn={conn} sha={route.sha} onBack={() => setRoute(route.back)} />
        )}
      </main>
    </div>
  );
}
