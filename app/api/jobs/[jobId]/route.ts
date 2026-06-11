/**
 * Jobs API - Get Single Job & Update Job
 * 
 * GET /api/jobs/[jobId] - Get a specific job by ID with photo URLs
 * PATCH /api/jobs/[jobId] - Update job (status, checklist, notes, etc.)
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ApiResponse, UpdateJobRequest } from '@/lib/types';
import { WorkStatus, UserRole, PaymentStatus, ChecklistType } from '@/lib/types';
import { getJobWithPhotos, calculateBookingAmount } from '@/lib/services/job-service';
import { requireAuth } from '@/lib/auth/requireAuth';
import { updateJobWithAudit } from '@/lib/services/job-service';
import * as dynamodb from '@/lib/aws/dynamodb';
import { listServices } from '@/lib/square/catalog-api';
import { retrieveBooking, updateBooking } from '@/lib/square/bookings-api';
import { parseAddonsFromSellerNote } from '@/lib/square/booking-parser';
import * as notificationService from '@/lib/services/notification-service';

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> | { jobId: string } }
): Promise<NextResponse> {
  try {
    // Await params in case it's a Promise (Next.js 15+)
    const params = await Promise.resolve(context.params);
    const jobId = params.jobId;

    if (!jobId) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'MISSING_JOB_ID',
          message: 'Job ID is required',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Get job with photo URLs
    const job = await getJobWithPhotos(jobId);

    if (!job) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'JOB_NOT_FOUND',
          message: `Job ${jobId} not found`,
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Backward-compatibility fallback for legacy jobs that pre-date structured addonNames.
    // When the job is a website booking (has bookingId) but has no addonNames stored,
    // fetch the Square booking's seller_note and parse add-ons from it at read time.
    // This does NOT write back to DynamoDB — it is a live enrichment only.
    if (job.bookingId && (!job.addonNames || job.addonNames.length === 0)) {
      try {
        const squareBooking = await retrieveBooking(job.bookingId);
        if (squareBooking?.seller_note) {
          const parsedNames = parseAddonsFromSellerNote(squareBooking.seller_note);
          if (parsedNames.length > 0) {
            job.addonNames = parsedNames;
            console.log('[JOB GET] Add-ons hydrated from Square seller_note (legacy fallback)', {
              jobId,
              bookingId: job.bookingId,
              count: parsedNames.length,
              names: parsedNames,
            });
          }
        }
      } catch (fallbackError: any) {
        // Non-fatal: log and continue without add-ons
        console.warn('[JOB GET] Square fallback for add-ons failed', {
          jobId,
          bookingId: job.bookingId,
          error: fallbackError.message,
        });
      }
    }

    const response: ApiResponse = {
      success: true,
      data: job,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[JOB GET ERROR]', {
      error: error.message,
      stack: error.stack,
    });

    const response: ApiResponse = {
      success: false,
      error: {
        code: 'JOB_GET_ERROR',
        message: error.message || 'Failed to get job',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 500 });
  }
}

/**
 * PATCH /api/jobs/[jobId]
 * 
 * Update job with audit trail
 * Supports partial updates for:
 * - workStatus
 * - checklist (tech/qc)
 * - notes
 * - vehicleInfo
 */
