#!/usr/bin/env bun
/**
 * scripts/list-skills.ts
 *
 * Surface the YAML frontmatter of all SKILL.md files in this project's
 * `.claude/skills/` directory (falling back to `skills/`). Mirrors how the
 * Claude Code harness lists available skills, but as plain stdout an agent
 * can read.
 *
 * Sub-agents spawned via the Agent tool do NOT inherit the parent session's
 * skill registry — they see only the parent's skills, not the project-local
 * skills in their working directory. Running this script gives a sub-agent
 * operating in this project a quick index of available local skills. The
 * agent can then read any relevant SKILL.md by the printed path before
 * following its steps.
 *
 * Usage:
 *   bun run scripts/list-skills.ts
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const CANDIDATE_DIRS = ['.claude/skills', 'skills'] as const;

interface SkillEntry {
  name: string;
  description: string;
  path: string;
  references: string[];
}

/**
 * Naive YAML frontmatter parser. Handles flat `key: value` pairs and
 * folded (`>`) / literal (`|`) block scalars over indented continuation
 * lines. Sufficient for SKILL.md frontmatter — do not extend to general
 * YAML; pull in a real parser if the format outgrows this.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const [, key, raw] = kv;
    const val = raw.trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const buf: string[] = [];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        buf.push(lines[i].trim());
        i++;
      }
      out[key] = buf.join(' ').trim();
      continue;
    }
    out[key] = val;
    i++;
  }
  return out;
}

async function listReferences(skillDir: string): Promise<string[]> {
  const refsDir = join(skillDir, 'references');
  if (!existsSync(refsDir)) return [];
  const entries = await readdir(refsDir);
  return entries.filter((e) => e.endsWith('.md')).sort();
}

function findSkillsDir(): string | null {
  for (const dir of CANDIDATE_DIRS) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

async function main(): Promise<void> {
  const dir = findSkillsDir();
  if (!dir) {
    console.error(
      `No skills directory found. Expected one of: ${CANDIDATE_DIRS.join(', ')} at cwd (${resolve('.')}).`,
    );
    process.exit(1);
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const skills: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const content = await readFile(skillPath, 'utf-8');
    const fm = parseFrontmatter(content);
    skills.push({
      name: fm.name ?? entry.name,
      description: fm.description ?? '',
      path: resolve(skillPath),
      references: await listReferences(skillDir),
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`# Skills available in ${dir}/`);
  console.log(`# Working directory: ${resolve('.')}`);
  console.log(`#`);
  console.log(`# Sub-agents: this list mimics the parent harness's skill registry.`);
  console.log(`# Read the full SKILL.md at the listed path before following a skill's procedure.\n`);

  for (const s of skills) {
    console.log(`- ${s.name} (${s.path})`);
    if (s.description) console.log(`  ${s.description}`);
    if (s.references.length > 0) {
      console.log(`  references: ${s.references.join(', ')}`);
    }
    console.log();
  }

  console.log(`Total: ${skills.length} skills`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
