const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const PHONE_BOOKING_JOBS = [
  'vmeegfzzynp6qj',
  'b5qa1kaglqso7f',
  'h8ijfrv2hezya7',  // The one from your screenshot
  'h71lp2c8ew3xlj',
  'p19crj35z9cwwg',
];

async function fixPhoneBookingSource() {
  const client = new DynamoDBClient({ region: 'us-east-1' });
  const docClient = DynamoDBDocumentClient.from(client);
  
  console.log('Fixing phone booking source fields in production...\n');
  console.log(`Jobs to update: ${PHONE_BOOKING_JOBS.length}`);
  PHONE_BOOKING_JOBS.forEach(id => console.log(`  - ${id}`));
  console.log();
  
  let updated = 0;
  let failed = 0;
  
  for (const jobId of PHONE_BOOKING_JOBS) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: 'safari-detail-ops-prod-jobs',
        Key: { jobId },
        UpdateExpression: 'SET #source = :source, updatedAt = :now',
        ExpressionAttributeNames: {
          '#source': 'source',
        },
        ExpressionAttributeValues: {
          ':source': 'manual',
          ':now': new Date().toISOString(),
        },
      }));
      console.log(`✓ Updated: ${jobId}`);
      updated++;
    } catch (err) {
      console.error(`✗ Failed: ${jobId} - ${err.message}`);
      failed++;
    }
  }
  
  console.log();
  console.log(`Summary: ${updated}/${PHONE_BOOKING_JOBS.length} updated, ${failed} failed`);
}

fixPhoneBookingSource();
