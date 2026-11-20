import { HttpError } from './errors.js';

/** Load a reconciliation and enforce branch scoping. Employees only see their own branch. */
export function loadReconciliation(db, id, user, { write = false } = {}) {
  const rec = db.prepare('SELECT * FROM reconciliations WHERE id = ?').get(id);
  if (!rec) throw new HttpError(404, 'NOT_FOUND', 'Reconciliation not found.');
  if (user.role === 'employee' && rec.branch_id !== user.branchId) {
    // Do not reveal that another branch's reconciliation exists.
    throw new HttpError(404, 'NOT_FOUND', 'Reconciliation not found.');
  }
  if (write && rec.status !== 'open') {
    throw new HttpError(409, 'RECONCILIATION_CLOSED', 'This reconciliation has already been submitted.');
  }
  return rec;
}
