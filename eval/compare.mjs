// eval/compare.mjs
//
// Regression gate: compare a candidate eval report against the frozen baseline.
// A tracked metric dropping by more than the band (default 0.02 = the "-2pt
// recall@5" gate from design v2.1 §9) is a regression -> exit 1. Improvements
// and within-band moves are reported but pass. Use to gate Phase 2 retrieval
// changes against eval/baseline.json.
//
// Usage: node eval/compare.mjs <baseline.json> <candidate.json> [--band 0.02]

import { readFileSync } from "node:fs";

const TRACKED = ["recall@1","recall@5","recall@10","recall@20","mrr","ndcg10","success@5"];

function parseArgs(argv) {
  const a = { baseline: null, candidate: null, band: 0.02 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--band") a.band = parseFloat(argv[++i]);
    else if (!a.baseline) a.baseline = argv[i];
    else if (!a.candidate) a.candidate = argv[i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.baseline || !args.candidate) {
  console.error("usage: compare.mjs <baseline.json> <candidate.json> [--band 0.02]");
  process.exit(2);
}

const base = JSON.parse(readFileSync(args.baseline, "utf8")).overall;
const cand = JSON.parse(readFileSync(args.candidate, "utf8")).overall;

let regressed = 0, improved = 0;
console.log(`gate band = ${args.band}  (drop beyond this = FAIL)\n`);
console.log(`${"metric".padEnd(12)} ${"base".padStart(8)} ${"cand".padStart(8)} ${"delta".padStart(8)}  status`);
for (const m of TRACKED) {
  const b = base[m], c = cand[m];
  if (b == null || c == null) { console.log(`${m.padEnd(12)} ${String(b).padStart(8)} ${String(c).padStart(8)}      n/a  skip`); continue; }
  const d = c - b;
  let status = "ok";
  if (d < -args.band) { status = "REGRESSION"; regressed++; }
  else if (d > args.band) { status = "improved"; improved++; }
  const sign = d >= 0 ? "+" : "";
  console.log(`${m.padEnd(12)} ${b.toFixed(4).padStart(8)} ${c.toFixed(4).padStart(8)} ${(sign+d.toFixed(4)).padStart(8)}  ${status}`);
}

console.log(`\n${regressed} regression(s), ${improved} improvement(s).`);
if (regressed > 0) { console.log("GATE: FAIL"); process.exit(1); }
console.log("GATE: PASS");
process.exit(0);
