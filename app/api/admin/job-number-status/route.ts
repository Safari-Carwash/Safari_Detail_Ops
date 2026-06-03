/**
 * Admin Diagnostic Endpoint: Job Number Status
 * 
 * GET /api/admin/job-number-status
 * 
 * Check the current state of job numbering:
 * - Current counter value
 * - Count of jobs with/without job numbers
 * - Sample jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ApiResponse } from '@/lib/types';
import * as dynamodb from '@/lib/aws/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { getConfig } from '@/lib/config';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const config = getConfig();

    // Get counter value
    const counterValue = await dynamodb.getJobNumberCounter();

    // Get DynamoDB client
    const dynamoClient = new DynamoDBClient({ region: config.aws.region });
    const docClient = DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
    });

    // Scan for jobs (excluding counter document)
    const result = await docClient.send(new ScanCommand({
      TableName: config.aws.dynamodb.jobsTable,
      FilterExpression: 'jobId <> :counterId',
      ExpressionAttributeValues: {
        ':counterId': 'detailOpsJobNumberCounter',
      },
      Limit: 1000, // Scan up to 1000 jobs
    }));

    const jobs = (result.Items as any[]) || [];

    // Count jobs with/without jobNumbers
    const jobsWithNumber = jobs.filter(j => j.jobNumber !== undefined).length;
    const jobsWithoutNumber = jobs.filter(j => j.jobNumber === undefined).length;

    // Get sample jobs (with and without numbers)
    const samplesWithNumber = jobs
      .filter(j => j.jobNumber !== undefined)
      .sort((a, b) => (a.jobNumber || 0) - (b.jobNumber || 0))
      .slice(0, 5);

    const samplesWithoutNumber = jobs
      .filter(j => j.jobNumber === undefined)
      .slice(0, 5);

    const response: ApiResponse = {
      success: true,
      data: {
        counter: {
          currentValue: counterValue,
          nextJobNumber: counterValue + 1,
        },
        jobCounts: {
          total: jobs.length,
          withJobNumber: jobsWithNumber,
          withoutJobNumber: jobsWithoutNumber,
          percentage: jobs.length > 0 ? Math.round((jobsWithNumber / jobs.length) * 100) : 0,
        },
        samplesWithNumber: samplesWithNumber.map(j => ({
          jobId: j.jobId,
          jobNumber: j.jobNumber,
          customerName: j.customerName,
          createdAt: j.createdAt,
        })),
        samplesWithoutNumber: samplesWithoutNumber.map(j => ({
          jobId: j.jobId,
          jobNumber: j.jobNumber,
          customerName: j.customerName,
          createdAt: j.createdAt,
        })),
        recommendation:
          jobsWithoutNumber > 0
            ? 'Run backfill migration: npx ts-node scripts/backfill-job-numbers.ts'
            : 'All jobs have job numbers ✓',
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[JOB NUMBER STATUS ERROR]', {
      error: error.message,
      stack: error.stack,
    });

    const response: ApiResponse = {
      success: false,
      error: {
        code: 'DIAGNOSIS_ERROR',
        message: error.message || 'Failed to check job number status',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 500 });
  }
}
