// git smart HTTP: info/refs (v0 + v2), ls-refs, fetch (v0 + v2), receive-pack.
// Plain objects only in the packs this server sends (zero deltas is legal).

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  flattenTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  writePack,
  PKT_FLUSH,
  type GitObj,
  type Repo,
  type Store,
} from './store.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResult {
  return { status: 200, contentType, body };
}

function notFound(): GitResult {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main thin-pack ofs-delta';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, sorted heads then tags, with peeled targets for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const heads = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  for (const name of heads) out.push({ oid: repo.refs.get(name) as string, name });
  for (const name of tags) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      out.push({ oid, name, peeled: parseTag(object.data).object });
    } else {
      out.push({ oid, name });
    }
  }
  return out;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = refLines(repo);
  const mainTip = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, version2: boolean): GitResult {
  const repo = store.visibleRepo(owner, repoName);
  if (!repo) return notFound();
  if (service === 'git-upload-pack') {
    if (version2) return ok('application/x-git-upload-pack-advertisement', v2Advertisement(repo));
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement('git-upload-pack', repo));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo));
  }
  return notFound();
}

// ---------------------------------------------------------------- ls-refs (v2)

/** POST /{owner}/{repo}.git/git-upload-pack with command=ls-refs. */
function handleLsRefs(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) continue; // command + agent + object-format lines
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    if (symrefs && keep('HEAD') && mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** The objects the client already holds: reachable(haves), cutting parent edges at old shallow boundaries. */
function heldObjects(repo: Repo, haves: string[], oldShallow: string[]): Set<string> {
  const cut = new Set(oldShallow);
  const held = new Set<string>();
  const queue: string[] = [...haves];
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (!isOid(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      held.add(oid);
      const commit = parseCommit(object.data);
      for (const sub of collectReachable([commit.tree], (o) => repo.objects.get(o))) held.add(sub);
      if (!cut.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      held.add(oid);
      queue.push(parseTag(object.data).object);
    } else {
      for (const sub of collectReachable([oid], (o) => repo.objects.get(o))) held.add(sub);
    }
  }
  return held;
}

interface FetchPlan {
  packObjects: GitObj[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** Compute what a fetch sends: reachable(wants, depth) minus held, plus new shallow boundaries. */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const held = heldObjects(repo, request.haves, request.shallow);
  // Included commits: BFS from wants, depth-limited when requested.
  const includedCommits = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') queue.push({ oid: parseTag(object.data).object, depth: 0 });
    else if (object.type === 'commit') queue.push({ oid: want, depth: 0 });
  }
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (includedCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    includedCommits.add(oid);
    if (request.depth !== null && depth + 1 >= request.depth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  // Objects of the included commits: each commit plus its own tree closure.
  // (The tree closure must NOT follow parent links, or a depth limit would
  // still pull the whole history through the trees' commits.)
  const included = new Set<string>();
  for (const oid of includedCommits) {
    included.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      for (const sub of collectReachable([tree], (o) => repo.objects.get(o))) included.add(sub);
    }
  }
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object?.type === 'tag') included.add(want);
  }
  const packOids = [...included].filter((oid) => !held.has(oid));
  packOids.sort();
  const packObjects: GitObj[] = [];
  for (const oid of packOids) {
    const object = repo.objects.get(oid);
    if (object) packObjects.push(object);
  }
  // Shallow boundaries: included commits with a parent outside the included set.
  const shallow: string[] = [];
  if (request.depth !== null) {
    for (const oid of [...includedCommits].sort()) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
    }
  }
  // Unshallow: old boundaries now fully included (all parents included).
  const unshallow: string[] = [];
  for (const boundary of request.shallow) {
    if (!includedCommits.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => includedCommits.has(parent))) unshallow.push(boundary);
  }
  // Acknowledgments.
  let nak = false;
  const acks: string[] = [];
  if (request.haves.length === 0) {
    nak = true;
  } else {
    let allKnown = true;
    for (const have of request.haves) {
      const object = repo.objects.get(have);
      if (object?.type === 'commit') acks.push(have);
      else allKnown = false;
    }
    if (!allKnown || acks.length === 0) {
      nak = true;
      acks.length = 0;
    }
  }
  return { packObjects, shallow, unshallow, acks, nak };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function parseV2Fetch(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let sawDelim = false;
  let sawCommand = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) {
      // The first line is the command; the rest are command arguments
      // (agent=, object-format=) and are accepted and ignored.
      if (!sawCommand) {
        if (!line.startsWith('command=fetch')) throw new Error('expected command=fetch');
        sawCommand = true;
      }
      continue;
    }
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) request.depth = n;
    }
  }
  request.wants = [...new Set(request.wants)];
  return request;
}

