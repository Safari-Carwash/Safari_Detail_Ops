/**
 * DynamoDB Notifications Service Layer
 * 
 * Handles all DynamoDB operations for notifications table.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { getConfig } from '../config';
import type { Notification } from '../types';

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
 * Create a new notification
 */
export async function createNotification(notification: Notification): Promise<Notification> {
  const client = getDynamoClient();
  const config = getConfig();
  
  const timestamp = new Date().toISOString();
  const notificationWithTimestamp = {
    ...notification,
    createdAt: timestamp,
  };
  
  await client.send(new PutCommand({
    TableName: config.aws.dynamodb.notificationsTable,
    Item: notificationWithTimestamp,
  }));
  
  return notificationWithTimestamp;
}

/**
 * Get notifications for a location
 * 
 * @param locationId - Location to filter by
 * @param since - Only return notifications after this timestamp (optional)
 * @param limit - Max number to return (default: 50)
 * @returns Notifications sorted by createdAt descending
 */
export async function getNotifications(
  locationId: string,
  since?: string,
  limit: number = 50
): Promise<Notification[]> {
  const client = getDynamoClient();
  const config = getConfig();
  
  let filterExpression = 'locationId = :locationId';
  const expressionAttributeValues: Record<string, any> = {
    ':locationId': locationId,
  };
  
  if (since) {
    filterExpression += ' AND createdAt > :since';
    expressionAttributeValues[':since'] = since;
  }
  
  // Scan with pagination to ensure we get all results
  let allNotifications: Notification[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;
  let scanCount = 0;
  const maxScans = 10; // Prevent infinite loops
  
  try {
    do {
      const scanParams: any = {
        TableName: config.aws.dynamodb.notificationsTable,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: 100, // Scan up to 100 items per request
      };
      
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }
      
      const result = await client.send(new ScanCommand(scanParams));
      
      // Add items from this scan
      if (result.Items) {
        allNotifications.push(...(result.Items as Notification[]));
      }
      
      // Check if we have enough results
      if (allNotifications.length >= limit) {
        break;
      }
      
      lastEvaluatedKey = result.LastEvaluatedKey;
      scanCount++;
    } while (lastEvaluatedKey && scanCount < maxScans);
  } catch (err) {
    console.error('[NOTIFICATIONS QUERY] Scan error', {
      locationId,
      error: (err as Error).message,
    });
    // Return partial results on error
  }
  
  // Sort by createdAt descending
  allNotifications.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  
  // Return up to limit
  return allNotifications.slice(0, limit);
}

/**
 * Get unread count for a location
 */
export async function getUnreadCount(locationId: string): Promise<number> {
  const client = getDynamoClient();
  const config = getConfig();
  
  let totalCount = 0;
  let lastEvaluatedKey: Record<string, any> | undefined;
  let scanCount = 0;
  const maxScans = 50; // Prevent infinite loops
  
  try {
    do {
      const scanParams: any = {
        TableName: config.aws.dynamodb.notificationsTable,
        FilterExpression: 'locationId = :locationId AND attribute_not_exists(readAt)',
        ExpressionAttributeValues: {
          ':locationId': locationId,
        },
        Select: 'COUNT',
      };
      
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }
      
      const result = await client.send(new ScanCommand(scanParams));
      
      totalCount += result.Count || 0;
      lastEvaluatedKey = result.LastEvaluatedKey;
      scanCount++;
    } while (lastEvaluatedKey && scanCount < maxScans);
  } catch (err) {
    console.error('[UNREAD COUNT QUERY] Scan error', {
      locationId,
      error: (err as Error).message,
    });
    // Return partial count on error
  }
  
  return totalCount;
}

/**
 * Mark a notification as read
 */
export async function markAsRead(notificationId: string): Promise<void> {
  const client = getDynamoClient();
  const config = getConfig();
  
  await client.send(new UpdateCommand({
    TableName: config.aws.dynamodb.notificationsTable,
    Key: { notificationId },
    UpdateExpression: 'SET readAt = :readAt',
    ExpressionAttributeValues: {
      ':readAt': new Date().toISOString(),
    },
  }));
}

/**
 * Mark all notifications as read for a location
 */
export async function markAllAsRead(locationId: string): Promise<number> {
  const client = getDynamoClient();
  const config = getConfig();
  
  // Get all unread notifications
  const result = await client.send(new ScanCommand({
    TableName: config.aws.dynamodb.notificationsTable,
    FilterExpression: 'locationId = :locationId AND attribute_not_exists(readAt)',
    ExpressionAttributeValues: {
      ':locationId': locationId,
    },
    ProjectionExpression: 'notificationId',
  }));
  
  const notifications = (result.Items || []) as Pick<Notification, 'notificationId'>[];
  
  if (notifications.length === 0) {
    return 0;
  }
  
  const readAt = new Date().toISOString();
  
  // Batch update (max 25 at a time with BatchWriteCommand)
  const batchSize = 25;
  for (let i = 0; i < notifications.length; i += batchSize) {
    const batch = notifications.slice(i, i + batchSize);
    
    // Note: BatchWriteCommand doesn't support UpdateItem, so we need to use individual UpdateCommand
    await Promise.all(
      batch.map(notification =>
        client.send(new UpdateCommand({
          TableName: config.aws.dynamodb.notificationsTable,
          Key: { notificationId: notification.notificationId },
          UpdateExpression: 'SET readAt = :readAt',
          ExpressionAttributeValues: {
            ':readAt': readAt,
          },
        }))
      )
    );
  }
  
  return notifications.length;
}

/**
 * Check if a notification with the same dedupe key exists recently
 * 
 * @param locationId - Location ID
 * @param dedupeKey - Unique key for deduplication (e.g., `square:${eventId}`)
 * @param withinMinutes - Check if notification was created within this many minutes (default: 5)
 * @returns true if duplicate exists
 */
export async function isDuplicateNotification(
  locationId: string,
  dedupeKey: string,
  withinMinutes: number = 5
): Promise<boolean> {
  const client = getDynamoClient();
  const config = getConfig();
  
  const cutoffTime = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  
  const result = await client.send(new ScanCommand({
    TableName: config.aws.dynamodb.notificationsTable,
    FilterExpression: 'locationId = :locationId AND actor = :actor AND createdAt > :cutoff',
    ExpressionAttributeValues: {
      ':locationId': locationId,
      ':actor': dedupeKey,
      ':cutoff': cutoffTime,
    },
    Limit: 1,
  }));
  
  return (result.Items?.length || 0) > 0;
}
