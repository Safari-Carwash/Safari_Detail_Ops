/**
 * Job Management Service
 * 
 * High-level service for managing jobs, combining DynamoDB and S3 operations.
 */

import { v4 as uuidv4 } from 'uuid';
import * as dynamodb from '../aws/dynamodb';
import * as s3 from '../aws/s3';
import type { Job, UpdateJobRequest, UserAudit, PhotoMeta, ChecklistItem, CustomerCached } from '../types';
import { WorkStatus, PaymentStatus } from '../types';
import type { ParsedBooking } from '../square/booking-parser';
import { fetchCustomerWithRetry, isCacheStale, toCustomerCached } from '../square/customers-api';
import { sendCompletionSms } from './sms-service';
import { fetchCatalogObject, listAddons } from '../square/catalog-api';
import { retrieveOrder, extractNonAddonAmount } from '../square/orders-api';
import { findDepositPaymentForBooking } from '../square/payments-api';

/**
 * Tennessee sales tax rate
 */
const TAX_RATE = 0.0975;

/**
 * Parse a deposit amount from booking notes.
 *
 * @param notes - Booking notes or seller notes from Square
 */
function parseDepositAmountFromNotes(notes?: string): number | undefined {
  if (!notes) {
    return undefined;
  }

  const match = notes.match(/DEPOSIT\s+CHARGED:\s*\$?\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  if (!match || !match[1]) {
    return undefined;
  }

  const normalized = match[1].replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isNaN(amount) ? undefined : Math.round(amount * 100);
}

/**
 * Extract deposit and related Square order metadata from a booking's Square order.
 *
 * @param booking - Parsed booking from Square webhook or API
 */
async function enrichBookingDepositFromSquareData(booking: ParsedBooking) {
  let squareOrderId: string | undefined;
  let depositAmountCents: number | undefined;
  let depositCurrency: string | undefined;
  let depositPaymentStatus: string | undefined;
  let depositPaymentId: string | undefined;
  let depositReceiptNumber: string | undefined;
  let depositPaymentNote: string | undefined;

  console.log('[JOB SERVICE] Starting deposit enrichment', {
    bookingId: booking.bookingId,
    customerId: booking.customerId,
    appointmentTime: booking.appointmentTime,
    orderId: booking.orderId,
    locationId: booking.locationId,
  });

  // First: Try to get deposit from order
  if (booking.orderId) {
    console.log('[JOB SERVICE] Attempting to enrich from order', {
      orderId: booking.orderId,
    });
    try {
      const order = await retrieveOrder(booking.orderId);
      if (order) {
        squareOrderId = order.id;
        depositAmountCents = extractNonAddonAmount(order) || order.total_money?.amount;
        depositCurrency = order.total_money?.currency;
        depositPaymentStatus = order.state;
        console.log('[JOB SERVICE] Order enrichment successful', {
          orderId: order.id,
          depositAmountCents,
          depositPaymentStatus,
        });
      } else {
        console.warn('[JOB SERVICE] Order not found', { orderId: booking.orderId });
      }
    } catch (error: any) {
      console.warn('[JOB SERVICE] Failed to enrich deposit from order', {
        orderId: booking.orderId,
        error: error?.message || error,
      });
    }
  } else {
    console.log('[JOB SERVICE] No orderId, skipping order lookup');
  }

  // Second: Try to get deposit from payment if order didn't have amount
  if (depositAmountCents == null) {
    console.log('[JOB SERVICE] Attempting to find deposit payment', {
      bookingId: booking.bookingId,
      hasCustomerId: !!booking.customerId,
      hasAppointmentTime: !!booking.appointmentTime,
    });
    try {
      const payment = await findDepositPaymentForBooking({
        bookingId: booking.bookingId,
        customerId: booking.customerId,
        appointmentTime: booking.appointmentTime,
        locationId: booking.locationId,
        orderId: booking.orderId,
      });
      if (payment) {
        console.log('[JOB SERVICE] Deposit payment found', {
          paymentId: payment.id,
          amount: payment.amount_money?.amount,
          status: payment.status,
          note: payment.note,
        });
        depositAmountCents = payment.amount_money?.amount;
        depositCurrency = payment.amount_money?.currency;
        depositPaymentStatus = payment.status;
        depositPaymentId = payment.id;
        depositReceiptNumber = payment.receipt_number;
        depositPaymentNote = payment.note;
      } else {
        console.log('[JOB SERVICE] No deposit payment found', {
          bookingId: booking.bookingId,
        });
      }
    } catch (error: any) {
      console.warn('[JOB SERVICE] Failed to enrich deposit from payment', {
        bookingId: booking.bookingId,
        error: error?.message || error,
      });
    }
  } else {
    console.log('[JOB SERVICE] Skipping payment lookup - amount found in order', {
      depositAmountCents,
    });
  }

  // IMPORTANT: Do NOT parse deposit amount from notes text like "CARD ON FILE" or "$20 protection"
  // Only accept deposits from actual Square Payment transactions or Order data
  // Parsing notes is unreliable and incorrectly treats card-on-file text as collected deposit

  console.log('[JOB SERVICE] Deposit enrichment complete', {
    bookingId: booking.bookingId,
    orderId: booking.orderId,
    squareOrderId,
    depositAmountCents,
    depositPaymentId,
    depositPaymentNote,
    depositPaymentStatus,
    source: depositPaymentId ? 'square_payment' : 
            squareOrderId ? 'square_order' : 
            'not_found',
  });

  return {
    ...(squareOrderId ? { squareOrderId } : {}),
    ...(depositPaymentId ? { depositPaymentId } : {}),
    ...(depositReceiptNumber ? { depositReceiptNumber } : {}),
    ...(depositPaymentNote ? { depositPaymentNote } : {}),
    ...(depositAmountCents != null ? { depositAmountCents } : {}),
    ...(depositCurrency ? { depositCurrency } : {}),
    ...(depositPaymentStatus ? { depositPaymentStatus } : {}),
  };
}

/**
 * Calculate payment amount from booking with service and add-ons
 * 
 * @param serviceVariationId - Service variation ID from booking
 * @param notes - Booking notes containing add-ons
 * @returns Payment amount in cents, or undefined if calculation fails
 */
export async function calculateBookingAmount(
  serviceVariationId: string | undefined,
  notes: string | undefined
): Promise<number | undefined> {
  try {
    let subtotalCents = 0;

    // 1. Get service price
    if (serviceVariationId) {
      console.log('[PAYMENT CALC] Fetching service price', {
        variationId: serviceVariationId,
      });
      
      const serviceObj = await fetchCatalogObject(serviceVariationId);
      
      if (serviceObj) {
        console.log('[PAYMENT CALC] Service object found', {
          variationId: serviceVariationId,
          hasItemVariationData: !!serviceObj.item_variation_data,
          hasPriceMoney: !!serviceObj.item_variation_data?.price_money,
          amount: serviceObj.item_variation_data?.price_money?.amount,
        });
      } else {
        console.warn('[PAYMENT CALC] Service object not found', {
          variationId: serviceVariationId,
          note: 'fetchCatalogObject returned null',
        });
      }
      
      if (serviceObj?.item_variation_data?.price_money?.amount) {
        subtotalCents += serviceObj.item_variation_data.price_money.amount;
        console.log('[PAYMENT CALC] Service price added', {
          variationId: serviceVariationId,
          priceCents: serviceObj.item_variation_data.price_money.amount,
        });
      }
    } else {
      console.warn('[PAYMENT CALC] No service variation ID provided', {
        note: 'Cannot calculate service price without variation ID',
      });
    }

    // 2. Parse add-ons from notes and get prices
    if (notes && notes.includes('ADD-ONS REQUESTED')) {
      // Extract add-on names from notes
      const addonsMatch = notes.match(/✅\s*ADD-ONS\s+REQUESTED:\s*([\s\S]*?)(?:\n\n⚠️|$)/i);
      
      if (addonsMatch && addonsMatch[1]) {
        const addonLines = addonsMatch[1]
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.startsWith('•') || line.startsWith('-') || line.startsWith('*'))
          .map(line => line.substring(1).trim()); // Remove bullet point

        if (addonLines.length > 0) {
          console.log('[PAYMENT CALC] Found add-ons in notes', {
            count: addonLines.length,
            names: addonLines,
          });

          // Fetch all available add-ons to match names to prices
          const availableAddons = await listAddons();
          const addonMap = new Map(
            availableAddons.map(addon => [addon.name.toLowerCase(), addon.priceMoney?.amount || 0])
          );

          // Sum add-on prices
          for (const addonName of addonLines) {
            const price = addonMap.get(addonName.toLowerCase());
            if (price) {
              subtotalCents += price;
              console.log('[PAYMENT CALC] Add-on price', {
                name: addonName,
                priceCents: price,
              });
            } else {
              console.warn('[PAYMENT CALC] Add-on price not found', {
                name: addonName,
                note: 'Add-on may be inactive or renamed',
              });
            }
          }
        }
      }
    }

    if (subtotalCents === 0) {
      console.warn('[PAYMENT CALC] No prices found for booking');
      return undefined;
    }

    // 3. Calculate tax and total
    const taxCents = Math.round(subtotalCents * TAX_RATE);
    const totalCents = subtotalCents + taxCents;

    console.log('[PAYMENT CALC] Final calculation', {
      subtotalCents,
      taxCents,
      totalCents,
      taxRate: `${(TAX_RATE * 100).toFixed(2)}%`,
    });

    return totalCents;
  } catch (error: any) {
    console.error('[PAYMENT CALC] Calculation failed', {
      error: error.message,
    });
    return undefined;
  }
}

