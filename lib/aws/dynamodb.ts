/**
 * DynamoDB Service Layer
 * 
 * Handles all DynamoDB operations for Safari Detail Ops.
 * Uses AWS SDK v3 with DynamoDBDocumentClient for simplified operations.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  UpdateCommand, 
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand 
} from '@aws-sdk/lib-dynamodb';
import { getConfig } from '../config';
import type { Job, WorkStatus } from '../types';
import { getStartOfDayInTimezone, getEndOfDayInTimezone } from '../utils/timezone';

let dynamoClient: DynamoDBDocumentClient | null = null;

/**
 * Get or create DynamoDB Document Client
 */
function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const config = getConfig();
    
    const client = new DynamoDBClient({
      region: config.aws.region,
    });
    
    dynamoClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
    });
  }
  
  return dynamoClient;
}

/**
 * Get or initialize the job number counter
 * Counter document structure: { id: 'detailOpsJobNumberCounter', counter: 10000 }
 */
export async function getJobNumberCounter(): Promise<number> {
  const client = getDynamoClient();
  const config = getConfig();
  
  const result = await client.send(new GetCommand({
    TableName: config.aws.dynamodb.jobsTable,
    Key: { jobId: 'detailOpsJobNumberCounter' },
  }));
  
  if (!result.Item) {
    // Counter doesn't exist, try to create it
    try {
      await client.send(new PutCommand({
        TableName: config.aws.dynamodb.jobsTable,
        Item: {
          jobId: 'detailOpsJobNumberCounter',
          counter: 10000,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(jobId)',
      }));
      console.log('[JOB NUMBER] Counter initialized to 10000');
      return 10000;
    } catch (error: any) {
      // If creation fails due to race condition, try to read again
      if (error.name === 'ConditionalCheckFailedException') {
        console.log('[JOB NUMBER] Counter already created by another process, reading again');
        const retryResult = await client.send(new GetCommand({
          TableName: config.aws.dynamodb.jobsTable,
          Key: { jobId: 'detailOpsJobNumberCounter' },
        }));
        return (retryResult.Item as any)?.counter || 10000;
      }
      throw error;
    }
  }
  
  return (result.Item as any).counter || 10000;
}

/**
 * Increment job number counter and return next job number (10001, 10002, etc.)
 * Uses DynamoDB atomic increment to prevent duplicate job numbers
 */
export async function incrementJobNumberCounter(): Promise<number> {
  const client = getDynamoClient();
  const config = getConfig();
  
  // First, ensure counter exists
  await getJobNumberCounter();
  
  // Atomically increment the counter
  const result = await client.send(new UpdateCommand({
    TableName: config.aws.dynamodb.jobsTable,
    Key: { jobId: 'detailOpsJobNumberCounter' },
    UpdateExpression: 'SET #counter = #counter + :inc, #updatedAt = :now',
    ExpressionAttributeNames: {
      '#counter': 'counter',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':inc': 1,
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  }));
  
  const newCounter = (result.Attributes as any).counter || 10001;
  return newCounter;
}

/**
 * Create a new job record
 */
export async function createJob(job: Job): Promise<Job> {
  const client = getDynamoClient();
  const config = getConfig();
  
  const timestamp = new Date().toISOString();
  const jobWithTimestamps = {
    ...job,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  
  await client.send(new PutCommand({
    TableName: config.aws.dynamodb.jobsTable,
    Item: jobWithTimestamps,
    ConditionExpression: 'attribute_not_exists(jobId)',
  }));
  
  return jobWithTimestamps;
}

/**
 * Get job by ID
 */
export async function getJob(jobId: string): Promise<Job | null> {
  const client = getDynamoClient();
  const config = getConfig();
  
  const result = await client.send(new GetCommand({
    TableName: config.aws.dynamodb.jobsTable,
    Key: { jobId },
  }));
  
  return result.Item as Job | null;
}

/**
 * Get job by booking ID
 */
export async function getJobByBookingId(bookingId: string): Promise<Job | null> {
  const client = getDynamoClient();
  const config = getConfig();
  
  const result = await client.send(new ScanCommand({
    TableName: config.aws.dynamodb.jobsTable,
    FilterExpression: 'bookingId = :bookingId',
    ExpressionAttributeValues: {
      ':bookingId': bookingId,
    },
    Limit: 1,
  }));
  
  return result.Items?.[0] as Job | null;
}

/**
 * Update job record
 */
export async function updateJob(
  jobId: string,
  updates: Partial<Job>
): Promise<Job> {
  const client = getDynamoClient();
  const config = getConfig();
  
  // Remove fields that shouldn't be updated (including updatedAt since we add it separately)
  const { jobId: _, createdAt, updatedAt, ...allowedUpdates } = updates as any;
  
  // Build update expression
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};
  
  Object.keys(allowedUpdates).forEach((key, index) => {
    const placeholder = `#attr${index}`;
    const valuePlaceholder = `:val${index}`;
    updateExpressions.push(`${placeholder} = ${valuePlaceholder}`);
    expressionAttributeNames[placeholder] = key;
    expressionAttributeValues[valuePlaceholder] = allowedUpdates[key];
  });
  
  // Always update the updatedAt timestamp (use provided value or generate new one)
  updateExpressions.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = updates.updatedAt || new Date().toISOString();
  
  const result = await client.send(new UpdateCommand({
    TableName: config.aws.dynamodb.jobsTable,
    Key: { jobId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW',
  }));
  
  return result.Attributes as Job;
}

/**
 * List jobs with optional filters
 */
export async function listJobs(options?: {
  status?: WorkStatus;
  customerId?: string;
  limit?: number;
  nextToken?: string;
  boardDate?: string; // YYYY-MM-DD format from America/Chicago timezone
}): Promise<{ jobs: Job[]; nextToken?: string }> {
  const client = getDynamoClient();
  const config = getConfig();
  
  console.log('[DynamoDB] listJobs called with options:', JSON.stringify({
    status: options?.status,
    customerId: options?.customerId,
    limit: options?.limit,
    hasNextToken: !!options?.nextToken,
  }, null, 2));
  
  let filterExpression: string | undefined;
  const expressionAttributeValues: Record<string, any> = {};
  
  if (options?.status) {
    filterExpression = '#status = :status';
    expressionAttributeValues[':status'] = options.status;
  }
  
  if (options?.customerId) {
    const customerFilter = 'customerId = :customerId';
    filterExpression = filterExpression 
      ? `${filterExpression} AND ${customerFilter}`
      : customerFilter;
    expressionAttributeValues[':customerId'] = options.customerId;
  }
  
  // If boardDate is provided, add filter for appointments on that date
  // This filters at DB level to avoid scanning irrelevant jobs
  if (options?.boardDate) {
    try {
      // boardDate is in format YYYY-MM-DD (America/Chicago timezone)
      // Use timezone utilities to get UTC boundaries
      const dayStart = getStartOfDayInTimezone(options.boardDate);
      const dayEnd = getEndOfDayInTimezone(options.boardDate);
      
      // Use comparison operators (>= and <) instead of BETWEEN for better compatibility
      const dateFilter = '(appointmentTime >= :dayStart AND appointmentTime < :dayEnd)';
      filterExpression = filterExpression 
        ? `(${filterExpression}) AND ${dateFilter}`
        : dateFilter;
      expressionAttributeValues[':dayStart'] = dayStart;
      expressionAttributeValues[':dayEnd'] = dayEnd;
      
      console.log('[DynamoDB] Applied boardDate filter:', {
        boardDate: options.boardDate,
        dayStart,
        dayEnd,
      });
    } catch (dateError: any) {
      console.warn('[DynamoDB] Failed to apply boardDate filter, skipping:', dateError.message);
      // Continue without date filter rather than failing completely
    }
  }
  
  const scanParams = {
    TableName: config.aws.dynamodb.jobsTable,
    FilterExpression: filterExpression,
    ExpressionAttributeNames: filterExpression ? { '#status': 'status' } : undefined,
    ExpressionAttributeValues: Object.keys(expressionAttributeValues).length > 0 
      ? expressionAttributeValues 
      : undefined,
    Limit: options?.limit || 50,
    ExclusiveStartKey: options?.nextToken 
      ? JSON.parse(Buffer.from(options.nextToken, 'base64').toString())
      : undefined,
  };
  
  console.log('[DynamoDB] Scan parameters:', JSON.stringify({
    TableName: scanParams.TableName,
    FilterExpression: scanParams.FilterExpression,
    Limit: scanParams.Limit,
    hasExpressionAttributeValues: !!scanParams.ExpressionAttributeValues,
  }, null, 2));
  
  const result = await client.send(new ScanCommand(scanParams));
  
  console.log('[DynamoDB] Scan result:', {
    itemsCount: result.Items?.length || 0,
    hasLastEvaluatedKey: !!result.LastEvaluatedKey,
    scannedCount: result.ScannedCount,
  });
  
  return {
    jobs: (result.Items as Job[]) || [],
    nextToken: result.LastEvaluatedKey 
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : undefined,
  };
}

/**
 * Delete job by ID
 */
export async function deleteJob(jobId: string): Promise<void> {
  const client = getDynamoClient();
  const config = getConfig();
  
  await client.send(new DeleteCommand({
    TableName: config.aws.dynamodb.jobsTable,
    Key: { jobId },
  }));
}
