// The forge's in-memory store: repositories, git objects, issues, pull requests.
// No wall clock, no randomness: every timestamp comes from MAKEFUN_TRIAL_NOW plus a
// monotonic counter, so a replay with the same requests reproduces the same state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- viewer

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const TEAMMATE_ID = 1001;
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

export interface UserRef {
  login: string;
  id: number;
}

// ---------------------------------------------------------------- clock

function trialNowBaseMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return 1_735_689_600_000; // 2025-01-01T00:00:00Z
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.trunc(asNumber);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return 1_735_689_600_000;
}

// ---------------------------------------------------------------- git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- packfiles

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] ?? 0;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] ?? 0;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] ?? 0) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] ?? 0) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile (plain objects, OFS_DELTA and REF_DELTA) into resolved objects. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer } => {
    const cached = (entry as unknown as { _resolved?: { type: ObjType; data: Buffer } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        type = baseEntry.type;
        data = applyDelta(baseEntry.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const out = { type, data };
    (entry as unknown as { _resolved?: { type: ObjType; data: Buffer } })._resolved = out;
    resolvedByOid.set(hashObject(type, data), out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(hashObject(resolved.type, resolved.data), resolved);
  }
  return objects;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer of pkt-lines; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------- trees as flat maps

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> entry. */
export function flattenTree(objects: Map<string, GitObj>, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, at: string): void => {
    const object = objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build (and store) nested trees from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(objects: Map<string, GitObj>, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (!child) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** The empty tree's oid (stored on demand). */
export function emptyTreeOid(objects: Map<string, GitObj>): string {
  const data = Buffer.alloc(0);
  const oid = hashObject('tree', data);
  if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
  return oid;
}

// ---------------------------------------------------------------- the store

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: UserRef;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: UserRef;
  created_at: string;
  updated_at: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  created_at: string;
  updated_at: string;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private repoSeq = 0;
  private tick = 0;
  private readonly baseMs: number;

  constructor() {
    this.baseMs = trialNowBaseMs();
  }

  /** The next deterministic timestamp (ISO), one second per tick. */
  nowIso(): string {
    const ms = this.baseMs + this.tick * 1000;
    this.tick += 1;
    return new Date(ms).toISOString();
  }

  /** The next deterministic Unix timestamp (seconds), for commit/tag objects. */
  nowSec(): number {
    return Math.floor(this.baseMs / 1000) + this.tick;
  }

  viewerRef(): UserRef {
    return { login: VIEWER_LOGIN, id: VIEWER_ID };
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Only the viewer's repositories are visible to the token owner. */
  visibleRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.getRepo(owner, name);
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(name: string, opts: { private?: boolean; description?: string; autoInit?: boolean }): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      created_at: now,
      updated_at: now,
      seq: this.repoSeq++,
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    if (opts.autoInit === true) {
      const tree = emptyTreeOid(repo.objects);
      const commit = this.makeCommit(repo, tree, [], 'Initial commit');
      repo.refs.set(`refs/heads/${DEFAULT_BRANCH}`, commit);
    }
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  nextEntity(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  /** Create a commit object in `repo` and return its oid. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string, author?: string): string {
    const stamp = this.nowSec();
    const who = `${author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${stamp} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    const oid = hashObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a branch name, ref or commit oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === '') return null;
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    if (isOid(ref)) {
      const object = repo.objects.get(ref);
      if (object?.type === 'commit') return ref;
      if (object?.type === 'tag') return parseTag(object.data).object;
    }
    return null;
  }

  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Walk a commit's ancestry (tip first, parents after) up to `limit` commits. */
  commitHistory(repo: Repo, tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(object.data);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The first common ancestor of two commits (first-parent walk from `b` into `a`'s set). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stack: string[] = [a];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    let cursor: string | null = b;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      if (ancestorsA.has(cursor)) return cursor;
      seen.add(cursor);
      const object = repo.objects.get(cursor);
      if (!object || object.type !== 'commit') return null;
      const parents = parseCommit(object.data).parents;
      cursor = parents.length > 0 ? (parents[0] as string) : null;
    }
    return null;
  }

  /**
   * Three-way merge of trees: baseTree <- headTree onto baseTipTree.
   * Returns the merged tree oid, or null on conflict.
   */
  threeWayMerge(repo: Repo, baseTree: string, headTree: string, tipTree: string): string | null {
    const base = flattenTree(repo.objects, baseTree);
    const head = flattenTree(repo.objects, headTree);
    const tip = flattenTree(repo.objects, tipTree);
    const merged = new Map<string, FlatEntry>();
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) {
        if (t !== undefined) merged.set(path, t);
      } else if (same(t, b)) {
        if (h !== undefined) merged.set(path, h);
      } else if (same(h, t)) {
        if (h !== undefined) merged.set(path, h);
      } else {
        return null; // both sides changed the path differently
      }
    }
    return buildTreeFromFlat(repo.objects, merged);
  }

  /** Is the head tip mergeable into the base tip (three-way, no conflict)? */
  mergeable(repo: Repo, headTip: string, baseTip: string): boolean {
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return false;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const tipCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return false;
    if (headCommit.type !== 'commit' || tipCommit.type !== 'commit' || baseCommit.type !== 'commit') return false;
    const merged = this.threeWayMerge(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, parseCommit(tipCommit.data).tree);
    return merged !== null;
  }

  /** Apply a contents change on `branch` (create/update/delete a file) and return the new commit. */
  commitContentChange(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    let flat = new Map<string, FlatEntry>();
    const parents: string[] = [];
    if (tip !== null) {
      const commitObject = repo.objects.get(tip);
      if (commitObject?.type === 'commit') {
        flat = flattenTree(repo.objects, parseCommit(commitObject.data).tree);
        parents.push(tip);
      }
    }
    let blobSha: string | null = null;
    if (content !== null) {
      blobSha = this.putObject(repo, 'blob', content);
      flat.set(path, { oid: blobSha, mode: '100644' });
    } else {
      flat.delete(path);
    }
    const tree = buildTreeFromFlat(repo.objects, flat);
    const commitSha = this.makeCommit(repo, tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Read a file or directory from a commit's tree. */
  readPath(repo: Repo, commitOid: string, path: string): { kind: 'file'; blob: Buffer; oid: string } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const commitObject = repo.objects.get(commitOid);
    if (!commitObject || commitObject.type !== 'commit') return null;
    const rootTree = parseCommit(commitObject.data).tree;
    if (path === '' || path === '/') {
      const root = repo.objects.get(rootTree);
      if (!root) return null;
      return { kind: 'dir', entries: parseTree(root.data) };
    }
    const segments = path.split('/').filter((s) => s !== '');
    let treeOid = rootTree;
    for (let i = 0; i < segments.length; i += 1) {
      const treeObject = repo.objects.get(treeOid);
      if (!treeObject || treeObject.type !== 'tree') return null;
      const entry = parseTree(treeObject.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      const last = i === segments.length - 1;
      if (last) {
        if (entry.mode === '40000') {
          const dir = repo.objects.get(entry.oid);
          if (!dir) return null;
          return { kind: 'dir', entries: parseTree(dir.data) };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob) return null;
        return { kind: 'file', blob: blob.data, oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** The blob oid of a path at a commit, or null. */
  blobAt(repo: Repo, commitOid: string, path: string): string | null {
    const read = this.readPath(repo, commitOid, path);
    if (read?.kind === 'file') return read.oid;
    return null;
  }

  // ---------------------------------------------------------- issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextEntity(),
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: this.viewerRef(),
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
      seq: this.nextEntityId,
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const now = this.nowIso();
    const pull: Pull = {
      id: this.nextEntity(),
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      user: this.viewerRef(),
      created_at: now,
      updated_at: now,
      seq: this.nextEntityId,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseTip = this.refTip(repo, pull.base.ref);
    const headTip = this.refTip(repo, pull.head.ref);
    if (baseTip === null || headTip === null) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return null;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const tipCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return null;
    const mergedTree = this.threeWayMerge(
      repo,
      parseCommit(baseCommit.data).tree,
      parseCommit(headCommit.data).tree,
      parseCommit(tipCommit.data).tree,
    );
    if (mergedTree === null) return null;
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.makeCommit(repo, mergedTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    const now = this.nowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = now;
    pull.merge_commit_sha = sha;
    pull.updated_at = now;
    return sha;
  }

  /** File diff between the merge-base tree and the head tree of a pull request. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTip = this.refTip(repo, pull.base.ref);
    const headTip = pull.head.sha;
    const headCommit = repo.objects.get(headTip);
    if (!headCommit || headCommit.type !== 'commit') return [];
    const headTree = flattenTree(repo.objects, parseCommit(headCommit.data).tree);
    let baseTree = new Map<string, FlatEntry>();
    if (baseTip !== null) {
      const base = this.mergeBase(repo, headTip, baseTip);
      if (base !== null) {
        const baseCommit = repo.objects.get(base);
        if (baseCommit?.type === 'commit') baseTree = flattenTree(repo.objects, parseCommit(baseCommit.data).tree);
      }
    }
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      let status = 'modified';
      let additions = 0;
      let deletions = 0;
      const oldText = b === undefined ? '' : (repo.objects.get(b.oid)?.data.toString('utf8') ?? '');
      const newText = h === undefined ? '' : (repo.objects.get(h.oid)?.data.toString('utf8') ?? '');
      if (b === undefined) {
        status = 'added';
        additions = countLines(newText);
      } else if (h === undefined) {
        status = 'removed';
        deletions = countLines(oldText);
      } else {
        const diff = lineDiff(oldText, newText);
        additions = diff.additions;
        deletions = diff.deletions;
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line additions/deletions by multiset difference (small files only). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

// ---------------------------------------------------------------- global ids

/** Opaque, stable Relay-style global ids: base64 of "<Type>:<repoDbId>:<number>". */
export function globalId(type: string, repoDbId: number, number: number): string {
  return Buffer.from(`${type}:${repoDbId}:${number}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; repoDbId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoDbId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isSafeInteger(repoDbId) || !Number.isSafeInteger(number)) return null;
    return { type: parts[0] as string, repoDbId, number };
  } catch {
    return null;
  }
}
