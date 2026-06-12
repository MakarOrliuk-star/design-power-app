import pg from 'pg';

async function migrateUsers() {
  
  if (!process.env.PROD_DATABASE_URL || !process.env.DATABASE_URL) {
    console.log("Скрипт миграции: Пропущено (не заданы переменные URL).");
    return;
  }

  
  const prodPool = new pg.Pool({ connectionString: process.env.PROD_DATABASE_URL });
  const testPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log("Получаем пользователей из Production базы...");
    
    const { rows: prodUsers, fields } = await prodPool.query('SELECT * FROM "User"');

    if (prodUsers.length === 0) {
      console.log("На продакшене не найдено пользователей для переноса.");
      return;
    }

    console.log(`Найдено ${prodUsers.length} пользователей. Переносим в Test...`);

    
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
    
    console.log("🚀 Миграция данных успешно завершена!");
  } catch (err) {
    console.error("❌ Ошибка при прямой SQL-миграции:", err);
  } finally {
    // Обязательно закрываем соединения, иначе процесс зависнет
    await prodPool.end();
    await testPool.end();
  }
}

// Запускаем процесс
migrateUsers();