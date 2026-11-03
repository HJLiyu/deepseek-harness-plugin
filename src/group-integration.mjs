import { integrationFailure } from './integration-diagnostics.mjs';
import { contentHash as hash, projectGit as git, gitNames as names, fileHash, textHash, projectSnapshot as snapshot, trackedPaths } from './project-files.mjs';
import { retainedFiles, assertRetention } from './artifact-policy.mjs';
export function captureIntegrationConsent(group, { member, files, sourceMessageId, requestId, revision }) {
  if (!Object.hasOwn(group.worktrees, member) || !Array.isArray(files) || !files.length || files.length > 100 || new Set(files).size !== files.length) throw Error('Invalid integration consent scope.');
  const targets = Object.fromEntries(files.map(name => {
    if (typeof name !== 'string' || name.includes('\\') || /(^|\/)\.git(?:\/|$)/i.test(name)) throw Error('Invalid integration consent path.');
    return [name, { before: fileHash(group.repo, name), wanted: fileHash(group.worktrees[member], name) }];
  }));
  return { member, targets, sourceMessageId, requestId, revision, expiresAt: Date.now() + 30 * 60 * 1000 };
}
export function captureIntegrationScope(group, member, files, revision) {
  if (!Object.hasOwn(group.worktrees, member) || !Array.isArray(files) || files.length > 100 || new Set(files).size !== files.length) throw Error('Invalid integration file selection.');
  const targets = Object.fromEntries(files.map(name => {
    if (typeof name !== 'string' || name.includes('\\') || /(^|\/)\.git(?:\/|$)/i.test(name)) throw Error('Invalid integration path.');
    return [name, fileHash(group.worktrees[member], name)];
  }));
  return { member, targets, revision };
}
export function captureWorkBaseline(group, member) {
  return { version: 2, tracked: trackedPaths(group.worktrees[member]), peer: snapshot(group.worktrees[member]), main: snapshot(group.repo) };
}
export function captureReviewedIntegration(group, member, files, before, revision) {
  const scope=captureIntegrationScope(group,member,files,revision),bases={};
  for(const [name,wanted] of Object.entries(scope.targets)){
    const base=before.main[name]??null;
    if(wanted===null&&base!==null&&!Object.hasOwn(before.peer,name))throw integrationFailure('scope_source_missing',{file:name,member});
    if(wanted!==(before.peer[name]??null)||fileHash(group.repo,name)!==base)throw integrationFailure('main_conflict',{file:name,kind:'changed_during_readiness_review'});
    bases[name]=base;
  }
  return {...scope,bases:{[member]:bases}};
}
export function captureReviewedMain(group, files, before, revision) {
  if(!Array.isArray(files)||files.length>100||new Set(files).size!==files.length)throw Error('Invalid main review scope.');
  const mainTargets={};
  for(const name of files){if(typeof name!=='string'||name.includes('\\')||/(^|\/)\.git(?:\/|$)/i.test(name))throw Error('Invalid main review path.');
    const current=fileHash(group.repo,name);if(current===null||current!==before.main[name])throw integrationFailure('main_conflict',{file:name,kind:'changed_during_main_review'});mainTargets[name]=current;
  }
  return {revision,mainTargets};
}
export function captureReviewedClosure(group, filesByMember, beforeByMember, originalScope, revision) {
  if(!filesByMember||typeof filesByMember!=='object'||Array.isArray(filesByMember))throw Error('Missing closure source map.');
  const original=originalScope.members??{[originalScope.member]:originalScope.targets};
  for(const [member,files] of Object.entries(original))for(const name of Object.keys(files??{}))if(!filesByMember[member]?.includes(name))throw Error('Closure cannot omit or move an existing selected file.');
  const selected={},bases={};let count=0;
  for(const [member,files] of Object.entries(filesByMember)){
    if(!Object.hasOwn(group.worktrees,member)||!Array.isArray(files)||new Set(files).size!==files.length||!beforeByMember[member])throw Error('Invalid closure member.');
    selected[member]={};bases[member]={};
    for(const name of files){
      if(++count>100||typeof name!=='string'||name.includes('\\')||/(^|\/)\.git(?:\/|$)/i.test(name))throw Error('Invalid closure file.');
      const before=beforeByMember[member];
      const deletion=originalScope.deletions?.[member]?.[name];
      const capturedDeletion=original[member]?.[name]===null&&deletion?.tracked===true&&/^[a-f0-9]{64}$/.test(deletion.before??'');
      if(!Object.hasOwn(before.peer,name)&&!capturedDeletion)throw Error('Closure source was not captured; ignored or unknown file.');
      const wanted=fileHash(group.worktrees[member],name),main=fileHash(group.repo,name);
      if(wanted!==(before.peer[name]??null)||main!==(before.main[name]??null))throw integrationFailure('main_conflict',{file:name,kind:'changed_during_closure_review'});
      if(Object.hasOwn(original[member]??{},name)&&wanted!==original[member][name])throw Error('Closure candidate changed from fixed scope.');
      if(wanted===null&&!Object.hasOwn(original[member]??{},name))throw Error('Closure cannot add an absent source.');
      selected[member][name]=wanted;bases[member][name]=main;
    }
  }
  if(!count)throw Error('Closure cannot discard the fixed scope.');
  return {revision,members:selected,bases,...(originalScope.deletions?{deletions:structuredClone(originalScope.deletions)}:{})};
}
export function captureWorkDelta(group, member, baseline) {
  const after = snapshot(group.worktrees[member], Object.keys(baseline.peer)), targets = {}, bases = {}, missingSources = {}, deletions = {}, retainedChanges = {};
  const retained=retainedFiles(group);
  const tracked = new Set(baseline.tracked ?? trackedPaths(group.worktrees[member]));
  for (const name of new Set([...Object.keys(baseline.peer), ...Object.keys(after)])) {
    const before = baseline.peer[name] ?? null, wanted = after[name] ?? null;
    if (wanted === before) continue;
    if(Object.hasOwn(retained,name)){retainedChanges[name]={before,wanted,retained:retained[name]};continue;}
    // Disappearing untracked artifacts have no deletion intent. Preserve main
    // and expose the missing source separately, never encode it as target=null.
    if(wanted===null&&!tracked.has(name)){missingSources[name]={before,main:baseline.main[name]??null};continue;}
    if(wanted===null&&before!==null)deletions[name]={tracked:true,before};
    targets[name] = wanted;
    // A newer per-request base is trusted only when the member actually
    // started from the identical main file. A stale worktree gains no grant.
    if (before === (baseline.main[name] ?? null)) bases[name] = before;
  }
  return { version: 2, targets, bases, missingSources, deletions, retainedChanges };
}
// Eligibility for a fresh read-only review, never an overwrite grant. Legacy
// multi-owner work may have synchronized maintenance after admission, and the
// old executor-only diagnosis can narrow files without establishing new bases.
// Only unchanged coordinator-captured main bytes and exact work candidates
// qualify. Real concurrent edits and multiple writing members stay protected.
export function staleWorkScopeForReview(group, request) {
  const scope = request.integrationScope;
  if (!scope || scope.revision !== request.revision) return null;
  const selected = scope.members ?? { [scope.member]: scope.targets };
  const active = Object.entries(selected).filter(([, files]) => files && Object.keys(files).length);
  if (active.length !== 1) return null;
  const [member, targets] = active[0], baseline = request.workBaselines?.[member], candidate = request.workCandidates?.[member];
  if (member !== request.agreement.integrator || !baseline?.main || !baseline.peer || !candidate?.targets) return null;
  let unaligned = false;
  const bases = {};
  for (const [name, wanted] of Object.entries(targets)) {
    const main = baseline.main[name] ?? null;
    if (!Object.hasOwn(candidate.targets, name) || candidate.targets[name] !== wanted ||
        fileHash(group.repo, name) !== main || fileHash(group.worktrees[member], name) !== wanted) return null;
    bases[name] = main;
    if (!Object.hasOwn(scope.bases?.[member] ?? {}, name) && (baseline.peer[name] ?? null) !== main) unaligned = true;
  }
  return unaligned ? { member, targets: { ...targets }, bases } : null;
}
export function integrationPreflight(group, consent, scope) {
  const retained=assertRetention(group,scope,consent);
  for(const [name,wanted] of Object.entries(scope?.preserved??{}))if(fileHash(group.repo,name)!==wanted)throw integrationFailure('main_conflict',{file:name,kind:'retained_artifact_changed'});
  if(scope?.mainTargets){
    if(consent)throw Error('Main-only review cannot authorize overwrites.');
    for(const [name,wanted] of Object.entries(scope.mainTargets))if(wanted===null||fileHash(group.repo,name)!==wanted)throw integrationFailure('main_conflict',{file:name,kind:'changed_after_main_review'});
    return {expected:{...scope.mainTargets},textExpected:{},peers:{...group.integrationState?.peers},before:snapshot(group.repo,Object.keys(retained)),index:hash(git(group.repo,['diff','--cached','--binary']))};
  }
  const selected = scope?.members ?? (scope ? { [scope.member]: scope.targets } : null);
  if (consent) {
    if (consent.expiresAt <= Date.now()) throw integrationFailure('consent_expired', { expiresAt: consent.expiresAt, now: Date.now(), files: Object.keys(consent.targets), requestId: consent.requestId, revision: consent.revision });
    for (const [name, target] of Object.entries(consent.targets)) {
      const current = fileHash(group.repo, name), wanted = fileHash(group.worktrees[consent.member], name);
      if (current !== target.before || wanted !== target.wanted) throw integrationFailure('consent_files_changed', { file: name, before: target.before, current, wanted, authorizedWanted: target.wanted, member: consent.member, requestId: consent.requestId, revision: consent.revision, expiresAt: consent.expiresAt });
    }
  }
  const expected = {}, textExpected = {}, peers = {}, baseline = group.baseline.commit;
  for (const [member, root] of Object.entries(group.worktrees)) {
    const tracked = new Set(trackedPaths(root));
    const previous = group.integrationState?.peers?.[member];
    peers[member] = consent || scope ? { ...previous } : snapshot(root);
    const changed = new Set([...names(git(root, ['diff', '--name-only', '-z', baseline, '--'])), ...names(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))]);
    if (previous) for (const name of Object.keys(previous)) changed.add(name);
    if (consent) { changed.clear(); if (member === consent.member) for (const name of Object.keys(consent.targets)) changed.add(name); }
    else if (scope) { changed.clear(); for (const name of Object.keys(selected[member] ?? {})) changed.add(name); }
    for (const name of changed) {
      if(Object.hasOwn(retained,name)&&!consent?.targets[name])continue;
      const wanted = fileHash(root, name);
      const deletion=scope?.deletions?.[member]?.[name];
      const capturedDeletion=deletion?.tracked===true&&/^[a-f0-9]{64}$/.test(deletion.before??'');
      if(wanted===null&&!tracked.has(name)&&!capturedDeletion&&!consent?.targets[name])throw integrationFailure('scope_source_missing',{file:name,member,kind:'untracked_source_disappeared'});
      if (!consent && scope && wanted !== selected[member][name]) throw integrationFailure('main_conflict', { file: name, kind: 'candidate_changed_after_diagnosis' });
      if (!consent && !scope && previous && (previous[name] ?? null) === wanted) continue;
      if (Object.hasOwn(expected, name) && expected[name] !== wanted) throw integrationFailure('member_conflict', { file: name, member, first: expected[name], wanted });
      let base = null;
      if (git(root, ['ls-tree', '-z', baseline, '--', name]).length) base = hash(git(root, ['show', `${baseline}:${name}`]));
      if (Object.hasOwn(group.integrationState?.main ?? {}, name)) base = group.integrationState.main[name];
      if (!consent && Object.hasOwn(scope?.bases?.[member] ?? {}, name)) base = scope.bases[member][name];
      const current = fileHash(group.repo, name);
      const text = textHash(root, name);
      const textEquivalent = Boolean(text && textHash(group.repo, name) === text);
      if (!consent?.targets[name] && current !== base && current !== wanted && !textEquivalent) throw integrationFailure('main_conflict', { file: name, base, current, wanted, textEquivalent, checkpointHasFile: Object.hasOwn(group.integrationState?.main ?? {}, name) });
      expected[name] = wanted;
      if (consent || scope) peers[member][name] = wanted;
      if (text) textExpected[name] = text;
    }
  }
  return { expected, textExpected, peers, before: snapshot(group.repo,Object.keys(retained)), index: hash(git(group.repo, ['diff', '--cached', '--binary'])) };
}
export function verifyIntegration(repo, check) {
  if (hash(git(repo, ['diff', '--cached', '--binary'])) !== check.index) throw Error('Integration changed staged content; preserve scene for review.');
  const after = snapshot(repo,[...Object.keys(check.before),...Object.keys(check.expected)]);
  for (const name of new Set([...Object.keys(check.before), ...Object.keys(after), ...Object.keys(check.expected)])) {
    const expected = Object.hasOwn(check.expected, name) ? check.expected[name] : check.before[name] ?? null;
    if ((after[name] ?? null) !== expected && !(Object.hasOwn(check.expected, name) && check.textExpected?.[name] && textHash(repo, name) === check.textExpected[name])) {
      const error=integrationFailure('verification_mismatch',{file:name,expected,current:after[name]??null,inScope:Object.hasOwn(check.expected,name)});
      error.message=`Integration verification failed: ${name}; preserve scene for review.`;throw error;
    }
  }
  return Object.fromEntries(Object.keys(check.expected).map(name => [name, after[name] ?? null]));
}
