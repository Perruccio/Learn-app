// Minimal GitHub REST client for a single repository (contents, trees, blobs).

import { b64decodeUtf8, b64encodeUtf8 } from './util.js?v=3543b6911ed6';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(path, { method = 'GET', body, accept = 'application/vnd.github+json', keepalive = false } = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        keepalive,
      });
    } catch (err) {
      throw new GitHubError('Network unreachable', 0);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message || '';
      } catch {
        /* ignore */
      }
      throw new GitHubError(`GitHub ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }
    return res;
  }

  /** Throws a GitHubError if the repository is not reachable with this token. */
  async checkAccess() {
    const res = await this.request(this.repoPath);
    return res.json();
  }

  /** All files of the branch: [{path, sha, size}]. */
  async listFiles() {
    const res = await this.request(`${this.repoPath}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    const data = await res.json();
    const files = (data.tree || [])
      .filter((item) => item.type === 'blob')
      .map((item) => ({ path: item.path, sha: item.sha, size: item.size }));
    return { files, truncated: !!data.truncated };
  }

  /** Raw bytes of a blob (up to 100 MB), with optional progress callback(loaded, total). */
  async getBlob(sha, onProgress, expectedSize) {
    const res = await this.request(`${this.repoPath}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw' });
    if ((res.headers.get('Content-Type') || '').includes('json')) {
      // Raw media type not honoured: fall back to the base64 JSON representation.
      const data = await res.json();
      const binary = atob((data.content || '').replace(/\s/g, ''));
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    const total = Number(res.headers.get('Content-Length')) || expectedSize || 0;
    if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Text file at path, or null if it does not exist: {sha, text}. */
  async getTextFile(path) {
    try {
      const res = await this.request(`${this.repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`);
      const data = await res.json();
      if (!data.content && data.size > 0) {
        // Files over 1 MB come without inline content: read the blob instead.
        return { sha: data.sha, text: new TextDecoder().decode(await this.getBlob(data.sha)) };
      }
      return { sha: data.sha, text: b64decodeUtf8(data.content || '') };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /** Create or update a file. `sha` is required when updating an existing file. */
  async putFile(path, { text, base64 }, sha, message, { keepalive = false } = {}) {
    const body = {
      message,
      content: base64 ?? b64encodeUtf8(text),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    };
    const res = await this.request(`${this.repoPath}/contents/${encodePath(path)}`, { method: 'PUT', body, keepalive });
    return res.json();
  }

  /**
   * Create or replace a large binary file through the Git Data API (blob, tree, commit, ref).
   * The contents endpoint rejects big payloads ("too large to be processed"); blobs accept
   * files up to GitHub's 100 MB limit. Retries if someone else pushed in the meantime.
   */
  async putLargeFile(path, base64, message) {
    const post = async (endpoint, body) => (await this.request(`${this.repoPath}/git/${endpoint}`, { method: 'POST', body })).json();
    const blob = await post('blobs', { content: base64, encoding: 'base64' });
    const ref = `heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 0; ; attempt++) {
      const head = await (await this.request(`${this.repoPath}/git/ref/${ref}`)).json();
      const parent = await (await this.request(`${this.repoPath}/git/commits/${head.object.sha}`)).json();
      const tree = await post('trees', { base_tree: parent.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
      const commit = await post('commits', { message, tree: tree.sha, parents: [head.object.sha] });
      try {
        await this.request(`${this.repoPath}/git/refs/${ref}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return { sha: blob.sha, commit: commit.sha };
      } catch (err) {
        // 422: the branch moved (not a fast-forward). Rebuild on the new head.
        if (err.status !== 422 || attempt >= 3) throw err;
      }
    }
  }
}
