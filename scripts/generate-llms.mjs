#!/usr/bin/env node
/** Generate llms.txt and llms-full.txt from this package's skills. */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(scriptDir, "..");
const skillsDir = join(pkgRoot, "skills");
const llmsTxtPath = join(pkgRoot, "llms.txt");
const llmsFullPath = join(pkgRoot, "llms-full.txt");
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const packageName = pkgJson.name;
const tagline = pkgJson.description ?? "";
const shortName = packageName.split("/").pop();
const projectName =
  "Warlock " +
  shortName
    .split("-")
    .map((part) =>
      part.length <= 2 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
const packageNotes = [
  "SSR React pages served by the same Warlock HTTP server that serves the API — a backend framework that renders React, not a React framework.",
  "First published release: 5.0.0. `@warlock.js/web` had never been published to npm before this release.",
  "Use 5.1 or newer. In an installed 5.0.0–5.0.2 app no client JavaScript ran at all: the dev server served `react-dom/client` as raw CommonJS, so `hydrateRoot` was missing and hydration failed on import — dead `useState`, no HMR, `<Link>` falling back to full page loads. Pages still server-rendered, which is why it looked like a React problem.",
  "Consumer entry points: `@warlock.js/web`, `@warlock.js/web/client/runtime`, `@warlock.js/web/connector`, and `@warlock.js/web/vite`. The published `@warlock.js/web/hydration` subpath is a framework build input; application code never imports it.",
  "Deliberate non-goals: server actions are a v2 design decision rather than a missing v1 feature; page routes reject regex parameters, optional parameters, and multiple parameters in one segment.",
];

function parseFrontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: contents };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
    }
    meta[key] = value;
  }

  return { meta, body: match[2] };
}

function collectSkills() {
  if (!existsSync(skillsDir)) return [];

  const skills = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const folderPath = join(skillsDir, entry);
    if (!statSync(folderPath).isDirectory()) continue;

    const skillPath = join(folderPath, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    skills.push({ folder: entry, path: skillPath, folderPath });
  }
  return skills;
}

function collectReferenceFiles(folderPath) {
  return readdirSync(folderPath)
    .sort()
    .filter((entry) => entry !== "SKILL.md" && entry.endsWith(".md"))
    .map((entry) => ({ name: entry, path: join(folderPath, entry) }));
}

const skills = collectSkills();
const indexLines = [`# ${projectName}`, "", `> Package: \`${packageName}\``, ""];
if (tagline) indexLines.push(`> ${tagline}`, "");
for (const note of packageNotes) indexLines.push(`> ${note}`, "");
indexLines.push("## Skills", "");

for (const skill of skills) {
  const { meta } = parseFrontmatter(readFileSync(skill.path, "utf8"));
  indexLines.push(
    `- [${skill.folder}](${packageName}/${skill.folder}/SKILL.md): ${meta.description ?? "(no description)"}`,
  );
}
writeFileSync(llmsTxtPath, `${indexLines.join("\n")}\n`, "utf8");

const fullLines = [
  `# ${projectName} — full skills`,
  "",
  `> Package: \`${packageName}\``,
  "",
  `> Generated artifact. Concatenates every SKILL.md and reference file under \`${packageName}/skills/\`. Re-run \`node scripts/generate-llms.mjs\` after any change.`,
  "",
];

for (const skill of skills) {
  fullLines.push(
    `## ${skill.folder}  \`${packageName}/${skill.folder}/SKILL.md\``,
    "",
    readFileSync(skill.path, "utf8").trimEnd(),
    "",
  );
  for (const reference of collectReferenceFiles(skill.folderPath)) {
    fullLines.push(
      `### ${skill.folder}/${reference.name}  \`${packageName}/${skill.folder}/${reference.name}\``,
      "",
      readFileSync(reference.path, "utf8").trimEnd(),
      "",
    );
  }
}
writeFileSync(llmsFullPath, `${fullLines.join("\n")}\n`, "utf8");

console.log(`OK  ${packageName}  (${skills.length} skills)`);
console.log(`    ${llmsTxtPath}`);
console.log(`    ${llmsFullPath}`);
