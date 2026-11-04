#!/usr/bin/env node
// 私聊按需巡回群聊记忆检索工具：
// 用法：node "E:\AI\qq-bridge\scripts\agy-recall-group.mjs" "关键词1" "关键词2"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).map((a) => String(a || '').trim()).filter((a) => a && !a.startsWith('--'));
const queries = args.length > 0 ? args : [''];

const groupsRoot = path.join(ROOT, 'memory', 'groups');
const hits = [];

if (fs.existsSync(groupsRoot)) {
  for (const gName of fs.readdirSync(groupsRoot)) {
    const gDir = path.join(groupsRoot, gName);
    if (!fs.statSync(gDir).isDirectory()) continue;
    const files = [];
    const sumPath = path.join(gDir, 'summary.md');
    if (fs.existsSync(sumPath)) files.push({ path: sumPath, tag: `${gName}/常驻` });
    const peopleDir = path.join(gDir, 'people');
    if (fs.existsSync(peopleDir)) {
      for (const f of fs.readdirSync(peopleDir).filter((x) => x.endsWith('.md'))) {
        files.push({ path: path.join(peopleDir, f), tag: `${gName}/人物/${f.replace(/\.md$/, '')}` });
      }
    }
    const diaryDir = path.join(gDir, 'diary');
    if (fs.existsSync(diaryDir)) {
      const dFiles = fs.readdirSync(diaryDir)
        .filter((x) => x.endsWith('.md'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 20);
      for (const f of dFiles) {
        files.push({ path: path.join(diaryDir, f), tag: `${gName}/${f.replace(/\.md$/, '')}` });
      }
    }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('>')) continue;
        let score = 0;
        for (const q of queries) {
          if (!q) {
            score = 1;
            continue;
          }
          if (line.toLowerCase().includes(q.toLowerCase())) score += 5;
        }
        if (score > 0) {
          hits.push({ score, text: `[${f.tag}] ${line.replace(/^[-*]\s*/, '')}` });
        }
      }
    }
  }
}

hits.sort((a, b) => b.score - a.score);
const unique = [...new Set(hits.map((h) => h.text))].slice(0, 12);
if (unique.length === 0) {
  console.log('未在群聊记忆库中命中该关键词。');
} else {
  console.log(`=== 群聊记忆按需巡回结果（共 ${unique.length} 条） ===`);
  for (const u of unique) console.log(`- ${u}`);
}
