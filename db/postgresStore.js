// db/postgresStore.js
// Postgres implementation of the exact same interface as db/jsonStore.js.
// Only loaded when process.env.DATABASE_URL is set (see db/store.js) —
// requires the `pg` package, which is NOT a default dependency of this
// project (see package.json / README). Install it yourself first:
//
//   npm install pg
//
// IMPORTANT: this module could not be exercised against a live Postgres
// database in the environment this was written in (no network access,
// no Postgres server available there). It's written carefully against
// db/schema.sql and follows the same parameterized-query conventions
// throughout, but you should run it against a real database and re-run
// the test flow in README.md before trusting it in production.

let pg;
try {
  pg = require('pg');
} catch (e) {
  throw new Error(
    "DATABASE_URL is set but the 'pg' package isn't installed. Run `npm install pg` first."
  );
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function rowToResource(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    courseCode: row.course_code,
    courseName: row.course_name,
    faculty: row.faculty,
    department: row.department,
    level: row.level,
    description: row.description,
    accessType: row.access_type,
    priceKobo: row.price_kobo,
    status: row.status,
    storageProvider: row.storage_provider,
    storageKey: row.storage_key,
    fileHash: row.file_hash,
    originalFilename: row.original_filename,
    fileSizeBytes: row.file_size_bytes,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function rowToPurchase(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    resourceId: row.resource_id,
    status: row.status,
    provider: row.provider,
    providerReference: row.provider_reference,
    amountKobo: row.amount_kobo,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at
  };
}

module.exports = {
  kind: 'postgres',

  async listResources({ q, faculty, department, level, includeArchived } = {}) {
    const clauses = [];
    const values = [];
    if (!includeArchived) clauses.push(`status != 'archived'`);
    if (q) { values.push(`%${q.toLowerCase()}%`); clauses.push(`(LOWER(title) LIKE $${values.length} OR LOWER(course_code) LIKE $${values.length})`); }
    if (faculty) { values.push(faculty); clauses.push(`faculty = $${values.length}`); }
    if (department) { values.push(department); clauses.push(`department = $${values.length}`); }
    if (level) { values.push(Number(level)); clauses.push(`level = $${values.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM resources ${where} ORDER BY created_at DESC`, values);
    return rows.map(rowToResource);
  },

  async getResource(id) {
    const { rows } = await pool.query('SELECT * FROM resources WHERE id = $1', [id]);
    return rowToResource(rows[0]);
  },

  async findResourceByHash(fileHash) {
    if (!fileHash) return null;
    const { rows } = await pool.query(`SELECT * FROM resources WHERE file_hash = $1 AND status != 'archived'`, [fileHash]);
    return rowToResource(rows[0]);
  },

  async createResource(data) {
    const priceKobo = data.accessType === 'free' ? 0 : data.priceKobo;
    const { rows } = await pool.query(
      `INSERT INTO resources
        (title, course_code, course_name, faculty, department, level, description,
         access_type, price_kobo, storage_provider, storage_key, file_hash, original_filename,
         file_size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [data.title, data.courseCode, data.courseName || null, data.faculty, data.department,
        data.level || null, data.description || '', data.accessType, priceKobo,
        data.storageProvider, data.storageKey, data.fileHash || null, data.originalFilename || null,
        data.fileSizeBytes || null, data.uploadedBy]
    );
    return rowToResource(rows[0]);
  },

  async updateResource(id, patch) {
    const fieldMap = {
      title: 'title', courseCode: 'course_code', courseName: 'course_name',
      faculty: 'faculty', department: 'department', level: 'level',
      description: 'description', accessType: 'access_type', priceKobo: 'price_kobo',
      status: 'status'
    };
    const sets = [];
    const values = [];
    Object.entries(fieldMap).forEach(([jsKey, col]) => {
      if (patch[jsKey] !== undefined) { values.push(patch[jsKey]); sets.push(`${col} = $${values.length}`); }
    });
    if (patch.accessType === 'free') { values.push(0); sets.push(`price_kobo = $${values.length}`); }
    if (!sets.length) return this.getResource(id);
    values.push(id);
    sets.push('updated_at = now()');
    const { rows } = await pool.query(
      `UPDATE resources SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    return rowToResource(rows[0]);
  },

  async replaceResourceFile(id, { storageProvider, storageKey, originalFilename, fileSizeBytes, fileHash }) {
    const existing = await this.getResource(id);
    if (!existing) return null;
    const { rows } = await pool.query(
      `UPDATE resources SET storage_provider=$1, storage_key=$2, original_filename=$3,
        file_size_bytes=$4, file_hash=$5, updated_at=now() WHERE id=$6 RETURNING *`,
      [storageProvider, storageKey, originalFilename, fileSizeBytes, fileHash || null, id]
    );
    return { resource: rowToResource(rows[0]), oldStorageKey: existing.storageKey, oldStorageProvider: existing.storageProvider };
  },

  async deleteResource(id) {
    const { rowCount } = await pool.query('DELETE FROM resources WHERE id = $1', [id]);
    return rowCount > 0;
  },

  async countPurchasesForResource(resourceId) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM purchases WHERE resource_id = $1', [resourceId]);
    return rows[0].count;
  },

  async findPurchase(userId, resourceId) {
    const { rows } = await pool.query(
      'SELECT * FROM purchases WHERE user_id = $1 AND resource_id = $2', [userId, resourceId]
    );
    return rowToPurchase(rows[0]);
  },

  async findPurchaseByProviderReference(providerReference) {
    if (!providerReference) return null;
    const { rows } = await pool.query('SELECT * FROM purchases WHERE provider_reference = $1', [providerReference]);
    return rowToPurchase(rows[0]);
  },

  // Atomic via Postgres's own unique constraint (uq_purchase_user_resource
  // in schema.sql) + ON CONFLICT — this is real DB-level concurrency
  // safety, not just "no await in between" like the JSON store has to rely
  // on. Two simultaneous requests can both attempt the INSERT; the database
  // itself guarantees only one row ever exists for a given (user, resource)
  // pair, and the loser of the race gets nothing back from the INSERT, so
  // we SELECT the winning row instead.
  async findOrCreatePurchase(data) {
    const { rows } = await pool.query(
      `INSERT INTO purchases (user_id, resource_id, status, provider, provider_reference, amount_kobo, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, resource_id) DO NOTHING
       RETURNING *`,
      [data.userId, data.resourceId, data.status || 'pending', data.provider || null,
        data.providerReference || null, data.amountKobo || 0,
        data.status === 'success' ? new Date().toISOString() : null]
    );
    if (rows[0]) return { purchase: rowToPurchase(rows[0]), created: true };
    const existing = await this.findPurchase(data.userId, data.resourceId);
    return { purchase: existing, created: false };
  },

  async updatePurchaseStatus(id, status, extra = {}) {
    const { rows } = await pool.query(
      `UPDATE purchases SET status = $1,
        provider_reference = COALESCE($2, provider_reference),
        confirmed_at = CASE WHEN $1 = 'success' THEN now() ELSE confirmed_at END
       WHERE id = $3 RETURNING *`,
      [status, extra.providerReference || null, id]
    );
    return rowToPurchase(rows[0]);
  },

  async listPurchasesForUser(userId) {
    const { rows } = await pool.query('SELECT * FROM purchases WHERE user_id = $1', [userId]);
    return rows.map(rowToPurchase);
  },

  async listAllPurchases() {
    const { rows } = await pool.query('SELECT * FROM purchases ORDER BY created_at DESC');
    return rows.map(rowToPurchase);
  }
};
