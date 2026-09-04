/**
 * How much body does the server read before refusing, per path class?
 *
 * Writes a 64 MiB multipart body one 256 KiB chunk at a time over a raw socket and
 * stops the instant response headers arrive, so the number reported is bytes the
 * SERVER accepted, not bytes handed to the kernel.
 */
import { connect } from "node:net";

const PORT = 3052, HOST = "127.0.0.1";
const B = "----pdfdadiUnroutedCost";
const CHUNK = Buffer.alloc(256 * 1024, 0x41);
const TOTAL = 64 * 1024 * 1024;

function head(path, len) {
  return Buffer.from(
    `POST ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\n` +
    `Content-Type: multipart/form-data; boundary=${B}\r\n` +
    `Content-Length: ${len}\r\nConnection: close\r\n\r\n`,
  );
}
const preamble = Buffer.from(
  `--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n` +
  `Content-Type: application/pdf\r\n\r\n`,
);

function run(path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sent = 0, done = false, status = null, cc = null, raw = "";
    const sock = connect(PORT, HOST);
    const finish = () => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve({ path, status, sentMiB: +(sent / 1048576).toFixed(2), ms: Date.now() - t0, cc });
    };
    sock.on("data", (d) => {
      raw += d.toString("latin1");
      if (!status && raw.includes("\r\n\r\n")) {
        status = Number(raw.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
        cc = raw.match(/^cache-control: (.*)$/im)?.[1]?.trim() ?? "-";
        finish();
      }
    });
    sock.on("error", finish);
    sock.on("close", finish);
    sock.on("connect", () => {
      sock.write(head(path, TOTAL));
      sock.write(preamble);
      sent += preamble.length;
      const pump = () => {
        while (!done && sent < TOTAL) {
          sent += CHUNK.length;
          if (!sock.write(CHUNK)) { sock.once("drain", pump); return; }
        }
        if (!done && sent >= TOTAL) setTimeout(finish, 3000);
      };
      pump();
    });
  });
}

const PATHS = [
  // Excluded from the proxy matcher, with a route handler: the accepted upload work.
  ["EXCLUDED  upload route      ", "/api/workspaces/cku1abc/documents/upload"],
  ["EXCLUDED  version upload    ", "/api/workspaces/cku1abc/documents/cku2def/versions/upload"],
  ["EXCLUDED  attachments       ", "/api/workspaces/cku1abc/documents/cku2def/attachments"],
  ["EXCLUDED  tools             ", "/api/tools/merge-pdf"],
  ["EXCLUDED  jobs              ", "/api/jobs"],
  // The A/B that isolates the matcher: NEITHER of these has a route handler, so the
  // only difference between them is whether the proxy matcher claims the path.
  ["MATCHED   unrouted          ", "/api/nope"],
  ["EXCLUDED  unrouted (dotted) ", "/api/nope.txt"],
  // Everything else the matcher claims and the App Router ends: page paths, and a
  // path one segment deeper than an excluded upload route (the alternation is $-anchored).
  ["MATCHED   page path         ", "/"],
  ["MATCHED   upload + 1 segment", "/api/workspaces/cku1abc/documents/upload/extra"],
  ["EXCLUDED  unrouted _next    ", "/_next/static/nope"],
];
console.log("64 MiB multipart streamed, anonymous, measured against the cold artifact:\n");
for (const [label, p] of PATHS) {
  const r = await run(p);
  console.log(`${label} ${String(r.status).padEnd(4)} read ${String(r.sentMiB).padStart(6)} MiB  ${String(r.ms).padStart(6)}ms  cc=${r.cc}`);
}
