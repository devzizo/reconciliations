import { HttpError } from './errors.js';

/** Load a reconciliation and enforce branch scoping. Employees only see their own branch. */
export async function loadReconciliation(db, id, user, { write = false } = {}) {
  const rec = await db.get('SELECT * FROM reconciliations WHERE id = ?', id);
  // Do not reveal that another branch's reconciliation exists.
  if (!rec || (user.role === 'employee' && rec.branch_id !== user.branchId)) throw new HttpError(404, 'NOT_FOUND', 'التسوية غير موجودة.');
  if (write && rec.status !== 'open') throw new HttpError(409, 'RECONCILIATION_CLOSED', 'تم إرسال تسوية هذا اليوم مسبقًا ولا يمكن تعديلها.');
  return rec;
}
