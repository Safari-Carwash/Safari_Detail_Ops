/**
 * Script to create production manager users
 * 
 * Usage:
 *   APP_ENV=prod npx tsx scripts/create-prod-managers.ts
 * 
 * This script creates 8 manager users in the production environment.
 */

import { createUser, getUserByEmail } from '../lib/services/user-service';
import { hashPassword } from '../lib/auth/password';
import { UserRole } from '../lib/types';

const PRODUCTION_MANAGERS = [
  {
    email: 'safariwashes@gmail.com',
    name: 'Safari Washes',
    password: 'detailops',
  },
  {
    email: 'naga@thesafaricarwash.com',
    name: 'Naga',
    password: 'detailops',
  },
  {
    email: 'chenna@thesafaricarwash.com',
    name: 'Chenna',
    password: 'detailops',
  },
  {
    email: 'toni@thesafaricarwash.com',
    name: 'Toni',
    password: 'detailops',
  },
  {
    email: 'aaron@thesafaricarwash.com',
    name: 'Aaron',
    password: 'detailops',
  },
  {
    email: 'brandon@thesafaricarwash.com',
    name: 'Brandon',
    password: 'detailops',
  },
  {
    email: 'jesus@thesafaricarwash.com',
    name: 'Jesus',
    password: 'detailops',
  },
  {
    email: 'chewy@thesafaricarwash.com',
    name: 'Chewy',
    password: 'detailops',
  },
];

async function main() {
  console.log('\n🚀 Safari Detail Ops - Production Manager Setup\n');

  // Verify we're in production mode
  const env = process.env.APP_ENV?.toLowerCase();
  if (env !== 'prod') {
    console.error('❌ ERROR: This script must be run with APP_ENV=prod');
    console.error(`   Current APP_ENV: ${env || 'not set'}`);
    console.error('\nUsage:');
    console.error('   APP_ENV=prod npx tsx scripts/create-prod-managers.ts\n');
    process.exit(1);
  }

  console.log('✓ Environment: PRODUCTION');
  console.log(`✓ Creating ${PRODUCTION_MANAGERS.length} manager accounts\n`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const manager of PRODUCTION_MANAGERS) {
    try {
      console.log(`Processing: ${manager.email}`);

      // Check if user already exists
      const existingUser = await getUserByEmail(manager.email);
      if (existingUser) {
        console.log(`  ⊘ User already exists - skipping`);
        skipCount++;
        continue;
      }

      // Hash password
      const passwordHash = await hashPassword(manager.password);

      // Create user in DynamoDB
      const user = await createUser({
        email: manager.email,
        name: manager.name,
        role: UserRole.MANAGER,
        passwordHash,
      });

      console.log(`  ✅ Created successfully (User ID: ${user.userId})`);
      successCount++;

    } catch (error) {
      console.error(`  ❌ Failed to create user`);
      if (error instanceof Error) {
        console.error(`     ${error.message}`);
      }
      errorCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Summary:');
  console.log(`  ✅ Created:  ${successCount}`);
  console.log(`  ⊘ Skipped:   ${skipCount} (already exist)`);
  console.log(`  ❌ Failed:   ${errorCount}`);
  console.log('='.repeat(60) + '\n');

  if (successCount > 0) {
    console.log('Manager accounts created successfully!');
    console.log('Login URL: https://ops.thesafaricarwash.com/login');
    console.log('Default password: detailops\n');
  }

  if (errorCount > 0) {
    process.exit(1);
  }
}

main();