export const PATCH = requireAuth(async (
  request: NextRequest,
  session,
  context: { params: Promise<{ jobId: string }> | { jobId: string } }
): Promise<NextResponse> => {
  try {
    // Await params in case it's a Promise (Next.js 15+)
    const params = await Promise.resolve(context.params);
    const jobId = params.jobId;

    if (!jobId) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'MISSING_JOB_ID',
          message: 'Job ID is required',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    const body: UpdateJobRequest = await request.json();

    // Validate workStatus if provided
    if (body.workStatus) {
      const validStatuses = Object.values(WorkStatus);
      if (!validStatuses.includes(body.workStatus)) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: `Invalid work status. Must be one of: ${validStatuses.join(', ')}`,
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    // Validate checklist role permissions
    if (body.checklist) {
      const userRole = session.role as UserRole;
      
      if (body.checklist.tech && userRole !== UserRole.TECH && userRole !== UserRole.MANAGER) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only TECH and MANAGER can update tech checklist',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 403 });
      }
      
      if (body.checklist.qc && userRole !== UserRole.QC && userRole !== UserRole.MANAGER) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only QC and MANAGER can update QC checklist',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 403 });
      }
    }

    // Get current job to check for backward movement and issue operations
    const currentJob = await dynamodb.getJob(jobId);
    
    if (!currentJob) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'JOB_NOT_FOUND',
          message: `Job ${jobId} not found`,
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 404 });
    }

    // RULE: CANCELLED jobs cannot be modified (except for viewing)
    if (currentJob.status === WorkStatus.CANCELLED) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'JOB_CANCELLED',
          message: 'Cancelled jobs cannot be modified. The booking was cancelled in Square.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 409 });
    }

    // RULE: WORK_COMPLETED is irreversible - cannot move backward
    if (body.workStatus && currentJob.status === WorkStatus.WORK_COMPLETED && body.workStatus !== WorkStatus.WORK_COMPLETED) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS_TRANSITION',
          message: 'Completed jobs cannot be moved backward. Use post-completion issue tracking instead.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Validate post-completion issue operations
    if (body.openPostCompletionIssue || body.resolvePostCompletionIssue) {
      const userRole = session.role as UserRole;
      
      // Only MANAGER can open/resolve issues
      if (userRole !== UserRole.MANAGER) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only MANAGER can open or resolve post-completion issues',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 403 });
      }

      // Can only open/resolve issues on WORK_COMPLETED jobs
      if (currentJob.status !== WorkStatus.WORK_COMPLETED) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_OPERATION',
            message: 'Post-completion issues can only be managed on completed jobs',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 400 });
      }

      // Cannot open issue if one is already open
      if (body.openPostCompletionIssue && currentJob.postCompletionIssue?.isOpen) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'ISSUE_ALREADY_OPEN',
            message: 'An issue is already open for this job',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 400 });
      }

      // Cannot resolve issue if none is open
      if (body.resolvePostCompletionIssue && !currentJob.postCompletionIssue?.isOpen) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'NO_OPEN_ISSUE',
            message: 'No open issue to resolve',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 400 });
      }

      // Validate issue type if opening
      if (body.openPostCompletionIssue) {
        const validTypes = ['QC_MISS', 'CUSTOMER_COMPLAINT', 'DAMAGE', 'REDO', 'OTHER'];
        if (!validTypes.includes(body.openPostCompletionIssue.type)) {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'INVALID_ISSUE_TYPE',
              message: `Invalid issue type. Must be one of: ${validTypes.join(', ')}`,
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }
      }
    }

    // Validate payment status updates
    if (body.payment) {
      const userRole = session.role as UserRole;
      
      // Only MANAGER can change payment status
      if (userRole !== UserRole.MANAGER) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only MANAGER can change payment status',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 403 });
      }

      // If marking as PAID, require at least one receipt photo
      if (body.payment.status === 'PAID') {
        if (!currentJob.receiptPhotos || currentJob.receiptPhotos.length === 0) {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'RECEIPT_REQUIRED',
              message: 'At least one receipt photo is required to mark payment as PAID',
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }
      }

      // If marking as UNPAID, require a reason
      if (body.payment.status === 'UNPAID') {
        if (!body.payment.unpaidReason) {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'UNPAID_REASON_REQUIRED',
              message: 'A reason is required when marking payment as UNPAID',
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }
      }
    }

    // Phase 5: Validate no-show operations
    if (body.noShow) {
      const userRole = session.role as UserRole;
      
      // Only MANAGER can mark/resolve no-show
      if (userRole !== UserRole.MANAGER) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Only MANAGER can manage no-show status',
          },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 403 });
      }

      // Marking as NO_SHOW
      if (body.noShow.status === 'NO_SHOW') {
        // Cannot mark NO_SHOW if already QC_READY or WORK_COMPLETED
        if (currentJob.status === WorkStatus.QC_READY || currentJob.status === WorkStatus.WORK_COMPLETED) {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'INVALID_STATUS_FOR_NO_SHOW',
              message: 'Cannot mark as no-show when job is in QC_READY or WORK_COMPLETED status',
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }

        // Require reason when marking as NO_SHOW
        if (!body.noShow.reason) {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'NO_SHOW_REASON_REQUIRED',
              message: 'A reason is required when marking as no-show',
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }
      }

      // Resolving NO_SHOW
      if (body.noShow.status === 'RESOLVED') {
        // Can only resolve if currently marked as NO_SHOW
        if (!currentJob.noShow || currentJob.noShow.status !== 'NO_SHOW') {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'NO_OPEN_NO_SHOW',
              message: 'Can only resolve when job is marked as no-show',
            },
            timestamp: new Date().toISOString(),
          };
          return NextResponse.json(response, { status: 400 });
        }
      }
    }

    // Handle add-ons update
    if (body.addonNames !== undefined) {
      console.log('[JOB UPDATE] Updating add-ons', {
        jobId,
        addonNames: body.addonNames,
      });
      
      // Parse existing notes to preserve non-addon content
      let baseNotes = currentJob.notes || '';
      
      // Remove existing add-ons section if present
      baseNotes = baseNotes.replace(/\n\n✅\s*ADD-ONS\s+REQUESTED:[\s\S]*?(?=\n\n|$)/gi, '');
      baseNotes = baseNotes.trim();
      
      // Add new add-ons section if any selected
      if (body.addonNames.length > 0) {
        const addonsSection = `\n\n✅ ADD-ONS REQUESTED:\n${body.addonNames.map((name: string) => `• ${name}`).join('\n')}\n\n⚠️ Add-ons charged separately`;
        baseNotes = (baseNotes + addonsSection).trim();
      }
      
      // Update notes in the request body
      body.notes = baseNotes;
      
      console.log('[JOB UPDATE] Updated notes with add-ons', {
        jobId,
        notesLength: baseNotes.length,
        hasAddons: baseNotes.includes('ADD-ONS'),
      });
      
      // Recalculate payment if job is unpaid
      if (!currentJob.payment || currentJob.payment.status === PaymentStatus.UNPAID) {
        try {
          console.log('[JOB UPDATE] Recalculating payment for add-ons change', {
            jobId,
            serviceType: currentJob.serviceType,
          });
          
          // Look up service variation ID by service name
          const services = await listServices();
          const matchingService = services.find(s => s.name === currentJob.serviceType);
          
          if (matchingService) {
            const amountCents = await calculateBookingAmount(matchingService.id, baseNotes);
            
            if (amountCents) {
              body.payment = {
                status: PaymentStatus.UNPAID,
                amountCents,
              };
              
              console.log('[JOB UPDATE] Payment recalculated', {
                jobId,
                amountCents,
                amountDollars: (amountCents / 100).toFixed(2),
              });
            } else {
              console.warn('[JOB UPDATE] Payment recalculation returned undefined', {
                jobId,
              });
            }
          } else {
            console.warn('[JOB UPDATE] Could not find service variation ID', {
              jobId,
              serviceType: currentJob.serviceType,
            });
          }
        } catch (error: any) {
          console.error('[JOB UPDATE] Payment recalculation failed', {
            jobId,
            error: error.message,
          });
          // Continue without failing the update
        }
      } else {
        console.log('[JOB UPDATE] Skipping payment recalculation - job is paid', {
          jobId,
          paymentStatus: currentJob.payment.status,
        });
      }
      
      // Sync add-ons back to Square booking if bookingId exists
      if (currentJob.bookingId && baseNotes) {
        try {
          console.log('[JOB UPDATE] Syncing add-ons to Square booking', {
            jobId,
            bookingId: currentJob.bookingId,
          });
          
          // Fetch current booking to get version
          const currentBooking = await retrieveBooking(currentJob.bookingId);
          
          if (currentBooking && currentBooking.version) {
            // Extract just the add-ons section from notes
            const addonsMatch = baseNotes.match(/✅\s*ADD-ONS\s+REQUESTED:[\s\S]*?(?=\n\n⚠️|$)/i);
            let sellerNote = '';
            
            if (addonsMatch) {
              // Include the add-ons section and warning
              sellerNote = addonsMatch[0];
              if (baseNotes.includes('⚠️ Add-ons charged separately')) {
                sellerNote += '\n\n⚠️ Add-ons charged separately';
              }
            }
            
            // Update booking with new seller_note
            await updateBooking({
              bookingId: currentJob.bookingId,
              version: currentBooking.version,
              sellerNote,
            });
            
            console.log('[JOB UPDATE] Successfully synced add-ons to Square', {
              jobId,
              bookingId: currentJob.bookingId,
            });
          } else {
            console.warn('[JOB UPDATE] Could not get booking version', {
              jobId,
              bookingId: currentJob.bookingId,
            });
          }
        } catch (error: any) {
          console.error('[JOB UPDATE] Failed to sync add-ons to Square', {
            jobId,
            bookingId: currentJob.bookingId,
            error: error.message,
          });
          // Continue without failing the job update
        }
      }
    }

    // Auto-initialize checklists when transitioning to CHECKED_IN
    if (body.workStatus === WorkStatus.CHECKED_IN && currentJob.status !== WorkStatus.CHECKED_IN) {
      console.log(`[ChecklistAutoInit] Job ${jobId} transitioning to CHECKED_IN, checking if checklists need initialization...`);
      
      // Check if checklists are empty or missing
      const needsInitialization = !currentJob.checklist || 
        (!currentJob.checklist.tech?.length && !currentJob.checklist.qc?.length);
      
      if (needsInitialization) {
        console.log(`[ChecklistAutoInit] Initializing checklists for job ${jobId} with service type: ${currentJob.serviceType}`);
        
        try {
          // Import checklist service
          const checklistTemplateService = await import('@/lib/services/checklist-template-service');
          const { v4: uuidv4 } = await import('uuid');
          
          // Get templates
          const techTemplateItems = await checklistTemplateService.getActiveTemplateItems(
            currentJob.serviceType,
            ChecklistType.TECH
          );
          const qcTemplateItems = await checklistTemplateService.getActiveTemplateItems(
            currentJob.serviceType,
            ChecklistType.QC
          );
          
          // Convert to checklist items
          const techChecklist = techTemplateItems.map((item) => ({
            id: uuidv4(),
            label: item.label,
            checked: false,
          }));
          const qcChecklist = qcTemplateItems.map((item) => ({
            id: uuidv4(),
            label: item.label,
            checked: false,
          }));
          
          // Add checklists to the update body
          body.checklist = {
            tech: techChecklist,
            qc: qcChecklist,
          };
          
          console.log(`[ChecklistAutoInit] Initialized checklists for job ${jobId}:`, {
            techItems: techChecklist.length,
            qcItems: qcChecklist.length,
          });
        } catch (error: any) {
          console.error(`[ChecklistAutoInit] Failed to initialize checklists for job ${jobId}:`, error);
          // Don't fail the status update, just log the error
        }
      } else {
        console.log(`[ChecklistAutoInit] Job ${jobId} already has checklists, skipping initialization`);
      }
    }

    // Update job with audit trail
    const updatedJob = await updateJobWithAudit(jobId, body, {
      userId: session.sub,
      name: session.name,
      role: session.role as UserRole,
    });

    if (!updatedJob) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'JOB_NOT_FOUND',
          message: `Job ${jobId} not found`,
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Generate notifications for major changes
    try {
      // Status change notification
      if (body.workStatus && currentJob && body.workStatus !== currentJob.status) {
        await notificationService.notifyJobStatusChanged(
          updatedJob,
          currentJob.status,
          body.workStatus,
          session.sub,
          session.email
        );
        console.log('[NOTIFICATION] Status change notification sent', {
          jobId,
          oldStatus: currentJob.status,
          newStatus: body.workStatus,
          actorEmail: session.email,
        });
      }

      // Checklist update notification
      if (body.checklist) {
        const checklistType = body.checklist.tech ? 'tech' : 'qc';
        await notificationService.notifyChecklistUpdated(
          updatedJob,
          checklistType,
          session.sub,
          session.email
        );
        console.log('[NOTIFICATION] Checklist update notification sent', {
          jobId,
          checklistType,
          actorEmail: session.email,
        });
      }

      // Add-ons update notification
      if (body.addonNames && body.addonNames.length > 0) {
        await notificationService.notifyAddonsUpdated(
          updatedJob,
          body.addonNames,
          session.sub,
          session.email
        );
        console.log('[NOTIFICATION] Add-ons update notification sent', {
          jobId,
          addons: body.addonNames,
          actorEmail: session.email,
        });
      }
    } catch (notificationError: any) {
      // Don't fail the request if notification fails
      console.error('[NOTIFICATION ERROR]', {
        jobId,
        error: notificationError.message,
        stack: notificationError.stack,
      });
    }

    const response: ApiResponse = {
      success: true,
      data: { job: updatedJob },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[JOB PATCH ERROR]', {
      error: error.message,
      stack: error.stack,
    });

    const response: ApiResponse = {
      success: false,
      error: {
        code: 'JOB_UPDATE_ERROR',
        message: error.message || 'Failed to update job',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 500 });
  }
});

