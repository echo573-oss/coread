import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const HUMAN = Object.freeze({ role: 'human', scopes: ['owner'] });
export const AI = Object.freeze({ role: 'ai', scopes: ['reading:read', 'reading:write'] });
export const actor = () => context.getStore() || AI;
export const runAs = (identity, work) => context.run(identity, work);
export const isHuman = () => actor().role === 'human';
export function requireHuman() {
  if (!isHuman()) throw Object.assign(new Error('Owner session required'), { status: 403 });
}
