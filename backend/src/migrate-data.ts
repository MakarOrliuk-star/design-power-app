import { PrismaClient } from '@prisma/client';

async function migrateUsers() {
  const testDb = new PrismaClient(); 
  
  const prodDb = new PrismaClient({
    datasources: { db: { url: process.env.PROD_DATABASE_URL } },
  });

  try {
    console.log("Получаем пользователей из Production...");
    const prodUsers = await prodDb.user.findMany();

    console.log(`found ${prodUsers.length} users. migrating to test env...`);
    
    for (const user of prodUsers) {
      await testDb.user.upsert({
        where: { email: user.email },
        update: {}, 
        create: user, 
      });
    }
    console.log("Done!");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prodDb.$disconnect();
    await testDb.$disconnect();
  }
}


migrateUsers();