/**
 * Generate next unique job number (10001, 10002, etc.)
 * 
 * Uses atomic counter increment to prevent duplicates when jobs are created simultaneously
 */
export async function generateJobNumber(): Promise<number> {
  const jobNumber = await dynamodb.incrementJobNumberCounter();
  console.log('[JOB SERVICE] Generated job number', { jobNumber });
  return jobNumber;
}

/**
 * Create a job from a Square booking (Phase 3: with customer caching)
 * 
 * Uses booking ID as job ID for consistency and idempotency
 */
export async function createJobFromBooking(booking: ParsedBooking): Promise<Job> {
  // Use booking ID as job ID for idempotency (matches manager phone booking behavior)
  const jobId = booking.bookingId;
  
  // Generate unique job number (10001, 10002, etc.)
  const jobNumber = await generateJobNumber();
  
  console.log('[JOB SERVICE] Creating job from booking', {
    jobId,
    jobNumber,
    bookingId: booking.bookingId,
    customerName: booking.customerName,
  });
  
  // Phase 3: Fetch and cache customer details from Square if available
  let customerCached: CustomerCached | undefined;
  if (booking.customerId) {
    const cachedData = await fetchCustomerWithRetry(booking.customerId, 1);
    if (cachedData) {
      customerCached = cachedData;
    }
  }
  
  // Use cached customer name if available, otherwise use booking name or placeholder
  const displayName = customerCached?.name || 
    booking.customerName || 
    (booking.customerId ? `Customer ${booking.customerId.substring(0, 8)}...` : 'Unknown Customer');
  
  // Calculate payment amount from service + add-ons + tax
  const amountCents = await calculateBookingAmount(booking.serviceVariationId, booking.notes);
  const depositMeta = await enrichBookingDepositFromSquareData(booking);
  
  const mappedStatus = mapBookingStatusToJobStatus(booking.status);
  const isCancelled = mappedStatus === WorkStatus.CANCELLED;
  
  const job: Job = {
    jobId,
    jobNumber, // Unique job number (10001, 10002, etc.)
    customerId: booking.customerId || '',
    customerName: displayName,
    customerEmail: customerCached?.email || booking.customerEmail,
    customerPhone: customerCached?.phone || booking.customerPhone,
    vehicleInfo: {}, // Will be filled in by staff later
    serviceType: booking.serviceType || 'Detail Service',
    status: mappedStatus,
    bookingId: booking.bookingId,
    orderId: booking.orderId,
    squareOrderId: depositMeta.squareOrderId,
    depositAmountCents: depositMeta.depositAmountCents,
    depositCurrency: depositMeta.depositCurrency,
    depositPaymentStatus: depositMeta.depositPaymentStatus,
    appointmentTime: booking.appointmentTime,
    photos: [],
    photosMeta: [], // Phase 3: Initialize empty photo metadata
    notes: booking.notes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    customerCached, // Phase 3: Cache customer data on job creation
    payment: amountCents ? {
      status: PaymentStatus.UNPAID,
      amountCents,
    } : undefined,
    // Add cancellation metadata if booking is cancelled
    ...(isCancelled && {
      cancelledAt: new Date().toISOString(),
      cancelledSource: 'square' as const,
      cancellationReason: `Square booking status: ${booking.status}`,
    }),
  };

  return dynamodb.createJob(job);
}

