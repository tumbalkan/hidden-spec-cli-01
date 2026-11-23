// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// mend applies an edit that an AI model wrote to a tree of text files. Models
// write edits in four formats: a unified diff (often with wrong line numbers),
// SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
// JSON. Each format is read as SPEC.md says, and every file is changed or
// nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2 with exactly one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Remove surrounding spaces (space characters only, not other whitespace). */
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and the empty piece after a final `\n` dropped. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, its lines, and whether it ends with a break. */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- matching lines (SPEC.md section 5) ----

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every position where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  const ln = tier === 0 ? lines : lines.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (ln[i + j] !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its occurrences there; null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occs: number[] } | null {
  for (const t of tiers(strict)) {
    const occs = occurrences(lines, o, t);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A non-context line of N, re-indented at tier 2: its leading P (from O's first line) replaced by F (from the file's first matched line). */
function reindent(text: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return text;
  if (text === '' || /^\s+$/.test(text)) return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** One line of O or N: its text, and whether it is a context line (a line of both O and N). */
interface PatchLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines N writes when O matched at `pos`: a context line is written as the
 * file's own matched line, never the patch's; every other line is N's line,
 * re-indented at tier 2.
 */
function replacementLines(n: PatchLine[], o: PatchLine[], lines: string[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((it, idx) => {
    if (it.ctx) oCtx.push(idx);
  });
  const f = pos < lines.length ? leadingWs(lines[pos]) : '';
  const p = o.length > 0 ? leadingWs(o[0].text) : '';
  const out: string[] = [];
  let ci = 0;
  for (const item of n) {
    if (item.ctx) out.push(lines[pos + oCtx[ci++]]);
    else out.push(reindent(item.text, tier, f, p));
  }
  return out;
}

// ---- detecting the format (section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (section 9) ----

/** One JSON edit object, or null when it is not one (a parse fault). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLF = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLF(before);
      const old = toLF(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLF(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (section 6) ----

interface Hunk {
  a: number;
  o: PatchLine[];
  n: PatchLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  noFinalPlus: boolean;
}

interface SectionDraft {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | undefined;
  renameNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters, up to the first tab, surrounding spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = trimSpaces(t);
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's body: the lines after its header, with the empty lines at its end dropped. */
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: PatchLine[] = [];
  const n: PatchLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ') || l === '') {
      const text = l === '' ? '' : l.slice(1);
      o.push({ text, ctx: true });
      n.push({ text, ctx: true });
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false });
    }
  }
  let noFinal = false;
  let noFinalPlus = false;
  let foundCtxPlus = false;
  let foundPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k];
    const isCtx = l.startsWith(' ') || l === '';
    const isPlus = l.startsWith('+');
    if (!foundCtxPlus && (isCtx || isPlus)) {
      foundCtxPlus = true;
      noFinal = k + 1 < body.length && body[k + 1].startsWith('\\');
    }
    if (!foundPlus && isPlus) {
      foundPlus = true;
      noFinalPlus = k + 1 < body.length && body[k + 1].startsWith('\\');
    }
    if (foundCtxPlus && foundPlus) break;
  }
  return { hunk: { a: 0, o, n, noFinal, noFinalPlus }, next: j };
}

