// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line (1), the output and
// exit codes (2), safe paths and the line model (3), format detection (4), three-tier matching (5), unified diffs (6),
// SEARCH/REPLACE blocks (7), V4A patches (8), JSON edits (9) and the all-or-nothing write (10). Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  /** True when the path holds a file in the tree, or any entry on disk (a directory counts as existing). */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

/** A move an edit performed (for the `R` output line); void when the edit is not a move. */
interface Move {
  old: string;
  new: string;
}
type Edit = (tree: Tree) => Move | void;

/** A file's lines, its line break, and whether it ends with one (section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5: line equality at a tier (0 exact, 1 trailing ws, 2 leading and trailing ws). */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  const u = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return u(a) === u(b);
}

/** Every 0-based position where O occurs in lines at a tier (occurrences may overlap). */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or -1 (--strict tries tier 0 only). */
function findTier(O: string[], lines: string[], strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(O, lines, t).length > 0) return t;
  }
  return -1;
}

/** One line of N: ctx is the O index when it is a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

/**
 * Replace the k matched lines at pos with N. A context line is written as the file's own matched line, never the
 * patch's. At tier 2 every other line of N is re-indented: P is the leading whitespace of O's first line, F that of
 * the file's first matched line; a non-empty, non-whitespace-only line of N that starts with P has that P replaced
 * by F.
 */
function applyReplace(lines: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^([ \t]*)/.exec(lines[pos]!)![1]!;
    P = /^([ \t]*)/.exec(O[0]!)![1]!;
  }
  for (const nl of N) {
    if (nl.ctx >= 0) {
      out.push(lines[pos + nl.ctx]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
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
    if (blank(l)) return;
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

/** Section 6: one hunk of a unified diff. */
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  hasCtxOrPlus: boolean;
  lastHasBackslash: boolean;
  /** The `+` lines in body order, for creations. */
  plus: string[];
  /** Whether a `\` line follows the section's last `+` line so far (for creations). */
  lastPlusHasBackslash: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string; empty: boolean; blank: boolean };

function buildHunk(a: number, body: BodyLine[]): Hunk {
  while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
  const o: string[] = [];
  const n: NewLine[] = [];
  const plus: string[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: -1 });
      plus.push(b.text);
    }
  }
  let hasCtxOrPlus = false;
  let lastHasBackslash = false;
  let lastPlusHasBackslash = false;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      hasCtxOrPlus = true;
      lastHasBackslash = i + 1 < body.length && body[i + 1]!.kind === 'bs';
    }
    if (b.kind === 'new') lastPlusHasBackslash = i + 1 < body.length && body[i + 1]!.kind === 'bs';
  }
  return { a, o, n, hasCtxOrPlus, lastHasBackslash, plus, lastPlusHasBackslash };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** The path after `--- ` / `+++ `: up to the first tab, trimmed, one leading a/ or b/ removed. */
function diffPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  let inHeader = false;
  let hasPair = false;
  let hunkA = 0;
  let body: BodyLine[] | null = null;
  const finishHunk = (): void => {
    if (body !== null && section !== null) section.hunks.push(buildHunk(hunkA, body));
    body = null;
  };
  const finishSection = (): void => {
    finishHunk();
    if (section !== null) sections.push(section);
    section = null;
    inHeader = false;
    hasPair = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (body !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && next.startsWith('+++ '))) {
        finishHunk();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        body.push({
          kind: line === '' ? 'ctx' : line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'bs',
          text: line === '' ? '' : line.slice(1),
          empty: line === '',
          blank: line === '',
        });
        continue;
      } else {
        finishHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      section = { oldPath: m[1]!, newPath: m[2]!, creation: false, deletion: false, hunks: [] };
      inHeader = true;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      if (section !== null && inHeader && !hasPair) {
        section.oldPath = diffPath(line);
        section.newPath = diffPath(next);
        hasPair = true;
      } else {
        finishSection();
        section = { oldPath: diffPath(line), newPath: diffPath(next), creation: false, deletion: false, hunks: [] };
        inHeader = true;
        hasPair = true;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (section !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunkA = Number(m[1]);
      body = [];
      inHeader = false;
      continue;
    }
    if (section !== null && inHeader) {
      if (line.startsWith('rename from ') && !hasPair) section.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !hasPair) section.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) section.creation = true;
      else if (line.startsWith('deleted file mode')) section.deletion = true;
      continue;
    }
    // Prose, code fences and anything else outside bodies and headers is ignored.
  }
  finishSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const isCreation = sec.oldPath === null || sec.creation;
  const isDeletion = !isCreation && (sec.newPath === null || sec.deletion);
  return (tree) => {
    for (const p of [sec.oldPath, sec.newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreation) {
      const p = sec.newPath;
      if (p === null) return;
      if (tree.exists(p)) throw new Fail('exists', p);
      const added: string[] = [];
      let lastPlusHasBackslash = false;
      for (const h of sec.hunks) {
        if (h.plus.length > 0) lastPlusHasBackslash = h.lastPlusHasBackslash;
        added.push(...h.plus);
      }
      const f: FileLines = { lines: added, br: '\n', final: added.length > 0 && !lastPlusHasBackslash };
      tree.now.set(p, joinFile(f));
      return;
    }
    if (isDeletion) {
      const p = sec.oldPath;
      if (p === null) return;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null || newP === null) return;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.exists(newP)) throw new Fail('exists', newP);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length > 0) {
        const tier = findTier(h.o, f.lines, strict);
        if (tier < 0) throw new Fail('no-match', oldP);
        const occ = occurrences(h.o, f.lines, tier);
        const target = h.a - 1 + d;
        let pos = occ[0]!;
        for (const q of occ) {
          if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
        }
        const atEnd = pos + h.o.length === f.lines.length;
        f.lines = applyReplace(f.lines, pos, h.o, h.n, tier);
        if (atEnd) f.final = h.hasCtxOrPlus ? !h.lastHasBackslash : true;
        d += h.n.length - h.o.length;
      } else {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        const ins = h.n.map((nl) => nl.text);
        f.lines.splice(at, 0, ...ins);
        if (atEnd) f.final = h.hasCtxOrPlus ? !h.lastHasBackslash : true;
        d += h.n.length;
      }
    }
    const out = joinFile(f);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      return { old: oldP, new: newP };
    }
    tree.now.set(oldP, out);
  };
}

/** Section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sepIdx = -1;
    let endIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sepIdx = j;
        break;
      }
    }
    if (sepIdx >= 0) {
      for (let j = sepIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          endIdx = j;
          break;
        }
      }
    }
    if (sepIdx < 0 || endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const old = lines.slice(searchIdx + 1, sepIdx);
    const nw = lines.slice(sepIdx + 1, endIdx);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.exists(p)) throw new Fail('exists', p);
        const f: FileLines = { lines: [...nw], br: '\n', final: nw.length > 0 };
        tree.now.set(p, joinFile(f));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const tier = findTier(old, f.lines, strict);
      if (tier < 0) throw new Fail('no-match', p);
      const occ = occurrences(old, f.lines, tier);
      if (occ.length > 1) throw new Fail('ambiguous', p);
      const N: NewLine[] = nw.map((t) => ({ text: t, ctx: -1 }));
      f.lines = applyReplace(f.lines, occ[0]!, old, N, tier);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    prevReplaceEnd = endIdx;
    i = endIdx + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */
interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines?: string[];
  moveTo?: string;
  chunks?: V4AChunk[];
}