/**
 * Update a job from a Square booking update (Phase 3: with customer cache refresh)
 */
export async function updateJobFromBooking(
  jobId: string,
  booking: ParsedBooking
): Promise<Job> {
  const currentJob = await dynamodb.getJob(jobId);
  
  // Phase 3: Refresh customer cache if stale or missing
  let customerCached: CustomerCached | undefined = currentJob?.customerCached;
  if (booking.customerId && (!customerCached || isCacheStale(customerCached.cachedAt))) {
    const cachedData = await fetchCustomerWithRetry(booking.customerId, 1);
    if (cachedData) {
      customerCached = cachedData;
      console.log('[JOB SERVICE] Customer cache refreshed', {
        jobId,
        customerId: booking.customerId,
      });
    }
  }
  
  const displayName = customerCached?.name || booking.customerName || currentJob?.customerName;
  const depositMeta = await enrichBookingDepositFromSquareData(booking);
  
  // Recalculate payment amount if not yet paid (in case add-ons or service changed)
  let paymentUpdate: Partial<Job>['payment'] | undefined;
  if (!currentJob?.payment || currentJob.payment.status === PaymentStatus.UNPAID) {
    const amountCents = await calculateBookingAmount(booking.serviceVariationId, booking.notes);
    if (amountCents) {
      paymentUpdate = {
        status: PaymentStatus.UNPAID,
        amountCents,
      };
    }
  }
  
  const mappedStatus = mapBookingStatusToJobStatus(booking.status);
  const isCancelled = mappedStatus === WorkStatus.CANCELLED;
  const wasAlreadyCancelled = currentJob?.status === WorkStatus.CANCELLED;
  
  const updates: Partial<Job> = {
    status: mappedStatus,
    appointmentTime: booking.appointmentTime,
    customerName: displayName,
    customerEmail: customerCached?.email || booking.customerEmail,
    customerPhone: customerCached?.phone || booking.customerPhone,
    notes: booking.notes,
    updatedBy: 'square-webhook',
    customerCached, // Phase 3: Update cached customer data
    payment: paymentUpdate,
    ...depositMeta,
    // Add cancellation metadata if newly cancelled (idempotent)
    ...(isCancelled && !wasAlreadyCancelled && {
      cancelledAt: new Date().toISOString(),
      cancelledSource: 'square' as const,
      cancellationReason: `Square booking status: ${booking.status}`,
    }),
  };
  
  // Remove undefined values to prevent DynamoDB UpdateExpression errors
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([_, value]) => value !== undefined)
  ) as Partial<Job>;
  
  return dynamodb.updateJob(jobId, cleanUpdates);
}

