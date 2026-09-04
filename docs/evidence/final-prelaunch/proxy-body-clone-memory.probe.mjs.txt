/** Concurrent anonymous multipart POSTs to an UNROUTED matched path: does the body land in memory? */
import { connect } from "node:net";
import { execSync } from "node:child_process";

const PORT = 3052, HOST = "127.0.0.1", PID = process.argv[2];
const B = "----pdfdadiMem";
const CHUNK = Buffer.alloc(1024 * 1024, 0x41);
const TOTAL = 100 * 1024 * 1024;
const N = Number(process.argv[3] ?? 4);

const rss = () => Math.round(Number(execSync(`ps -o rss= -p ${PID}`).toString().trim()) / 1024);

function slowPost(path) {
  return new Promise((resolve) => {
    let sent = 0, done = false, status = null;
    const sock = connect(PORT, HOST);
    const fin = () => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ status, sentMiB: Math.round(sent / 1048576) }); };
    sock.on("data", (d) => { const s = d.toString("latin1").match(/^HTTP\/1\.1 (\d+)/); if (s) { status = Number(s[1]); fin(); } });
    sock.on("error", fin); sock.on("close", fin);
    sock.on("connect", () => {
      sock.write(`POST ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nContent-Type: multipart/form-data; boundary=${B}\r\nContent-Length: ${TOTAL}\r\nConnection: close\r\n\r\n`);
      sock.write(`--${B}\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\n`);
      const pump = () => {
        // 8 MiB per 100ms per connection: slow enough that all N are in flight together.
        if (done) return;
        for (let i = 0; i < 8 && sent < TOTAL; i += 1) { sent += CHUNK.length; sock.write(CHUNK); }
        if (sent < TOTAL) setTimeout(pump, 100); else setTimeout(fin, 4000);
      };
      pump();
    });
  });
}

const base = rss();
console.log(`baseline RSS ${base} MB · ${N} concurrent x 100 MiB to /api/nope (unrouted, matched, anonymous)`);
let peak = base;
const t = setInterval(() => { const r = rss(); if (r > peak) peak = r; }, 150);
const res = await Promise.all(Array.from({ length: N }, () => slowPost("/api/nope")));
clearInterval(t);
console.log(`statuses ${JSON.stringify(res.map((r) => r.status))} · bytes read ${JSON.stringify(res.map((r) => r.sentMiB + "MiB"))}`);
console.log(`peak RSS ${peak} MB (+${peak - base} MB over baseline)`);
await new Promise((r) => setTimeout(r, 6000));
console.log(`RSS 6s after ${rss()} MB`);
