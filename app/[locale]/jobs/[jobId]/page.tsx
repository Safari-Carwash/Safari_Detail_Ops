'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { useTranslations } from '@/lib/i18n/provider';
import { usePolling } from '@/lib/hooks/usePolling';
import { WorkStatus, PaymentStatus, ChecklistItem } from '@/lib/types';
import type { Locale } from '@/i18n';
import PhotoUploader from './PhotoUploader';
import EditBookingModal from '@/app/components/EditBookingModal';

interface Job {
  jobId: string;
  jobNumber?: number; // Unique job number (10001, 10002, etc.)
  bookingId?: string;
  orderId?: string;
  squareOrderId?: string;
  depositPaymentId?: string;
  depositReceiptNumber?: string;
  depositPaymentNote?: string;
  depositAmountCents?: number;
  depositCurrency?: string;
  depositPaymentStatus?: string;
  source?: 'website' | 'manual'; // Booking source
  createdAt?: string;
  createdBy?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  notes?: string;
  vehicleInfo: {
    make?: string;
    model?: string;
    year?: number;
    color?: string;
    licensePlate?: string;
  };
  serviceType: string;
  scheduledStart?: string;
  appointmentTime?: string;
  workStatus: WorkStatus;
  status: string;
  payment?: {
    status: PaymentStatus;
    amountCents?: number;
    paidAt?: string;
    paidBy?: {
      name: string;
    };
    unpaidReason?: string;
    unpaidNote?: string;
  };
  checklist?: {
    tech?: ChecklistItem[];
    qc?: ChecklistItem[];
  };
  photosMeta?: Array<any>;
  receiptPhotos?: Array<{
    photoId: string;
    publicUrl: string;
    uploadedAt: string;
    uploadedBy: {
      name: string;
    };
  }>;
  customerCached?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  postCompletionIssue?: {
    isOpen: boolean;
    type: string;
    notes?: string;
    openedAt: string;
    openedBy: {
      name: string;
    };
    resolvedAt?: string;
    resolvedBy?: {
      name: string;
    };
  };
  noShow?: {
    status: 'NONE' | 'NO_SHOW' | 'RESOLVED';
    reason?: 'NO_ARRIVAL' | 'LATE_CANCEL' | 'UNREACHABLE' | 'OTHER';
    notes?: string;
    updatedAt: string;
    updatedBy: {
      userId: string;
      name: string;
      role: 'MANAGER';
    };
    resolvedAt?: string;
    resolvedBy?: {
      userId: string;
      name: string;
      role: 'MANAGER';
    };
  };
}