/**
 * Map Square booking status to work status
 */
function mapBookingStatusToJobStatus(bookingStatus: string): WorkStatus {
  switch (bookingStatus.toUpperCase()) {
    case 'ACCEPTED':
    case 'PENDING':
      return WorkStatus.SCHEDULED;
    case 'CANCELLED':
    case 'DECLINED':
      return WorkStatus.CANCELLED;
    default:
      return WorkStatus.SCHEDULED;
  }
}

/**
 * Get job by ID with photo URLs
 */
export async function getJobWithPhotos(jobId: string): Promise<Job & { photoUrls?: string[] } | null> {
  const job = await dynamodb.getJob(jobId);
  
  if (!job) {
    return null;
  }
  
  // Generate presigned download URLs for photosMeta (Phase 3+)
  if (job.photosMeta && job.photosMeta.length > 0) {
    const photosMetaWithUrls = await Promise.all(
      job.photosMeta.map(async (photo) => ({
        ...photo,
        publicUrl: await s3.generateDownloadUrl(photo.s3Key, 3600),
      }))
    );
    job.photosMeta = photosMetaWithUrls;
  }
  
  // Generate presigned download URLs for receipt photos
  if (job.receiptPhotos && job.receiptPhotos.length > 0) {
    const receiptPhotosWithUrls = await Promise.all(
      job.receiptPhotos.map(async (receipt) => ({
        ...receipt,
        publicUrl: await s3.generateDownloadUrl(receipt.s3Key, 3600),
      }))
    );
    job.receiptPhotos = receiptPhotosWithUrls;
  }
  
  // Generate download URLs for legacy photos array
  if (job.photos && job.photos.length > 0) {
    const photoUrls = await Promise.all(
      job.photos.map(key => s3.generateDownloadUrl(key, 3600))
    );
    
    return { ...job, photoUrls };
  }
  
  return job;
}