function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const request = parseV2Fetch(packets);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_FLUSH);
  if (request.depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (plan.packObjects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(writePack(plan.packObjects)));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0] as string;
        request.wants.push(oid);
      } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isSafeInteger(n) && n > 0) request.depth = n;
      }
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    }
  }
  request.wants = [...new Set(request.wants)];
  return request;
}

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const request = parseV0Fetch(body);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.packObjects.length > 0) parts.push(...sidebandPackets(writePack(plan.packObjects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs or fetch, v2 when the header says so. */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, version2: boolean): GitResult {
  const repo = store.visibleRepo(owner, repoName);
  if (!repo) return notFound();
  let out: Buffer;
  if (version2) {
    const packets = decodePktLines(body);
    const first = packets.find((p) => p.kind === 'data');
    const command = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
    if (command === 'command=ls-refs') out = handleLsRefs(repo, packets);
    else if (command === 'command=fetch') out = handleFetchV2(repo, body);
    else throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  } else {
    out = handleFetchV0(repo, body);
  }
  return ok('application/x-git-upload-pack-result', out);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = store.visibleRepo(owner, repoName);
  if (!repo) return notFound();
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let packOffset = 0;
  // Walk the raw body: command pkt-lines up to the first flush; the rest is the pack.
  let offset = 0;
  let first = true;
  let unpackError: string | null = null;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      unpackError = 'truncated pkt-line';
      break;
    }
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      unpackError = 'invalid pkt-line length';
      break;
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      packOffset = offset;
      break;
    }
    if (length < 4 || length > 65520 || offset + length > body.length) {
      unpackError = 'invalid pkt-line length';
      break;
    }
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const commandText = nul >= 0 ? line.slice(0, nul) : line;
    if (first && nul >= 0) {
      for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
    }
    first = false;
    const parts = commandText.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    offset += length;
  }
  // Unpack the pack that follows the command list.
  const packBytes = packOffset > 0 && packOffset < body.length ? body.subarray(packOffset) : Buffer.alloc(0);
  if (unpackError === null && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'pack parse failed';
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const result = applyCommand(repo, command);
      reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
    }
  }
  const reportStream = Buffer.concat(reportLines.map((line) => pktLine(line)));
  let response: Buffer;
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let off = 0; off < reportStream.length; off += CHUNK) {
      const chunk = reportStream.subarray(off, Math.min(reportStream.length, off + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    response = Buffer.concat(parts);
  } else {
    response = Buffer.concat([reportStream, PKT_FLUSH]);
  }
  return ok('application/x-git-receive-pack-result', response);
}

function applyCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'no such ref' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const newObject = repo.objects.get(newOid);
  if (!newObject) return { ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
  if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (newOid === current) return { ok: true, reason: '' };
  // Fast-forward: new must descend from old (through commits; tags count via their target).
  let newCommit = newOid;
  const newObj = repo.objects.get(newOid);
  if (newObj?.type === 'tag') newCommit = parseTag(newObj.data).object;
  const descendant = isDescendant(repo, oldOid, newCommit);
  if (!descendant) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

function isDescendant(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return false;
}

export { flattenTree, hashObject };