const V4A_START = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const isV4AStart = (l: string): boolean => V4A_START.some((p) => l.startsWith(p));

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const sec: V4ASection = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), line: i + 1, addLines: [] };
      i++;
      // Collect the section's raw lines first. Blank lines at the end of a section are
      // not part of it (section 8), so they are stripped before parsing; a blank line
      // that is not a `+` line and not empty anywhere else is a parse error, because
      // the Add File bullet allows only `+` lines and empty lines.
      const raw: { l: string; idx: number }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isV4AStart(l)) break;
        raw.push({ l, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
      for (const { l, idx } of raw) {
        if (l.startsWith('+')) sec.addLines!.push(l.slice(1));
        else if (l === '') sec.addLines!.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      while (sec.addLines!.length > 0 && sec.addLines![sec.addLines!.length - 1] === '') sec.addLines!.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), line: i + 1 });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: V4ASection = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), line: i + 1, chunks: [] };
      i++;
      let firstChunk = true;
      let chunk: { anchor: string | null; body: BodyLine[]; eof: boolean } | null = null;
      const finishChunk = (atSectionEnd: boolean): void => {
        if (chunk === null) return;
        const body = chunk.body;
        // Blank lines at the end of a section are not part of it (section 8); a chunk that ends
        // mid-section keeps its trailing blank lines.
        if (atSectionEnd) while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
        const o: string[] = [];
        const n: NewLine[] = [];
        for (const b of body) {
          if (b.kind === 'ctx') {
            o.push(b.text);
            n.push({ text: b.text, ctx: o.length - 1 });
          } else if (b.kind === 'old') {
            o.push(b.text);
          } else if (b.kind === 'new') {
            n.push({ text: b.text, ctx: -1 });
          }
        }
        sec.chunks!.push({ anchor: chunk.anchor, o, n, eof: chunk.eof });
        chunk = null;
      };
      while (i < last) {
        const l = lines[i]!;
        if (isV4AStart(l)) break;
        if (l.startsWith('*** Move to: ') && firstChunk && chunk === null && sec.chunks!.length === 0 && sec.moveTo === undefined) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          finishChunk(false);
          firstChunk = false;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          finishChunk(false);
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          firstChunk = false;
          i++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            chunk = { anchor: null, body: [], eof: false };
            firstChunk = false;
          }
          chunk.body.push({
            kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
            text: l === '' ? '' : l.slice(1),
            empty: l === '',
            blank: blank(l),
          });
          i++;
          continue;
        }
        if (blank(l)) {
          // A blank line that is not a body line (it starts with a tab, say) is a parse
          // error, unless it is at the end of the section, where blank lines are not
          // part of it (section 8).
          let trailing = true;
          for (let j = i + 1; j < last; j++) {
            const m = lines[j]!;
            if (isV4AStart(m)) break;
            if (!blank(m)) {
              trailing = false;
              break;
            }
          }
          if (trailing) {
            i++;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finishChunk(true);
      if (sec.chunks!.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.exists(sec.path)) throw new Fail('exists', sec.path);
      const f: FileLines = { lines: [...sec.addLines!], br: '\n', final: sec.addLines!.length > 0 };
      tree.now.set(sec.path, joinFile(f));
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.exists(sec.moveTo)) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    const maxTier = strict ? 0 : 2;
    let cursor = 0;
    for (const ch of sec.chunks!) {
      if (ch.anchor !== null) {
        let found = -1;
        for (let t = 0; t <= maxTier && found < 0; t++) {
          for (let j = cursor; j < f.lines.length; j++) {
            if (tierEq(ch.anchor, f.lines[j]!, t)) {
              found = j;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const ins = ch.n.map((nl) => nl.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let tier = -1;
      let pos = -1;
      for (let t = 0; t <= maxTier; t++) {
        const occ = occurrences(ch.o, f.lines, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === f.lines.length));
        if (occ.length > 0) {
          tier = t;
          pos = occ[0]!;
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', sec.path);
      f.lines = applyReplace(f.lines, pos, ch.o, ch.n, tier);
      cursor = pos + ch.n.length;
    }
    const out = joinFile(f);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      return { old: sec.path, new: sec.moveTo };
    }
    tree.now.set(sec.path, out);
  };
}

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
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== undefined) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!covered.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
