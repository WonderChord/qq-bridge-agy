#!/usr/bin/env node
// 全域按需记忆检索工具（同时支持检索 Creator 详细事件簿 event_book.md、私聊日记与群聊记忆库）：
// 用法：node "<QQ_BRIDGE_DIR>/scripts/agy-recall-group.mjs" "关键词1" "关键词2"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).map((a) => String(a || '').trim()).filter((a) => a && !a.startsWith('--'));
const queries = args.length > 0 ? args : [''];

function parseEventBookBlocks(raw) {
  const blocks = [];
  let currentHeader = '';
  let currentTags = '';
  let currentDetail = '';
  const flush = () => {
    if (!currentHeader) return;
    const text = `${currentHeader}${currentDetail ? ' —— ' + currentDetail : ''}${currentTags ? ' [标签: ' + currentTags + ']' : ''}`;
    blocks.push(text);
    currentHeader = '';
    currentTags = '';
    currentDetail = '';
  };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const mBulletEvt = line.match(/^[-*]\s*\*\*(\[EVT-[^*]+)\*\*(.*)$/);
    if (line.startsWith('### ')) {
      flush();
      currentHeader = line.replace(/^###\s+/, '').trim();
    } else if (mBulletEvt) {
      flush();
      currentHeader = mBulletEvt[1].trim();
      const tail = (mBulletEvt[2] || '').trim();
      if (tail) currentTags = tail;
    } else if (currentHeader) {
      const mTag = line.match(/^[-*]\s*\*\*(?:检索标签|关键词)\*\*[：:]\s*(.+)$/);
      const mDet = line.match(/^[-*]\s*\*\*(?:事件与细节|始末)\*\*[：:]\s*(.+)$/);
      if (mTag) currentTags = mTag[1].trim();
      else if (mDet) currentDetail = mDet[1].trim();
      else if (!line.startsWith('#') && !line.startsWith('>')) {
        currentDetail += (currentDetail ? ' ' : '') + line.replace(/^[-*]\s+/, '');
      }
    }
  }
  flush();
  return blocks;
}

const hits = [];

function scanLines(lines, tag, boost = 0) {
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    let score = 0;
    for (const q of queries) {
      if (!q) {
        score = 1;
        continue;
      }
      if (line.toLowerCase().includes(q.toLowerCase())) score += 5 + boost;
    }
    if (score > 0) {
      const clean = line.replace(/^[-*]\s*/, '').replace(/\s*\[标签:\s*[^\]]+\]\s*$/, '');
      hits.push({ score, text: `[${tag}] ${clean.slice(0, 380)}` });
    }
  }
}

// 1. 检索 Creator 私聊记忆舱（event_book.md 优先加权 + intimate_ledger.md + owner.md + diary/*.md）
const privRoot = path.join(ROOT, 'memory', 'creator_private');
if (fs.existsSync(privRoot)) {
  const eventBookPath = path.join(privRoot, 'event_book.md');
  if (fs.existsSync(eventBookPath)) {
    try {
      const raw = fs.readFileSync(eventBookPath, 'utf8');
      scanLines(parseEventBookBlocks(raw), 'Creator事件簿', 3);
    } catch {}
  }
  const intimatePath = path.join(privRoot, 'intimate_ledger.md');
  if (fs.existsSync(intimatePath)) {
    try {
      scanLines(fs.readFileSync(intimatePath, 'utf8').split(/\r?\n/), '亲密账本', 2);
    } catch {}
  }
  const ownerPath = path.join(privRoot, 'owner.md');
  if (fs.existsSync(ownerPath)) {
    try {
      scanLines(fs.readFileSync(ownerPath, 'utf8').split(/\r?\n/), 'Creator主档', 1);
    } catch {}
  }
  const privDiaryDir = path.join(privRoot, 'diary');
  if (fs.existsSync(privDiaryDir)) {
    const dFiles = fs.readdirSync(privDiaryDir)
      .filter((x) => x.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 30);
    for (const f of dFiles) {
      try {
        scanLines(fs.readFileSync(path.join(privDiaryDir, f), 'utf8').split(/\r?\n/), `私聊日记/${f.replace(/\.md$/, '')}`, 1);
      } catch {}
    }
  }
}

// 2. 检索群聊记忆舱
const groupsRoot = path.join(ROOT, 'memory', 'groups');
if (fs.existsSync(groupsRoot)) {
  for (const gName of fs.readdirSync(groupsRoot)) {
    const gDir = path.join(groupsRoot, gName);
    if (!fs.statSync(gDir).isDirectory()) continue;
    const files = [];
    const sumPath = path.join(gDir, 'summary.md');
    if (fs.existsSync(sumPath)) files.push({ path: sumPath, tag: `${gName}/常驻` });
    const peopleFile = path.join(gDir, 'people.md');
    if (fs.existsSync(peopleFile)) files.push({ path: peopleFile, tag: `${gName}/百字档案` });
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
      try {
        scanLines(fs.readFileSync(f.path, 'utf8').split(/\r?\n/), f.tag, 0);
      } catch {}
    }
  }
}

hits.sort((a, b) => b.score - a.score);
const unique = [...new Set(hits.map((h) => h.text))].slice(0, 15);
if (unique.length === 0) {
  console.log('未在 Creator 事件簿、私聊日记或群聊记忆库中命中该关键词。');
} else {
  console.log(`=== 记忆库按需巡回结果（共 ${unique.length} 条） ===`);
  for (const u of unique) console.log(`- ${u}`);
}
