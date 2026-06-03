'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useTranslations } from '@/lib/i18n/provider';
import { WorkStatus, PaymentStatus } from '@/lib/types';
import type { Locale } from '@/i18n';
import { PaymentBadge } from './components/PaymentBadge';
import { NotificationBell } from '../components/NotificationBell';
import { useToast } from '../components/ToastProvider';
import type { Notification } from '@/lib/types';

interface JobCard {
  jobId: string;
  jobNumber?: number;
  customerName: string;
  vehicleInfo: string;
  serviceType: string;
  scheduledStart: string;
  workStatus: WorkStatus;
  hasOpenIssue: boolean;
  paymentStatus: PaymentStatus;
  payment?: {
    status: PaymentStatus;
    amountCents?: number;
  };
  noShow?: {
    status: 'NONE' | 'NO_SHOW' | 'RESOLVED';
    reason?: string;
  };
  notes?: string;
}

/**
 * Parse add-ons from booking notes
 * Format: "✅ ADD-ONS REQUESTED:\n• Addon 1\n• Addon 2"
 */
function parseAddonsFromNotes(notes: string | undefined): string[] {
  if (!notes) return [];
  
  const addonsMatch = notes.match(/[✅✓]\s*ADD[-\s]ONS\s+REQUESTED:\s*([\s\S]*?)(?:\n\n|⚠️|$)/i);
  if (!addonsMatch) return [];
  
  const addonLines = addonsMatch[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('•') || line.startsWith('-') || line.startsWith('*'))
    .map(line => line.substring(1).trim());
  
  return addonLines;
}

const mockJobs: JobCard[] = [
  {
    jobId: '1',
    jobNumber: 10001,
    customerName: 'John Doe',
    vehicleInfo: '2020 Tesla Model 3 - ABC123',
    serviceType: 'Full Detail',
    scheduledStart: '2026-02-05T09:00:00Z',
    workStatus: WorkStatus.SCHEDULED,
    hasOpenIssue: false,
    paymentStatus: PaymentStatus.UNPAID,
  },
  {
    jobId: '2',
    jobNumber: 10002,
    customerName: 'Jane Smith',
    vehicleInfo: '2019 Honda Accord - XYZ789',
    serviceType: 'Express Wash',
    scheduledStart: '2026-02-05T10:00:00Z',
    workStatus: WorkStatus.CHECKED_IN,
    hasOpenIssue: false,
    paymentStatus: PaymentStatus.PAID,
  },
];

