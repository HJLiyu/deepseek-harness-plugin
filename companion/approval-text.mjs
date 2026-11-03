// Grants retain the exact transport grammar. A whole-line bold rejection may
// be copied from the native rich-text editor; it can only deny, never grant.
export function permissionText(text) {
  if (typeof text !== 'string') return '';
  const bold = /^\*\*([^\r\n]+)\*\*[ \t]*(?:\r\n|\n)?(?![\s\S])/.exec(text);
  return bold ? bold[1] : text;
}
export function looksLikeCommand(text) {
  if (typeof text !== 'string') return false;
  // Detection only: wrappers/entities must never turn into an authorized command.
  // Leave parseCommand and the original native proof text entirely unchanged.
  const head = text.replace(/^(?:\s|\*\*|__|`|&(?:amp;)?(?:#(?:x[0-9a-f]+|[0-9]+)|nbsp|ensp|emsp);)+/iu, '');
  return /^(?:批准|拒绝) \d{4}-\d{2}-\d{2}-[a-f0-9]{8} [a-f0-9-]{36}(?:$|[\s*_`&])/.test(head);
}
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const presented = permissionText(text);
  if (presented !== text) {
    if (!presented.startsWith('拒绝 ')) return null;
    text = presented;
  }
  const match = /^(批准|拒绝) (\d{4}-\d{2}-\d{2}-[a-f0-9]{8}) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*(?:\r\n|\n)?(?![\s\S])/.exec(text);
  return match ? { decision: match[1] === '批准' ? 'allow' : 'reject', groupId: match[2], permissionId: match[3] } : null;
}
export function sameCommand(left, right) {
  const a = parseCommand(left), b = parseCommand(right);
  return Boolean(a && b && a.decision === b.decision && a.groupId === b.groupId && a.permissionId === b.permissionId);
}