/**
 * Add photo to job
 */
export async function addPhotoToJob(
  jobId: string,
  filename: string,
  content: Buffer,
  contentType: string = 'image/jpeg'
): Promise<{ job: Job; photoKey: string; photoUrl: string }> {
  // Upload photo to S3
  const photoKey = await s3.uploadPhoto(jobId, filename, content, contentType);
  
  // Get current job
  const job = await dynamodb.getJob(jobId);
  
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  
  // Add photo key to job
  const photos = [...(job.photos || []), photoKey];
  const updatedJob = await dynamodb.updateJob(jobId, { photos });
  
  // Generate download URL
  const photoUrl = await s3.generateDownloadUrl(photoKey, 3600);
  
  return { job: updatedJob, photoKey, photoUrl };
}

/**
 * Remove photo from job
 */
export async function removePhotoFromJob(jobId: string, photoKey: string): Promise<Job> {
  // Get current job
  const job = await dynamodb.getJob(jobId);
  
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  
  // Remove photo key from job
  const photos = (job.photos || []).filter(key => key !== photoKey);
  const updatedJob = await dynamodb.updateJob(jobId, { photos });
  
  // Delete photo from S3
  await s3.deletePhoto(photoKey);
  
  return updatedJob;
}

/**
 * Update job status
 */
export async function updateJobStatus(
  jobId: string,
  status: WorkStatus,
  updatedBy?: string
): Promise<Job> {
  // Get current job to check for status transition
  const currentJob = await dynamodb.getJob(jobId);
  const previousStatus = currentJob?.status;
  
  // Update job status
  const updatedJob = await dynamodb.updateJob(jobId, { status, updatedBy });
  
  // Send completion SMS if transitioning to WORK_COMPLETED
  if (status === WorkStatus.WORK_COMPLETED && previousStatus !== WorkStatus.WORK_COMPLETED) {
    try {
      const result = await sendCompletionSms(jobId);
      console.log('[JOB SERVICE] Completion SMS result', {
        jobId,
        sent: result.sent,
        skipped: result.skipped,
        reason: result.reason,
        messageSid: result.messageSid,
      });
    } catch (error: any) {
      // Log error but don't fail the status update
      console.error('[JOB SERVICE] Failed to send completion SMS', {
        jobId,
        error: error.message,
        stack: error.stack,
      });
      // Note: We don't throw here because we want the status update to succeed
      // even if SMS fails. The SMS can be retried manually if needed.
    }
  }
  
  return updatedJob;
}

/**
 * Update job vehicle information
 */
export async function updateJobVehicle(
  jobId: string,
  vehicleInfo: Job['vehicleInfo'],
  updatedBy?: string
): Promise<Job> {
  return dynamodb.updateJob(jobId, { vehicleInfo, updatedBy });
}

/**
 * List jobs with filters
 */
export async function listJobs(options?: {
  status?: WorkStatus;
  customerId?: string;
  limit?: number;
  nextToken?: string;
  boardDate?: string;
}): Promise<{ jobs: Job[]; nextToken?: string }> {
  return dynamodb.listJobs(options);
}

/**
 * Delete job and all associated photos
 */
export async function deleteJobCompletely(jobId: string): Promise<void> {
  // Delete all photos
  await s3.deleteJobPhotos(jobId);
  
  // Delete job record
  await dynamodb.deleteJob(jobId);
}

/**
 * Phase 3: Update job with audit trail
 * 
 * Supports partial updates for workStatus, checklist, notes, vehicleInfo, post-completion issues
 */