export default function TodayBoard() {
  const t = useTranslations('today');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const params = useParams();
  const locale = params.locale as Locale;

  const [jobs, setJobs] = useState<JobCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [updatingJobs, setUpdatingJobs] = useState<Set<string>>(new Set());
  const [userRole, setUserRole] = useState<'TECH' | 'MANAGER' | null>(null);
  const [boardDate, setBoardDate] = useState<string>(() => {
    // Calculate today in Central Time (business timezone)
    // This is a fallback - will be updated via API after mount
    const now = new Date();
    const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
    const centralTime = new Date(utcTime - 6 * 60 * 60000); // CDT is UTC-6 (or UTC-5 during standard time, but let's use -6 for consistency)
    const year = centralTime.getFullYear();
    const month = String(centralTime.getMonth() + 1).padStart(2, '0');
    const day = String(centralTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });

  // Fetch today's date from server to ensure timezone is correct
  useEffect(() => {
    const fetchToday = async () => {
      try {
        const response = await fetch('/api/today');
        const data = await response.json();
        console.log('[PAGE] Fetched today from API:', data.today);
        setBoardDate(data.today);
      } catch (error) {
        console.error('[PAGE] Failed to fetch today\'s date - using client calculation:', error);
        // Keep the initial value calculated above
      }
    };
    
    fetchToday();
  }, []);

  const columns = [
    { status: WorkStatus.SCHEDULED, title: t('status.scheduled'), color: '#64748B' },
    { status: WorkStatus.CHECKED_IN, title: t('status.checkedIn'), color: '#2563EB' },
    { status: WorkStatus.IN_PROGRESS, title: t('status.inProgress'), color: '#F47C20' },
    { status: WorkStatus.QC_READY, title: t('status.qcReady'), color: '#7C3AED' },
    { status: WorkStatus.WORK_COMPLETED, title: t('status.workCompleted'), color: '#16A34A' },
  ];

  // Separate section for cancelled jobs (displayed at the bottom)
  const cancelledColumn = { status: WorkStatus.CANCELLED, title: 'Cancelled', color: '#9CA3AF' };

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const updateJobStatus = async (jobId: string, newStatus: WorkStatus) => {
    setUpdatingJobs(prev => new Set(prev).add(jobId));

    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workStatus: newStatus }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update status: ${response.status}`);
      }

      const data = await response.json();

      if (data.success && data.data?.job) {
        setJobs(prevJobs =>
          prevJobs.map(job =>
            job.jobId === jobId ? { ...job, workStatus: newStatus } : job
          )
        );
        showToast('Status updated successfully', 'success');
      } else {
        throw new Error(data.error?.message || 'Failed to update status');
      }
    } catch (err) {
      console.error('Failed to update job status:', err);
      showToast((err as Error).message, 'error');
    } finally {
      setUpdatingJobs(prev => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const getNextStatus = (currentStatus: WorkStatus): WorkStatus | null => {
    const workflow = [
      WorkStatus.SCHEDULED,
      WorkStatus.CHECKED_IN,
      WorkStatus.IN_PROGRESS,
      WorkStatus.QC_READY,
      WorkStatus.WORK_COMPLETED,
    ];
    const currentIndex = workflow.indexOf(currentStatus);
    return currentIndex < workflow.length - 1 ? workflow[currentIndex + 1] : null;
  };

  // Parse date string without timezone conversion issues
  const parseLocalDate = (dateString: string): Date => {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, month - 1, day);
  };

  const isToday = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    return boardDate === todayStr;
  };

  const getBoardTitle = () => {
    if (isToday()) {
      return t('boardTitle'); // "Today's Board"
    }
    // For other dates, show "Board for [Date]"
    return `Board for ${parseLocalDate(boardDate).toLocaleDateString(locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US', { 
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    })}`;
  };

  const handleNewNotification = (notification: Notification) => {
    // Show toast for new notification
    const typeLabels: Record<string, string> = {
      'JOB_CREATED': '🆕 New Booking',
      'JOB_CANCELLED': '❌ Booking Cancelled',
      'JOB_RESCHEDULED': '📅 Booking Rescheduled',
      'JOB_STATUS_CHANGED': '🔄 Status Updated',
    };
    
    const title = typeLabels[notification.type] || notification.title;
    showToast(`${title}: ${notification.message}`, 'success');
  };

  useEffect(() => {
    async function fetchUser() {
      try {
        const response = await fetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.data?.user) {
            setUserRole(data.data.user.role);
          }
        }
      } catch (err) {
        console.error('Failed to fetch user:', err);
      }
    }

    async function fetchJobs() {
      try {
        console.log('[PAGE] Fetching jobs for boardDate:', boardDate);
        setLoading(true);
        const response = await fetch(`/api/jobs?boardDate=${boardDate}`);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch jobs: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[PAGE] Jobs API response:', data);
        
        if (data.success && data.data?.jobs) {
          const formattedJobs: JobCard[] = data.data.jobs.map((job: any) => ({
            jobId: job.jobId,
            jobNumber: job.jobNumber,
            customerName: job.customerName || 'Unknown',
            vehicleInfo: job.vehicleInfo?.year && job.vehicleInfo?.make 
              ? `${job.vehicleInfo.year} ${job.vehicleInfo.make} ${job.vehicleInfo.model || ''} - ${job.vehicleInfo.licensePlate || ''}`.trim()
              : 'Vehicle info pending',
            serviceType: job.serviceType || 'Detail Service',
            scheduledStart: job.appointmentTime || job.createdAt,
            workStatus: job.status,
            hasOpenIssue: job.postCompletionIssue?.isOpen || false,
            paymentStatus: job.payment?.status || PaymentStatus.UNPAID,
            payment: job.payment,
            noShow: job.noShow,
            notes: job.notes,
          }));
          console.log('[PAGE] Formatted jobs:', formattedJobs);
          setJobs(formattedJobs);
        } else {
          console.warn('API returned no jobs, using mock data');
          setJobs(mockJobs);
        }
      } catch (err) {
        console.error('Failed to fetch jobs:', err);
        setError((err as Error).message);
        setJobs(mockJobs);
      } finally {
        setLoading(false);
      }
    }

    fetchUser();
    fetchJobs();
  }, [boardDate]);

  return (
    <div className="min-h-screen" style={{ background: 'var(--sf-bg)' }}>
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-6 py-3 rounded-lg shadow-lg ${
          toast.type === 'success' ? 'bg-green-500' : 'bg-red-500'
        } text-white`}>
          {toast.message}
        </div>
      )}

      <header className="bg-white shadow-sm border-b-[3px] border-[#F47C20]" style={{ boxShadow: 'var(--sf-shadow)' }}>
        <div className="container mx-auto px-2 sm:px-4 py-3 sm:py-5">
          <div className="flex items-center justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4">
              <Image src="/safari-logo.png" alt="Safari Car Wash" width={40} height={40} className="object-contain sm:w-[60px] sm:h-[60px] flex-shrink-0" />
              <h1 className="text-sm sm:text-2xl font-bold leading-tight" style={{ color: 'var(--sf-ink)' }}>{t('title')}</h1>
            </div>
            <div className="flex gap-1.5 sm:gap-3 items-center flex-shrink-0">
              <NotificationBell onNewNotification={handleNewNotification} />
              {userRole === 'MANAGER' && (
                <Link 
                  href={`/${locale}/manager/phone-booking`}
                  className="px-3 py-2 sm:px-6 sm:py-3 bg-[#F47C20] text-white rounded-lg sm:rounded-xl font-medium hover:bg-[#DB6E1C] sf-button-transition flex items-center gap-1 sm:gap-2"
                  style={{ boxShadow: 'var(--sf-shadow)' }}
                  title={tNav('phoneBooking')}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  <span className="hidden sm:inline">{tNav('phoneBooking')}</span>
                </Link>
              )}
              <Link 
                href={`/${locale}/calendar`}
                className="px-3 py-2 sm:px-6 sm:py-3 bg-white border border-[#E7E2D8] rounded-lg sm:rounded-xl font-medium hover:bg-[#FAF6EF] sf-button-transition flex items-center gap-1 sm:gap-2"
                style={{ color: 'var(--sf-ink)' }}
                title={tNav('calendar')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="hidden sm:inline">{tNav('calendar')}</span>
              </Link>
              <Link 
                href={`/${locale}/settings`}
                className="px-3 py-2 sm:px-6 sm:py-3 bg-white border border-[#E7E2D8] rounded-lg sm:rounded-xl font-medium hover:bg-[#FAF6EF] sf-button-transition flex items-center gap-1 sm:gap-2"
                style={{ color: 'var(--sf-ink)' }}
                title={tNav('settings')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="hidden sm:inline">{tNav('settings')}</span>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-3 sm:px-6 py-4 sm:py-6">
        <div className="mb-4 sm:mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0 mb-4">
            <h2 className="text-lg sm:text-xl font-semibold" style={{ color: 'var(--sf-ink)' }}>{getBoardTitle()}</h2>
            <div className="flex items-center gap-2 sm:gap-3">
              <label htmlFor="boardDate" className="text-xs sm:text-sm font-medium whitespace-nowrap" style={{ color: 'var(--sf-brown)' }}>
                Board Date:
              </label>
              <button
                onClick={() => {
                  const [year, month, day] = boardDate.split('-').map(Number);
                  const currentDate = new Date(year, month - 1, day);
                  currentDate.setDate(currentDate.getDate() - 1);
                  const newYear = currentDate.getFullYear();
                  const newMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
                  const newDay = String(currentDate.getDate()).padStart(2, '0');
                  setBoardDate(`${newYear}-${newMonth}-${newDay}`);
                }}
                className="px-2 py-2 sm:px-3 bg-white border border-[#E7E2D8] rounded-lg hover:bg-[#FAF6EF] sf-button-transition"
                style={{ color: 'var(--sf-ink)' }}
                title="Previous Day"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={locale === 'ar' ? 'M9 5l7 7-7 7' : 'M15 19l-7-7 7-7'} />
                </svg>
              </button>
              <input
                type="date"
                id="boardDate"
                value={boardDate}
                onChange={(e) => setBoardDate(e.target.value)}
                className="px-2 py-1.5 sm:px-3 sm:py-2 border rounded-lg text-xs sm:text-sm focus:ring-2 focus:ring-[#F47C20] focus:border-[#F47C20] shadow-sm bg-white"
                style={{ borderColor: 'var(--sf-border)', color: 'var(--sf-ink)' }}
              />
              <button
                onClick={() => {
                  const [year, month, day] = boardDate.split('-').map(Number);
                  const currentDate = new Date(year, month - 1, day);
                  currentDate.setDate(currentDate.getDate() + 1);
                  const newYear = currentDate.getFullYear();
                  const newMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
                  const newDay = String(currentDate.getDate()).padStart(2, '0');
                  setBoardDate(`${newYear}-${newMonth}-${newDay}`);
                }}
                className="px-2 py-2 sm:px-3 bg-white border border-[#E7E2D8] rounded-lg hover:bg-[#FAF6EF] sf-button-transition"
                style={{ color: 'var(--sf-ink)' }}
                title="Next Day"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={locale === 'ar' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} />
                </svg>
              </button>
              <button
                onClick={() => {
                  const today = new Date();
                  const year = today.getFullYear();
                  const month = String(today.getMonth() + 1).padStart(2, '0');
                  const day = String(today.getDate()).padStart(2, '0');
                  setBoardDate(`${year}-${month}-${day}`);
                }}
                className="px-4 py-2 text-sm font-medium bg-[#F47C20] text-white rounded-lg hover:bg-[#DB6E1C] sf-button-transition shadow-sm"
              >
                Today
              </button>
            </div>
          </div>
          <p className="text-sm" style={{ color: 'var(--sf-muted)' }}>
            {parseLocalDate(boardDate).toLocaleDateString(locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}
          </p>
          {error && (
            <div className="mt-2 p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-800">
              ⚠️ {t('apiError', { error })}
            </div>
          )}
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F47C20]"></div>
            <p className="mt-2" style={{ color: 'var(--sf-muted)' }}>{t('loadingJobs')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              {columns.map((column) => {
                const columnJobs = jobs.filter(job => job.workStatus === column.status);
                
                return (
                  <div key={column.status} className="bg-transparent">
                    <div className="sticky top-0 bg-white border-b p-4 mb-4 rounded-t-2xl" style={{ borderColor: 'var(--sf-border)', boxShadow: 'var(--sf-shadow)' }}>
                      <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--sf-ink)' }}>
                        <span 
                          className="w-2 h-2 rounded-full" 
                          style={{ backgroundColor: column.color }}
                        ></span>
                        <span>{column.title}</span>
                        <span 
                          className="ml-auto px-3 py-1 text-xs rounded-full font-medium bg-[#FAF6EF]"
                          style={{ color: 'var(--sf-brown)' }}
                        >
                          {columnJobs.length}
                        </span>
                      </h3>
                    </div>

                    <div className="space-y-3 px-1">
                      {columnJobs.length === 0 ? (
                        <div className="text-center py-8 text-sm" style={{ color: 'var(--sf-muted)' }}>
                          {t('noJobs')}
                        </div>
                      ) : (
                        columnJobs.map((job) => {
                          const nextStatus = getNextStatus(job.workStatus);
                          const isUpdating = updatingJobs.has(job.jobId);
                          const needsPaymentAttention = job.workStatus === WorkStatus.WORK_COMPLETED && job.paymentStatus === PaymentStatus.UNPAID;
                          
                          return (
                            <div
                              key={job.jobId}
                              className={`bg-white rounded-2xl p-4 border sf-card-hover ${
                                job.noShow?.status === 'NO_SHOW' ? 'border-orange-400' : 
                                needsPaymentAttention ? 'border-yellow-400 border-2 shadow-lg animate-pulse' :
                                'border-[#E7E2D8]'
                              }`}
                              style={{ 
                                boxShadow: 'var(--sf-shadow)',
                                borderLeft: `4px solid ${column.color}`
                              }}
                            >
                              <Link
                                href={`/${locale}/jobs/${job.jobId}`}
                                className="block hover:opacity-90 transition"
                              >
                                <div className="flex items-start justify-between mb-2">
                                  <div className="font-semibold text-sm" style={{ color: 'var(--sf-ink)' }}>{job.customerName}</div>
                                  <div className="flex gap-1 flex-wrap justify-end">
                                    <PaymentBadge status={job.paymentStatus} />
                                    {job.hasOpenIssue && (
                                      <span className="text-xs bg-red-100 text-red-700 px-3 py-1 rounded-full font-medium border border-red-200">
                                        Issue Open
                                      </span>
                                    )}
                                    {job.noShow?.status === 'NO_SHOW' && (
                                      <span className="text-xs bg-orange-100 text-orange-700 px-3 py-1 rounded-full font-medium border border-orange-200">
                                        {t('job.noShow.badge' as any) || 'No-show'}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                {job.jobNumber && (
                                  <div className="text-xs font-semibold mb-1" style={{ color: 'var(--sf-orange)' }}>
                                    Job #{String(job.jobNumber).padStart(5, '0')}
                                  </div>
                                )}
                                {job.payment?.amountCents && (
                                  <div className="text-sm font-semibold mb-2" style={{ color: 'var(--sf-orange)' }}>
                                    ${(job.payment.amountCents / 100).toFixed(2)}
                                  </div>
                                )}
                                <div className="text-xs mb-2" style={{ color: 'var(--sf-muted)' }}>{job.vehicleInfo}</div>
                                <div className="text-sm font-medium mb-1" style={{ color: 'var(--sf-ink)' }}>{job.serviceType}</div>
                                {(() => {
                                  const addons = parseAddonsFromNotes(job.notes);
                                  return addons.length > 0 && (
                                    <div className="text-xs mb-1" style={{ color: 'var(--sf-muted)' }}>
                                      <span className="font-medium">Add-ons:</span> {addons.join(', ')}
                                    </div>
                                  );
                                })()}
                                <div className="text-xs font-medium" style={{ color: 'var(--sf-muted)' }}>
                                  {new Date(job.scheduledStart).toLocaleTimeString(locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US', {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                  })}
                                </div>
                              </Link>
                              
                              {nextStatus && (
                                <button
                                  onClick={() => updateJobStatus(job.jobId, nextStatus)}
                                  disabled={isUpdating}
                                  className={`mt-3 w-full h-9 px-3 text-sm font-medium rounded-lg sf-button-transition ${
                                    isUpdating
                                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                      : 'bg-[#F47C20] text-white hover:bg-[#DB6E1C]'
                                  }`}
                                >
                                  {isUpdating ? 'Updating...' : `Move to ${columns.find(c => c.status === nextStatus)?.title}`}
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cancelled Jobs Section */}
            {(() => {
              const cancelledJobs = jobs.filter(job => job.workStatus === WorkStatus.CANCELLED);
              if (cancelledJobs.length === 0) return null;
              
              return (
                <div className="mt-8">
                  <div className="bg-white border-b p-4 mb-4 rounded-t-2xl" style={{ borderColor: 'var(--sf-border)', boxShadow: 'var(--sf-shadow)' }}>
                    <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--sf-muted)' }}>
                      <span 
                        className="w-2 h-2 rounded-full" 
                        style={{ backgroundColor: cancelledColumn.color }}
                      ></span>
                      <span>{cancelledColumn.title}</span>
                      <span 
                        className="ml-auto px-3 py-1 text-xs rounded-full font-medium bg-gray-100"
                        style={{ color: 'var(--sf-muted)' }}
                      >
                        {cancelledJobs.length}
                      </span>
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-5 gap-4 px-1">
                    {cancelledJobs.map((job) => (
                      <div
                        key={job.jobId}
                        className="bg-white rounded-2xl p-4 border border-gray-300 opacity-60 relative"
                        style={{ 
                          boxShadow: 'var(--sf-shadow)',
                          borderLeft: `4px solid ${cancelledColumn.color}`,
                          filter: 'grayscale(0.5)'
                        }}
                      >
                        {/* CANCELLED Badge */}
                        <div className="absolute top-2 right-2 bg-[#F47C20] text-white px-3 py-1 rounded-full text-xs font-bold">
                          CANCELLED
                        </div>

                        <Link
                          href={`/${locale}/jobs/${job.jobId}`}
                          className="block hover:opacity-90 transition"
                        >
                          <div className="flex items-start justify-between mb-2 pr-24">
                            <div className="font-semibold text-sm" style={{ color: 'var(--sf-ink)' }}>{job.customerName}</div>
                          </div>
                          {job.payment?.amountCents && (
                            <div className="text-sm font-semibold mb-2 line-through" style={{ color: 'var(--sf-muted)' }}>
                              ${(job.payment.amountCents / 100).toFixed(2)}
                            </div>
                          )}
                          <div className="text-xs mb-2" style={{ color: 'var(--sf-muted)' }}>{job.vehicleInfo}</div>
                          <div className="text-sm font-medium mb-1 line-through" style={{ color: 'var(--sf-ink)' }}>{job.serviceType}</div>
                          <div className="text-xs font-medium" style={{ color: 'var(--sf-muted)' }}>
                            {new Date(job.scheduledStart).toLocaleTimeString(locale === 'ar' ? 'ar-SA' : locale === 'es' ? 'es-ES' : 'en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </div>
                        </Link>
                        
                        {/* No action buttons for cancelled jobs */}
                        <div className="mt-3 text-xs text-center" style={{ color: 'var(--sf-muted)' }}>
                          Booking cancelled in Square
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </main>
    </div>
  );
}
