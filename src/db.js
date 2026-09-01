import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Opens (and migrates) the SQLite file. On Railway DB_PATH points inside the
 * mounted volume (/data), so the file survives redeploys; anywhere else on the
 * container filesystem it would be wiped on every deploy.
 */
export function openDb(dbPath) {
  const dir = path.dirname(path.resolve(dbPath));
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS food_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      source     TEXT NOT NULL,
      raw_input  TEXT,
      items_json TEXT NOT NULL,
      kcal       REAL NOT NULL,
      protein_g  REAL NOT NULL,
      carbs_g    REAL NOT NULL,
      fat_g      REAL NOT NULL,
      estimated  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_food_log_chat_ts ON food_log (chat_id, ts);
  `);

  return db;
}

export function createQueries(db) {
  const insert = db.prepare(`
    INSERT INTO food_log (chat_id, ts, source, raw_input, items_json, kcal, protein_g, carbs_g, fat_g, estimated)
    VALUES (@chat_id, @ts, @source, @raw_input, @items_json, @kcal, @protein_g, @carbs_g, @fat_g, @estimated)
  `);

  const sumRange = db.prepare(`
    SELECT
      COUNT(*)                      AS meals,
      COALESCE(SUM(kcal), 0)        AS kcal,
      COALESCE(SUM(protein_g), 0)   AS protein_g,
      COALESCE(SUM(carbs_g), 0)     AS carbs_g,
      COALESCE(SUM(fat_g), 0)       AS fat_g,
      COALESCE(SUM(estimated), 0)   AS estimated_count
    FROM food_log
    WHERE chat_id = ? AND ts >= ? AND ts < ?
  `);

  const latest = db.prepare(`
    SELECT * FROM food_log WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT 1
  `);

  const deleteById = db.prepare('DELETE FROM food_log WHERE id = ?');

  return {
    /** Persist one analysed meal. Returns the new row id. */
    addEntry({ chatId, ts, source, rawInput, result }) {
      const info = insert.run({
        chat_id: String(chatId),
        ts,
        source,
        raw_input: rawInput ?? null,
        items_json: JSON.stringify(result.items ?? []),
        kcal: result.kcal,
        protein_g: result.protein_g,
        carbs_g: result.carbs_g,
        fat_g: result.fat_g,
        estimated: result.estimated ? 1 : 0,
      });
      return Number(info.lastInsertRowid);
    },

    /** Totals over a UTC ts range. DB only — never costs an API call. */
    totalsForRange(chatId, start, end) {
      const row = sumRange.get(String(chatId), start, end);
      return {
        meals: row.meals,
        kcal: row.kcal,
        protein_g: row.protein_g,
        carbs_g: row.carbs_g,
        fat_g: row.fat_g,
        estimatedCount: row.estimated_count,
      };
    },

    /** Delete the most recent entry. Returns the deleted row, or null. */
    deleteLatest(chatId) {
      const row = latest.get(String(chatId));
      if (!row) return null;
      deleteById.run(row.id);
      return row;
    },
  };
}
