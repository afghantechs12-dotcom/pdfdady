/* global process, console */
/**
 * A throwaway HTTPS terminator in front of a local Next.js standalone server.
 *
 * WHY THIS EXISTS. Session and anonymous-owner cookies are `Secure` in
 * production. A real browser on a plain `http://` origin therefore drops them
 * silently, every ownership check resolves a different actor, and the probe sees a
 * 404 that looks exactly like a product defect. And the production startup gate
 * refuses a loopback `NEXT_PUBLIC_SITE_URL`, so `https://localhost` is not
 * available either. What is left is: serve the artifact on loopback http, and put
 * a self-signed https listener on a LAN address in front of it.
 *
 * Every browser probe in this directory needed that, and until now each run
 * re-created a copy of this file in /tmp by hand. Once, in the repo, is better:
 * the recipes in the probe headers can name something that exists.
 *
 *   # terminal 1
 *   node scripts/next-build.js
 *   cp -R .next/static .next/standalone/.next/static      # the Dockerfile's own step
 *   [ -d public ] && cp -R public .next/standalone/public   # only if the repo has one
 *   cd .next/standalone && NODE_ENV=production PORT=3002 HOSTNAME=127.0.0.1 \
 *     NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 \
 *     DATABASE_URL="file:/abs/path/to.db" node server.js
 *
 *   # terminal 2
 *   node scripts/tls-front.mjs --listen 3001 --target 3002
 *   #   prints the origin to use; must equal NEXT_PUBLIC_SITE_URL exactly, or the
 *   #   result download becomes cross-origin and invents a CSP violation.
 *
 * The certificate is generated per run by `openssl` into a temp directory and is
 * never written into the repo. Clients must be told to accept it —
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for node `fetch`, `--ignore-certificate-errors`
 * for Chrome — which is why this is a probe tool and nothing else.
 */
import { createServer } from "node:https";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const LISTEN = Number(arg("--listen", "3001"));
const TARGET = Number(arg("--target", "3002"));

/**
 * The first non-internal IPv4 address, because the gate refuses a loopback public
 * origin. Overridable, since a machine with several interfaces may not offer the
 * one the browser can reach first.
 */
function lanAddress() {
  const explicit = arg("--host", null);
  if (explicit) return explicit;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  throw new Error(
    "no non-loopback IPv4 interface found. Pass --host <address>; the production " +
      "startup gate refuses a loopback NEXT_PUBLIC_SITE_URL, so 127.0.0.1 is not an option.",
  );
}

const host = lanAddress();
const dir = mkdtempSync(join(tmpdir(), "tls-front-"));
const keyFile = join(dir, "key.pem");
const certFile = join(dir, "cert.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyFile, "-out", certFile,
  "-days", "1", "-subj", `/CN=${host}`,
  "-addext", `subjectAltName=IP:${host}`,
], { stdio: "ignore" });

createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  (req, res) => {
    // `X-Forwarded-Proto` is what tells the app it is being served over TLS, so
    // `Secure` cookies are set and the redirect targets it builds stay https.
    const upstream = request(
      {
        host: "127.0.0.1",
        port: TARGET,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": `${host}:${LISTEN}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      // A dead upstream must not read as an application failure: 502 with the
      // reason, so a probe reports "terminator could not reach the server".
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`tls-front: upstream 127.0.0.1:${TARGET} — ${err.message}\n`);
    });
    req.pipe(upstream);
  },
).listen(LISTEN, host, () => {
  console.log(`tls-front: https://${host}:${LISTEN} → http://127.0.0.1:${TARGET}`);
  console.log(`  NEXT_PUBLIC_SITE_URL=https://${host}:${LISTEN}`);
  console.log(`  cert: ${certFile} (self-signed, throwaway)`);
});
