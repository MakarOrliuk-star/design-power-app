import pg from 'pg';

async function migrateUsers() {
  
  if (!process.env.PROD_DATABASE_URL || !process.env.DATABASE_URL) {
    console.log("Migration Script onmited (no url parameters).");
    return;
  }

  
  const prodPool = new pg.Pool({ connectionString: process.env.PROD_DATABASE_URL });
  const testPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log("Получаем пользователей из Production базы...");
    
    const { rows: prodUsers, fields } = await prodPool.query('SELECT * FROM "User"');

    if (prodUsers.length === 0) {
      console.log("Prod env has no accounts to migrate");
      return;
    }

    console.log(`Found ${prodUsers.length} users. Migrating to test env...`);

    
    const columns = fields.map(f => `"${f.name}"`).join(', ');

    for (const user of prodUsers) {
      const values = fields.map(f => user[f.name]);
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');

     
      await testPool.query(`
        INSERT INTO "User" (${columns})
        VALUES (${placeholders})
        ON CONFLICT (email) DO NOTHING
      `, values);
    }
    
    console.log("Migration complete successfully");
  } catch (err) {
    console.error("Direct SQL-migration error:", err);
  } finally {

    await prodPool.end();
    await testPool.end();
  }
}

// Starting
migrateUsers();