/**
 * Backfill Job Numbers Migration Script
 * 
 * Assigns unique job numbers (10001, 10002, etc.) to all existing jobs
 * sorted by createdAt ascending. Makes the counter idempotent - skips
 * jobs that already have a jobNumber assigned.
 * 
 * Usage: npx ts-node scripts/backfill-job-numbers.ts [--dry-run]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  ScanCommand, 
  UpdateCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface Job {
  jobId: string;
  jobNumber?: number;
  createdAt: string;
  [key: string]: any;
}

interface Counter {
  jobId: string;
  counter: number;
  createdAt: string;
  updatedAt: string;
}

const JOB_NUMBER_START = 10001;
const COUNTER_INITIAL = 10000;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('Job Number Backfill Migration');
  console.log(`${'='.repeat(60)}`);
  console.log(`Dry Run: ${dryRun}`);
  console.log(`Start Job Number: ${JOB_NUMBER_START}`);
  
  // Validate environment
  const env = process.env.APP_ENV || 'qa';
  const region = process.env.AWS_REGION || 'us-east-1';
  const jobsTable = `safari-detail-ops-${env}-jobs`;
  
  console.log(`\nEnvironment: ${env}`);
  console.log(`Region: ${region}`);
  console.log(`Jobs Table: ${jobsTable}\n`);
  
  // Create DynamoDB client
  const dynamoClient = new DynamoDBClient({ region });
  const docClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
  });
  
  try {
    // Step 1: Get all jobs sorted by createdAt
    console.log('Step 1: Fetching all jobs from DynamoDB...');
    const result = await docClient.send(new ScanCommand({
      TableName: jobsTable,
      // Filter out the counter document
      FilterExpression: 'attribute_not_exists(#counter) OR attribute_not_exists(#id) OR #id <> :counterId',
      ExpressionAttributeNames: {
        '#counter': 'counter',
        '#id': 'jobId',
      },
      ExpressionAttributeValues: {
        ':counterId': 'detailOpsJobNumberCounter',
      },
    }));
    
    let jobs = (result.Items as Job[]) || [];
    
    // Filter out the counter document more aggressively
    jobs = jobs.filter(job => job.jobId !== 'detailOpsJobNumberCounter' && !job.counter);
    
    // Sort by createdAt ascending
    jobs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    
    console.log(`Found ${jobs.length} jobs to process\n`);
    
    // Step 2: Count jobs that already have jobNumbers
    const jobsWithNumbers = jobs.filter(j => j.jobNumber !== undefined).length;
    const jobsWithoutNumbers = jobs.filter(j => j.jobNumber === undefined).length;
    
    console.log(`Jobs with job numbers: ${jobsWithNumbers}`);
    console.log(`Jobs without job numbers: ${jobsWithoutNumbers}\n`);
    
    if (jobsWithoutNumbers === 0) {
      console.log('✓ All jobs already have job numbers assigned!');
      console.log('Migration complete (no changes needed).\n');
      return;
    }
    
    // Step 3: Assign job numbers to jobs that don't have them
    console.log('Step 2: Assigning job numbers...');
    let nextJobNumber = JOB_NUMBER_START;
    const updates: Array<{ job: Job; newJobNumber: number }> = [];
    
    for (const job of jobs) {
      if (job.jobNumber === undefined) {
        updates.push({ job, newJobNumber: nextJobNumber });
        nextJobNumber++;
      } else {
        // Use existing job number to update counter tracking
        nextJobNumber = Math.max(nextJobNumber, (job.jobNumber || 0) + 1);
      }
    }
    
    console.log(`Will assign ${updates.length} job numbers (${JOB_NUMBER_START} to ${nextJobNumber - 1})\n`);
    
    if (dryRun) {
      console.log('DRY RUN - Showing first 10 jobs that would be updated:');
      updates.slice(0, 10).forEach(({ job, newJobNumber }) => {
        console.log(`  ${job.jobId} (${new Date(job.createdAt).toISOString()}) → Job #${String(newJobNumber).padStart(5, '0')}`);
      });
      if (updates.length > 10) {
        console.log(`  ... and ${updates.length - 10} more`);
      }
      console.log(`\nFinal counter value would be set to: ${nextJobNumber - 1}\n`);
      console.log('✓ Dry run complete. No changes made.\n');
      return;
    }
    
    // Step 4: Update jobs with new job numbers
    console.log('Step 3: Updating jobs in DynamoDB...');
    let updated = 0;
    let failed = 0;
    
    for (const { job, newJobNumber } of updates) {
      try {
        const now = new Date().toISOString();
        await docClient.send(new UpdateCommand({
          TableName: jobsTable,
          Key: { jobId: job.jobId },
          UpdateExpression: 'SET jobNumber = :jobNumber, updatedAt = :now',
          ExpressionAttributeValues: {
            ':jobNumber': newJobNumber,
            ':now': now,
          },
        }));
        updated++;
        
        if (updated % 10 === 0) {
          console.log(`  Updated ${updated}/${updates.length} jobs...`);
        }
      } catch (error: any) {
        failed++;
        console.error(`  ERROR updating job ${job.jobId}:`, error.message);
      }
    }
    
    console.log(`Updated: ${updated}/${updates.length} jobs`);
    if (failed > 0) {
      console.log(`Failed: ${failed} jobs\n`);
    } else {
      console.log('');
    }
    
    // Step 5: Update counter
    console.log('Step 4: Updating counter...');
    const counterValue = nextJobNumber - 1;
    
    try {
      const now = new Date().toISOString();
      await docClient.send(new PutCommand({
        TableName: jobsTable,
        Item: {
          jobId: 'detailOpsJobNumberCounter',
          counter: counterValue,
          createdAt: now,
          updatedAt: now,
        },
      }));
      console.log(`Counter set to: ${counterValue}\n`);
    } catch (error: any) {
      console.error('ERROR updating counter:', error.message);
      console.error('You may need to manually set the counter!\n');
    }
    
    // Step 6: Verify
    console.log('Step 5: Verifying migration...');
    const verifyResult = await docClient.send(new ScanCommand({
      TableName: jobsTable,
      FilterExpression: 'attribute_exists(jobNumber)',
    }));
    
    const jobsWithNumbersAfter = verifyResult.Items?.filter(item => item.jobId !== 'detailOpsJobNumberCounter').length || 0;
    
    console.log(`Jobs with job numbers after migration: ${jobsWithNumbersAfter}`);
    console.log(`Original jobs: ${jobs.length}`);
    
    if (jobsWithNumbersAfter >= jobs.length - jobsWithNumbers) {
      console.log('\n✓ Migration successful!\n');
    } else {
      console.log('\n⚠ Migration may have incomplete results. Check the logs above.\n');
    }
    
  } catch (error: any) {
    console.error('\n✗ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
