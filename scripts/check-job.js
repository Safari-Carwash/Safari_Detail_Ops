const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

async function checkJob() {
  const jobId = 'h8jfrvzh2eya7';
  const client = new DynamoDBClient({ region: 'us-east-1' });
  const docClient = DynamoDBDocumentClient.from(client);
  
  try {
    const result = await docClient.send(new GetCommand({
      TableName: 'safari-detail-ops-prod-jobs',
      Key: { jobId }
    }));
    
    if (result.Item) {
      console.log('Job found:');
      console.log('  jobId:', result.Item.jobId);
      console.log('  source:', result.Item.source || '[NOT SET]');
      console.log('  createdBy:', result.Item.createdBy || '[NOT SET]');
      console.log('  bookingId:', result.Item.bookingId ? 'YES' : 'NO');
      console.log('  createdAt:', result.Item.createdAt || '[NOT SET]');
    } else {
      console.log('Job not found');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkJob();
