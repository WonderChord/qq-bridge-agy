import fs from 'node:fs';
import path from 'node:path';

const dailyFile = /^\d{4}-\d{2}-\d{2}\.md$/;
function markdownFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
  } catch { return []; }
}

// 监听目录以捕获编辑器的原子替换，同时监听父目录以捕获目录的删除与重建。
function watchDirectories(targets, invalidate) {
  const watchers = [];
  const filters = new Map();
  for (const [directory, accepts] of targets) {
    let dir = directory;
    let filter = accepts;
    while (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      const missing = path.basename(dir);
      filter = (name) => name === missing;
      dir = parent;
    }
    if (!filters.has(dir)) filters.set(dir, []);
    filters.get(dir).push(filter);
  }
  try {
    for (const [dir, accepts] of filters) {
      const watcher = fs.watch(dir, { persistent: false }, (_, name) => {
        if (!name || accepts.some((filter) => filter(name))) invalidate();
      });
      watcher.on('error', invalidate);
      watchers.push(watcher);
    }
    return watchers;
  } catch {
    for (const watcher of watchers) watcher.close();
    return [];
  }
}

function parseFile(file, previous, isProfile) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size && previous.ino === stat.ino) return previous;
    const raw = fs.readFileSync(file, 'utf8');
    // 人物条目可以出现在标题或正文里，先提取整个文件，再参与所有行的评分。
    const entities = isProfile ? [...raw.matchAll(/`([^`\r\n]{2,40})`|\*\*([^*\r\n]{2,40})\*\*/g)]
      .map((m) => (m[1] || m[2]).trim().toLowerCase()) : [];
    const lines = raw.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !/^[#>]/.test(line)).map((line) => line.replace(/^[-*]\s+/, ''));
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, entities, lines };
  } catch { return null; }
}

export function createGroupMemoryIndex() {
  const groups = new Map();
  function discard(key) {
    for (const watcher of groups.get(key)?.watchers || []) watcher.close();
    groups.delete(key);
  }
  function load(key, { summaryPath, diaryDir }) {
    let entry = groups.get(key);
    if (entry?.summaryPath !== summaryPath || entry?.diaryDir !== diaryDir) {
      discard(key);
      entry = { summaryPath, diaryDir, dirty: true, files: new Map(), watchers: [] };
      groups.set(key, entry);
    }
    if (!entry.dirty && (entry.watchers.length || Date.now() < entry.retryAt)) return entry;
    for (const watcher of entry.watchers) watcher.close();
    entry.dirty = false;
    const summaryDir = path.dirname(summaryPath);
    const peopleFile = path.join(summaryDir, 'people.md');
    const peopleDir = path.join(summaryDir, 'people');
    const md = (name) => name.endsWith('.md');
    const targets = [[summaryPath, false], [peopleFile, false], [peopleDir, true], [diaryDir, true]].flatMap(([file, isDir]) => {
      const name = path.basename(file);
      const parent = [path.dirname(file), (changed) => changed === name];
      return isDir ? [parent, [file, md]] : [parent];
    });
    targets.push([path.dirname(summaryDir), (name) => name === path.basename(summaryDir)]);
    try { entry.watchers = watchDirectories(targets, () => { entry.dirty = true; }); }
    catch { entry.watchers = []; }
    // 文件监视不可用时限频检查 mtime，避免索引永久过期。
    entry.retryAt = Date.now() + 2000;
    const files = new Map();
    const sources = [];
    const entities = new Set();
    function add(file, tag, isProfile, date = null) {
      const data = parseFile(file, entry.files.get(file), isProfile);
      if (!data) return;
      files.set(file, data);
      sources.push({ tag, date, lines: data.lines });
      for (const entity of data.entities) entities.add(entity);
    }
    add(summaryPath, '常驻', true);
    add(peopleFile, '百字档案', true);
    for (const name of markdownFiles(peopleDir)) add(path.join(peopleDir, name), '人物/' + name.slice(0, -3), true);
    const diary = markdownFiles(diaryDir).filter((name) => !/raw|chatlog/i.test(name));
    // 日期日记按文件名选最新六份。兼容旧版非日期日记，空位按 mtime 补齐。
    const daily = diary.filter((name) => dailyFile.test(name)).reverse().slice(0, 6);
    if (daily.length < 6) {
      const other = diary.filter((name) => !dailyFile.test(name)).map((name) => ({
        name, mtime: fs.statSync(path.join(diaryDir, name), { throwIfNoEntry: false })?.mtimeMs || 0,
      })).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
      daily.push(...other.slice(0, 6 - daily.length).map((item) => item.name));
    }
    for (const name of daily) {
      const tag = name.slice(0, -3);
      add(path.join(diaryDir, name), tag, false, dailyFile.test(name) ? Date.parse(tag) : null);
    }
    Object.assign(entry, { files, sources, entities, newestDiary: sources.find((s) => s.tag === daily[0]?.slice(0, -3)) });
    return entry;
  }
  return {
    load,
    retain(keys) { for (const key of groups.keys()) if (!keys.includes(key)) discard(key); },
    close() { for (const key of groups.keys()) discard(key); },
  };
}
