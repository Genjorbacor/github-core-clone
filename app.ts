// The forge's HTTP server: routing, auth, REST v3, and dispatch to git, GraphQL and MCP.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  parseCommit,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  Store,
} from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN !== undefined && process.env.MAKEFUN_SHOP_TOKEN !== ''
  ? process.env.MAKEFUN_SHOP_TOKEN
  : 'makefun-local-test-token';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendNoBody(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------- JSON shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User', avatar_url: '' },
    private: repo.private,
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    labels: issue.labels.map((label) => ({ id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`, default: false })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    head: {
      label: `${repo.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    merged: pull.merged,
    mergeable: true,
    draft: false,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  void store;
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author,
      committer,
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, host: string, path: string): Page<T> {
  const rawPerPage = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, Math.trunc(rawPerPage))) : 30;
  const rawPage = Number(query.get('page') ?? '1');
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const build = (pageNumber: number): string => {
    const params = new URLSearchParams();
    for (const [key, value] of query.entries()) {
      if (key === 'page') continue;
      params.append(key, value);
    }
    params.set('page', String(pageNumber));
    params.set('per_page', String(perPage));
    return `http://${host}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${build(1)}>; rel="first"`);
    links.push(`<${build(totalPages)}>; rel="last"`);
  }
  return { items: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------- request context

interface Ctx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  path: string;
  body: Buffer;
  json: unknown;
  jsonError: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- REST handlers

function requireRepo(store: Store, owner: string, name: string): Repo | null {
  return store.visibleRepo(owner, name) ?? null;
}

function handleUserReposList(store: Store, ctx: Ctx, res: ServerResponse): void {
  const repos = store.listViewerRepos().map((repo) => repoJson(repo));
  const page = paginate(repos, ctx.query, ctx.host, ctx.path);
  sendJson(res, 200, page.items, page.link !== null ? { link: page.link } : {});
}

function handleUserReposCreate(store: Store, ctx: Ctx, res: ServerResponse): void {
  if (!isRecord(ctx.json)) {
    errJson(res, 422, 'Validation Failed: name is required');
    return;
  }
  const name = ctx.json.name;
  if (typeof name !== 'string' || name === '') {
    errJson(res, 422, 'Validation Failed: name is required');
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    errJson(res, 422, 'Validation Failed: name is invalid');
    return;
  }
  if (store.getRepo(VIEWER_LOGIN, name)) {
    errJson(res, 422, 'Repository creation failed. name already exists on this account.');
    return;
  }
  const repo = store.createRepo(name, {
    private: ctx.json.private === true,
    description: typeof ctx.json.description === 'string' ? ctx.json.description : '',
    autoInit: ctx.json.auto_init === true,
  });
  sendJson(res, 201, repoJson(repo));
}

function handleGetRepo(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, repoJson(repo));
}

function handlePatchRepo(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (isRecord(ctx.json)) {
    if (typeof ctx.json.description === 'string') repo.description = ctx.json.description;
    if (ctx.json.private === true || ctx.json.private === false) repo.private = ctx.json.private;
  }
  repo.updated_at = store.nowIso();
  sendJson(res, 200, repoJson(repo));
}

function handleDeleteRepo(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  store.deleteRepo(owner, name);
  sendNoBody(res, 204);
}

function handleBranches(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
    .map((branch) => ({
      name: branch,
      commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
      protected: false,
    }));
  sendJson(res, 200, branches);
}

function handleGetBranch(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, branch: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    errJson(res, 404, 'Branch not found');
    return;
  }
  sendJson(res, 200, {
    name: branch,
    commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` },
    protected: false,
  });
}

function handleCommits(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const ref = ctx.query.get('sha') ?? repo.default_branch;
  const tip = store.resolveRef(repo, ref);
  if (tip === null) {
    errJson(res, 404, 'No commit found for this reference');
    return;
  }
  const history = store.commitHistory(repo, tip, 1000);
  const items = history.map((oid) => commitJson(store, repo, oid)).filter((entry): entry is Record<string, unknown> => entry !== null);
  const page = paginate(items, ctx.query, ctx.host, ctx.path);
  sendJson(res, 200, page.items, page.link !== null ? { link: page.link } : {});
}

function handleCreateRef(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(ctx.json) || typeof ctx.json.ref !== 'string' || typeof ctx.json.sha !== 'string') {
    errJson(res, 422, 'Validation Failed: ref and sha are required');
    return;
  }
  const ref = ctx.json.ref;
  const sha = ctx.json.sha;
  if (!ref.startsWith('refs/')) {
    errJson(res, 422, 'Validation Failed: ref must start with refs/');
    return;
  }
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') {
    errJson(res, 422, 'Validation Failed: sha is not a commit in this repository');
    return;
  }
  if (repo.refs.has(ref)) {
    errJson(res, 422, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(res, 201, {
    ref,
    node_id: `R_${ref}`,
    url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice('refs/'.length)}`,
    object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
  });
}

function handleGetRef(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, rest: string[]): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const ref = `refs/${rest.join('/')}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) {
    errJson(res, 404, 'Reference does not exist');
    return;
  }
  const object = repo.objects.get(oid);
  sendJson(res, 200, {
    ref,
    node_id: `R_${ref}`,
    url: `/api/v3/repos/${owner}/${name}/git/refs/${rest.join('/')}`,
    object: { sha: oid, type: object?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` },
  });
}

