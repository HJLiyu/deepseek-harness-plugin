import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dataDir } from './state.mjs';

function git(cwd, args, env) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }).trim();
}
export function gitRoot(workspace) {
  const input = path.resolve(workspace);
  if (!fs.existsSync(input)) throw new Error(`Workspace does not exist: ${input}`);
  try { return path.resolve(git(input, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error(`Workspace must be a Git repository: ${input}`); }
}
export function projectPath(projectsRoot, projectName) {
  if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot.trim())) throw new Error('请选择项目存放位置的绝对路径。');
  const name = typeof projectName === 'string' ? projectName.trim() : '';
  if (!name || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /[. ]$/.test(name) || /^\.{1,2}$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error('项目名称不能包含路径符号、Windows 保留名称或末尾句点，且最多100个字符。');
  return path.join(path.resolve(projectsRoot.trim()), name);
}
export function createProject(projectsRoot, projectName) {
  const target = projectPath(projectsRoot, projectName), parent = path.dirname(target);
  if (fs.existsSync(target)) throw new Error(`同名目录已存在，请改名或选择已有项目：${target}`);
  let ancestor = parent;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  let enclosing;
  try { enclosing = git(ancestor, ['rev-parse', '--show-toplevel']); } catch { /* a new project must be independent */ }
  if (enclosing) throw new Error(`存放位置已在 Git 项目内，请选择其他位置：${enclosing}`);
  fs.mkdirSync(parent, { recursive: true });
  const canonical = path.join(fs.realpathSync(parent), path.basename(target));
  // Exclusive mkdir never initializes or overwrites an existing directory.
  fs.mkdirSync(canonical);
  try {
    git(canonical, ['init', '--initial-branch=main', '--template=']);
    const tree = git(canonical, ['write-tree']);
    const env = { GIT_AUTHOR_NAME: 'Codex Harness', GIT_AUTHOR_EMAIL: 'project@localhost', GIT_COMMITTER_NAME: 'Codex Harness', GIT_COMMITTER_EMAIL: 'project@localhost' };
    const commit = git(canonical, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'Initialize project'], env);
    git(canonical, ['update-ref', 'HEAD', commit]);
    return canonical;
  } catch (error) { throw new Error(`Git 初始化未完成，目录已保留，可检查后手动选用：${canonical}。${error.message}`); }
}
export function captureProjectSnapshot(repo, indexRoot = path.join(dataDir, 'snapshots')) {
  const root = gitRoot(repo), head = git(root, ['rev-parse', 'HEAD']);
  if (!git(root, ['status', '--porcelain', '--untracked-files=all'], { GIT_OPTIONAL_LOCKS: '0' })) return { commit: head, sourceHead: head, dirty: false };
  const index = path.join(indexRoot, `${randomUUID()}.index`);
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Codex Harness Snapshot', GIT_AUTHOR_EMAIL: 'snapshot@localhost', GIT_COMMITTER_NAME: 'Codex Harness Snapshot', GIT_COMMITTER_EMAIL: 'snapshot@localhost' };
  try {
    git(root, ['read-tree', head], env);
    git(root, ['add', '--all', '--', '.'], env);
    if (git(root, ['diff', '--name-only'], env) || git(root, ['ls-files', '--others', '--exclude-standard'], env)) throw new Error('Project changed while capturing the worktree baseline; retry from a stable checkpoint.');
    const tree = git(root, ['write-tree'], env);
    const commit = git(root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-m', 'Private working-tree baseline for Codex × Harness group (main index and branch unchanged)'], env);
    return { commit, sourceHead: head, dirty: true };
  } finally {
    // Only the two explicitly created temporary index paths, never a user index or a computed directory tree.
    for (const file of [index, `${index}.lock`]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
export function createHarnessWorktree(repo, goalId, ref = 'HEAD') {
  const root = gitRoot(repo);
  const target = path.resolve(dataDir, 'worktrees', goalId);
  const relative = path.relative(path.resolve(dataDir, 'worktrees'), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Worktree path escaped plugin data directory.');
  if (fs.existsSync(target)) throw new Error(`Worktree target already exists: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const branch = `codex-harness/${goalId}`;
  git(root, ['worktree', 'add', '-b', branch, target, ref]);
  return { repo: root, worktree: target, branch };
}
export function worktreeStatus(worktree) {
  try {
    return { exists: true, status: git(worktree, ['status', '--short']), diffStat: git(worktree, ['diff', '--stat']) };
  } catch (error) {
    return { exists: false, error: error.message };
  }
}