export async function updateJobWithAudit(
  jobId: string,
  updates: UpdateJobRequest,
  userAudit: UserAudit
): Promise<Job | null> {
  const currentJob = await dynamodb.getJob(jobId);
  
  if (!currentJob) {
    return null;
  }

  const updateData: Partial<Job> = {
    updatedAt: new Date().toISOString(),
    updatedBy: userAudit,
  };

  const statusHistory = currentJob.statusHistory || [];

  // Update work status
  if (updates.workStatus !== undefined) {
    updateData.status = updates.workStatus;
    
    // Add status history entry for status change
    statusHistory.push({
      from: currentJob.status,
      to: updates.workStatus,
      event: 'STATUS_CHANGE',
      changedAt: new Date().toISOString(),
      changedBy: userAudit,
    });
  }

  // Handle opening post-completion issue
  if (updates.openPostCompletionIssue) {
    updateData.postCompletionIssue = {
      isOpen: true,
      type: updates.openPostCompletionIssue.type,
      notes: updates.openPostCompletionIssue.notes,
      openedAt: new Date().toISOString(),
      openedBy: {
        userId: userAudit.userId,
        name: userAudit.name,
        role: 'MANAGER' as const,
      },
    };

    // Add status history entry for issue opened
    statusHistory.push({
      from: currentJob.status,
      to: currentJob.status,
      event: 'POST_COMPLETION_ISSUE_OPENED',
      changedAt: new Date().toISOString(),
      changedBy: userAudit,
      reason: updates.openPostCompletionIssue.notes,
    });
  }

  // Handle resolving post-completion issue
  if (updates.resolvePostCompletionIssue && currentJob.postCompletionIssue) {
    updateData.postCompletionIssue = {
      ...currentJob.postCompletionIssue,
      isOpen: false,
      resolvedAt: new Date().toISOString(),
      resolvedBy: {
        userId: userAudit.userId,
        name: userAudit.name,
        role: 'MANAGER' as const,
      },
    };

    // Add status history entry for issue resolved
    statusHistory.push({
      from: currentJob.status,
      to: currentJob.status,
      event: 'POST_COMPLETION_ISSUE_RESOLVED',
      changedAt: new Date().toISOString(),
      changedBy: userAudit,
    });
  }

  // Update checklist with audit trail
  if (updates.checklist) {
    const currentChecklist = currentJob.checklist || {};
    updateData.checklist = {
      tech: updates.checklist.tech || currentChecklist.tech || [],
      qc: updates.checklist.qc || currentChecklist.qc || [],
    };
  }

  // Update notes
  if (updates.notes !== undefined) {
    updateData.notes = updates.notes;
  }

  // Update vehicle info
  if (updates.vehicleInfo !== undefined) {
    updateData.vehicleInfo = {
      ...currentJob.vehicleInfo,
      ...updates.vehicleInfo,
    };
  }

  // Update service type
  if (updates.serviceType !== undefined) {
    updateData.serviceType = updates.serviceType;
  }

  // Handle payment status updates
  if (updates.payment) {
    const now = new Date().toISOString();
    const currentPayment = currentJob.payment || { status: PaymentStatus.UNPAID };

    if (updates.payment.status === PaymentStatus.PAID) {
      // Mark as PAID
      updateData.payment = {
        ...currentPayment,
        status: PaymentStatus.PAID,
        paidAt: now,
        paidBy: {
          userId: userAudit.userId,
          name: userAudit.name,
          role: 'MANAGER' as const,
        },
        // Clear unpaid reason/note when marking as paid
        unpaidReason: undefined,
        unpaidNote: undefined,
      };

      // Add payment history entry
      statusHistory.push({
        from: null,
        to: null,
        event: 'PAYMENT_MARKED_PAID',
        changedAt: now,
        changedBy: userAudit,
      });
    } else if (updates.payment.status === PaymentStatus.UNPAID) {
      // Mark as UNPAID or update amount
      updateData.payment = {
        ...currentPayment,
        status: PaymentStatus.UNPAID,
        unpaidReason: updates.payment.unpaidReason,
        unpaidNote: updates.payment.unpaidNote,
        // Update amount if provided (e.g., when add-ons change)
        amountCents: updates.payment.amountCents !== undefined ? updates.payment.amountCents : currentPayment.amountCents,
        // Keep paidAt/paidBy for history if they exist
      };

      // Add payment history entry only if status changed or unpaid reason provided
      if (currentPayment.status !== PaymentStatus.UNPAID || updates.payment.unpaidReason) {
        statusHistory.push({
          from: null,
          to: null,
          event: updates.payment.unpaidReason ? 'PAYMENT_MARKED_UNPAID' : 'PAYMENT_AMOUNT_UPDATED',
          changedAt: now,
          changedBy: userAudit,
          reason: updates.payment.unpaidReason ? `${updates.payment.unpaidReason}${updates.payment.unpaidNote ? `: ${updates.payment.unpaidNote}` : ''}` : undefined,
        });
      }
    }
  }

  // Phase 5: Handle no-show operations
  if (updates.noShow) {
    const now = new Date().toISOString();
    
    if (updates.noShow.status === 'NO_SHOW') {
      // Mark as NO_SHOW
      updateData.noShow = {
        status: 'NO_SHOW',
        reason: updates.noShow.reason,
        notes: updates.noShow.notes,
        updatedAt: now,
        updatedBy: {
          userId: userAudit.userId,
          name: userAudit.name,
          role: 'MANAGER' as const,
        },
      };

      // Add audit trail
      statusHistory.push({
        from: currentJob.status,
        to: currentJob.status,
        event: 'NO_SHOW_MARKED',
        changedAt: now,
        changedBy: userAudit,
        reason: `${updates.noShow.reason}${updates.noShow.notes ? `: ${updates.noShow.notes}` : ''}`,
      });
    } else if (updates.noShow.status === 'RESOLVED') {
      // Resolve NO_SHOW
      const currentNoShow = currentJob.noShow;
      if (currentNoShow) {
        updateData.noShow = {
          ...currentNoShow,
          status: 'RESOLVED',
          resolvedAt: now,
          resolvedBy: {
            userId: userAudit.userId,
            name: userAudit.name,
            role: 'MANAGER' as const,
          },
        };

        // Update notes if provided
        if (updates.noShow.notes) {
          updateData.noShow.notes = updates.noShow.notes;
        }

        // Add audit trail
        statusHistory.push({
          from: currentJob.status,
          to: currentJob.status,
          event: 'NO_SHOW_RESOLVED',
          changedAt: now,
          changedBy: userAudit,
          reason: updates.noShow.notes,
        });
      }
    }
  }

  // Update status history if there are any changes
  if (statusHistory.length > 0) {
    updateData.statusHistory = statusHistory;
  }

  // Update the job in database
  const updatedJob = await dynamodb.updateJob(jobId, updateData);

  // Send completion SMS if transitioning to WORK_COMPLETED
  if (updates.workStatus === WorkStatus.WORK_COMPLETED && currentJob.status !== WorkStatus.WORK_COMPLETED) {
    try {
      const smsResult = await sendCompletionSms(jobId);
      console.log('[JOB SERVICE] Completion SMS result', {
        jobId,
        sent: smsResult.sent,
        skipped: smsResult.skipped,
        reason: smsResult.reason,
        messageSid: smsResult.messageSid,
      });
    } catch (error: any) {
      // Log error but don't fail the status update
      console.error('[JOB SERVICE] Failed to send completion SMS', {
        jobId,
        error: error.message,
        stack: error.stack,
      });
      // Note: We don't throw here because we want the status update to succeed
      // even if SMS fails. The SMS can be retried manually if needed.
    }
  }

  return updatedJob;
}