function contentsFileJson(repo: Repo, path: string, oid: string, content: Buffer): Record<string, unknown> {
  const segments = path.split('/').filter((s) => s !== '');
  const name = segments[segments.length - 1] ?? '';
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `/${repo.owner}/${repo.name}/blob/${repo.default_branch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    download_url: `/${repo.owner}/${repo.name}/raw/${repo.default_branch}/${path}`,
    _links: {
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html: `/${repo.owner}/${repo.name}/blob/${repo.default_branch}/${path}`,
    },
  };
}

function handlePutContents(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, path: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(ctx.json) || typeof ctx.json.message !== 'string' || typeof ctx.json.content !== 'string') {
    errJson(res, 422, 'Validation Failed: message and content are required');
    return;
  }
  const branch = typeof ctx.json.branch === 'string' && ctx.json.branch !== '' ? ctx.json.branch : repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const currentSha = tip !== null ? store.blobAt(repo, tip, path) : null;
  if (typeof ctx.json.sha === 'string') {
    if (currentSha === null || ctx.json.sha.toLowerCase() !== currentSha.toLowerCase()) {
      errJson(res, 409, 'Conflict: sha does not match the current blob');
      return;
    }
  }
  let content: Buffer;
  try {
    content = Buffer.from(ctx.json.content.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    errJson(res, 422, 'Validation Failed: content is not valid base64');
    return;
  }
  const isCreate = currentSha === null;
  const { commitSha, blobSha } = store.commitContentChange(repo, branch, path, content, ctx.json.message);
  sendJson(res, isCreate ? 201 : 200, {
    content: contentsFileJson(repo, path, blobSha as string, content),
    commit: { sha: commitSha, message: ctx.json.message },
  });
}

function handleGetContents(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, path: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const ref = ctx.query.get('ref') ?? repo.default_branch;
  const tip = store.resolveRef(repo, ref);
  if (tip === null) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const read = store.readPath(repo, tip, path);
  if (read === null) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (read.kind === 'file') {
    sendJson(res, 200, contentsFileJson(repo, path, read.oid, read.blob));
    return;
  }
  const entries = read.entries.map((entry) => {
    const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.mode === '40000') {
      return { type: 'dir', name: entry.name, path: entryPath, sha: entry.oid, url: `/api/v3/repos/${owner}/${name}/contents/${entryPath}` };
    }
    const blob = repo.objects.get(entry.oid);
    return {
      type: 'file',
      name: entry.name,
      path: entryPath,
      sha: entry.oid,
      size: blob ? blob.data.length : 0,
      url: `/api/v3/repos/${owner}/${name}/contents/${entryPath}`,
    };
  });
  sendJson(res, 200, entries);
}

function handleDeleteContents(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, path: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const branch = isRecord(ctx.json) && typeof ctx.json.branch === 'string' && ctx.json.branch !== '' ? ctx.json.branch : repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const currentSha = tip !== null ? store.blobAt(repo, tip, path) : null;
  if (currentSha === null) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (isRecord(ctx.json) && typeof ctx.json.sha === 'string' && ctx.json.sha.toLowerCase() !== currentSha.toLowerCase()) {
    errJson(res, 409, 'Conflict: sha does not match the current blob');
    return;
  }
  const message = isRecord(ctx.json) && typeof ctx.json.message === 'string' ? ctx.json.message : 'Delete file';
  const { commitSha } = store.commitContentChange(repo, branch, path, null, message);
  sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
}

function handleCreateLabel(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(ctx.json) || typeof ctx.json.name !== 'string' || ctx.json.name === '') {
    errJson(res, 422, 'Validation Failed: name is required');
    return;
  }
  const labelName = ctx.json.name;
  const existing = repo.labels.get(labelName);
  if (existing) {
    sendJson(res, 201, { id: existing.id, name: existing.name, color: existing.color, description: existing.description, default: false });
    return;
  }
  const label = {
    id: store.nextEntity(),
    name: labelName,
    color: typeof ctx.json.color === 'string' ? ctx.json.color : 'ededed',
    description: typeof ctx.json.description === 'string' ? ctx.json.description : '',
  };
  repo.labels.set(labelName, label);
  sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false });
}

function handleCreateIssue(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(ctx.json) || typeof ctx.json.title !== 'string' || ctx.json.title === '') {
    errJson(res, 422, 'Validation Failed: title is required');
    return;
  }
  const labels: Label[] = [];
  if (Array.isArray(ctx.json.labels)) {
    for (const labelName of ctx.json.labels) {
      if (typeof labelName !== 'string') continue;
      const label = repo.labels.get(labelName);
      if (!label) {
        errJson(res, 422, `Validation Failed: label "${labelName}" does not exist`);
        return;
      }
      labels.push(label);
    }
  }
  const issue = store.createIssue(repo, ctx.json.title, typeof ctx.json.body === 'string' ? ctx.json.body : '', labels);
  sendJson(res, 201, issueJson(repo, issue));
}

function handleListIssues(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  let list = [...repo.issues];
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') list = list.filter((issue) => issue.state === 'open');
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const page = paginate(list.map((issue) => issueJson(repo, issue)), ctx.query, ctx.host, ctx.path);
  sendJson(res, 200, page.items, page.link !== null ? { link: page.link } : {});
}

function handleGetIssue(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const issue = store.findIssue(repo, number);
  if (!issue) {
    errJson(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function handlePatchIssue(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const issue = store.findIssue(repo, number);
  if (!issue) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (isRecord(ctx.json)) {
    if (ctx.json.state === 'open' || ctx.json.state === 'closed') {
      issue.state = ctx.json.state;
      issue.closed_at = ctx.json.state === 'closed' ? store.nowIso() : null;
    }
    if (typeof ctx.json.title === 'string') issue.title = ctx.json.title;
    if (typeof ctx.json.body === 'string') issue.body = ctx.json.body;
  }
  issue.updated_at = store.nowIso();
  sendJson(res, 200, issueJson(repo, issue));
}

function handleCreateComment(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const issue = store.findIssue(repo, number);
  if (!issue) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(ctx.json) || typeof ctx.json.body !== 'string') {
    errJson(res, 422, 'Validation Failed: body is required');
    return;
  }
  const now = store.nowIso();
  const comment = { id: store.nextEntity(), body: ctx.json.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: now, updated_at: now };
  issue.comments.push(comment);
  sendJson(res, 201, commentJson(repo, issue, comment));
}

function handleListComments(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const issue = store.findIssue(repo, number);
  if (!issue) {
    errJson(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
}

function handleCreatePull(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(ctx.json) || typeof ctx.json.title !== 'string' || typeof ctx.json.head !== 'string' || typeof ctx.json.base !== 'string') {
    errJson(res, 422, 'Validation Failed: title, head and base are required');
    return;
  }
  const head = ctx.json.head;
  const base = ctx.json.base;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) {
    errJson(res, 422, `Validation Failed: head branch ${head} not found`);
    return;
  }
  if (baseSha === undefined) {
    errJson(res, 422, `Validation Failed: base branch ${base} not found`);
    return;
  }
  const existing = repo.pulls.find((pull) => pull.head.ref === head && pull.base.ref === base && pull.state === 'open');
  if (existing) {
    errJson(res, 422, 'Validation Failed: a pull request already exists for this head and base');
    return;
  }
  const pull = store.createPull(repo, ctx.json.title, typeof ctx.json.body === 'string' ? ctx.json.body : '', head, headSha, base, baseSha);
  sendJson(res, 201, pullJson(repo, pull));
}

function handleListPulls(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  let list = [...repo.pulls];
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') list = list.filter((pull) => pull.state === 'open');
  list.sort((a, b) => b.number - a.number);
  const page = paginate(list.map((pull) => pullJson(repo, pull)), ctx.query, ctx.host, ctx.path);
  sendJson(res, 200, page.items, page.link !== null ? { link: page.link } : {});
}

function handleGetPull(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const pull = store.findPull(repo, number);
  if (!pull) {
    errJson(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, pullJson(repo, pull));
}

function handlePullFiles(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const pull = store.findPull(repo, number);
  if (!pull) {
    errJson(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, store.pullFiles(repo, pull));
}

function handleMergePull(store: Store, ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = requireRepo(store, owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const pull = store.findPull(repo, number);
  if (!pull) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (pull.merged) {
    errJson(res, 405, 'Pull request is already merged');
    return;
  }
  const sha = store.squashMerge(repo, pull);
  if (sha === null) {
    errJson(res, 405, 'Merge conflict: the pull request cannot be merged cleanly');
    return;
  }
  sendJson(res, 200, { merged: true, sha, message: `Merged #${pull.number}` });
}

