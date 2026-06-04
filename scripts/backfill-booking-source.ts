/**
 * Backfill script to set booking source for existing jobs
 * 
 * Determines source based on Square integration:
 * - If bookingId or squareOrderId exists → source = 'website'
 * - Otherwise → source = 'manual'
 * 
 * Usage:
 *   $env:APP_ENV='prod'; npx ts-node scripts/backfill-booking-source.ts [--dry-run]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  ScanCommand, 
  UpdateCommand 
} from '@aws-sdk/lib-dynamodb';
import { getConfig } from '@/lib/config';

const dryRun = process.argv.includes('--dry-run');

async function backfillBookingSource() {
  try {
    const config = getConfig();
    const jobsTableName = config.aws.dynamodb.jobsTable;

    // Create DynamoDB client
    const client = new DynamoDBClient({
      region: config.aws.region,
    });
    
    const dynamoClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
    });

    console.log('============================================================');
    console.log('Backfill Booking Source');
    console.log('============================================================');
    console.log(`Dry Run: ${dryRun}`);
    console.log(`Environment: ${config.env}`);
    console.log(`Region: ${config.aws.region}`);
    console.log(`Jobs Table: ${jobsTableName}`);
    console.log();

    // Step 1: Scan all jobs
    console.log('Step 1: Scanning all jobs from DynamoDB...');
    const scanCommand = new ScanCommand({
      TableName: jobsTableName,
      ProjectionExpression: 'jobId,source,bookingId,squareOrderId,createdBy',
    });

    const scanResult = await dynamoClient.send(scanCommand);
    const allJobs = scanResult.Items || [];

    console.log(`Found ${allJobs.length} total jobs`);
    console.log();

    // Step 2: Analyze jobs
    const jobsWithSource = allJobs.filter((job: any) => job.source);
    const jobsWithoutSource = allJobs.filter((job: any) => !job.source);

    console.log('Step 2: Analyzing jobs...');
    console.log(`Jobs with source: ${jobsWithSource.length}`);
    console.log(`Jobs without source: ${jobsWithoutSource.length}`);
    console.log();

    // Step 3: Categorize jobs to update
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

    console.log('Step 3: Categorizing jobs to update...');
    console.log(`Total jobs to update: ${toUpdate.length}`);

    const websiteJobs = toUpdate.filter((j) => j.source === 'website');
    const manualJobs = toUpdate.filter((j) => j.source === 'manual');

    console.log(`  - Website bookings: ${websiteJobs.length}`);
    console.log(`  - Manual bookings: ${manualJobs.length}`);
    console.log();

    if (dryRun) {
      console.log('DRY RUN - Showing first 10 jobs that would be updated:');
      toUpdate.slice(0, 10).forEach((job) => {
        console.log(`  ${job.jobId} → source = ${job.source} (${job.reason})`);
      });
      console.log();
      console.log(`✓ Dry run complete. ${toUpdate.length} jobs would be updated.`);
      return;
    }

    // Step 4: Update jobs
    console.log('Step 4: Updating jobs in DynamoDB...');
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < toUpdate.length; i++) {
      const { jobId, source } = toUpdate[i];

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
        updated++;

        if ((i + 1) % 50 === 0) {
          console.log(`  Updated ${i + 1}/${toUpdate.length} jobs...`);
        }
      } catch (err) {
        failed++;
        console.error(`  Failed to update ${jobId}:`, (err as Error).message);
      }
    }

    console.log(`Updated: ${updated}/${toUpdate.length} jobs`);
    console.log(`Failed: ${failed}/${toUpdate.length} jobs`);
    console.log();

    // Summary
    console.log('Step 5: Verification');
    console.log(`Jobs with booking source after migration: ${jobsWithSource.length + updated}`);
    console.log(`Original jobs without source: ${jobsWithoutSource.length}`);
    console.log();

    if (failed === 0) {
      console.log('✓ Migration successful!');
    } else {
      console.log(`⚠ Migration completed with ${failed} failures`);
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

backfillBookingSource();
