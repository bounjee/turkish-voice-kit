/**
 * Turkish TTS benchmark: blind listening page. Human scores are the real measure; the machine (STT)
 * score sits next to them.
 *
 *   npx tsx listen.ts                          # http://localhost:4477 (results: /results), all sentences
 *   npx tsx listen.ts --ids fiyat-paket,telefon-cep   # only these sentence ids
 *
 * The `text` recordings (`runs/audio/<model>/`) of the chosen sentences are rated. Each screen shows one
 * sentence with all models' recordings below it. While rating, model names never reach the browser
 * (a clip id is a hash); once every recording is rated the names appear next to them. Sentence order and
 * clip order within a sentence are shuffled but fixed, and rating resumes where it stopped. Loudness is
 * normalized (a louder clip must not seem better). Ratings are appended to `runs/listening.jsonl`; the
 * last line for a clip wins.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const dir = new URL(".", import.meta.url).pathname;
const OUT = `${dir}runs`;
const PORT = 4477;
const SCORES = `${OUT}/listening.jsonl`;

const idsArg = process.argv.indexOf("--ids");
const only = idsArg > 0 ? new Set(process.argv[idsArg + 1]?.split(",").map((s) => s.trim())) : null;
type Item = { id: string; text: string };
const items = (JSON.parse(readFileSync(`${dir}sentences.json`, "utf8")) as { items: Item[] }).items.filter((i) => !only || only.has(i.id));
const models = readdirSync(`${OUT}/audio`);
const hash = (s: string) => createHash("sha1").update(`blind-listening|${s}`).digest("hex");

/** Clip id → model and file; the browser only sees the id. */
const clips = new Map<string, { model: string; id: string; file: string; src: string }>();
mkdirSync(`${OUT}/listening-audio`, { recursive: true });
const groups = items
  .map((item) => {
    const keys: string[] = [];
    for (const model of models) {
      const src = readdirSync(`${OUT}/audio/${model}`).find((f) => f.startsWith(`${item.id}__text.`));
      if (!src) continue;
      const key = hash(`${model}|${item.id}`).slice(0, 12);
      const file = `${OUT}/listening-audio/${key}.mp3`;
      if (!existsSync(file)) {
        execFileSync("ffmpeg", ["-v", "error", "-y", "-i", `${OUT}/audio/${model}/${src}`, "-af", "loudnorm=I=-20:TP=-2:LRA=11", "-ac", "1", "-ar", "44100", "-b:a", "128k", file]);
      }
      clips.set(key, { model, id: item.id, file, src: `${OUT}/audio/${model}/${src}` });
      keys.push(key);
    }
    return { id: item.id, text: item.text, clips: keys.sort() };
  })
  .sort((a, b) => hash(a.id).localeCompare(hash(b.id)));

