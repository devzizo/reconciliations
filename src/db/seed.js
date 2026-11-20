import { hashPassword } from '../auth.js';

/** Demo branches and accounts for local development. Never enabled on the Cloudflare deployment. */
export async function seedDemoData(db, config) {
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return;
  await db.run("INSERT INTO branches (id, name, name_ar) VALUES ('tabuk', 'Tabuk', 'تبوك'), ('najran', 'Najran', 'نجران')");
  const users = [
    ['u-emp-tabuk', 'tabuk.employee', 'Tabuk Employee', 'change-me-tabuk', 'employee', 'tabuk'],
    ['u-emp-najran', 'najran.employee', 'Najran Employee', 'change-me-najran', 'employee', 'najran'],
    ['u-manager', 'finance.manager', 'Finance Manager', 'change-me-manager', 'manager', null],
  ];
  for (const [id, username, name, pw, role, branch] of users) {
    await db.run('INSERT INTO users (id, username, display_name, password_hash, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)',
      id, username, name, await hashPassword(pw, config.passwordIterations), role, branch);
  }
}
