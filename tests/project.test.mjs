import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPath, createProject, captureProjectSnapshot } from '../src/git.mjs';
import { GroupRuntime } from '../src/group-runtime.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-project-test-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

test('project names produce one absolute child directory and reject traversal and Windows invalid names', t => {
  const root = temporary(t);
  assert.equal(projectPath(root, ' 我的应用 '), path.join(root, '我的应用'));
  for (const name of ['', '..', '../escape', 'a/b', 'a\\b', 'NUL.txt', 'COM1', 'app.', 'a:b', 'a\0b']) assert.throws(() => projectPath(root, name));
  assert.throws(() => projectPath('relative', 'app'));
  assert.equal(fs.readdirSync(root).length, 0);
});

test('new project has clean main HEAD usable for snapshots and worktrees, refuses existing directories and nested repositories', t => {
  const root = temporary(t), repo = createProject(root, '中文项目');
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  const before = git(repo, 'rev-parse', 'HEAD');
  const baseline = captureProjectSnapshot(repo);
  assert.equal(baseline.commit, before);
  const tree = path.join(root, 'peer-tree');
  git(repo, 'worktree', 'add', '--detach', tree, baseline.commit);
  assert.equal(git(tree, 'rev-parse', 'HEAD'), before);
  assert.throws(() => createProject(root, '中文项目'), /同名目录/);
  assert.throws(() => createProject(repo, 'nested'), /Git 项目内/);
  assert.equal(fs.existsSync(path.join(repo, 'nested')), false);
  const existing = path.join(root, 'ordinary'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep');
  assert.throws(() => createProject(root, 'ordinary'), /同名目录/);
  assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(existing, '.git')), false);
});

test('disconnected group setup does not create project directories', async t => {
  const root = temporary(t), runtime = new GroupRuntime({});
  await assert.rejects(runtime.create({ createProject: true, projectsRoot: root, projectName: 'unused', codexModel: 'c', harnessModel: 'h' }), /not connected/);
  assert.equal(fs.existsSync(path.join(root, 'unused')), false);
});
