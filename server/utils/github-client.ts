/**
 * Thin GitHub REST API client for Mimir's code-change tools.
 *
 * Why raw fetch instead of Octokit:
 * - One dep saved, smaller bundle for Vercel
 * - We only use ~8 endpoints — Octokit's surface is overkill
 * - Matches the rest of Mimir's "fetch-only" style (lead-tools, etc.)
 *
 * Repo allowlist is enforced at THIS layer — every public function takes a
 * RepoKey, not a free-form repo string. Adding a repo means editing this file.
 */

// =====================================================================
// REPO ALLOWLIST — the only repos Mimir is allowed to touch
// =====================================================================

export const MANAGED_REPOS = {
  mimir: {
    owner: 'AdamDeLeon530',
    repo: 'mimir',
    label: 'Mimir',
    description: "Mimir's own source — the dashboard, voice, tools, system prompt.",
    defaultBranch: 'main',
  },
  nordicnerd: {
    owner: 'AdamDeLeon530',
    repo: 'NordicNerd',
    label: 'Nordic Nerd monorepo',
    description: 'The marketing site, client templates, ops stack, agent rules.',
    defaultBranch: 'main',
  },
} as const

export type RepoKey = keyof typeof MANAGED_REPOS

export function isManagedRepo(key: string): key is RepoKey {
  return key in MANAGED_REPOS
}

export function listManagedRepos() {
  return (Object.keys(MANAGED_REPOS) as RepoKey[]).map(key => ({
    key,
    ...MANAGED_REPOS[key],
  }))
}

// =====================================================================
// LOW-LEVEL: authenticated fetch
// =====================================================================

const API = 'https://api.github.com'

function token(): string {
  const t = process.env.NUXT_GITHUB_TOKEN
  if (!t) throw new Error('NUXT_GITHUB_TOKEN not set — Mimir cannot open PRs without it')
  return t
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${token()}`,
      'User-Agent': 'Mimir-CodeChange/1.0',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub ${res.status} ${init.method ?? 'GET'} ${path} → ${text.slice(0, 300)}`)
  }
  return res.status === 204 ? (undefined as T) : (await res.json() as T)
}

function repoPath(key: RepoKey, suffix = ''): string {
  const r = MANAGED_REPOS[key]
  return `/repos/${r.owner}/${r.repo}${suffix}`
}

// =====================================================================
// READ — file content, tree listing
// =====================================================================

export async function readFile(key: RepoKey, path: string, ref?: string): Promise<{
  content: string
  sha: string
  encoding: 'base64'
}> {
  const r = MANAGED_REPOS[key]
  const branch = ref ?? r.defaultBranch
  const data = await gh<{ content: string; sha: string; encoding: string }>(
    repoPath(key, `/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`),
  )
  // GitHub returns base64; decode to UTF-8 string for the caller
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8')
  return { content: decoded, sha: data.sha, encoding: 'base64' }
}

export interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
  size?: number
  sha: string
}

export async function listRepoTree(key: RepoKey, ref?: string): Promise<TreeEntry[]> {
  const r = MANAGED_REPOS[key]
  const branch = ref ?? r.defaultBranch
  // Get the branch's tip commit SHA
  const head = await gh<{ commit: { sha: string } }>(
    repoPath(key, `/branches/${encodeURIComponent(branch)}`),
  )
  // Recursive tree
  const tree = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    repoPath(key, `/git/trees/${head.commit.sha}?recursive=1`),
  )
  // Filter out node_modules and other noise that we never edit
  return tree.tree.filter(e =>
    !e.path.startsWith('node_modules/') &&
    !e.path.startsWith('.next/') &&
    !e.path.startsWith('.nuxt/') &&
    !e.path.startsWith('dist/') &&
    !e.path.startsWith('.vercel/') &&
    !e.path.endsWith('.lock') &&
    !e.path.endsWith('package-lock.json') &&
    !e.path.endsWith('pnpm-lock.yaml') &&
    !e.path.endsWith('yarn.lock'),
  )
}

// =====================================================================
// WRITE — branch creation + atomic multi-file commit + PR
// =====================================================================

