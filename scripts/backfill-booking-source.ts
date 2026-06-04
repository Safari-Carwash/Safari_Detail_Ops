/**
 * Backfill script to set booking source for existing jobs
 * 
 * Determines source based on Square integration:
 * - If bookingId or squareOrderId exists → source = 'website'
 * - Otherwise → source = 'manual'
 * 
 * REQUIREMENTS:
 * 1. AWS credentials configured (via IAM role, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or ~/.aws/credentials)
 * 2. IAM permissions: dynamodb:Scan, dynamodb:UpdateItem on jobs table
 * 3. Environment variable: APP_ENV (set to 'prod' or 'qa')
 * 
 * Usage:
 *   # Production run (interactive - will confirm before updating)
 *   $env:APP_ENV='prod'; npx ts-node scripts/backfill-booking-source.ts
 *   
 *   # Production dry run (shows what would be updated)
 *   $env:APP_ENV='prod'; npx ts-node scripts/backfill-booking-source.ts --dry-run
 *   
 *   # Production auto-confirm (no prompts)
 *   $env:APP_ENV='prod'; npx ts-node scripts/backfill-booking-source.ts --confirm
 * 
 * DEBUGGING:
 *   # Verbose logging
 *   $env:LOG_LEVEL='debug'; $env:APP_ENV='prod'; npx ts-node scripts/backfill-booking-source.ts --dry-run
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  ScanCommand, 
  UpdateCommand 
} from '@aws-sdk/lib-dynamodb';
import { getConfig } from '@/lib/config';

const dryRun = process.argv.includes('--dry-run');
const autoConfirm = process.argv.includes('--confirm');

// Retry configuration for DynamoDB throttling
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 100;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateJobWithRetry(
  dynamoClient: DynamoDBDocumentClient,
  jobsTableName: string,
  jobId: string,
  source: 'website' | 'manual',
  retryCount = 0
): Promise<void> {
  try {
    const updateCommand = new UpdateCommand({
      TableName: jobsTableName,
      Key: { jobId },
      UpdateExpression: 'SET #source = :source',
      ExpressionAttributeNames: {
        '#source': 'source',
      },
      ExpressionAttributeValues: {
        ':source': source,
      },
    });

    await dynamoClient.send(updateCommand);
  } catch (err: any) {
    // Handle throttling with exponential backoff
    if (err.name === 'ProvisionedThroughputExceededException' || 
        err.code === 'ProvisionedThroughputExceededException' ||
        err.statusCode === 400 && err.message?.includes('ProvisionedThroughput')) {
      if (retryCount < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);
        console.warn(`    [Throttled] Job ${jobId} - retry ${retryCount + 1}/${MAX_RETRIES} after ${delayMs}ms`);
        await sleep(delayMs);
        return updateJobWithRetry(dynamoClient, jobsTableName, jobId, source, retryCount + 1);
      }
    }
    throw err;
  }
}

async function backfillBookingSource() {
  try {
    // Step 0: Validate environment
    console.log('============================================================');
    console.log('Backfill Booking Source for Jobs');
    console.log('============================================================');
    console.log();
    
    console.log('Step 0: Validating environment and configuration...');
    const appEnv = process.env.APP_ENV?.toLowerCase();
    console.log(`  APP_ENV: ${appEnv || '[NOT SET - defaulting to qa]'}`);
    console.log(`  AWS_REGION: ${process.env.AWS_REGION || '[NOT SET - defaulting to us-east-1]'}`);
    console.log(`  AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? '[SET]' : '[NOT SET]'}`);
    console.log(`  AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? '[SET]' : '[NOT SET]'}`);
    console.log();

    const config = getConfig();
    const jobsTableName = config.aws.dynamodb.jobsTable;

    console.log(`Step 1: Configuration loaded`);
    console.log(`  Environment: ${config.env}`);
    console.log(`  Region: ${config.aws.region}`);
    console.log(`  Jobs Table: ${jobsTableName}`);
    console.log(`  Dry Run: ${dryRun}`);
    console.log(`  Auto-confirm: ${autoConfirm}`);
    console.log();

    // Step 2: Create DynamoDB client
    console.log('Step 2: Creating DynamoDB client...');
    try {
      const client = new DynamoDBClient({
        region: config.aws.region,
      });
      
      var dynamoClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
          removeUndefinedValues: true,
          convertEmptyValues: false,
        },
      });
      console.log('  ✓ DynamoDB client created successfully');
    } catch (err: any) {
      console.error('  ✗ Failed to create DynamoDB client:', err.message);
      throw err;
    }
    console.log();

    // Step 3: Scan all jobs
    console.log('Step 3: Scanning all jobs from DynamoDB...');
    let scanResult;
    try {
      const scanCommand = new ScanCommand({
        TableName: jobsTableName,
        ProjectionExpression: 'jobId,source,bookingId,squareOrderId,createdBy',
      });

      scanResult = await dynamoClient.send(scanCommand);
      const allJobs = scanResult.Items || [];
      console.log(`  ✓ Found ${allJobs.length} total jobs`);
    } catch (err: any) {
      console.error('  ✗ Scan failed:', err.message);
      console.error('     Code:', err.code);
      console.error('     Status Code:', err.statusCode);
      if (err.message?.includes('ValidationException')) {
        console.error('     → Table may not exist. Check: APP_ENV and DYNAMODB_JOBS_TABLE');
      }
      if (err.message?.includes('AccessDenied') || err.message?.includes('UnauthorizedOperation')) {
        console.error('     → AWS credentials may not have permissions. Check IAM policy.');
      }
      throw err;
    }
    console.log();

    const allJobs = scanResult.Items || [];

    // Step 4: Analyze jobs
    const jobsWithSource = allJobs.filter((job: any) => job.source);
    const jobsWithoutSource = allJobs.filter((job: any) => !job.source);

    console.log('Step 4: Analyzing jobs...');
    console.log(`  Jobs with source: ${jobsWithSource.length}`);
    console.log(`  Jobs without source: ${jobsWithoutSource.length}`);
    console.log();

    // Step 5: Categorize jobs to update
    const toUpdate: Array<{
      jobId: string;
      source: 'website' | 'manual';
      reason: string;
    }> = [];

    for (const job of jobsWithoutSource) {
      const source = (job.bookingId || job.squareOrderId) ? 'website' : 'manual';
      toUpdate.push({
        jobId: job.jobId,
        source,
        reason: source === 'website' 
          ? `Has ${job.bookingId ? 'bookingId' : 'squareOrderId'}`
          : 'No Square linkage (manual entry)',
      });
    }

    console.log('Step 5: Categorizing jobs to update...');
    console.log(`  Total jobs to update: ${toUpdate.length}`);

    const websiteJobs = toUpdate.filter((j) => j.source === 'website');
    const manualJobs = toUpdate.filter((j) => j.source === 'manual');

    console.log(`    - Website bookings: ${websiteJobs.length}`);
    console.log(`    - Manual bookings: ${manualJobs.length}`);
    console.log();

    if (dryRun) {
      console.log('DRY RUN MODE - Preview of jobs that would be updated:');
      console.log();
      toUpdate.slice(0, 10).forEach((job) => {
        console.log(`  ${job.jobId} → source = ${job.source} (${job.reason})`);
      });
      if (toUpdate.length > 10) {
        console.log(`  ... and ${toUpdate.length - 10} more jobs`);
      }
      console.log();
      console.log(`✓ Dry run complete. ${toUpdate.length} jobs would be updated.`);
      return;
    }

    // Step 6: Confirm before updating (unless --confirm flag)
    if (!autoConfirm) {
      console.log('⚠️  PRODUCTION UPDATE CONFIRMATION');
      console.log(`  Environment: ${config.env.toUpperCase()}`);
      console.log(`  Table: ${jobsTableName}`);
      console.log(`  Jobs to update: ${toUpdate.length}`);
      console.log();
      console.log('  Type "yes" to proceed with update:');
      
      // For now in non-interactive mode, require explicit confirmation
      if (process.stdin.isTTY === false) {
        console.error('  ✗ Non-interactive mode detected.');
        console.error('     Use --confirm flag to skip confirmation: npx ts-node scripts/backfill-booking-source.ts --confirm');
        process.exit(1);
      }
    } else {
      console.log('Auto-confirm mode enabled - proceeding with update...');
      console.log();
    }

    // Step 7: Update jobs
    console.log('Step 6: Updating jobs in DynamoDB...');
    let updated = 0;
    let failed = 0;
    const errors: Array<{ jobId: string; error: string }> = [];

    for (let i = 0; i < toUpdate.length; i++) {
      const { jobId, source } = toUpdate[i];

      try {
        await updateJobWithRetry(dynamoClient, jobsTableName, jobId, source);
        updated++;

        if ((i + 1) % 50 === 0) {
          console.log(`  Updated ${i + 1}/${toUpdate.length} jobs...`);
        }
      } catch (err: any) {
        failed++;
        const errorMsg = err.message || String(err);
        errors.push({ jobId, error: errorMsg });
        console.error(`  ✗ Failed to update ${jobId}: ${errorMsg}`);
      }
    }

    console.log();
    console.log('Step 7: Update Summary');
    console.log(`  Updated: ${updated}/${toUpdate.length} jobs`);
    console.log(`  Failed: ${failed}/${toUpdate.length} jobs`);
    console.log();

    if (errors.length > 0 && errors.length <= 5) {
      console.log('Failed jobs details:');
      errors.forEach(({ jobId, error }) => {
        console.log(`  ${jobId}: ${error}`);
      });
      console.log();
    }

    // Final status
    console.log('============================================================');
    if (failed === 0) {
      console.log('✓ Migration successful!');
      console.log(`  All ${updated} jobs now have booking source set`);
    } else if (updated > 0) {
      console.log(`⚠ Migration completed with ${failed} failures`);
      console.log(`  ${updated} jobs updated successfully`);
      console.log(`  ${failed} jobs failed - retry may be needed`);
    } else {
      console.log('✗ Migration failed - no jobs were updated');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('============================================================');
    console.error('✗ FATAL ERROR:', err.message);
    console.error('============================================================');
    console.error();
    console.error('TROUBLESHOOTING:');
    console.error('1. Verify AWS credentials are configured');
    console.error('   - Check: $env:AWS_ACCESS_KEY_ID and $env:AWS_SECRET_ACCESS_KEY');
    console.error('   - Or: ~/.aws/credentials with default profile');
    console.error('2. Verify IAM permissions for DynamoDB Scan and UpdateItem');
    console.error('3. Verify table exists: ' + (process.env.DYNAMODB_JOBS_TABLE || 'jobs'));
    console.error('4. Verify APP_ENV is set correctly (qa or prod)');
    if (err.stack) {
      console.error();
      console.error('Stack trace:');
      console.error(err.stack);
    }
    process.exit(1);
  }
}

backfillBookingSource();
