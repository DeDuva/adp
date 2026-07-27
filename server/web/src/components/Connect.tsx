import { useState } from "react";
import { api, saveConnection, type Connection } from "../api.js";

export default function Connect({ onConnected }: { onConnected: (conn: Connection) => void }) {
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const conn: Connection = { token: token.trim(), owner: owner.trim(), repo: repo.trim() };
    try {
      await api.whoami(conn);
      saveConnection(conn);
      onConnected(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connect-screen">
      <form className="connect-card" onSubmit={connect}>
        <h1>adp / supervise</h1>
        <p>Read-only view over a repo's issues, PRs, and op log. Paste a token with at least repo:read.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="token">Token</label>
          <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="owner">Owner</label>
          <input id="owner" value={owner} onChange={(e) => setOwner(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="repo">Repo</label>
          <input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
