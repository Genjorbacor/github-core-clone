// MCP over streamable HTTP: server/discover (2026-07-28), initialize fallback,
// tools/list, tools/call. Stateless; every request echoes its JSON-RPC id exactly.

import {
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResult {
  status: number;
  body: Buffer;
}

function jsonBody(status: number, value: unknown): McpResult {
  return { status, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? 1000 : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    has_issues: true,
    fork: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    user: issue.user,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredOf(tool: ToolDef): string[] {
  const schema = tool.inputSchema;
  const required = schema.required;
  return Array.isArray(required) ? (required.filter((entry) => typeof entry === 'string') as string[]) : [];
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const missing = requiredOf(tool).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (typeof repoName !== 'string' || repoName === '') return toolError('name is required');
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.visibleRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.visibleRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.visibleRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = store.visibleRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) return toolError(`Head branch ${head} not found`);
      if (baseSha === undefined) return toolError(`Base branch ${base} not found`);
      const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, headSha, base, baseSha);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.visibleRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = store.findPull(repo, number);
      if (!pull) return toolError(`Pull request #${String(args.pull_number)} not found`);
      if (pull.merged) return toolError(`Pull request #${number} is already merged`);
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return toolError(`Pull request #${number} has a merge conflict`);
      return toolResult({ merged: true, number: pull.number, sha, state: 'closed', message: `Merged #${pull.number}` });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function extractId(text: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (!match) return null;
  const raw = match[1] as string;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return Number(raw);
}

/** Handle one POST /mcp body. `declaredVersion` is the MCP-Protocol-Version header, if any. */
export function handleMcp(store: Store, rawBody: string, declaredVersion?: string): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonBody(400, {
      jsonrpc: '2.0',
      id: extractId(rawBody),
      error: { code: -32700, message: 'Parse error' },
    });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonBody(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    return jsonBody(200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  const params = (request.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const requestedVersion =
    typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
      : typeof meta.protocolVersion === 'string'
        ? (meta.protocolVersion as string)
        : declaredVersion;

  const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
  const result = (value: unknown): McpResult => jsonBody(200, { jsonrpc: '2.0', id, result: value });
  const rpcError = (code: number, message: string, data?: unknown): McpResult =>
    jsonBody(200, { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

  switch (method) {
    case 'server/discover': {
      if (requestedVersion !== undefined && !MCP_SUPPORTED_VERSIONS.includes(requestedVersion)) {
        return rpcError(-32022, `Unsupported protocol version: ${requestedVersion}`, { supported: [...MCP_SUPPORTED_VERSIONS] });
      }
      return result({
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...serverInfo },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const negotiated = offered !== undefined && MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...serverInfo },
      });
    }
    case 'ping': {
      return result({});
    }
    case 'tools/list': {
      return result({ tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        return rpcError(-32602, 'tools/call requires a tool name');
      }
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(-32602, `Unknown tool: ${toolName}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return rpcError(-32602, 'tools/call arguments must be an object');
      }
      return result(callTool(store, toolName, args));
    }
    default:
      return rpcError(-32601, `Method not found: ${method}`);
  }
}