// ---------------------------------------------------------------- dispatch

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function dispatchRest(store: Store, ctx: Ctx, res: ServerResponse): void {
  const s = ctx.segments; // after /api/v3
  const method = ctx.method;

  if (s.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  if (s[0] === 'meta' && s.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  if (s[0] === 'user') {
    if (s.length === 1 && method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: `U_${VIEWER_ID}`,
        avatar_url: '',
        type: 'User',
        site_admin: false,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        html_url: `/${VIEWER_LOGIN}`,
        url: '/api/v3/user',
      });
      return;
    }
    if (s.length === 2 && s[1] === 'repos') {
      if (method === 'GET') {
        handleUserReposList(store, ctx, res);
        return;
      }
      if (method === 'POST') {
        handleUserReposCreate(store, ctx, res);
        return;
      }
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  if (s[0] === 'repos' && s.length >= 3) {
    const owner = s[1] as string;
    const name = s[2] as string;
    const rest = s.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        handleGetRepo(store, ctx, res, owner, name);
        return;
      }
      if (method === 'PATCH') {
        handlePatchRepo(store, ctx, res, owner, name);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteRepo(store, ctx, res, owner, name);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        handleBranches(store, ctx, res, owner, name);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        handleGetBranch(store, ctx, res, owner, name, rest.slice(1).join('/'));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      handleCommits(store, ctx, res, owner, name);
      return;
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        handleCreateRef(store, ctx, res, owner, name);
        return;
      }
      if (rest.length >= 3 && method === 'GET') {
        handleGetRef(store, ctx, res, owner, name, rest.slice(2));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') {
        handlePutContents(store, ctx, res, owner, name, path);
        return;
      }
      if (method === 'GET') {
        handleGetContents(store, ctx, res, owner, name, path);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteContents(store, ctx, res, owner, name, path);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      handleCreateLabel(store, ctx, res, owner, name);
      return;
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          handleListIssues(store, ctx, res, owner, name);
          return;
        }
        if (method === 'POST') {
          handleCreateIssue(store, ctx, res, owner, name);
          return;
        }
      }
      const issueNumber = Number(rest[1]);
      if (rest.length === 2 && Number.isSafeInteger(issueNumber)) {
        if (method === 'GET') {
          handleGetIssue(store, ctx, res, owner, name, issueNumber);
          return;
        }
        if (method === 'PATCH') {
          handlePatchIssue(store, ctx, res, owner, name, issueNumber);
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments' && Number.isSafeInteger(issueNumber)) {
        if (method === 'GET') {
          handleListComments(store, ctx, res, owner, name, issueNumber);
          return;
        }
        if (method === 'POST') {
          handleCreateComment(store, ctx, res, owner, name, issueNumber);
          return;
        }
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          handleListPulls(store, ctx, res, owner, name);
          return;
        }
        if (method === 'POST') {
          handleCreatePull(store, ctx, res, owner, name);
          return;
        }
      }
      const pullNumber = Number(rest[1]);
      if (rest.length === 2 && Number.isSafeInteger(pullNumber) && method === 'GET') {
        handleGetPull(store, ctx, res, owner, name, pullNumber);
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && Number.isSafeInteger(pullNumber) && method === 'GET') {
        handlePullFiles(store, ctx, res, owner, name, pullNumber);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && Number.isSafeInteger(pullNumber) && method === 'PUT') {
        handleMergePull(store, ctx, res, owner, name, pullNumber);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  errJson(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        let pathname = '/';
        let query = new URLSearchParams();
        try {
          const url = new URL(req.url ?? '/', 'http://entry');
          pathname = url.pathname;
          query = url.searchParams;
        } catch {
          pathname = '/';
        }
        const host = req.headers.host ?? '127.0.0.1';
        const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
          const suffix = gitMatch[3] as string;
          const version2 = req.headers['git-protocol'] === 'version=2';
          if (suffix === '/info/refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            const result = handleInfoRefs(store, owner, repoName, service, version2);
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          if (suffix === '/git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            try {
              const result = handleUploadPack(store, owner, repoName, body, version2);
              sendBuffer(res, result.status, result.contentType, result.body);
            } catch (err) {
              errJson(res, 400, err instanceof Error ? err.message : 'bad request');
            }
            return;
          }
          if (suffix === '/git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            try {
              const result = handleReceivePack(store, owner, repoName, body);
              sendBuffer(res, result.status, result.contentType, result.body);
            } catch (err) {
              errJson(res, 400, err instanceof Error ? err.message : 'bad request');
            }
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql' && method === 'POST') {
          if (!isAuthorized(req)) {
            errJson(res, 401, 'Bad credentials');
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            errJson(res, 400, 'Invalid JSON');
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              if (!isRecord(entry) || typeof entry.query !== 'string') {
                return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
              }
              const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
              return executeGraphQL(store, entry.query, variables, typeof entry.operationName === 'string' ? entry.operationName : undefined);
            });
            sendJson(res, 200, results);
            return;
          }
          if (!isRecord(parsed) || typeof parsed.query !== 'string') {
            errJson(res, 400, 'Invalid GraphQL operation');
            return;
          }
          const variables = isRecord(parsed.variables) ? (parsed.variables as Record<string, unknown>) : {};
          const result = executeGraphQL(store, parsed.query, variables, typeof parsed.operationName === 'string' ? parsed.operationName : undefined);
          const envelope: Record<string, unknown> = { data: result.data };
          if (result.errors.length > 0) envelope.errors = result.errors;
          sendJson(res, 200, envelope);
          return;
        }

        // MCP.
        if (pathname === '/mcp' && method === 'POST') {
          if (!isAuthorized(req)) {
            errJson(res, 401, 'Bad credentials');
            return;
          }
          const body = await readBody(req);
          const declared = typeof req.headers['mcp-protocol-version'] === 'string' ? (req.headers['mcp-protocol-version'] as string) : undefined;
          const result = handleMcp(store, body.toString('utf8'), declared);
          if (result.body.length === 0) {
            res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendBuffer(res, result.status, 'application/json; charset=utf-8', result.body);
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            errJson(res, 401, 'Bad credentials');
            return;
          }
          const restSegments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((part) => part !== '').map(decodeSegment);
          let json: unknown = undefined;
          let jsonError = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const body = await readBody(req);
            if (body.length > 0) {
              try {
                json = JSON.parse(body.toString('utf8'));
              } catch {
                jsonError = true;
              }
            }
          }
          if (jsonError) {
            errJson(res, 400, 'Invalid JSON');
            return;
          }
          const ctx: Ctx = { method, segments: restSegments, query, host, path: pathname, body: Buffer.alloc(0), json, jsonError };
          dispatchRest(store, ctx, res);
          return;
        }

        errJson(res, 404, 'Not Found');
      } catch (err) {
        try {
          errJson(res, 500, err instanceof Error ? err.message : 'internal error');
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });
}
