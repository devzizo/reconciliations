/** Demo branches for local development (the Cloudflare deployment manages branches with scripts/create-branch.mjs). */
export async function seedDemoData(db) {
  if ((await db.get('SELECT COUNT(*) AS n FROM branches')).n > 0) return;
  await db.run("INSERT INTO branches (id, name, name_ar, norm_name) VALUES ('tabuk', 'Tabuk', 'تبوك', 'تبوك'), ('najran', 'Najran', 'نجران', 'نجران')");
}
