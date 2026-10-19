import pg from 'pg'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

dotenv.config();


const { Pool } = pg;

export const db = new Pool({
    connectionString: process.env.DATABASE_URL
});

export async function runMigrations(): Promise<void> {
    const client = await db.connect();
    try {
        await client.query(`
        CREATE TABLE IF NOT EXISTS _schema_migrations(
            id SERIAL PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            executed_at TIMESTAMPTZ DEFAULT NOW()
            );
            `);
        
        const migrationsDir = path.join(process.cwd(), 'migrations');
        if (!fs.existsSync(migrationsDir)) {
            fs.mkdirSync(migrationsDir);
        }
        const files = fs.readdirSync(migrationsDir).sort();

        for (const file of files) {
            if (file.endsWith('.sql')) {
                const checkRes = await client.query(
                    'SELECT 1 FROM _schema_migrations WHERE filename = \$1', [file]
                );
                if (checkRes.rowCount === 0) {
                    console.log(`Running migration: ${file}...`);
                    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
                    try {
                         await client.query('BEGIN');
                         await client.query(sql);
                         await client.query(
                        'INSERT INTO _schema_migrations (filename) VALUES (\$1)', [file]
                    );
                        await client.query('COMMIT');
                        console.log(`Successfully applied: ${file}`);

                    } catch (fileError) {
                        await client.query('ROLLBACK')
                        throw fileError;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        client.release();
    }
}