/**
 * Phase 3: Generate presigned URLs for photo uploads
 */
export async function generatePresignedUploadUrls(
  jobId: string,
  files: Array<{ filename: string; contentType: string; category?: PhotoMeta['category'] }>
): Promise<Array<{
  photoId: string;
  s3Key: string;
  putUrl: string;
  publicUrl: string;
  contentType: string;
  category?: PhotoMeta['category'];
}>> {
  const config = await import('../config').then(m => m.getConfig());
  
  const uploads = await Promise.all(
    files.map(async (file) => {
      const photoId = uuidv4();
      
      // Generate presigned PUT URL (5 minutes expiry) - this returns the actual S3 key
      const { url: putUrl, key: s3Key } = await s3.generateUploadUrl(jobId, file.filename, file.contentType, 300);
      
      // Build public URL using the actual S3 key
      const publicUrl = `https://${config.aws.s3.photosBucket}.s3.${config.aws.region}.amazonaws.com/${s3Key}`;
      
      return {
        photoId,
        s3Key,
        putUrl,
        publicUrl,
        contentType: file.contentType,
        category: file.category,
      };
    })
  );

  return uploads;
}

/**
 * Phase 3: Commit uploaded photos to job metadata
 */
export async function commitPhotosToJob(
  jobId: string,
  photos: Array<{
    photoId: string;
    s3Key: string;
    publicUrl: string;
    contentType: string;
    category?: 'before' | 'after' | 'damage' | 'other';
  }>,
  userAudit: UserAudit
): Promise<Job | null> {
  const currentJob = await dynamodb.getJob(jobId);
  
  if (!currentJob) {
    return null;
  }

  const newPhotosMeta: PhotoMeta[] = photos.map(photo => ({
    photoId: photo.photoId,
    s3Key: photo.s3Key,
    publicUrl: photo.publicUrl,
    contentType: photo.contentType,
    uploadedAt: new Date().toISOString(),
    uploadedBy: userAudit,
    category: photo.category,
  }));

  const existingPhotosMeta = currentJob.photosMeta || [];
  const updatedPhotosMeta = [...existingPhotosMeta, ...newPhotosMeta];

  return dynamodb.updateJob(jobId, {
    photosMeta: updatedPhotosMeta,
    updatedAt: new Date().toISOString(),
    updatedBy: userAudit,
  });
}