export async function createBranch(
  key: RepoKey,
  newBranch: string,
  fromBranch?: string,
): Promise<{ ref: string; sha: string }> {
  const r = MANAGED_REPOS[key]
  const from = fromBranch ?? r.defaultBranch
  const head = await gh<{ commit: { sha: string } }>(
    repoPath(key, `/branches/${encodeURIComponent(from)}`),
  )
  await gh(repoPath(key, '/git/refs'), {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${newBranch}`,
      sha: head.commit.sha,
    }),
  })
  return { ref: `refs/heads/${newBranch}`, sha: head.commit.sha }
}

export interface FileChange {
  path: string
  // null content = delete file
  content: string | null
}

/**
 * Atomic multi-file commit via the git data API.
 *
 * Steps:
 *   1. Get the branch's current commit SHA + base tree SHA
 *   2. Create blobs for each new/changed file
 *   3. Build a new tree referencing the new blobs
 *   4. Create a commit pointing to the new tree
 *   5. Update the branch ref to point at the new commit
 *
 * One commit, N files. The user sees a clean PR.
 */
export async function commitMultipleFiles(
  key: RepoKey,
  branch: string,
  changes: FileChange[],
  message: string,
  authorName = 'Mimir',
  authorEmail = 'mimir-bot@thenordicnerd.com',
): Promise<{ commitSha: string }> {
  // 1. Branch tip
  const ref = await gh<{ object: { sha: string } }>(
    repoPath(key, `/git/refs/heads/${encodeURIComponent(branch)}`),
  )
  const parentSha = ref.object.sha
  const parentCommit = await gh<{ tree: { sha: string } }>(
    repoPath(key, `/git/commits/${parentSha}`),
  )
  const baseTreeSha = parentCommit.tree.sha

  // 2. Blobs (skip blobs for deletes — we just omit them from the tree)
  const blobs = await Promise.all(
    changes.map(async (c) => {
      if (c.content === null) return null
      const blob = await gh<{ sha: string }>(repoPath(key, '/git/blobs'), {
        method: 'POST',
        body: JSON.stringify({
          content: Buffer.from(c.content, 'utf-8').toString('base64'),
          encoding: 'base64',
        }),
      })
      return blob.sha
    }),
  )

  // 3. New tree
  const treeEntries = changes.map((c, i) => ({
    path: c.path,
    mode: '100644' as const,
    type: 'blob' as const,
    ...(c.content === null ? { sha: null } : { sha: blobs[i] }),
  }))
  const newTree = await gh<{ sha: string }>(repoPath(key, '/git/trees'), {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeEntries,
    }),
  })

  // 4. Commit
  const commit = await gh<{ sha: string }>(repoPath(key, '/git/commits'), {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: [parentSha],
      author: { name: authorName, email: authorEmail, date: new Date().toISOString() },
    }),
  })

  // 5. Move the branch ref
  await gh(repoPath(key, `/git/refs/heads/${encodeURIComponent(branch)}`), {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })

  return { commitSha: commit.sha }
}

// =====================================================================
// PULL REQUESTS
// =====================================================================

export interface PullRequest {
  number: number
  html_url: string
  state: 'open' | 'closed'
  merged: boolean
  title: string
  body: string | null
  head: { ref: string }
  base: { ref: string }
  user: { login: string }
  created_at: string
  updated_at: string
}

export async function createPullRequest(
  key: RepoKey,
  branch: string,
  title: string,
  body: string,
  baseBranch?: string,
): Promise<PullRequest> {
  const r = MANAGED_REPOS[key]
  return gh<PullRequest>(repoPath(key, '/pulls'), {
    method: 'POST',
    body: JSON.stringify({
      title,
      body,
      head: branch,
      base: baseBranch ?? r.defaultBranch,
      maintainer_can_modify: true,
    }),
  })
}

export async function getPullRequest(key: RepoKey, prNumber: number): Promise<PullRequest> {
  return gh<PullRequest>(repoPath(key, `/pulls/${prNumber}`))
}

export async function listOpenPullRequests(key: RepoKey): Promise<PullRequest[]> {
  return gh<PullRequest[]>(repoPath(key, '/pulls?state=open&per_page=20'))
}

export async function mergePullRequest(
  key: RepoKey,
  prNumber: number,
  options: { method?: 'merge' | 'squash' | 'rebase'; commitMessage?: string } = {},
): Promise<{ merged: boolean; sha?: string; message?: string }> {
  try {
    const result = await gh<{ merged: boolean; sha: string; message: string }>(
      repoPath(key, `/pulls/${prNumber}/merge`),
      {
        method: 'PUT',
        body: JSON.stringify({
          merge_method: options.method ?? 'squash',
          ...(options.commitMessage ? { commit_title: options.commitMessage } : {}),
        }),
      },
    )
    return result
  } catch (err) {
    return { merged: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function closePullRequest(key: RepoKey, prNumber: number): Promise<void> {
  await gh(repoPath(key, `/pulls/${prNumber}`), {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  })
}

// =====================================================================
// PR COMMENTS — used to fetch the Vercel preview URL
// =====================================================================

interface IssueComment {
  user: { login: string; type: string }
  body: string
  created_at: string
}

/**
 * Vercel's GitHub integration drops a "Deployment status" comment on every PR
 * within ~30-90s of the branch being pushed. We scrape the preview URL from
 * that comment so Mimir can hand it to Adam.
 */
export async function getVercelPreviewUrl(key: RepoKey, prNumber: number): Promise<string | null> {
  const comments = await gh<IssueComment[]>(
    repoPath(key, `/issues/${prNumber}/comments?per_page=50`),
  )
  for (const c of comments) {
    if (c.user.login !== 'vercel[bot]' && c.user.login !== 'vercel') continue
    // The comment body contains lines like:
    //   | **Preview** | [Visit Preview](https://mimir-git-mimir-foo-adamdeleon530.vercel.app) |
    const m = c.body.match(/https:\/\/[a-z0-9-]+\.vercel\.app/i)
    if (m) return m[0]
  }
  return null
}

// =====================================================================
// HEALTH CHECK
// =====================================================================

export async function whoAmI(): Promise<{ login: string; ok: boolean; error?: string }> {
  try {
    const data = await gh<{ login: string }>('/user')
    return { login: data.login, ok: true }
  } catch (err) {
    return { login: '', ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
