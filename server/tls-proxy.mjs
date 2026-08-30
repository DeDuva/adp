// `gh` refuses plain HTTP for any non-github.com host — no override exists.
// This is a bare TLS-terminating reverse proxy in front of the plain-HTTP ADP
// server, so that the real `gh` binary has something it will talk to.
//
// #158 moved it out of `conformance/`. It was a test fixture there, used by
// three harnesses, and a person setting up a *persistent* local instance got
// none of it — which made "the fiddliest part of the walkthrough", in the
// manual test plan's own words, something the repo had already solved four
// times and shipped zero times. `scripts/dev/local.sh` is the supported mode
// it now backs, and a supported mode must not depend on a file that lives in
// a test tier.
//
// Still not a production TLS story, and `docs/self-hosting.md` says so where
// it matters: a real deployment terminates at Caddy with a real certificate
// (deploy/Caddyfile). This is for evaluation and development, where the
// hostname is `localhost` and no CA will ever issue for it.
import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const [, , certPath, keyPath, listenPortStr, targetPortStr] = process.argv;
if (!certPath || !keyPath || !listenPortStr || !targetPortStr) {
  console.error("usage: tls-proxy.mjs <cert> <key> <listenPort> <targetPort>");
  process.exit(1);
}

const listenPort = Number(listenPortStr);
const targetPort = Number(targetPortStr);

const server = https.createServer(
  { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
  (req, res) => {
    const proxyReq = http.request(
      { host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (err) => {
      res.writeHead(502);
      res.end(String(err));
    });
    req.pipe(proxyReq);
  },
);

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`tls-proxy: https://127.0.0.1:${listenPort} -> http://127.0.0.1:${targetPort}`);
});