function scores() {
  const last: Record<string, unknown> = {};
  if (existsSync(SCORES)) for (const line of readFileSync(SCORES, "utf8").split("\n").filter(Boolean)) last[JSON.parse(line).key] = JSON.parse(line);
  return last;
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Blind listening</title>
<style>
body{font:15px/1.5 system-ui;margin:0;background:#f6f5f1;color:#1a1a1a}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
.progress{color:#666;font-size:14px}
.sentence{font-size:22px;line-height:1.35;margin:12px 0 20px;padding:18px 20px;background:#fff;border-radius:12px}
.row,.head{display:grid;grid-template-columns:104px 150px 216px 1fr 72px;gap:14px;align-items:center;padding:10px 12px;border-radius:10px}
.head{padding:0 12px 4px;color:#666;font-size:13px}
.named .row,.named .head{grid-template-columns:300px 150px 216px 1fr 72px}
.row.playing{background:#ecebe4}
.row.done .name{color:#1a7f37}
.group{display:flex;gap:6px}
button{font:inherit;padding:8px 12px;border:1px solid #c9c7c0;border-radius:8px;background:#fff;cursor:pointer}
button.on{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
button.name{font-weight:600;white-space:nowrap}
button:disabled{opacity:.4;cursor:default}
input{font:inherit;padding:8px 10px;border:1px solid #c9c7c0;border-radius:8px;min-width:0}
.nav{display:flex;gap:12px;align-items:center;margin-top:20px}
</style>
<main>
<div class="progress" id="progress"></div>
<div class="sentence" id="sentence"></div>
<div class="head"><span>Listen</span><span>Reading</span><span>Naturalness (1 robot · 5 human)</span><span>Note (optional)</span><span></span></div>
<div id="rows"></div>
<div class="nav"><button id="prev">Previous sentence</button><button id="next">Next sentence</button><span class="progress" id="left"></span></div>
<p class="progress" style="margin-top:28px"><a href="/results">See results</a> (reveals model names; do not look before rating is done)</p>
</main>
<script>
let groups = [], score = {}, names = {}, g = 0, audio = new Audio(), playing = null;
const q = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const done = (key) => score[key] && score[key].correct !== undefined && score[key].natural;
function save(key) {
  if (!done(key)) return;
  const p = score[key];
  fetch("/api/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, correct: p.correct, natural: p.natural, note: p.note || "" }) });
}
function pick(key, field, value) { score[key] = { ...(score[key] || {}), [field]: value }; save(key); draw(); }
function play(key) { playing = key; audio.src = "/audio/" + key + ".mp3"; audio.play().catch(() => {}); draw(); }
audio.onended = () => { playing = null; draw(); };
function draw() {
  const group = groups[g];
  if (!group) return;
  const all = groups.flatMap((x) => x.clips);
  q("#progress").textContent = "Sentence " + (g + 1) + " / " + groups.length + " · " + all.filter(done).length + " / " + all.length + " recordings rated";
  q("#sentence").textContent = group.text;
  q("#rows").replaceChildren(...group.clips.map((key, n) => {
    const p = score[key] || {};
    const row = el("div", "row" + (playing === key ? " playing" : "") + (done(key) ? " done" : ""));
    const listen = el("button", "name", (playing === key ? "■ " : "▶ ") + "Clip " + (n + 1) + (names[key] ? " · " + names[key] : ""));
    listen.onclick = () => play(key);
    const reading = el("div", "group");
    for (const [label, value] of [["Correct", true], ["Wrong", false]]) {
      const b = el("button", p.correct === value ? "on" : "", label);
      b.onclick = () => pick(key, "correct", value);
      reading.append(b);
    }
    const natural = el("div", "group");
    for (const k of [1, 2, 3, 4, 5]) {
      const b = el("button", p.natural === k ? "on" : "", String(k));
      b.onclick = () => pick(key, "natural", k);
      natural.append(b);
    }
    const note = el("input");
    note.placeholder = "what was wrong?";
    note.value = p.note || "";
    note.onchange = () => { score[key] = { ...(score[key] || {}), note: note.value.trim() }; save(key); };
    const download = el("a", "", "Download");
    download.href = "/download/" + key;
    row.append(listen, reading, natural, note, download);
    return row;
  }));
  const left = group.clips.filter((key) => !done(key)).length;
  q("#left").textContent = left ? left + " recordings not rated in this sentence" : "This sentence is done";
  q("#prev").disabled = g === 0;
  q("#next").disabled = g === groups.length - 1;
}
function go(to) { g = to; audio.pause(); playing = null; draw(); scrollTo(0, 0); }
q("#prev").onclick = () => go(g - 1);
q("#next").onclick = () => go(g + 1);
fetch("/api/state").then((r) => r.json()).then((d) => {
  groups = d.groups; score = d.scores; names = d.names || {};
  document.querySelector("main").classList.toggle("named", Object.keys(names).length > 0);
  g = Math.max(0, groups.findIndex((x) => x.clips.some((key) => !done(key))));
  draw();
});
</script></html>`;

const LABELS: Record<string, string> = {
  "alania-2": "Alania-2", "antalia-2-mini": "Antalia-2 Mini", "ema-lightning": "EMA Lightning", "trendyol-tts": "Trendyol-TTS", "anka-tts": "Anka TTS",
  "freya-tts-1-hd": "Freya tts-1-hd", "cartesia-sonic-3.6": "Cartesia Sonic 3.6", "elevenlabs-v4": "ElevenLabs v4", "gemini-3.8-flash-tts": "Gemini 3.8 Flash TTS",
  "openai-gpt-4o-mini-tts": "OpenAI gpt-4o-mini-tts",
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Results page: model names are revealed here. One score: half the correct-reading rate, half
 *  naturalness (the 1-5 mean mapped to 0-100). */
function results(): string {
  const rows = Object.values(scores()) as { model: string; id: string; correct: boolean; natural: number; note?: string }[];
  const byModel = models
    .map((model) => {
      const mine = rows.filter((r) => r.model === model);
      const right = mine.filter((r) => r.correct).length;
      const rate = mine.length ? right / mine.length : 0;
      const natural = mine.length ? mine.reduce((sum, r) => sum + r.natural, 0) / mine.length : 0;
      return { model, n: mine.length, right, rate, natural, score: 50 * rate + (50 * (natural - 1)) / 4 };
    })
    .filter((m) => m.n)
    .sort((a, b) => b.score - a.score);
  const table = byModel
    .map((m, i) => `<tr><td>${i + 1}</td><td>${esc(LABELS[m.model] ?? m.model)}</td><td><b>${m.score.toFixed(1)}</b></td><td>${m.right} / ${m.n}</td><td>${Math.round(m.rate * 100)}%</td><td>${m.natural.toFixed(2)}</td></tr>`)
    .join("");
  const sentences = groups
    .map((g) => {
      const mine = rows.filter((r) => r.id === g.id);
      const wrong = mine.filter((r) => !r.correct).map((r) => (LABELS[r.model] ?? r.model) + (r.note ? ` (${r.note})` : ""));
      return `<tr><td>${esc(g.text)}</td><td>${mine.filter((r) => r.correct).length} / ${mine.length}</td><td>${esc(wrong.join(", ") || "–")}</td></tr>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Blind listening results</title>
<style>body{font:15px/1.5 system-ui;margin:0;background:#f6f5f1;color:#1a1a1a}main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;margin:12px 0 32px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #eceae4;vertical-align:top}
th{font-size:13px;color:#666;font-weight:600}p{color:#666}</style>
<main><h2>Blind listening results</h2>
<p>${rows.length} / ${clips.size} recordings rated, ${groups.length} sentences. Score out of 100: half the correct-reading rate, half naturalness (1 robot, 5 human).</p>
<table><tr><th>Rank</th><th>Model</th><th>Score</th><th>Read correctly</th><th>Rate</th><th>Naturalness</th></tr>${table}</table>
<h3>By sentence</h3>
<table><tr><th>Sentence</th><th>Read correctly by</th><th>Misread by</th></tr>${sentences}</table>
<p><a href="/">Back to listening</a></p></main></html>`;
}

createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
  if (url === "/results") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(results());
  if (url === "/api/state") {
    // Only clip ids and rating fields are sent; model names are added only after every recording is rated.
    const all = scores();
    const safe = Object.fromEntries(Object.entries(all).map(([k, v]) => { const { correct, natural, note } = v as Record<string, unknown>; return [k, { correct, natural, note }]; }));
    const names = [...clips.keys()].every((k) => k in all) ? Object.fromEntries([...clips].map(([k, c]) => [k, LABELS[c.model] ?? c.model])) : {};
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ groups: groups.map((g) => ({ text: g.text, clips: g.clips })), scores: safe, names }));
  }
  const audio = /^\/audio\/([0-9a-f]{12})\.mp3$/.exec(url);
  if (audio && clips.has(audio[1])) return res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" }).end(readFileSync(clips.get(audio[1])!.file));
  // The model's original audio, loudness unchanged, as MP3 (WAV is converted). Before names are revealed the
  // file name does not carry the model name either.
  const download = /^\/download\/([0-9a-f]{12})$/.exec(url);
  if (download && clips.has(download[1])) {
    const clip = clips.get(download[1])!;
    const open = [...clips.keys()].every((k) => k in scores());
    const name = open ? `${clip.model}__${clip.id}.mp3` : `clip-${download[1]}.mp3`;
    const mp3 = clip.src.endsWith(".mp3") ? readFileSync(clip.src) : execFileSync("ffmpeg", ["-v", "error", "-i", clip.src, "-b:a", "192k", "-f", "mp3", "-"], { maxBuffer: 1 << 26 });
    return res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Disposition": `attachment; filename="${name}"` }).end(mp3);
  }
  if (url === "/api/score" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { key, correct, natural, note } = JSON.parse(body) as { key: string; correct: boolean; natural: number; note?: string };
      const clip = clips.get(key);
      if (!clip) return res.writeHead(400).end();
      appendFileSync(SCORES, JSON.stringify({ t: new Date().toISOString(), key, model: clip.model, id: clip.id, correct, natural, note: note ?? "" }) + "\n");
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => {
  console.info(`Blind listening: http://localhost:${PORT}  (${groups.length} sentences, ${clips.size} recordings, ${models.length} models)`);
  // Missing recordings skew the ranking: show before starting if a model's set is incomplete.
  for (const model of models) {
    const n = [...clips.values()].filter((c) => c.model === model).length;
    if (n < groups.length) console.info(`  MISSING ${model}: ${n} / ${groups.length} recordings`);
  }
});
