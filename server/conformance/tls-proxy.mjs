// `gh` refuses plain HTTP for any non-github.com host — no override exists.
// This is a bare TLS-terminating reverse proxy in front of the plain-HTTP
// ADP server, purely so the real `gh` binary (conformance/run.sh) has
// something it will talk to. Not a production concern: real deployments
// terminate TLS at Caddy (deploy/Caddyfile), same idea, different tool.
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
