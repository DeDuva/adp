import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import type { Db } from "../db/client.js";
import type { GitBackend, TreeEntry, CommitInfo } from "../core/git-backend.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";

function serializeCommit(commit: CommitInfo, owner: string, repoName: string) {
  return {
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: { name: commit.authorName, email: commit.authorEmail, date: commit.authorDate },
    },
    parents: commit.parents.map((sha) => ({ sha })),
    html_url: `/${owner}/${repoName}/commit/${commit.sha}`,
  };
}

function serializeTreeEntry(entry: TreeEntry) {
  return {
    path: entry.path,
    mode: entry.mode,
    type: entry.type === "blob" ? "file" : entry.type === "tree" ? "dir" : "commit",
    sha: entry.sha,
  };
}

// Tier-2 REST tail (docs/pragmatic_mvp.md M1b′ item 2): read-mostly git-data
// plumbing `gh` and scripted agents fall back to when the native plane
// doesn't cover something — contents, commits/compare, and the git/* object
// endpoints. All backed by the real `git` binary (core/git-backend.ts), no
// isomorphic-git.
export function registerGitDataRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend) {
  app.get("/api/v3/repos/:owner/:repo/contents/*", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const filePath = (req.params as { "*": string })["*"] ?? "";
    const { ref } = req.query as { ref?: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const resolvedRef = ref ?? repo.defaultBranch;
    const stat = await gitBackend.statPath(owner, repoName, resolvedRef, filePath);
    if (!stat) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    if (stat.type === "blob") {
      const content = await gitBackend.readBlob(owner, repoName, stat.sha);
      reply.send({
        type: "file",
        name: filePath.split("/").pop() ?? filePath,
        path: filePath,
        sha: stat.sha,
        size: content.byteLength,
        content: content.toString("base64"),
        encoding: "base64",
      });
      return;
    }

    const entries = await gitBackend.listTree(owner, repoName, stat.sha);
    reply.send(
      entries.map((entry) => ({
        type: entry.type === "blob" ? "file" : "dir",
        name: entry.path,
        path: filePath ? `${filePath}/${entry.path}` : entry.path,
        sha: entry.sha,
      })),
    );
  });

  app.get("/api/v3/repos/:owner/:repo/commits", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const { sha, per_page } = req.query as { sha?: string; per_page?: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const limit = Math.min(Number(per_page) || 30, 100);
    const commits = await gitBackend.log(owner, repoName, sha ?? repo.defaultBranch, limit);
    reply.send(commits.map((c) => serializeCommit(c, owner, repoName)));
  });

  app.get("/api/v3/repos/:owner/:repo/commits/:sha", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, sha } = req.params as { owner: string; repo: string; sha: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const commit = await gitBackend.getCommit(owner, repoName, sha);
    if (!commit) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.send(serializeCommit(commit, owner, repoName));
  });

  // GitHub's basehead segment is literally "base...head" inside one path
  // component — Fastify can't declare that as two params, so it's parsed
  // out of the wildcard tail.
  app.get("/api/v3/repos/:owner/:repo/compare/*", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const basehead = (req.params as { "*": string })["*"] ?? "";
    const sep = basehead.indexOf("...");
    if (sep === -1) {
      reply.code(422).send({ message: "basehead must be in the form base...head" });
      return;
    }
    const base = basehead.slice(0, sep);
    const head = basehead.slice(sep + 3);

    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const baseSha = await gitBackend.resolveRef(owner, repoName, base);
    const headSha = await gitBackend.resolveRef(owner, repoName, head);
    if (!baseSha || !headSha) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    const [aheadBy, behindBy, commits, files] = await Promise.all([
      gitBackend.mergeBaseCount(owner, repoName, baseSha, headSha),
      gitBackend.mergeBaseCount(owner, repoName, headSha, baseSha),
      gitBackend.log(owner, repoName, `${baseSha}..${headSha}`, 250),
      gitBackend.diffNameStatus(owner, repoName, baseSha, headSha),
    ]);

    reply.send({
      base_commit: { sha: baseSha },
      merge_base_commit: { sha: baseSha },
      status: aheadBy === 0 ? "identical" : behindBy === 0 ? "ahead" : "diverged",
      ahead_by: aheadBy,
      behind_by: behindBy,
      total_commits: commits.length,
      commits: commits.reverse().map((c) => serializeCommit(c, owner, repoName)),
      files: files.map((f) => ({ filename: f.path, status: f.status })),
    });
  });

  // GitHub-shaped per_page/page, same precedent as GET /commits above — a
  // repo mirrored from GitHub can carry far more refs (branches + tags) than
  // fits comfortably in one unbounded response.
  function paginateRefs(refs: { ref: string; sha: string }[], query: { per_page?: string; page?: string }) {
    const limit = Math.min(Number(query.per_page) || 30, 100);
    const offset = (Math.max(Number(query.page) || 1, 1) - 1) * limit;
    return refs.slice(offset, offset + limit);
  }

  app.get("/api/v3/repos/:owner/:repo/git/refs/*", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const refTail = (req.params as { "*": string })["*"] ?? "";
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const refs = await gitBackend.listRefs(owner, repoName, `refs/${refTail}`);
    if (refs.length === 0) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    const page = paginateRefs(refs, req.query as { per_page?: string; page?: string });
    reply.send(page.map((r) => ({ ref: r.ref, object: { sha: r.sha, type: "commit" } })));
  });

  app.get("/api/v3/repos/:owner/:repo/git/refs", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const refs = await gitBackend.listRefs(owner, repoName, "refs/");
    const page = paginateRefs(refs, req.query as { per_page?: string; page?: string });
    reply.send(page.map((r) => ({ ref: r.ref, object: { sha: r.sha, type: "commit" } })));
  });

  const CreateRefBody = z.object({ ref: z.string().min(1), sha: z.string().min(1) });
  app.post("/api/v3/repos/:owner/:repo/git/refs", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const parsed = CreateRefBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    await gitBackend.createRef(owner, repoName, parsed.data.ref, parsed.data.sha);
    reply.code(201).send({ ref: parsed.data.ref, object: { sha: parsed.data.sha, type: "commit" } });
  });

  app.delete(
    "/api/v3/repos/:owner/:repo/git/refs/heads/:branch",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, branch } = req.params as { owner: string; repo: string; branch: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      await gitBackend.deleteRef(owner, repoName, `refs/heads/${branch}`);
      reply.code(204).send();
    },
  );

  const CreateBlobBody = z.object({ content: z.string(), encoding: z.enum(["utf-8", "base64"]).default("utf-8") });
  app.post("/api/v3/repos/:owner/:repo/git/blobs", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const parsed = CreateBlobBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const buf = Buffer.from(parsed.data.content, parsed.data.encoding === "base64" ? "base64" : "utf8");
    const sha = await gitBackend.createBlob(owner, repoName, buf);
    reply.code(201).send({ sha, url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${sha}` });
  });

  app.get("/api/v3/repos/:owner/:repo/git/blobs/:sha", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, sha } = req.params as { owner: string; repo: string; sha: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    try {
      const content = await gitBackend.readBlob(owner, repoName, sha);
      reply.send({ sha, content: content.toString("base64"), encoding: "base64", size: content.byteLength });
    } catch {
      reply.code(404).send({ message: "Not Found" });
    }
  });

  const TreeEntryInput = z.object({
    path: z.string().min(1),
    mode: z.string().min(1),
    type: z.enum(["blob", "tree", "commit"]),
    sha: z.string().nullable().optional(),
    content: z.string().optional(),
  });
  const CreateTreeBody = z.object({ base_tree: z.string().optional(), tree: z.array(TreeEntryInput) });
  app.post("/api/v3/repos/:owner/:repo/git/trees", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const parsed = CreateTreeBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const base = new Map<string, TreeEntry>();
    if (parsed.data.base_tree) {
      for (const entry of await gitBackend.listTree(owner, repoName, parsed.data.base_tree)) {
        base.set(entry.path, entry);
      }
    }
    for (const entry of parsed.data.tree) {
      if (entry.sha === null) {
        base.delete(entry.path);
        continue;
      }
      const sha =
        entry.sha ?? (await gitBackend.createBlob(owner, repoName, Buffer.from(entry.content ?? "", "utf8")));
      base.set(entry.path, { mode: entry.mode, type: entry.type, sha, path: entry.path });
    }

    const treeSha = await gitBackend.createTree(owner, repoName, [...base.values()]);
    reply.code(201).send({ sha: treeSha, tree: [...base.values()].map(serializeTreeEntry) });
  });

  app.get("/api/v3/repos/:owner/:repo/git/trees/:sha", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, sha } = req.params as { owner: string; repo: string; sha: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    try {
      const entries = await gitBackend.listTree(owner, repoName, sha);
      reply.send({ sha, tree: entries.map(serializeTreeEntry) });
    } catch {
      reply.code(404).send({ message: "Not Found" });
    }
  });

  const CreateCommitBody = z.object({
    message: z.string().min(1),
    tree: z.string().min(1),
    parents: z.array(z.string()).default([]),
  });
  app.post("/api/v3/repos/:owner/:repo/git/commits", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const parsed = CreateCommitBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const author = { name: req.identity!.principal, email: `${req.identity!.principal}@adp.local` };
    const sha = await gitBackend.createCommit(
      owner,
      repoName,
      parsed.data.tree,
      parsed.data.parents,
      parsed.data.message,
      author,
    );
    reply.code(201).send({
      sha,
      message: parsed.data.message,
      tree: { sha: parsed.data.tree },
      parents: parsed.data.parents.map((p) => ({ sha: p })),
      author,
    });
  });

  app.get("/api/v3/repos/:owner/:repo/git/commits/:sha", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, sha } = req.params as { owner: string; repo: string; sha: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const commit = await gitBackend.getCommit(owner, repoName, sha);
    if (!commit) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.send({
      sha: commit.sha,
      message: commit.message,
      author: { name: commit.authorName, email: commit.authorEmail, date: commit.authorDate },
      parents: commit.parents.map((p) => ({ sha: p })),
    });
  });
}