/**
 * Payment toggle: Generate presigned URLs for receipt uploads
 */
export async function generatePresignedReceiptUrls(
  jobId: string,
  files: Array<{ filename: string; contentType: string }>
): Promise<Array<{
  photoId: string;
  s3Key: string;
  putUrl: string;
  publicUrl: string;
  contentType: string;
}>> {
  const config = await import('../config').then(m => m.getConfig());
  
  const uploads = await Promise.all(
    files.map(async (file) => {
      const photoId = uuidv4();
      const timestamp = Date.now();
      const sanitizedFilename = file.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
      
      // Receipt-specific S3 key convention
      const s3Key = `jobs/${jobId}/receipts/${photoId}-${sanitizedFilename}`;
      
      // Generate presigned PUT URL (5 minutes expiry)
      const client = s3.getS3Client();
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      
      const command = new PutObjectCommand({
        Bucket: config.aws.s3.photosBucket,
        Key: s3Key,
        ContentType: file.contentType,
        Metadata: {
          jobId,
          type: 'receipt',
        },
      });
      
      const putUrl = await getSignedUrl(client, command, { expiresIn: 300 });
      
      // Build public URL
      const publicUrl = `https://${config.aws.s3.photosBucket}.s3.${config.aws.region}.amazonaws.com/${s3Key}`;
      
      return {
        photoId,
        s3Key,
        putUrl,
        publicUrl,
        contentType: file.contentType,
      };
    })
  );

  return uploads;
}

/**
 * Payment toggle: Commit uploaded receipts to job record
 */
export async function commitReceiptsToJob(
  jobId: string,
  receipts: Array<{
    photoId: string;
    s3Key: string;
    publicUrl: string;
    contentType: string;
  }>,
  userAudit: UserAudit
): Promise<Job | null> {
  const currentJob = await dynamodb.getJob(jobId);
  
  if (!currentJob) {
    return null;
  }

  const newReceipts = receipts.map(receipt => ({
    photoId: receipt.photoId,
    s3Key: receipt.s3Key,
    publicUrl: receipt.publicUrl,
    contentType: receipt.contentType,
    uploadedAt: new Date().toISOString(),
    uploadedBy: {
      userId: userAudit.userId,
      name: userAudit.name,
      role: 'MANAGER' as const,
    },
  }));

  const existingReceipts = currentJob.receiptPhotos || [];
  const updatedReceipts = [...existingReceipts, ...newReceipts];

  return dynamodb.updateJob(jobId, {
    receiptPhotos: updatedReceipts,
    updatedAt: new Date().toISOString(),
    updatedBy: userAudit,
  });
}
