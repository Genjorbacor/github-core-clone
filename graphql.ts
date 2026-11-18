// GraphQL v4: a small parser + executor for the fixed documents gh and
// github-mcp-server send (viewer, repository, issues, pull requests, node,
// __type introspection, the five mutations, batching). No schema library.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '$', '@', ',', '|', '&']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += input[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let text = '';
      if (input[j] === '-') {
        text += '-';
        j += 1;
      }
      while (j < input.length && /[0-9.]/.test(input[j] as string)) {
        text += input[j];
        j += 1;
      }
      if (text.includes('.')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) {
        text += input[j] as string;
        j += 1;
      }
      tokens.push({ kind: 'name', value: text });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: Selection[] | null;
}

export interface FragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  selection: Selection[];
}

export type Selection = FieldSel | FragmentSel;

export interface VarDef {
  name: string;
  type: string;
  defaultValue: Value | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selection: Selection[];
}

class Parser {
  private pos = 0;

  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Syntax Error: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Syntax Error: expected "${value}" but got ${JSON.stringify(token)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Syntax Error: expected ${what} but got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, varDefs, selection });
        continue;
      }
      if (token?.kind === 'name' && token.value === 'fragment') {
        throw new Error('Syntax Error: named fragments are not supported');
      }
      throw new Error(`Syntax Error: unexpected token ${JSON.stringify(token)}`);
    }
    return operations;
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (!this.matchPunct('(')) return defs;
    while (true) {
      if (this.matchPunct(')')) break;
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: Value | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    let type = '';
    if (this.matchPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName('a type');
    }
    if (this.matchPunct('!')) type += '!';
    return type;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Syntax Error: unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.pos += 1;
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.pos += 1;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.pos += 1;
        const typeCondition = this.expectName('a type condition');
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      throw new Error('Syntax Error: named fragment spreads are not supported');
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.parseArgs();
    this.skipDirectives();
    let selection: Selection[] | null = null;
    const next = this.peek();
    if (next?.kind === 'punct' && next.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private skipDirectives(): void {
    while (true) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '@') {
        this.pos += 1;
        this.expectName('a directive name');
        this.parseArgs();
        continue;
      }
      break;
    }
  }

  private parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (!this.matchPunct('(')) return args;
    while (true) {
      if (this.matchPunct(')')) break;
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.pos += 1;
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.pos += 1;
          break;
        }
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Syntax Error: unexpected value ${JSON.stringify(token)}`);
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- nodes

interface NodeBase {
  __typename: string;
}

type AnyNode = NodeBase & Record<string, unknown>;

function userNode(): AnyNode {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoNode(repo: Repo): AnyNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): AnyNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): AnyNode {
  return { __typename: 'PullRequest', repo, pull };
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author', 'headRef', 'baseRef', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'],
  User: ['login', 'id', 'name', 'email'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------- execution

class GqlError extends Error {}

interface FieldResult {
  value: unknown;
  type: string;
}

type Resolver = (parent: AnyNode, args: Record<string, unknown>, store: Store) => FieldResult;

function scalar(value: unknown, type = 'String'): FieldResult {
  return { value, type };
}

function node(value: AnyNode | null): FieldResult {
  return { value, type: value === null ? 'Null' : value.__typename };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return Number(match[1]);
  } catch {
    return 0;
  }
  return 0;
}

function pageInfo(total: number, offset: number, returned: number): AnyNode {
  return {
    __typename: 'PageInfo',
    hasNextPage: offset + returned < total,
    hasPreviousPage: offset > 0,
    startCursor: returned > 0 ? encodeCursor(offset) : null,
    endCursor: returned > 0 ? encodeCursor(offset + returned) : null,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): AnyNode {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  const compare = (a: Issue, b: Issue): number => {
    if (field === 'COMMENTS') return a.comments.length - b.comments.length;
    return a.seq - b.seq;
  };
  list.sort((a, b) => (direction === 'ASC' ? compare(a, b) : -compare(a, b)));
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const offset = decodeCursor(args.after ?? null);
  const page = list.slice(offset, offset + first);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: pageInfo(list.length, offset, page.length),
    totalCount: list.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): AnyNode {
  const list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const offset = decodeCursor(args.after ?? null);
  const page = list.slice(offset, offset + first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    pageInfo: pageInfo(list.length, offset, page.length),
    totalCount: list.length,
  };
}

function filesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): AnyNode {
  const files = store.pullFiles(repo, pull);
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
  const page = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions })),
    pageInfo: pageInfo(files.length, 0, page.length),
    totalCount: files.length,
  };
}

function findRepoById(store: Store, repoDbId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === repoDbId) return repo;
  return undefined;
}

function resolveGlobalRepo(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string' || id === '') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  return findRepoById(store, parsed.repoDbId) ?? null;
}

function resolveGlobalIssue(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string' || id === '') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Issue') return null;
  const repo = findRepoById(store, parsed.repoDbId);
  if (!repo) return null;
  const issue = store.findIssue(repo, parsed.number);
  if (!issue) return null;
  return { repo, issue };
}

function resolveGlobalPull(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string' || id === '') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'PullRequest') return null;
  const repo = findRepoById(store, parsed.repoDbId);
  if (!repo) return null;
  const pull = store.findPull(repo, parsed.number);
  if (!pull) return null;
  return { repo, pull };
}

const QUERY_FIELDS: Record<string, Resolver> = {
  viewer: () => node(userNode()),
  repository: (_parent, args, store) => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return node(null);
    const repo = store.visibleRepo(owner, name);
    return node(repo ? repoNode(repo) : null);
  },
  node: (_parent, args, store) => {
    const id = args.id;
    if (typeof id !== 'string') return node(null);
    const parsed = parseGlobalId(id);
    if (!parsed) return node(null);
    if (parsed.type === 'Repository') {
      const repo = findRepoById(store, parsed.repoDbId);
      return node(repo ? repoNode(repo) : null);
    }
    if (parsed.type === 'Issue') {
      const found = resolveGlobalIssue(store, id);
      return node(found ? issueNode(found.repo, found.issue) : null);
    }
    if (parsed.type === 'PullRequest') {
      const found = resolveGlobalPull(store, id);
      return node(found ? pullNode(found.repo, found.pull) : null);
    }
    return node(null);
  },
  __type: (_parent, args) => {
    const name = args.name;
    if (typeof name !== 'string') return node(null);
    const fields = TYPE_FIELDS[name];
    const enumValues = TYPE_ENUM_VALUES[name];
    if (fields === undefined && enumValues === undefined) return node(null);
    const typeNode: AnyNode = {
      __typename: '__Type',
      name,
      kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
      fields: (fields ?? []).map((field) => ({ __typename: '__Field', name: field })),
      enumValues: (enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
    };
    return node(typeNode);
  },
};

const USER_FIELDS: Record<string, Resolver> = {
  login: (parent) => scalar(parent.login),
  id: (parent) => scalar(parent.id, 'Int'),
  name: (parent) => scalar(parent.name ?? null),
  email: (parent) => scalar(parent.email ?? null),
};

const REPO_FIELDS: Record<string, Resolver> = {
  id: (parent) => scalar(globalId('Repository', (parent.repo as Repo).id, 0), 'ID'),
  databaseId: (parent) => scalar((parent.repo as Repo).id, 'Int'),
  name: (parent) => scalar((parent.repo as Repo).name),
  nameWithOwner: (parent) => {
    const repo = parent.repo as Repo;
    return scalar(`${repo.owner}/${repo.name}`);
  },
  owner: () => node(userNode()),
  defaultBranchRef: (parent) => {
    const repo = parent.repo as Repo;
    const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
    if (tip === undefined) return node(null);
    return node({ __typename: 'Ref', name: repo.default_branch });
  },
  viewerPermission: () => scalar('ADMIN'),
  hasIssuesEnabled: () => scalar(true, 'Boolean'),
  description: (parent) => scalar((parent.repo as Repo).description),
  createdAt: (parent) => scalar((parent.repo as Repo).created_at),
  updatedAt: (parent) => scalar((parent.repo as Repo).updated_at),
  url: (parent) => {
    const repo = parent.repo as Repo;
    return scalar(`/${repo.owner}/${repo.name}`);
  },
  issue: (parent, args) => {
    const repo = parent.repo as Repo;
    const number = args.number;
    if (typeof number !== 'number') return node(null);
    const issue = repo.issues.find((entry) => entry.number === number);
    return node(issue ? issueNode(repo, issue) : null);
  },
  issues: (parent, args) => {
    const repo = parent.repo as Repo;
    return node(issuesConnection(repo, args));
  },
  pullRequests: (parent, args) => {
    const repo = parent.repo as Repo;
    return node(pullsConnection(repo, args));
  },
  pullRequest: (parent, args) => {
    const repo = parent.repo as Repo;
    const number = args.number;
    if (typeof number !== 'number') return node(null);
    const pull = repo.pulls.find((entry) => entry.number === number);
    return node(pull ? pullNode(repo, pull) : null);
  },
};

const ISSUE_FIELDS: Record<string, Resolver> = {
  id: (parent) => scalar(globalId('Issue', (parent.repo as Repo).id, (parent.issue as Issue).number), 'ID'),
  number: (parent) => scalar((parent.issue as Issue).number, 'Int'),
  title: (parent) => scalar((parent.issue as Issue).title),
  state: (parent) => scalar((parent.issue as Issue).state.toUpperCase()),
  body: (parent) => scalar((parent.issue as Issue).body),
  url: (parent) => {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    return scalar(`/${repo.owner}/${repo.name}/issues/${issue.number}`);
  },
  createdAt: (parent) => scalar((parent.issue as Issue).created_at),
  updatedAt: (parent) => scalar((parent.issue as Issue).updated_at),
  author: () => node(userNode()),
  labels: (parent) => {
    const issue = parent.issue as Issue;
    return node({ __typename: 'LabelConnection', nodes: issue.labels.map((label) => ({ __typename: 'Label', name: label.name, color: label.color })) });
  },
  comments: (parent) => {
    const issue = parent.issue as Issue;
    return node({ __typename: 'IssueCommentConnection', nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: globalId('IssueComment', (parent.repo as Repo).id, comment.id), body: comment.body })) });
  },
};

const PULL_FIELDS: Record<string, Resolver> = {
  id: (parent) => scalar(globalId('PullRequest', (parent.repo as Repo).id, (parent.pull as Pull).number), 'ID'),
  number: (parent) => scalar((parent.pull as Pull).number, 'Int'),
  title: (parent) => scalar((parent.pull as Pull).title),
  state: (parent) => {
    const pull = parent.pull as Pull;
    if (pull.merged) return scalar('MERGED');
    return scalar(pull.state.toUpperCase());
  },
  merged: (parent) => scalar((parent.pull as Pull).merged, 'Boolean'),
  headRefName: (parent) => scalar((parent.pull as Pull).head.ref),
  baseRefName: (parent) => scalar((parent.pull as Pull).base.ref),
  mergeable: (parent, _args, store) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (headTip === undefined || baseTip === undefined) return scalar('UNKNOWN');
    return scalar(store.mergeable(repo, headTip, baseTip) ? 'MERGEABLE' : 'CONFLICTING');
  },
  files: (parent, args, store) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    return node(filesConnection(store, repo, pull, args));
  },
  body: (parent) => scalar((parent.pull as Pull).body),
  createdAt: (parent) => scalar((parent.pull as Pull).created_at),
  updatedAt: (parent) => scalar((parent.pull as Pull).updated_at),
  author: () => node(userNode()),
  headRef: (parent) => {
    const pull = parent.pull as Pull;
    return node({ __typename: 'Ref', name: pull.head.ref });
  },
  baseRef: (parent) => {
    const pull = parent.pull as Pull;
    return node({ __typename: 'Ref', name: pull.base.ref });
  },
  mergeCommit: (parent) => {
    const pull = parent.pull as Pull;
    if (!pull.merge_commit_sha) return node(null);
    return node({ __typename: 'Commit', oid: pull.merge_commit_sha });
  },
};

const MUTATION_FIELDS: Record<string, Resolver> = {
  createIssue: (_parent, args, store) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = resolveGlobalRepo(store, input.repositoryId);
    if (!repo) throw new GqlError('createIssue: repository not found');
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new GqlError('createIssue: title is required');
    const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    return node({ __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) });
  },
  closeIssue: (_parent, args, store) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = resolveGlobalIssue(store, input.issueId);
    if (!found) throw new GqlError('closeIssue: issue not found');
    found.issue.state = 'closed';
    found.issue.closed_at = store.nowIso();
    found.issue.updated_at = store.nowIso();
    return node({ __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) });
  },
  createPullRequest: (_parent, args, store) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = resolveGlobalRepo(store, input.repositoryId);
    if (!repo) throw new GqlError('createPullRequest: repository not found');
    const headRef = input.headRefName;
    const baseRef = input.baseRefName;
    if (typeof headRef !== 'string' || typeof baseRef !== 'string') throw new GqlError('createPullRequest: headRefName and baseRefName are required');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) throw new GqlError(`createPullRequest: head branch ${headRef} not found`);
    if (baseSha === undefined) throw new GqlError(`createPullRequest: base branch ${baseRef} not found`);
    const title = typeof input.title === 'string' ? input.title : '';
    const pull = store.createPull(repo, title, '', headRef, headSha, baseRef, baseSha);
    return node({ __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) });
  },
  mergePullRequest: (_parent, args, store) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = resolveGlobalPull(store, input.pullRequestId);
    if (!found) throw new GqlError('mergePullRequest: pull request not found');
    const sha = store.squashMerge(found.repo, found.pull);
    if (sha === null) throw new GqlError('mergePullRequest: merge conflict');
    return node({ __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) });
  },
  addComment: (_parent, args, store) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = resolveGlobalIssue(store, input.subjectId);
    if (!found) throw new GqlError('addComment: subject not found');
    const body = input.body;
    if (typeof body !== 'string') throw new GqlError('addComment: body is required');
    const now = store.nowIso();
    const comment = {
      id: store.nextEntity(),
      body,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: now,
      updated_at: now,
    };
    found.issue.comments.push(comment);
    const commentNode: AnyNode = { __typename: 'IssueComment', id: globalId('IssueComment', found.repo.id, comment.id), body };
    return node({ __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentNode } });
  },
};

const PAYLOAD_FIELDS: Record<string, Resolver> = {
  issue: (parent) => node((parent.issue as AnyNode) ?? null),
  pullRequest: (parent) => node((parent.pullRequest as AnyNode) ?? null),
  commentEdge: (parent) => node((parent.commentEdge as AnyNode) ?? null),
  node: (parent) => node((parent.node as AnyNode) ?? null),
};

const CONNECTION_FIELDS: Record<string, Resolver> = {
  nodes: (parent) => {
    const nodes = parent.nodes as AnyNode[];
    return { value: nodes, type: 'List' };
  },
  pageInfo: (parent) => node(parent.pageInfo as AnyNode),
  totalCount: (parent) => scalar(parent.totalCount ?? 0, 'Int'),
};

const TYPE_FIELDS_MAP: Record<string, Record<string, Resolver>> = {
  Query: QUERY_FIELDS,
  Mutation: MUTATION_FIELDS,
  User: USER_FIELDS,
  Repository: REPO_FIELDS,
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  Ref: { name: (parent) => scalar(parent.name) },
  IssueConnection: CONNECTION_FIELDS,
  PullRequestConnection: CONNECTION_FIELDS,
  PullRequestChangedFileConnection: CONNECTION_FIELDS,
  PullRequestChangedFile: {
    path: (parent) => scalar(parent.path),
    additions: (parent) => scalar(parent.additions ?? 0, 'Int'),
    deletions: (parent) => scalar(parent.deletions ?? 0, 'Int'),
  },
  PageInfo: {
    hasNextPage: (parent) => scalar(parent.hasNextPage, 'Boolean'),
    hasPreviousPage: (parent) => scalar(parent.hasPreviousPage, 'Boolean'),
    startCursor: (parent) => scalar(parent.startCursor ?? null),
    endCursor: (parent) => scalar(parent.endCursor ?? null),
  },
  CreateIssuePayload: PAYLOAD_FIELDS,
  CloseIssuePayload: PAYLOAD_FIELDS,
  CreatePullRequestPayload: PAYLOAD_FIELDS,
  MergePullRequestPayload: PAYLOAD_FIELDS,
  AddCommentPayload: PAYLOAD_FIELDS,
  IssueCommentEdge: PAYLOAD_FIELDS,
  IssueComment: {
    id: (parent) => scalar(parent.id, 'ID'),
    body: (parent) => scalar(parent.body),
  },
  Label: {
    name: (parent) => scalar(parent.name),
    color: (parent) => scalar(parent.color ?? ''),
  },
  LabelConnection: CONNECTION_FIELDS,
  IssueCommentConnection: CONNECTION_FIELDS,
  Commit: {
    oid: (parent) => scalar(parent.oid),
  },
  __Type: {
    name: (parent) => scalar(parent.name),
    kind: (parent) => scalar(parent.kind),
    fields: (parent) => {
      const fields = parent.fields as AnyNode[];
      return { value: fields, type: 'List' };
    },
    enumValues: (parent) => {
      const values = parent.enumValues as AnyNode[];
      return { value: values, type: 'List' };
    },
  },
  __Field: {
    name: (parent) => scalar(parent.name),
  },
  __EnumValue: {
    name: (parent) => scalar(parent.name),
  },
};

function executeSelection(
  parentType: string,
  parent: AnyNode,
  selections: Selection[],
  variables: Record<string, unknown>,
  store: Store,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = TYPE_FIELDS_MAP[parentType] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      const inner = executeSelection(parentType, parent, selection.selection, variables, store, errors);
      Object.assign(out, inner);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const resolver = fields[selection.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(selection.args)) {
      args[argName] = resolveValue(argValue, variables);
    }
    let result: FieldResult;
    try {
      result = resolver(parent, args, store);
    } catch (err) {
      if (err instanceof GqlError) {
        errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    const value = result.value;
    if (selection.selection === null) {
      out[key] = value;
    } else if (value === null || value === undefined) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      const itemType = result.type === 'List' ? guessItemType(parentType, selection.name) : result.type;
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? executeSelection(itemType, item as AnyNode, selection.selection as Selection[], variables, store, errors)
          : item,
      );
    } else if (typeof value === 'object') {
      out[key] = executeSelection(result.type, value as AnyNode, selection.selection as Selection[], variables, store, errors);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function guessItemType(parentType: string, fieldName: string): string {
  if (parentType === 'IssueConnection') return 'Issue';
  if (parentType === 'PullRequestConnection') return 'PullRequest';
  if (parentType === 'PullRequestChangedFileConnection') return 'PullRequestChangedFile';
  if (parentType === 'LabelConnection') return 'Label';
  if (parentType === 'IssueCommentConnection') return 'IssueComment';
  if (parentType === '__Type' && fieldName === 'fields') return '__Field';
  if (parentType === '__Type' && fieldName === 'enumValues') return '__EnumValue';
  return 'Unknown';
}

export interface GraphQLResult {
  data: unknown;
  errors: Array<{ message: string }>;
}

/** Execute one GraphQL operation document. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown> = {},
  operationName?: string,
): GraphQLResult {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'Syntax Error: no operation in document' }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined && operationName !== '') {
    operation = operations.find((op) => op.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== null) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyNode = { __typename: rootType };
  const errors: Array<{ message: string }> = [];
  let data: Record<string, unknown>;
  try {
    data = executeSelection(rootType, root, operation.selection, vars, store, errors);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  return { data, errors };
}
