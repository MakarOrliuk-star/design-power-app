// One-off: pull Item styles + their nano-gpt prompt wrappers out of the
// CREATE_ITEMS blueprint and write a deduped seed JSON. Not part of the app.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const path = process.argv[2];
const out = process.argv[3];
const bp = JSON.parse(await readFile(path, "utf8"));

const modules = [];
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    if (node.module === "http:ActionSendData") modules.push(node);
    for (const v of Object.values(node)) walk(v);
  }
})(bp);

const seen = new Set();
const styles = [];
for (const m of modules) {
  if (!String(m?.mapper?.url ?? "").includes("/v1/images/generations")) continue;
  const style = m?.filter?.name ?? m?.filter?.conditions?.[0]?.[0]?.b;
  if (!style || seen.has(style)) continue;
  let prompt = "";
  try {
    prompt = JSON.parse(m.mapper.data)?.prompt ?? "";
  } catch {
    continue;
  }
  // Normalize Make placeholders ({{10.Prompt}} / {{11.Prompt}}) → our {{prompt}}.
  prompt = prompt.replace(/\{\{\s*\d+\.Prompt\s*\}\}/g, "{{prompt}}");
  seen.add(style);
  styles.push({ style, prompt });
}

await mkdir(out.replace(/[^/\\]+$/, ""), { recursive: true });
await writeFile(out, JSON.stringify(styles, null, 2) + "\n", "utf8");
console.log(`wrote ${styles.length} styles → ${out}`);
console.log("styles:", styles.map((s) => s.style).join(", "));