/** A section's hunks applied in order to a file's text. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.o.map((it) => it.text);
    if (oTexts.length > 0) {
      const found = findTier(f.lines, oTexts, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occs[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occs) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + oTexts.length === f.lines.length;
      const rep = replacementLines(h.n, h.o, f.lines, best, found.tier);
      f.lines.splice(best, oTexts.length, ...rep);
      if (atEnd) f.final = !h.noFinal;
      d += h.n.length - h.o.length;
    } else {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...h.n.map((it) => it.text));
      if (atEnd) f.final = !h.noFinal;
      d += h.n.length;
    }
  }
  return joinFile(f);
}

function sectionEdit(d: SectionDraft, strict: boolean): Edit {
  const oldPath = d.hasPair ? d.pairOld : d.renameOld !== undefined ? d.renameOld : d.gitOld !== undefined ? d.gitOld : null;
  const newPath = d.hasPair ? d.pairNew : d.renameNew !== undefined ? d.renameNew : d.gitNew !== undefined ? d.gitNew : null;
  if (oldPath === null || d.create) {
    return (tree) => {
      if (newPath === null) return;
      if (!safePath(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of d.hunks) for (const it of h.n) if (!it.ctx) plus.push(it.text);
      let noFinal = false;
      for (let k = d.hunks.length - 1; k >= 0; k--) {
        if (d.hunks[k].n.some((it) => !it.ctx)) {
          noFinal = d.hunks[k].noFinalPlus;
          break;
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
    };
  }
  if (newPath === null || d.remove) {
    return (tree) => {
      if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safePath(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const after = applyHunks(before, d.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, after);
      tree.moves.push([oldPath, newPath]);
    };
  }
  return (tree) => {
    if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, d.hunks, strict, oldPath));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const drafts: SectionDraft[] = [];
  const newDraft = (): SectionDraft => ({
    gitOld: undefined,
    gitNew: undefined,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameOld: undefined,
    renameNew: undefined,
    create: false,
    remove: false,
    hunks: [],
  });
  let cur: SectionDraft | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      if (!l.startsWith('diff --git a/')) throw new Exit2(`error: parse ${i + 1}`);
      const rest = l.slice('diff --git a/'.length);
      const sep = rest.indexOf(' b/');
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      cur = newDraft();
      cur.gitOld = rest.slice(0, sep);
      cur.gitNew = rest.slice(sep + 3);
      drafts.push(cur);
      i += 1;
    } else if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i);
      hunk.a = Number(m[1]);
      cur.hunks.push(hunk);
      i = next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) {
        cur = newDraft();
        drafts.push(cur);
      }
      cur.hasPair = true;
      cur.pairOld = headerPath(l);
      cur.pairNew = headerPath(lines[i + 1]);
      i += 2;
    } else if (l.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
    } else if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (drafts.length === 0) throw new Exit2('error: parse 1');
  return drafts.map((d) => sectionEdit(d, strict));
}

// ---- SEARCH/REPLACE blocks (section 7) ----

interface SrBlock {
  path: string;
  old: string[];
  next: string[];
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occs.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occs[0];
    const oItems: PatchLine[] = b.old.map((text) => ({ text, ctx: false }));
    const nItems: PatchLine[] = b.next.map((text) => ({ text, ctx: false }));
    const rep = replacementLines(nItems, oItems, f.lines, pos, found.tier);
    f.lines.splice(pos, b.old.length, ...rep);
    tree.now.set(b.path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      let j = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '=======') {
          j = k;
          break;
        }
      }
      if (j < 0) throw new Exit2(`error: parse ${i + 1}`);
      let k = -1;
      for (let m = j + 1; m < lines.length; m++) {
        if (lines[m].trimEnd() === '>>>>>>> REPLACE') {
          k = m;
          break;
        }
      }
      if (k < 0) throw new Exit2(`error: parse ${i + 1}`);
      let path: string | null = null;
      for (let p = i - 1; p >= prevEnd; p--) {
        const t = lines[p].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
        path = prevPath;
      }
      prevPath = path;
      blocks.push({ path, old: lines.slice(i + 1, j), next: lines.slice(j + 1, k) });
      prevEnd = k + 1;
      i = k + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

// ---- V4A patches (section 8) ----

interface V4aChunk {
  anchor: string | null;
  o: PatchLine[];
  n: PatchLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

const V4A_PREFIX: Record<string, string> = {
  add: '*** Add File: ',
  delete: '*** Delete File: ',
  update: '*** Update File: ',
};

function v4aSectionKind(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith(V4A_PREFIX.add)) return 'add';
  if (l.startsWith(V4A_PREFIX.delete)) return 'delete';
  if (l.startsWith(V4A_PREFIX.update)) return 'update';
  return null;
}

function finishChunk(c: { anchor: string | null; body: string[]; eof: boolean }): V4aChunk {
  const o: PatchLine[] = [];
  const n: PatchLine[] = [];
  for (const l of c.body) {
    if (l.startsWith(' ') || l === '') {
      const text = l === '' ? '' : l.slice(1);
      o.push({ text, ctx: true });
      n.push({ text, ctx: true });
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false });
    }
  }
  return { anchor: c.anchor, o, n, eof: c.eof };
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safePath(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safePath(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          const a = normLine(chunk.anchor, t);
          for (let idx = cursor; idx < f.lines.length; idx++) {
            if (normLine(f.lines[idx], t) === a) {
              found = idx;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const oTexts = chunk.o.map((it) => it.text);
      if (oTexts.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const rep = chunk.n.map((it) => it.text);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else {
        let hit: { tier: number; pos: number } | null = null;
        for (const t of tiers(strict)) {
          const occs = occurrences(f.lines, oTexts, t).filter((pos) => pos >= cursor && (!chunk.eof || pos + oTexts.length === f.lines.length));
          if (occs.length > 0) {
            hit = { tier: t, pos: occs[0] };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', s.path);
        const rep = replacementLines(chunk.n, chunk.o, f.lines, hit.pos, hit.tier);
        f.lines.splice(hit.pos, oTexts.length, ...rep);
        cursor = hit.pos + rep.length;
      }
    }
    const after = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, after);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = trimSpaces(l.slice(V4A_PREFIX[kind].length));
    const secLines: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < last && v4aSectionKind(lines[j]) === null) {
      secLines.push({ text: lines[j], num: j + 1 });
      j += 1;
    }
    while (secLines.length > 0 && isBlank(secLines[secLines.length - 1].text)) secLines.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text.startsWith('+')) addLines.push(sl.text.slice(1));
        else if (sl.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${sl.num}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [] });
    } else if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0].num}`);
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (secLines.length > 0 && secLines[0].text.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(secLines[0].text.slice('*** Move to: '.length));
        start = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      let firstChunk = true;
      for (let s = start; s < secLines.length; s++) {
        const sl = secLines[s];
        const t = sl.text;
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${sl.num}`);
          cur.eof = true;
          chunks.push(finishChunk(cur));
          cur = null;
          firstChunk = false;
        } else if (t.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(finishChunk(cur));
            cur = null;
          }
          const anchorText = trimSpaces(t.slice(2));
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          firstChunk = false;
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${sl.num}`);
            cur = { anchor: null, body: [], eof: false };
            firstChunk = false;
          }
          cur.body.push(t);
        } else {
          throw new Exit2(`error: parse ${sl.num}`);
        }
      }
      if (cur !== null) chunks.push(finishChunk(cur));
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

// ---- the command line (sections 1, 2, 10) ----

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  const seenMoves = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const mk = `${oldP}\0${newP}`;
    if (seenMoves.has(mk)) continue;
    seenMoves.add(mk);
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : wasOld;
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