export default function JobDetail() {
  const t = useTranslations('job');
  const tCommon = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const locale = params.locale as Locale;
  const jobId = params.jobId as string;

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [showPhotoUploader, setShowPhotoUploader] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<any | null>(null);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issueType, setIssueType] = useState<'QC_MISS' | 'CUSTOMER_COMPLAINT' | 'DAMAGE' | 'REDO' | 'OTHER'>('OTHER');
  const [issueNotes, setIssueNotes] = useState('');

  // Payment toggle state
  const [showReceiptUploadModal, setShowReceiptUploadModal] = useState(false);
  const [showUnpaidModal, setShowUnpaidModal] = useState(false);
  const [unpaidReason, setUnpaidReason] = useState<string>('Refunded');
  const [unpaidNote, setUnpaidNote] = useState('');
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [uploadingReceipts, setUploadingReceipts] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<any | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string>('TECH'); // Will be fetched from /api/auth/me
  const [editingAmount, setEditingAmount] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);

  // Phase 5: No-show state
  const [showNoShowModal, setShowNoShowModal] = useState(false);
  const [showNoShowResolveModal, setShowNoShowResolveModal] = useState(false);
  const [noShowReason, setNoShowReason] = useState<'NO_ARRIVAL' | 'LATE_CANCEL' | 'UNREACHABLE' | 'OTHER'>('NO_ARRIVAL');
  const [noShowNotes, setNoShowNotes] = useState('');

  // Image error tracking for expired presigned URLs
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

  // Vehicle editing state
  const [editingVehicle, setEditingVehicle] = useState(false);
  const [vehicleForm, setVehicleForm] = useState({
    make: '',
    model: '',
    year: '',
    color: '',
    licensePlate: '',
  });
  const [serviceTypeForm, setServiceTypeForm] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [loadingServices, setLoadingServices] = useState(false);
  const [savingVehicle, setSavingVehicle] = useState(false);

  // Add-ons state
  const [addons, setAddons] = useState<Array<{
    name: string;
  }>>([]);
  const [loadingAddons, setLoadingAddons] = useState(false);
  
  // Add-ons editing state
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set());
  const [availableAddons, setAvailableAddons] = useState<Array<{
    id: string;
    name: string;
    priceMoney?: { amount: number; currency: string };
  }>>([]);

  // Booking edit state
  const [showEditBookingModal, setShowEditBookingModal] = useState(false);

  /**
   * Parse add-ons from booking notes
   * Format: "✅ ADD-ONS REQUESTED:\n• Addon 1\n• Addon 2"
   */
  const parseAddonsFromNotes = (notes: string | undefined): Array<{ name: string }> => {
    console.log('[ADDONS PARSER] Parsing notes', {
      hasNotes: !!notes,
      notesLength: notes?.length,
      notesPreview: notes?.substring(0, 200),
    });
    
    if (!notes) {
      console.log('[ADDONS PARSER] No notes to parse');
      return [];
    }
    
    // Look for the add-ons section (support both emoji and text variants)
    const addonsMatch = notes.match(/[✅✓]\s*ADD[-\s]ONS\s+REQUESTED:\s*([\s\S]*?)(?:\n\n|⚠️|$)/i);
    
    console.log('[ADDONS PARSER] Regex match result', {
      matched: !!addonsMatch,
      matchedText: addonsMatch?.[1]?.substring(0, 100),
    });
    
    if (!addonsMatch) {
      console.log('[ADDONS PARSER] No add-ons section found in notes');
      return [];
    }
    
    const addonsText = addonsMatch[1];
    
    // Extract individual add-ons (lines starting with • or -)
    const addonLines = addonsText.split('\n').filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('*');
    });
    
    console.log('[ADDONS PARSER] Extracted addon lines', {
      count: addonLines.length,
      lines: addonLines,
    });
    
    const parsedAddons = addonLines.map(line => ({
      name: line.replace(/^[•\-*]\s*/, '').trim(),
    }));
    
    console.log('[ADDONS PARSER] Final parsed add-ons', parsedAddons);
    
    return parsedAddons;
  };

  // Format last updated time
  const formatLastUpdated = (date: Date | null): string => {
    if (!date) return '';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  // Show toast notification
  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchJob = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/jobs/${jobId}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch job: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.data) {
        const apiJob = data.data;
        
        // Initialize default checklists if not present
        const defaultTechChecklist: ChecklistItem[] = [
          { id: 'tech-1', label: t('checklist.vacuumInterior'), checked: false },
          { id: 'tech-2', label: t('checklist.cleanWindows'), checked: false },
          { id: 'tech-3', label: t('checklist.washExterior'), checked: false },
          { id: 'tech-4', label: t('checklist.dryDetail'), checked: false },
        ];
        
        const defaultQcChecklist: ChecklistItem[] = [
          { id: 'qc-1', label: 'Inspect interior cleanliness', checked: false },
          { id: 'qc-2', label: 'Check exterior finish', checked: false },
          { id: 'qc-3', label: 'Verify all surfaces dry', checked: false },
        ];
        
        setJob({
          jobId: apiJob.jobId,
          jobNumber: apiJob.jobNumber,
          bookingId: apiJob.bookingId,
          orderId: apiJob.orderId,
          squareOrderId: apiJob.squareOrderId,
          depositPaymentId: apiJob.depositPaymentId,
          depositReceiptNumber: apiJob.depositReceiptNumber,
          depositPaymentNote: apiJob.depositPaymentNote,
          depositAmountCents: apiJob.depositAmountCents,
          depositCurrency: apiJob.depositCurrency,
          depositPaymentStatus: apiJob.depositPaymentStatus,
          source: apiJob.source,
          createdAt: apiJob.createdAt,
          createdBy: apiJob.createdBy,
          customerName: apiJob.customerCached?.name || apiJob.customerName || 'Unknown Customer',
          customerPhone: apiJob.customerCached?.phone || apiJob.customerPhone,
          customerEmail: apiJob.customerCached?.email || apiJob.customerEmail,
          notes: apiJob.notes,
          vehicleInfo: apiJob.vehicleInfo || {},
          serviceType: apiJob.serviceType || 'Service details pending',
          scheduledStart: apiJob.appointmentTime || apiJob.createdAt,
          appointmentTime: apiJob.appointmentTime,
          workStatus: (apiJob.status?.toUpperCase() as WorkStatus) || WorkStatus.SCHEDULED,
          status: apiJob.status,
          payment: apiJob.payment || {
            status: PaymentStatus.UNPAID,
            amountCents: 0,
          },
          checklist: {
            tech: apiJob.checklist?.tech || defaultTechChecklist,
            qc: apiJob.checklist?.qc || defaultQcChecklist,
          },
          photosMeta: apiJob.photosMeta || [],
          receiptPhotos: apiJob.receiptPhotos || [],
          customerCached: apiJob.customerCached,
          postCompletionIssue: apiJob.postCompletionIssue,
        });
      } else {
        throw new Error('Invalid API response');
      }
    } catch (err) {
      console.error('Failed to fetch job:', err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJob();
  }, [jobId]);

  // Parse add-ons from job notes when job is loaded or updated
  useEffect(() => {
    if (!job) {
      setAddons([]);
      return;
    }
    
    setLoadingAddons(true);
    
    try {
      console.log('[JOB DETAILS] Parsing add-ons from notes', {
        jobId: job.jobId,
        hasNotes: !!job.notes,
      });
      
      const parsedAddons = parseAddonsFromNotes(job.notes);
      
      setAddons(parsedAddons);
      console.log('[JOB DETAILS] Add-ons parsed from notes', {
        count: parsedAddons.length,
        addons: parsedAddons,
      });
    } catch (error) {
      console.error('[JOB DETAILS] Failed to parse add-ons', error);
      setAddons([]);
    } finally {
      setLoadingAddons(false);
    }
  }, [job?.notes, job?.jobId]);

  // Phase 4: Polling for real-time updates
  const pollingFetcher = useCallback(async (): Promise<Job> => {
    const response = await fetch(`/api/jobs/${jobId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch job: ${response.status}`);
    }
    const data = await response.json();
    
    if (data.success && data.data) {
      const apiJob = data.data;
      
      const defaultTechChecklist: ChecklistItem[] = [
        { id: 'tech-1', label: t('checklist.vacuumInterior'), checked: false },
        { id: 'tech-2', label: t('checklist.cleanWindows'), checked: false },
        { id: 'tech-3', label: t('checklist.washExterior'), checked: false },
        { id: 'tech-4', label: t('checklist.dryDetail'), checked: false },
      ];
      
      const defaultQcChecklist: ChecklistItem[] = [
        { id: 'qc-1', label: 'Inspect interior cleanliness', checked: false },
        { id: 'qc-2', label: 'Check exterior finish', checked: false },
        { id: 'qc-3', label: 'Verify all surfaces dry', checked: false },
      ];
      
      return {
        jobId: apiJob.jobId,
        bookingId: apiJob.bookingId,
        orderId: apiJob.orderId,
        squareOrderId: apiJob.squareOrderId,
        depositPaymentId: apiJob.depositPaymentId,
        depositReceiptNumber: apiJob.depositReceiptNumber,
        depositPaymentNote: apiJob.depositPaymentNote,
        depositAmountCents: apiJob.depositAmountCents,
        depositCurrency: apiJob.depositCurrency,
        depositPaymentStatus: apiJob.depositPaymentStatus,
        customerName: apiJob.customerCached?.name || apiJob.customerName || 'Unknown Customer',
        customerPhone: apiJob.customerCached?.phone || apiJob.customerPhone,
        customerEmail: apiJob.customerCached?.email || apiJob.customerEmail,
        notes: apiJob.notes,
        vehicleInfo: apiJob.vehicleInfo || {},
        serviceType: apiJob.serviceType || 'Service details pending',
        scheduledStart: apiJob.appointmentTime || apiJob.createdAt,
        appointmentTime: apiJob.appointmentTime,
        workStatus: (apiJob.status?.toUpperCase() as WorkStatus) || WorkStatus.SCHEDULED,
        status: apiJob.status,
        payment: apiJob.payment || {
          status: PaymentStatus.UNPAID,
          amountCents: 0,
        },
        checklist: {
          tech: apiJob.checklist?.tech || defaultTechChecklist,
          qc: apiJob.checklist?.qc || defaultQcChecklist,
        },
        photosMeta: apiJob.photosMeta || [],
        receiptPhotos: apiJob.receiptPhotos || [],
        customerCached: apiJob.customerCached,
        postCompletionIssue: apiJob.postCompletionIssue,
      };
    } else {
      throw new Error('Invalid API response');
    }
  }, [jobId, t]);

  // Poll every 20 seconds, pause when hidden
  const { data: polledJob, lastUpdatedAt } = usePolling(
    pollingFetcher,
    20000,
    { enabled: !loading && !error, runOnMount: false, pauseWhenHidden: true }
  );

  // Sync polled data to job state (only if not currently updating)
  useEffect(() => {
    if (polledJob && !updating) {
      setJob(polledJob);
      setLastPolledAt(lastUpdatedAt);
    }
  }, [polledJob, updating, lastUpdatedAt]);

  // Fetch current user role
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          console.log('User data:', data); // Debug log
          if (data.success && data.data?.user?.role) {
            console.log('Setting role to:', data.data.user.role); // Debug log
            setCurrentUserRole(data.data.user.role);
          }
        } else {
          console.error('Auth response not ok:', response.status);
        }
      } catch (err) {
        console.error('Failed to fetch user:', err);
      }
    };
    fetchUser();
  }, []);

  const refreshJob = async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data) {
          const apiJob = data.data;
          setJob(prev => prev ? {
            ...prev,
            photosMeta: apiJob.photosMeta || [],
            receiptPhotos: apiJob.receiptPhotos || [],
            checklist: apiJob.checklist || prev.checklist,
          } : null);
          // Clear image errors to allow retrying with new URLs
          setImageErrors(new Set());
        }
      }
    } catch (err) {
      console.error('Failed to refresh job:', err);
    }
  };

  // Handle image load error (e.g., expired presigned URLs)
  const handleImageError = useCallback(async (imageId: string) => {
    if (!imageErrors.has(imageId)) {
      console.log('Image load failed, refreshing URLs:', imageId);
      setImageErrors(prev => new Set(prev).add(imageId));
      // Refresh job to get new presigned URLs
      await refreshJob();
    }
  }, [imageErrors, jobId]);

  const handleStatusChange = async (newStatus: WorkStatus) => {
    if (!job || updating) return;
    
    setUpdating(true);
    const previousStatus = job.workStatus;

    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workStatus: newStatus }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to update status');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob({ ...job, workStatus: newStatus, status: newStatus });
        showToast('Status updated successfully', 'success');
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (err) {
      console.error('Failed to update status:', err);
      showToast((err as Error).message, 'error');
      setJob({ ...job, workStatus: previousStatus });
    } finally {
      setUpdating(false);
    }
  };

  const handleChecklistToggle = async (type: 'tech' | 'qc', itemId: string) => {
    if (!job || updating) return;

    const currentChecklist = job.checklist?.[type] || [];
    const updatedChecklist = currentChecklist.map(item =>
      item.id === itemId ? { ...item, checked: !item.checked } : item
    );

    setJob({
      ...job,
      checklist: {
        ...job.checklist!,
        [type]: updatedChecklist,
      },
    });

    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checklist: {
            [type]: updatedChecklist,
          },
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update checklist');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        if (data.data.job.checklist) {
          setJob(prev => prev ? { ...prev, checklist: data.data.job.checklist } : null);
        }
      }
    } catch (err) {
      console.error('Failed to update checklist:', err);
      showToast('Failed to save checklist change', 'error');
      setJob({
        ...job,
        checklist: {
          ...job.checklist!,
          [type]: currentChecklist,
        },
      });
    }
  };

  const handleOpenIssue = async () => {
    if (!job || updating) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openPostCompletionIssue: {
            type: issueType,
            notes: issueNotes,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to open issue');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, postCompletionIssue: data.data.job.postCompletionIssue } : null);
        showToast('Issue reported successfully', 'success');
        setShowIssueModal(false);
        setIssueNotes('');
        setIssueType('OTHER');
      }
    } catch (err) {
      console.error('Failed to open issue:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  const handleResolveIssue = async () => {
    if (!job || updating) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolvePostCompletionIssue: true,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to resolve issue');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, postCompletionIssue: data.data.job.postCompletionIssue } : null);
        showToast('Issue resolved successfully', 'success');
      }
    } catch (err) {
      console.error('Failed to resolve issue:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  // Payment toggle handlers
  const handlePaymentToggle = () => {
    console.log('handlePaymentToggle called. currentUserRole:', currentUserRole); // Debug log
    if (!job || currentUserRole !== 'MANAGER') {
      console.log('Early return - job:', !!job, 'role:', currentUserRole); // Debug log
      return;
    }

    const currentStatus = job.payment?.status || PaymentStatus.UNPAID;

    if (currentStatus === PaymentStatus.UNPAID) {
      // Toggling to PAID - check for receipts
      if (!job.receiptPhotos || job.receiptPhotos.length === 0) {
        // No receipts, show upload modal
        setShowReceiptUploadModal(true);
      } else {
        // Receipts exist, mark as paid directly
        handleMarkPaid();
      }
    } else {
      // Toggling to UNPAID - show reason modal
      setShowUnpaidModal(true);
    }
  };

  const handleReceiptUpload = async () => {
    if (!receiptFiles.length || uploadingReceipts) return;

    setUploadingReceipts(true);
    try {
      // Step 1: Get presigned URLs
      const presignResponse = await fetch(`/api/jobs/${jobId}/receipts/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: receiptFiles.map(file => ({
            filename: file.name,
            contentType: file.type,
          })),
        }),
      });

      if (!presignResponse.ok) {
        throw new Error('Failed to get upload URLs');
      }

      const presignData = await presignResponse.json();
      const uploads = presignData.data.uploads;

      // Step 2: Upload each file to S3
      await Promise.all(
        receiptFiles.map(async (file, index) => {
          const upload = uploads[index];
          const uploadResponse = await fetch(upload.putUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file,
          });
          if (!uploadResponse.ok) {
            throw new Error(`Failed to upload ${file.name}`);
          }
        })
      );

      // Step 3: Commit uploads to job record
      const commitResponse = await fetch(`/api/jobs/${jobId}/receipts/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: uploads.map((upload: any) => ({
            photoId: upload.photoId,
            s3Key: upload.s3Key,
            publicUrl: upload.publicUrl,
            contentType: upload.contentType,
          })),
        }),
      });

      if (!commitResponse.ok) {
        throw new Error('Failed to save receipt records');
      }

      const commitData = await commitResponse.json();
      
      // Update job with new receipt photos
      setJob(prev => prev ? { 
        ...prev, 
        receiptPhotos: commitData.data.job.receiptPhotos 
      } : null);

      showToast('Receipt photo saved successfully', 'success');
      setReceiptFiles([]);
    } catch (err) {
      console.error('Failed to save receipt:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUploadingReceipts(false);
    }
  };

  const handleMarkPaid = async () => {
    if (!job || updating) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment: { status: PaymentStatus.PAID },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to mark as paid');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, payment: data.data.job.payment } : null);
        showToast('Payment marked as PAID', 'success');
        setShowReceiptUploadModal(false);
      }
    } catch (err) {
      console.error('Failed to mark paid:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  const handleMarkUnpaid = async () => {
    if (!job || updating || !unpaidReason) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment: {
            status: PaymentStatus.UNPAID,
            unpaidReason,
            unpaidNote,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to mark as unpaid');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, payment: data.data.job.payment } : null);
        showToast('Payment marked as UNPAID', 'success');
        setShowUnpaidModal(false);
        setUnpaidNote('');
        setUnpaidReason('Refunded');
      }
    } catch (err) {
      console.error('Failed to mark unpaid:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  const handleAmountUpdate = async () => {
    if (!job || updating || !amountInput) return;

    const amountCents = Math.round(parseFloat(amountInput) * 100);
    if (isNaN(amountCents) || amountCents < 0) {
      showToast('Invalid amount', 'error');
      return;
    }

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment: {
            ...job.payment,
            amountCents,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to update amount');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, payment: data.data.job.payment } : null);
        showToast('Amount updated successfully', 'success');
        setEditingAmount(false);
      }
    } catch (err) {
      console.error('Failed to update amount:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  // Phase 5: No-show handlers
  const handleMarkNoShow = async () => {
    if (!job || updating || !noShowReason) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noShow: {
            status: 'NO_SHOW',
            reason: noShowReason,
            notes: noShowNotes || undefined,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to mark as no-show');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, noShow: data.data.job.noShow } : null);
        showToast(t('noShow.successMarked'), 'success');
        setShowNoShowModal(false);
        setNoShowNotes('');
        setNoShowReason('NO_ARRIVAL');
      }
    } catch (err) {
      console.error('Failed to mark no-show:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  const handleResolveNoShow = async () => {
    if (!job || updating) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noShow: {
            status: 'RESOLVED',
            notes: noShowNotes || undefined,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to resolve no-show');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { ...prev, noShow: data.data.job.noShow } : null);
        showToast(t('noShow.successResolved'), 'success');
        setShowNoShowResolveModal(false);
        setNoShowNotes('');
      }
    } catch (err) {
      console.error('Failed to resolve no-show:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  // Vehicle editing handlers
  const fetchServices = async () => {
    try {
      setLoadingServices(true);
      const response = await fetch('/api/services');
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data?.serviceTypes) {
          setServices(data.data.serviceTypes);
        }
      }
    } catch (err) {
      console.error('Failed to fetch services:', err);
    } finally {
      setLoadingServices(false);
    }
  };

  const fetchAvailableAddons = async () => {
    try {
      const response = await fetch('/api/addons');
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data?.addons) {
          setAvailableAddons(data.data.addons);
          return data.data.addons; // Return fetched addons
        }
      }
    } catch (err) {
      console.error('Failed to fetch add-ons:', err);
    }
    return []; // Return empty array on error
  };

  const handleEditVehicle = () => {
    if (!job) return;
    
    // Populate form with current values
    setVehicleForm({
      make: job.vehicleInfo.make || '',
      model: job.vehicleInfo.model || '',
      year: job.vehicleInfo.year?.toString() || '',
      color: job.vehicleInfo.color || '',
      licensePlate: job.vehicleInfo.licensePlate || '',
    });
    setServiceTypeForm(job.serviceType || '');
    
    // Pre-select current add-ons by matching names
    const currentAddonNames = new Set(addons.map(a => a.name.toLowerCase()));
    
    // Load services and add-ons
    fetchServices();
    fetchAvailableAddons().then((fetchedAddons) => {
      // Match current add-ons to available add-ons by name using fetched data
      const preselectedIds = new Set<string>();
      fetchedAddons.forEach((addon: { id: string; name: string; priceMoney?: { amount: number; currency: string } }) => {
        if (currentAddonNames.has(addon.name.toLowerCase())) {
          preselectedIds.add(addon.id);
        }
      });
      setSelectedAddonIds(preselectedIds);
    });
    
    setEditingVehicle(true);
  };

  const handleSaveVehicle = async () => {
    if (!job || savingVehicle) return;

    setSavingVehicle(true);
    try {
      const requestBody: any = {
        vehicleInfo: {
          make: vehicleForm.make || undefined,
          model: vehicleForm.model || undefined,
          year: vehicleForm.year ? parseInt(vehicleForm.year) : undefined,
          color: vehicleForm.color || undefined,
          licensePlate: vehicleForm.licensePlate || undefined,
        },
      };

      // Only include serviceType if it was changed
      if (serviceTypeForm && serviceTypeForm !== job.serviceType) {
        requestBody.serviceType = serviceTypeForm;
      }
      
      // Include add-ons if changed
      const selectedAddonNames = availableAddons
        .filter(addon => selectedAddonIds.has(addon.id))
        .map(addon => addon.name);
      
      requestBody.addonNames = selectedAddonNames;
      
      console.log('[VEHICLE EDIT] Saving with add-ons', {
        selectedAddonIds: Array.from(selectedAddonIds),
        selectedAddonNames,
      });

      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to update vehicle info');
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJob(prev => prev ? { 
          ...prev, 
          vehicleInfo: data.data.job.vehicleInfo,
          serviceType: data.data.job.serviceType,
          notes: data.data.job.notes,
          payment: data.data.job.payment,
        } : null);
        showToast('Vehicle info updated successfully', 'success');
        setEditingVehicle(false);
      }
    } catch (err) {
      console.error('Failed to update vehicle:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setSavingVehicle(false);
    }
  };

  const handleCancelEditVehicle = () => {
    setEditingVehicle(false);
    setVehicleForm({
      make: '',
      model: '',
      year: '',
      color: '',
      licensePlate: '',
    });
    setServiceTypeForm('');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--sf-bg)' }}>
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-[#F47C20] mb-4"></div>
          <p style={{ color: 'var(--sf-muted)' }}>{t('loadingDetails')}</p>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--sf-bg)' }}>
        <div className="text-center max-w-md">
          <div className="text-red-500 text-5xl mb-4">
            <svg className="w-20 h-20 mx-auto" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--sf-ink)' }}>{t('failedToLoad')}</h2>
          <p className="mb-4" style={{ color: 'var(--sf-muted)' }}>{error || t('notFound')}</p>
          <button
            onClick={() => router.back()}
            className="px-6 py-3 bg-[#F47C20] text-white rounded-xl hover:bg-[#DB6E1C] sf-button-transition"
          >
            ← {t('goBack')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--sf-bg)' }}>
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-6 py-3 rounded-lg shadow-lg ${
          toast.type === 'success' ? 'bg-green-500' : 'bg-red-500'
        } text-white`}>
          {toast.message}
        </div>
      )}

      {/* Header */}
      <header className="bg-white shadow-sm border-b-[3px] border-[#F47C20]" style={{ boxShadow: 'var(--sf-shadow)' }}>
        <div className="container mx-auto px-4 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.back()}
                className="px-5 py-2 bg-white border border-[#E7E2D8] rounded-xl hover:bg-[#FAF6EF] sf-button-transition"
                style={{ color: 'var(--sf-ink)' }}
              >
                {locale === 'ar' ? '→' : '←'} {tCommon('back')}
              </button>
              <Image src="/safari-logo.png" alt="Safari Car Wash" width={50} height={50} className="object-contain" />
              <h1 className="text-xl font-bold" style={{ color: 'var(--sf-ink)' }}>{t('title')}</h1>
            </div>
            {lastPolledAt && (
              <div className="text-xs" style={{ color: 'var(--sf-muted)' }}>
                Updated {formatLastUpdated(lastPolledAt)}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-4xl">
        {/* Job Number Display */}
        {job?.jobNumber && (
          <div className="bg-[#F47C20] rounded-2xl p-4 mb-6 text-center">
            <p className="text-white text-2xl font-bold">Job #{String(job.jobNumber).padStart(5, '0')}</p>
          </div>
        )}
        
        {/* Booking Information */}
        <section className="bg-white rounded-2xl p-6 mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--sf-ink)' }}>Booking Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Source */}
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Source</label>
              <div className="font-medium flex items-center gap-2" style={{ color: 'var(--sf-ink)' }}>
                {(() => {
                  // DEBUG: Log current state
                  const explicit = job?.source;
                  const hasBkng = !!job?.bookingId;
                  const hasSqOrd = !!job?.squareOrderId;
                  if (!explicit) {
                    console.log('[SOURCE DEBUG]', { source: explicit, bookingId: hasBkng, squareOrderId: hasSqOrd });
                  }
                  
                  // PRIORITIZE explicit source field - it's authoritative
                  if (job?.source === 'manual') {
                    return (
                      <>
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                        Manual
                      </>
                    );
                  }
                  
                  if (job?.source === 'website') {
                    return (
                      <>
                        <span className="inline-block w-2 h-2 rounded-full bg-blue-500"></span>
                        Website
                      </>
                    );
                  }
                  
                  // FALLBACK: Only infer if source is missing
                  const inferredSource = (job?.bookingId || job?.squareOrderId) ? 'website' : 'manual';
                  if (inferredSource === 'website') {
                    return (
                      <>
                        <span className="inline-block w-2 h-2 rounded-full bg-blue-500"></span>
                        Website
                      </>
                    );
                  } else {
                    return (
                      <>
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                        Manual
                      </>
                    );
                  }
                })()}
              </div>
            </div>
            
            {/* Created By */}
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Created By</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>
                {(() => {
                  const source = job?.source as 'website' | 'manual' | undefined;
                  
                  // Website bookings
                  if (source === 'website') {
                    return 'Website Booking';
                  }
                  
                  // Manual bookings with staff name
                  if (source === 'manual' && job?.createdBy) {
                    if (job.createdBy.includes('manager-phone:') || /^[0-9a-f-]{36}$/.test(job.createdBy)) {
                      return 'Staff / Manager';
                    }
                    return job.createdBy;
                  }
                  
                  // Fallback: if bookingId exists (likely website), show "Website Booking"
                  if (job?.bookingId) {
                    return 'Website Booking';
                  }
                  
                  // Default: manual or unknown
                  if (job?.createdBy) {
                    if (job.createdBy.includes('manager-phone:') || /^[0-9a-f-]{36}$/.test(job.createdBy)) {
                      return 'Staff / Manager';
                    }
                    return job.createdBy;
                  }
                  
                  return 'Staff / Manager';
                })()}
              </div>
            </div>
            
            {/* Created Date/Time */}
            <div className="md:col-span-2">
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Created</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>
                {job?.createdAt
                  ? (() => {
                      const date = new Date(job.createdAt);
                      const dateStr = date.toLocaleDateString(
                        locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US',
                        { month: 'short', day: 'numeric', year: 'numeric' }
                      );
                      const timeStr = date.toLocaleTimeString(
                        locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US',
                        { hour: 'numeric', minute: '2-digit' }
                      );
                      return `${dateStr} at ${timeStr}`;
                    })()
                  : 'Not available'}
              </div>
            </div>
            
            {/* Square Integration Status */}
            <div className="md:col-span-2">
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Square Integration</label>
              <div className="text-sm" style={{ color: 'var(--sf-ink)' }}>
                {job?.bookingId ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                    <span>Square Booking: Linked</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2" style={{ color: 'var(--sf-muted)' }}>
                    <span className="inline-block w-2 h-2 rounded-full bg-gray-400"></span>
                    <span>Square Booking: Not linked</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
        
        {/* Customer Info */}
        <section className="bg-white rounded-2xl p-6 mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--sf-ink)' }}>{t('customer.title')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>{t('customer.name')}</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>{job.customerName}</div>
            </div>
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>{t('customer.phone')}</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>{job.customerPhone || t('customer.notProvided')}</div>
            </div>
            <div className="md:col-span-2">
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>{t('customer.email')}</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>{job.customerEmail || t('customer.notProvided')}</div>
            </div>
          </div>
        </section>

        {/* Appointment Time */}
        <section className="bg-white rounded-2xl p-6 mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--sf-ink)' }}>Scheduled Appointment</h2>
            {currentUserRole === 'MANAGER' && job.bookingId && (
              <button
                onClick={() => setShowEditBookingModal(true)}
                className="px-4 py-2 bg-[#F47C20] text-white rounded-lg hover:bg-[#DB6E1C] sf-button-transition text-sm"
              >
                Edit Booking
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Date</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>
                {job.appointmentTime || job.scheduledStart
                  ? new Date(job.appointmentTime || job.scheduledStart!).toLocaleDateString(
                      locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US',
                      { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
                    )
                  : 'Not scheduled'}
              </div>
            </div>
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Time</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>
                {job.appointmentTime || job.scheduledStart
                  ? new Date(job.appointmentTime || job.scheduledStart!).toLocaleTimeString(
                      locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US',
                      { hour: 'numeric', minute: '2-digit' }
                    )
                  : 'Not scheduled'}
              </div>
            </div>
            <div>
              <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>Service Type</label>
              <div className="font-medium" style={{ color: 'var(--sf-ink)' }}>
                {job.serviceType || 'Not specified'}
              </div>
            </div>
          </div>
        </section>

        {/* Vehicle Info */}
        <section className="bg-white rounded-2xl p-6 mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--sf-ink)' }}>{t('vehicle.title')}</h2>
            {!editingVehicle && (
              <button
                onClick={handleEditVehicle}
                className="px-4 py-2 bg-[#F47C20] text-white rounded-lg hover:bg-[#DB6E1C] sf-button-transition text-sm"
              >
                Edit
              </button>
            )}
          </div>
          
          {editingVehicle ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Make
                  </label>
                  <input
                    type="text"
                    value={vehicleForm.make}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, make: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                    placeholder="e.g., Toyota"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Model
                  </label>
                  <input
                    type="text"
                    value={vehicleForm.model}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, model: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                    placeholder="e.g., Camry"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Year
                  </label>
                  <input
                    type="number"
                    value={vehicleForm.year}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, year: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                    placeholder="e.g., 2020"
                    min="1900"
                    max="2100"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    License Plate
                  </label>
                  <input
                    type="text"
                    value={vehicleForm.licensePlate}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, licensePlate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                    placeholder="e.g., ABC-1234"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Color
                  </label>
                  <input
                    type="text"
                    value={vehicleForm.color}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, color: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                    placeholder="e.g., Silver"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Service
                </label>
                {loadingServices ? (
                  <div className="text-sm text-gray-500">Loading services...</div>
                ) : services.length > 0 ? (
                  <select
                    value={serviceTypeForm}
                    onChange={(e) => setServiceTypeForm(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                  >
                    <option value={job.serviceType}>{job.serviceType}</option>
                    {services.filter(s => s !== job.serviceType).map((service) => (
                      <option key={service} value={service}>
                        {service}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={serviceTypeForm}
                    onChange={(e) => setServiceTypeForm(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                    placeholder={job.serviceType}
                  />
                )}
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Add-ons (Optional)
                </label>
                {availableAddons.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {availableAddons.map((addon) => (
                      <label
                        key={addon.id}
                        className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition"
                      >
                        <input
                          type="checkbox"
                          checked={selectedAddonIds.has(addon.id)}
                          onChange={(e) => {
                            const newSet = new Set(selectedAddonIds);
                            if (e.target.checked) {
                              newSet.add(addon.id);
                            } else {
                              newSet.delete(addon.id);
                            }
                            setSelectedAddonIds(newSet);
                          }}
                          className="w-4 h-4 text-[#F47C20] border-gray-300 rounded focus:ring-[#F47C20]"
                        />
                        <div className="ml-3 flex-1">
                          <div className="text-sm font-medium text-gray-900">{addon.name}</div>
                          {addon.priceMoney && (
                            <div className="text-xs text-gray-500">
                              +${(addon.priceMoney.amount / 100).toFixed(2)}
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">Loading add-ons...</div>
                )}
              </div>
              
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleSaveVehicle}
                  disabled={savingVehicle}
                  className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition disabled:opacity-50"
                >
                  {savingVehicle ? 'Saving...' : '✓ Save'}
                </button>
                <button
                  onClick={handleCancelEditVehicle}
                  disabled={savingVehicle}
                  className="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition disabled:opacity-50"
                >
                  ✕ Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-600">{t('vehicle.makeModel')}</label>
                <div className="font-medium text-gray-900">
                  {job.vehicleInfo.year || job.vehicleInfo.make || job.vehicleInfo.model
                    ? `${job.vehicleInfo.year || ''} ${job.vehicleInfo.make || ''} ${job.vehicleInfo.model || ''}`.trim()
                    : t('vehicle.pending')}
                </div>
              </div>
              <div>
                <label className="text-sm text-gray-600">{t('vehicle.licensePlate')}</label>
                <div className="font-medium text-gray-900">{job.vehicleInfo.licensePlate || t('vehicle.pending')}</div>
              </div>
              <div>
                <label className="text-sm text-gray-600">{t('vehicle.color')}</label>
                <div className="font-medium text-gray-900">{job.vehicleInfo.color || t('vehicle.pending')}</div>
              </div>
              <div>
                <label className="text-sm text-gray-600">{t('vehicle.service')}</label>
                <div className="font-medium text-sm text-gray-900">{job.serviceType}</div>
              </div>
              {(loadingAddons || addons.length > 0) && (
                <div className="col-span-2">
                  <label className="text-sm text-gray-600">Add-ons</label>
                  {loadingAddons ? (
                    <div className="text-sm text-gray-500">Loading add-ons...</div>
                  ) : addons.length > 0 ? (
                    <div className="space-y-1">
                      {addons.map((addon, index) => (
                        <div key={`addon-${index}`} className="flex items-center text-sm">
                          <span className="font-medium text-gray-900">• {addon.name}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">No add-ons</div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Status & Actions */}
        <section className="bg-white rounded-2xl p-6 mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--sf-ink)' }}>📊 {t('status.title')}</h2>
          <div className="mb-4">
            <label className="text-sm" style={{ color: 'var(--sf-muted)' }}>{t('status.current')}</label>
            <div className="text-xl font-bold" style={{ color: 'var(--sf-orange)' }}>{job.workStatus}</div>
          </div>

          <div className="flex flex-wrap gap-3">
            {job.workStatus === WorkStatus.SCHEDULED && (
              <button
                onClick={() => handleStatusChange(WorkStatus.CHECKED_IN)}
                disabled={updating}
                className="px-6 py-3 bg-[#1F8A5B] text-white rounded-xl font-medium hover:bg-[#196F4A] sf-button-transition disabled:opacity-50"
              >
                ✅ {t('actions.checkIn')}
              </button>
            )}
            
            {job.workStatus === WorkStatus.CHECKED_IN && (
              <>
                <button
                  onClick={() => handleStatusChange(WorkStatus.SCHEDULED)}
                  disabled={updating}
                  className="px-6 py-3 bg-[#64748B] text-white rounded-xl font-medium hover:bg-[#475569] sf-button-transition disabled:opacity-50"
                >
                  ← Back to Scheduled
                </button>
                <button
                  onClick={() => handleStatusChange(WorkStatus.IN_PROGRESS)}
                  disabled={updating}
                  className="px-6 py-3 bg-[#2563EB] text-white rounded-xl font-medium hover:bg-[#1D4ED8] sf-button-transition disabled:opacity-50"
                >
                  🔧 {t('actions.startWork')}
                </button>
              </>
            )}
            
            {job.workStatus === WorkStatus.IN_PROGRESS && (
              <>
                <button
                  onClick={() => handleStatusChange(WorkStatus.CHECKED_IN)}
                  disabled={updating}
                  className="px-6 py-3 bg-[#64748B] text-white rounded-xl font-medium hover:bg-[#475569] sf-button-transition disabled:opacity-50"
                >
                  ← Back to Checked In
                </button>
                <button
                  onClick={() => handleStatusChange(WorkStatus.QC_READY)}
                  disabled={updating}
                  className="px-6 py-3 bg-[#7C3AED] text-white rounded-xl font-medium hover:bg-[#6D28D9] sf-button-transition disabled:opacity-50"
                >
                  🔍 {t('actions.requestQC')}
                </button>
              </>
            )}
            
            {job.workStatus === WorkStatus.QC_READY && (
              <>
                <button
                  onClick={() => handleStatusChange(WorkStatus.IN_PROGRESS)}
                  disabled={updating}
                  className="px-6 py-3 bg-[#64748B] text-white rounded-xl font-medium hover:bg-[#475569] sf-button-transition disabled:opacity-50"
                >
                  ← Back to In Progress
                </button>
                <button
                  onClick={() => handleStatusChange(WorkStatus.WORK_COMPLETED)}
                  disabled={updating}
                  className="px-6 py-3 bg-[#16A34A] text-white rounded-xl font-medium hover:bg-[#15803D] sf-button-transition disabled:opacity-50"
                >
                  {t('actions.completeWork')}
                </button>
              </>
            )}
          </div>
        </section>

        {/* Checklist */}
        <section className="bg-white rounded-2xl p-6 mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--sf-ink)' }}>{t('checklist.title')}</h2>
          
          {/* Tech Checklist */}
          <div className="mb-6">
            <h3 className="text-md font-medium mb-3" style={{ color: 'var(--sf-brown)' }}>Tech Checklist</h3>
            <div className="space-y-3">
              {(job.checklist?.tech || []).map((item) => (
                <label
                  key={item.id}
                  className="flex items-center gap-3 p-3 bg-[#FAF6EF] rounded-lg cursor-pointer hover:bg-[#F0EBE3] sf-button-transition"
                >
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() => handleChecklistToggle('tech', item.id)}
                    disabled={updating}
                    className="w-6 h-6 text-primary-600 rounded focus:ring-primary-500"
                  />
                  <span className={item.checked ? 'line-through text-gray-500' : 'text-gray-900'}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* QC Checklist */}
          <div>
            <h3 className="text-md font-medium text-gray-700 mb-3">🔍 QC Checklist</h3>
            <div className="space-y-3">
              {(job.checklist?.qc || []).map((item) => (
                <label
                  key={item.id}
                  className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition"
                >
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() => handleChecklistToggle('qc', item.id)}
                    disabled={updating}
                    className="w-6 h-6 text-primary-600 rounded focus:ring-primary-500"
                  />
                  <span className={item.checked ? 'line-through text-gray-500' : 'text-gray-900'}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* Photos */}
        <section className="bg-white rounded-lg shadow-md p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">📸 {t('photos.title')}</h2>
          <div className="text-sm text-gray-600 mb-4">
            {(job.photosMeta || []).length} photos uploaded
          </div>
          
          {/* Photo Gallery */}
          {job.photosMeta && job.photosMeta.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              {job.photosMeta.map((photo, idx) => (
                <div 
                  key={idx} 
                  className="relative aspect-square bg-gray-200 rounded-lg overflow-hidden cursor-pointer hover:opacity-90 transition"
                  onClick={() => setSelectedPhoto(photo)}
                >
                  <img
                    src={photo.publicUrl}
                    alt={`Photo ${idx + 1}`}
                    className="w-full h-full object-cover"
                    onError={() => handleImageError(`photo-${photo.photoId}`)}
                  />
                  {photo.category && (
                    <span className="absolute top-2 left-2 px-2 py-1 bg-black bg-opacity-50 text-white text-xs rounded">
                      {photo.category}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          
          {/* Upload Toggle Button */}
          <button 
            onClick={() => setShowPhotoUploader(!showPhotoUploader)}
            className="px-6 py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition"
          >
            📷 {showPhotoUploader ? 'Hide Uploader' : 'Upload Photos'}
          </button>

          {/* Photo Uploader */}
          {showPhotoUploader && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <PhotoUploader 
                jobId={jobId}
                onUploadComplete={() => {
                  setShowPhotoUploader(false);
                  refreshJob();
                }}
              />
            </div>
          )}
        </section>

        {/* Post-Completion Issue (Only for WORK_COMPLETED jobs) */}
        {job.workStatus === WorkStatus.WORK_COMPLETED && (
          <section className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">⚠️ Post-Completion Issue</h2>
            
            {!job.postCompletionIssue && (
              <div>
                <p className="text-sm text-gray-600 mb-4">
                  Report issues discovered after job completion. This does not change the job status.
                </p>
                <button
                  onClick={() => setShowIssueModal(true)}
                  className="px-6 py-3 bg-yellow-600 text-white rounded-lg font-medium hover:bg-yellow-700 transition"
                >
                  Report Issue
                </button>
              </div>
            )}

            {job.postCompletionIssue && (
              <div className="space-y-4">
                <div className={`p-4 rounded-lg border-2 ${
                  job.postCompletionIssue.isOpen 
                    ? 'bg-red-50 border-red-300' 
                    : 'bg-green-50 border-green-300'
                }`}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900">
                          {job.postCompletionIssue.type.replace(/_/g, ' ')}
                        </span>
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                          job.postCompletionIssue.isOpen
                            ? 'bg-red-200 text-red-800'
                            : 'bg-green-200 text-green-800'
                        }`}>
                          {job.postCompletionIssue.isOpen ? 'OPEN' : 'RESOLVED'}
                        </span>
                      </div>
                      {job.postCompletionIssue.notes && (
                        <p className="text-sm text-gray-700 mt-2">{job.postCompletionIssue.notes}</p>
                      )}
                    </div>
                  </div>

                  <div className="text-xs text-gray-600 space-y-1">
                    <div>
                      Opened by {job.postCompletionIssue.openedBy.name} on{' '}
                      {new Date(job.postCompletionIssue.openedAt).toLocaleString()}
                    </div>
                    {job.postCompletionIssue.resolvedAt && job.postCompletionIssue.resolvedBy && (
                      <div>
                        Resolved by {job.postCompletionIssue.resolvedBy.name} on{' '}
                        {new Date(job.postCompletionIssue.resolvedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>

                {job.postCompletionIssue.isOpen && (
                  <button
                    onClick={handleResolveIssue}
                    disabled={updating}
                    className={`px-6 py-3 rounded-lg font-medium transition ${
                      updating
                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                        : 'bg-green-600 text-white hover:bg-green-700'
                    }`}
                  >
                    {updating ? 'Resolving...' : 'Mark Issue Resolved'}
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {/* Payment */}
        <section className="bg-white rounded-2xl p-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--sf-ink)' }}>💳 {t('payment.title')}</h2>
          
          {/* Determine if this is a website (deposit) booking or phone (manual) booking */}
          {(() => {
            const isManualBooking = job?.source === 'manual' || (!job?.source && !job?.bookingId && !job?.squareOrderId);
            const hasDeposit = job?.depositAmountCents != null && job.depositAmountCents > 0;
            
            if (isManualBooking || !hasDeposit) {
              // Phone booking - show only Total Job Amount
              return (
                <div className="grid grid-cols-1 gap-4 mb-4">
                  <div className="rounded-2xl border border-gray-200 p-4 bg-gray-50">
                    <div className="text-sm text-gray-500">Total Job Amount</div>
                    <div className="text-xl font-semibold mt-2">
                      ${((job?.payment?.amountCents || 0) / 100).toFixed(2)}
                    </div>
                  </div>
                </div>
              );
            } else {
              // Website booking with deposit - show all 3 boxes
              return (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div className="rounded-2xl border border-gray-200 p-4 bg-gray-50">
                    <div className="text-sm text-gray-500">Total Job Amount</div>
                    <div className="text-xl font-semibold mt-2">
                      ${((job?.payment?.amountCents || 0) / 100).toFixed(2)}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-gray-200 p-4 bg-gray-50">
                    <div className="text-sm text-gray-500">Deposit Collected</div>
                    <div className="text-xl font-semibold mt-2">
                      {job?.depositAmountCents != null ? `$${(job.depositAmountCents / 100).toFixed(2)}` : 'Not available'}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-gray-200 p-4 bg-gray-50">
                    <div className="text-sm text-gray-500">Remaining Balance Due</div>
                    <div className="text-xl font-semibold mt-2">
                      ${((job?.depositAmountCents != null ? Math.max(0, (job?.payment?.amountCents || 0) - job.depositAmountCents) : (job?.payment?.amountCents || 0)) / 100).toFixed(2)}
                    </div>
                  </div>
                </div>
              );
            }
          })()}
          
          {/* Deposit payment details - only for website bookings */}
          {(() => {
            const isManualBooking = job?.source === 'manual' || (!job?.source && !job?.bookingId && !job?.squareOrderId);
            const hasDeposit = job?.depositAmountCents != null && job.depositAmountCents > 0;
            
            if (!isManualBooking && job?.depositAmountCents == null) {
              return (
                <div className="text-sm text-[#92400E] bg-[#FEF3C7] p-3 rounded-lg mb-4 border border-[#FDE68A]">
                  {job?.notes?.includes('CARD ON FILE') 
                    ? 'Card on file stored — no payment charged yet'
                    : 'No deposit payment found in Square. Verify customer payment status.'}
                </div>
              );
            }
            return null;
          })()}
          <div className="flex items-center justify-between mb-4">
            <div className="flex-1">
              <div className="text-sm" style={{ color: 'var(--sf-muted)' }}>{t('payment.amount')}</div>
              {editingAmount && currentUserRole === 'MANAGER' ? (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-2xl font-bold" style={{ color: 'var(--sf-ink)' }}>$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    className="text-2xl font-bold border-b-2 border-[#F47C20] focus:outline-none w-32"
                    style={{ color: 'var(--sf-ink)' }}
                    autoFocus
                  />
                  <button
                    onClick={handleAmountUpdate}
                    disabled={updating}
                    className="px-3 py-1 bg-[#1F8A5B] text-white text-sm rounded hover:bg-[#196F4A] disabled:opacity-50 sf-button-transition"
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => {
                      setEditingAmount(false);
                      setAmountInput('');
                    }}
                    className="px-3 py-1 bg-gray-300 text-sm rounded hover:bg-gray-400"
                    style={{ color: 'var(--sf-brown)' }}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="text-2xl font-bold" style={{ color: 'var(--sf-ink)' }}>
                    ${((job.payment?.amountCents || 0) / 100).toFixed(2)}
                  </div>
                  {currentUserRole === 'MANAGER' && (
                    <button
                      onClick={() => {
                        setAmountInput(((job.payment?.amountCents || 0) / 100).toFixed(2));
                        setEditingAmount(true);
                      }}
                      className="hover:opacity-80 text-sm sf-button-transition"
                      style={{ color: 'var(--sf-orange)' }}
                    >
                      ✏️ Edit
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              {/* Debug: currentUserRole = {currentUserRole} */}
              {currentUserRole === 'MANAGER' ? (
                <button
                  onClick={handlePaymentToggle}
                  disabled={updating}
                  className={`px-6 py-3 rounded-xl font-medium sf-button-transition ${
                    job.payment?.status === PaymentStatus.PAID
                      ? 'bg-[#1F8A5B] text-white hover:bg-[#196F4A]'
                      : 'bg-[#F59E0B] text-white hover:bg-[#D97706]'
                  } disabled:opacity-50`}
                >
                  {job.payment?.status === PaymentStatus.PAID ? '✓ PAID' : 'UNPAID'}
                </button>
              ) : (
                <span className={`px-4 py-2 rounded-full font-medium border ${
                  job.payment?.status === PaymentStatus.PAID
                    ? 'bg-[#DCFCE7] text-[#166534] border-[#BBF7D0]'
                    : 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]'
                }`}>
                  {job.payment?.status || PaymentStatus.UNPAID}
                </span>
              )}
            </div>
          </div>

          {/* Payment metadata */}
          {job.payment?.paidAt && job.payment?.paidBy && (
            <div className="text-xs text-gray-600 mb-3">
              Marked paid by {job.payment.paidBy.name} on {new Date(job.payment.paidAt).toLocaleString()}
            </div>
          )}

          {(job.squareOrderId || job.depositPaymentId || job.depositReceiptNumber) && (
            <div className="text-xs text-gray-600 mb-3 space-y-1">
              {job.squareOrderId && (
                <div>
                  Deposit order: {job.squareOrderId}
                  {job.depositPaymentStatus ? ` • ${job.depositPaymentStatus}` : ''}
                </div>
              )}
              {job.depositPaymentId && (
                <div>
                  Deposit payment: {job.depositPaymentId}
                  {job.depositReceiptNumber ? ` • Receipt #${job.depositReceiptNumber}` : ''}
                </div>
              )}
              {job.depositPaymentNote && (
                <div>Note: {job.depositPaymentNote}</div>
              )}
            </div>
          )}

          {job.payment?.unpaidReason && (
            <div className="text-xs text-gray-600 bg-yellow-50 p-3 rounded-lg mb-3">
              <span className="font-semibold">Unpaid Reason:</span> {job.payment.unpaidReason}
              {job.payment.unpaidNote && <div className="mt-1">{job.payment.unpaidNote}</div>}
            </div>
          )}

          {/* Receipt photos */}
          {job.receiptPhotos && job.receiptPhotos.length > 0 && (
            <div className="border-t pt-4 mt-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Receipts ({job.receiptPhotos.length})</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {job.receiptPhotos.map((receipt) => (
                  <div
                    key={receipt.photoId}
                    className="relative aspect-square bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:opacity-90 transition"
                    onClick={() => setSelectedReceipt(receipt)}
                  >
                    <img
                      src={receipt.publicUrl}
                      alt="Receipt"
                      className="w-full h-full object-cover"
                      onError={() => handleImageError(`receipt-${receipt.photoId}`)}
                    />
                    {imageErrors.has(`receipt-${receipt.photoId}`) && (
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-200">
                        <span className="text-xs text-gray-500">Loading...</span>
                      </div>
                    )}
                  </div>
                ))}          
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Photo Modal */}
      {selectedPhoto && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-75 flex items-center justify-center p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div className="max-w-4xl max-h-full">
            <img
              src={selectedPhoto.publicUrl}
              alt="Full size photo"
              className="max-w-full max-h-screen rounded-lg"
              onError={() => handleImageError(`photo-modal-${selectedPhoto.photoId}`)}
            />
            <div className="mt-4 text-white text-center" onClick={(e) => e.stopPropagation()}>
              <div className="text-sm">
                Category: {selectedPhoto.category || 'N/A'}
              </div>
              <div className="text-xs text-gray-300 mt-1">
                Uploaded: {new Date(selectedPhoto.uploadedAt).toLocaleString()}
              </div>
              <button
                onClick={() => setSelectedPhoto(null)}
                className="mt-4 px-6 py-2 bg-white text-gray-900 rounded-lg hover:bg-gray-100 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 5: No-show Section (Manager only) */}
      {currentUserRole === 'MANAGER' && (
        <section className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">{t('noShow.title')}</h2>
          
          {(!job.noShow || job.noShow.status === 'NONE') && (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                Mark this appointment as no-show if the customer did not arrive or canceled too late.
              </p>
              {(job.workStatus === WorkStatus.SCHEDULED || job.workStatus === WorkStatus.CHECKED_IN || job.workStatus === WorkStatus.IN_PROGRESS) && (
                <button
                  onClick={() => setShowNoShowModal(true)}
                  className="px-6 py-3 bg-orange-600 text-white rounded-lg font-medium hover:bg-orange-700 transition"
                >
                  {t('noShow.markButton')}
                </button>
              )}
              {(job.workStatus === WorkStatus.QC_READY || job.workStatus === WorkStatus.WORK_COMPLETED) && (
                <p className="text-sm text-gray-500 italic">
                  Cannot mark as no-show once work is in QC or completed.
                </p>
              )}
            </div>
          )}

          {job.noShow && job.noShow.status === 'NO_SHOW' && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg border-2 bg-orange-50 border-orange-300">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">
                        {t(`noShow.reasons.${job.noShow.reason || 'OTHER'}`)}
                      </span>
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-orange-200 text-orange-800">
                        NO-SHOW
                      </span>
                    </div>
                    {job.noShow.notes && (
                      <p className="text-sm text-gray-700 mt-2">{job.noShow.notes}</p>
                    )}
                  </div>
                </div>

                <div className="text-xs text-gray-600 space-y-1">
                  <div>
                    {t('noShow.markedBy')} {job.noShow.updatedBy.name} on{' '}
                    {new Date(job.noShow.updatedAt).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowNoShowResolveModal(true)}
                  disabled={updating}
                  className={`px-6 py-3 rounded-lg font-medium transition ${
                    updating
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-green-600 text-white hover:bg-green-700'
                  }`}
                >
                  {updating ? 'Resolving...' : t('noShow.resolveButton')}
                </button>
                {job.bookingId && (
                  <a
                    href={`https://squareup.com/dashboard/appointments/bookings/${job.bookingId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition"
                  >
                    {t('noShow.openInSquare')} →
                  </a>
                )}
              </div>
            </div>
          )}

          {job.noShow && job.noShow.status === 'RESOLVED' && (
            <div className="p-4 rounded-lg border-2 bg-green-50 border-green-300">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-gray-900">No-show Resolved</span>
                <span className="text-xs px-2 py-1 rounded-full font-medium bg-green-200 text-green-800">
                  RESOLVED
                </span>
              </div>
              <div className="text-xs text-gray-600 space-y-1">
                <div>
                  Originally marked: {t(`noShow.reasons.${job.noShow.reason || 'OTHER'}`)}
                </div>
                <div>
                  {t('noShow.resolvedBy')} {job.noShow.resolvedBy?.name} on{' '}
                  {job.noShow.resolvedAt && new Date(job.noShow.resolvedAt).toLocaleString()}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Issue Modal */}
      {showIssueModal && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4"
          onClick={() => setShowIssueModal(false)}
        >
          <div 
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Report Post-Completion Issue</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Issue Type
                </label>
                <select
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value as 'QC_MISS' | 'CUSTOMER_COMPLAINT' | 'DAMAGE' | 'REDO' | 'OTHER')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="QC_MISS">QC Miss</option>
                  <option value="CUSTOMER_COMPLAINT">Customer Complaint</option>
                  <option value="DAMAGE">Damage</option>
                  <option value="REDO">Redo Required</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Notes
                </label>
                <textarea
                  value={issueNotes}
                  onChange={(e) => setIssueNotes(e.target.value)}
                  placeholder="Describe the issue..."
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowIssueModal(false)}
                disabled={updating}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleOpenIssue}
                disabled={updating}
                className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                  updating
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-red-600 text-white hover:bg-red-700'
                }`}
              >
                {updating ? 'Submitting...' : 'Submit Issue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Upload Modal */}
      {showReceiptUploadModal && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4"
          onClick={() => setShowReceiptUploadModal(false)}
        >
          <div 
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Take Receipt Photo to Mark as Paid</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Take Receipt Photo(s)
                </label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  onChange={(e) => setReceiptFiles(Array.from(e.target.files || []))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
                {receiptFiles.length > 0 && (
                  <div className="mt-2 text-sm text-gray-600">
                    {receiptFiles.length} photo(s) captured
                  </div>
                )}
              </div>

              {job.receiptPhotos && job.receiptPhotos.length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-sm text-gray-700 mb-2">
                    {job.receiptPhotos.length} receipt photo(s) already saved
                  </p>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowReceiptUploadModal(false);
                  setReceiptFiles([]);
                }}
                disabled={uploadingReceipts || updating}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                Cancel
              </button>
              {receiptFiles.length > 0 && (
                <button
                  onClick={async () => {
                    await handleReceiptUpload();
                    await handleMarkPaid();
                  }}
                  disabled={uploadingReceipts || updating}
                  className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                    uploadingReceipts || updating
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-green-600 text-white hover:bg-green-700'
                  }`}
                >
                  {uploadingReceipts ? 'Saving...' : updating ? 'Marking Paid...' : 'Save & Mark Paid'}
                </button>
              )}
              {!receiptFiles.length && job.receiptPhotos && job.receiptPhotos.length > 0 && (
                <button
                  onClick={handleMarkPaid}
                  disabled={updating}
                  className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                    updating
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-green-600 text-white hover:bg-green-700'
                  }`}
                >
                  {updating ? 'Marking Paid...' : 'Mark Paid'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Unpaid Reason Modal */}
      {showUnpaidModal && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4"
          onClick={() => setShowUnpaidModal(false)}
        >
          <div 
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Mark Payment as Unpaid</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Reason <span className="text-red-500">*</span>
                </label>
                <select
                  value={unpaidReason}
                  onChange={(e) => setUnpaidReason(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="Refunded">Refunded</option>
                  <option value="Mistake">Mistake</option>
                  <option value="Chargeback">Chargeback</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Additional Notes (Optional)
                </label>
                <textarea
                  value={unpaidNote}
                  onChange={(e) => setUnpaidNote(e.target.value)}
                  placeholder="Add any additional details..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowUnpaidModal(false);
                  setUnpaidNote('');
                  setUnpaidReason('Refunded');
                }}
                disabled={updating}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleMarkUnpaid}
                disabled={updating}
                className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                  updating
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-yellow-600 text-white hover:bg-yellow-700'
                }`}
              >
                {updating ? 'Saving...' : 'Mark Unpaid'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Viewer Modal */}
      {selectedReceipt && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-75 flex items-center justify-center p-4"
          onClick={() => setSelectedReceipt(null)}
        >
          <div className="max-w-4xl max-h-full">
            <img
              src={selectedReceipt.publicUrl}
              alt="Receipt"
              className="max-w-full max-h-screen rounded-lg"
              onError={() => handleImageError(`receipt-modal-${selectedReceipt.photoId}`)}
            />
            <div className="mt-4 text-white text-center"  onClick={(e) => e.stopPropagation()}>
              <div className="text-sm">
                Uploaded by: {selectedReceipt.uploadedBy.name}
              </div>
              <div className="text-xs text-gray-300 mt-1">
                {new Date(selectedReceipt.uploadedAt).toLocaleString()}
              </div>
              <button
                onClick={() => setSelectedReceipt(null)}
                className="mt-4 px-6 py-2 bg-white text-gray-900 rounded-lg hover:bg-gray-100 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 5: No-show Mark Modal */}
      {showNoShowModal && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4"
          onClick={() => setShowNoShowModal(false)}
        >
          <div 
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-gray-900 mb-4">{t('noShow.confirmMark')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('noShow.reason')} *
                </label>
                <select
                  value={noShowReason}
                  onChange={(e) => setNoShowReason(e.target.value as any)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                >
                  <option value="NO_ARRIVAL">{t('noShow.reasons.NO_ARRIVAL')}</option>
                  <option value="LATE_CANCEL">{t('noShow.reasons.LATE_CANCEL')}</option>
                  <option value="UNREACHABLE">{t('noShow.reasons.UNREACHABLE')}</option>
                  <option value="OTHER">{t('noShow.reasons.OTHER')}</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('noShow.notes')}
                </label>
                <textarea
                  value={noShowNotes}
                  onChange={(e) => setNoShowNotes(e.target.value)}
                  placeholder={t('noShow.enterNotes')}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowNoShowModal(false)}
                disabled={updating}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                {tCommon('cancel')}
              </button>
              <button
                onClick={handleMarkNoShow}
                disabled={updating}
                className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                  updating
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-orange-600 text-white hover:bg-orange-700'
                }`}
              >
                {updating ? 'Marking...' : t('noShow.confirmMark')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 5: No-show Resolve Modal */}
      {showNoShowResolveModal && (
        <div 
          className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4"
          onClick={() => setShowNoShowResolveModal(false)}
        >
          <div 
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-gray-900 mb-4">{t('noShow.confirmResolve')}</h3>
            
            <p className="text-sm text-gray-600 mb-4">
              This will mark the no-show as resolved. You can add optional notes about the resolution.
            </p>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('noShow.notes')}
              </label>
              <textarea
                value={noShowNotes}
                onChange={(e) => setNoShowNotes(e.target.value)}
                placeholder={t('noShow.enterNotes')}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
              />
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowNoShowResolveModal(false)}
                disabled={updating}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
              >
                {tCommon('cancel')}
              </button>
              <button
                onClick={handleResolveNoShow}
                disabled={updating}
                className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                  updating
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                {updating ? 'Resolving...' : t('noShow.confirmResolve')}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Edit Booking Modal */}
      {job.bookingId && (
        <EditBookingModal
          bookingId={job.bookingId}
          isOpen={showEditBookingModal}
          onClose={() => setShowEditBookingModal(false)}
          onSuccess={() => {
            // Refresh job data after successful edit
            fetchJob();
            showToast('Booking updated successfully', 'success');
          }}
        />
      )}
    </div>
  );
}
