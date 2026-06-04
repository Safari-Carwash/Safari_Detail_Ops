const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

async function findTodaysJobs() {
  const client = new DynamoDBClient({ region: 'us-east-1' });
  const docClient = DynamoDBDocumentClient.from(client);
  
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: 'safari-detail-ops-prod-jobs',
      Limit: 200,
      ProjectionExpression: 'jobId, #source, createdAt, createdBy, bookingId',
      ExpressionAttributeNames: {
        '#source': 'source',
      },
    }));
    
    const items = result.Items || [];
    
    // Filter for today's jobs (June 3, 2026)
    const todaysJobs = items.filter(job => {
      if (!job.createdAt) return false;
      const date = job.createdAt.split('T')[0];
      return date === '2026-06-03';
    });
    
    console.log(`Found ${todaysJobs.length} jobs created today:\n`);
    todaysJobs.forEach(job => {
      console.log(`Job: ${job.jobId}`);
      console.log(`  source: ${job.source || '[NOT SET]'}`);
      console.log(`  createdBy: ${job.createdBy || '[NOT SET]'}`);
      console.log(`  createdAt: ${job.createdAt}`);
      console.log(`  bookingId: ${job.bookingId ? 'YES' : 'NO'}`);
      console.log();
    });
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

findTodaysJobs();
