'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useTranslations } from '@/lib/i18n/provider';
import { usePolling } from '@/lib/hooks/usePolling';
import type { Locale } from '@/i18n';

interface Job {
  jobId: string;
  jobNumber?: number; // Unique job number (10001, 10002, etc.)
  customerName: string;
  vehicleInfo?: {
    year?: string;
    make?: string;
    model?: string;
    licensePlate?: string;
  };
  serviceType: string;
  appointmentTime: string;
  status: string;
}

export default function CalendarPage() {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const params = useParams();
  const locale = params.locale as Locale;

  const [currentDate, setCurrentDate] = useState(new Date());

  // Fetch jobs with polling (every 20 seconds)
  const fetchJobs = useCallback(async (): Promise<Job[]> => {
    const response = await fetch('/api/jobs');
    
    if (!response.ok) {
      throw new Error(`Failed to fetch jobs: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success && data.data?.jobs) {
      return data.data.jobs;
    }
    
    return [];
  }, []);

  const { data: jobs, loading, error, lastUpdatedAt, refresh } = usePolling(
    fetchJobs,
    20000, // Poll every 20 seconds
    { enabled: true, runOnMount: true, pauseWhenHidden: true }
  );

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

  // Group jobs by date
  const jobsByDate = (jobs || []).reduce((acc, job) => {
    const date = new Date(job.appointmentTime).toDateString();
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(job);
    return acc;
  }, {} as Record<string, Job[]>);

  // Get dates for the current month
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDayOfWeek = firstDay.getDay();

  const monthNames = locale === 'es' 
    ? ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
    : locale === 'ar'
    ? ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
    : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const dayNames = locale === 'es'
    ? ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
    : locale === 'ar'
    ? ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const previousMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const today = new Date().toDateString();

  return (
    <div className="min-h-screen" style={{ background: 'var(--sf-bg)' }}>
      {/* Header */}
      <header className="bg-white shadow-sm border-b-[3px] border-[#F47C20]" style={{ boxShadow: 'var(--sf-shadow)' }}>
        <div className="container mx-auto px-2 sm:px-4 py-3 sm:py-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-4">
              <Link 
                href={`/${locale}`}
                className="text-xl sm:text-2xl hover:opacity-80 transition"
                style={{ color: 'var(--sf-ink)' }}
              >
                {locale === 'ar' ? '→' : '←'}
              </Link>
              <Image src="/safari-logo.png" alt="Safari Car Wash" width={40} height={40} className="object-contain sm:w-[50px] sm:h-[50px]" />
              <h1 className="text-lg sm:text-2xl font-bold" style={{ color: 'var(--sf-ink)' }}>{t('calendar')}</h1>
            </div>
            <Link 
              href={`/${locale}/settings`}
              className="px-3 py-2 sm:px-6 sm:py-3 bg-white border border-[#E7E2D8] rounded-lg sm:rounded-xl font-medium hover:bg-[#FAF6EF] sf-button-transition flex items-center gap-1 sm:gap-2"
              style={{ color: 'var(--sf-ink)' }}
              title={t('settings')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="hidden sm:inline">{t('settings')}</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 max-w-7xl">
        {/* Month Navigation */}
        <div className="bg-white rounded-xl sm:rounded-2xl p-4 sm:p-6 mb-4 sm:mb-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
          <div className="flex items-center justify-between">
            <button
              onClick={previousMonth}
              className="px-3 py-2 sm:px-5 bg-white border border-[#E7E2D8] hover:bg-[#FAF6EF] rounded-lg sm:rounded-xl transition font-medium sf-button-transition"
              style={{ color: 'var(--sf-ink)' }}
            >
              {locale === 'ar' ? '→' : '←'}
            </button>
            <div className="flex flex-col items-center">
              <h2 className="text-lg sm:text-2xl font-bold" style={{ color: 'var(--sf-ink)' }}>
                {monthNames[month]} {year}
              </h2>
              {lastUpdatedAt && (
                <p className="text-xs mt-1" style={{ color: 'var(--sf-muted)' }}>
                  Updated {formatLastUpdated(lastUpdatedAt)}
                </p>
              )}
            </div>
            <button
              onClick={nextMonth}
              className="px-3 py-2 sm:px-5 bg-white border border-[#E7E2D8] hover:bg-[#FAF6EF] rounded-lg sm:rounded-xl transition font-medium sf-button-transition"
              style={{ color: 'var(--sf-ink)' }}
            >
              {locale === 'ar' ? '←' : '→'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F47C20]"></div>
            <p className="mt-2" style={{ color: 'var(--sf-muted)' }}>{tCommon('loading')}</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl sm:rounded-2xl p-3 sm:p-6" style={{ boxShadow: 'var(--sf-shadow)', border: '1px solid var(--sf-border)' }}>
            {/* Calendar Grid */}
            <div className="grid grid-cols-7 gap-1 sm:gap-2">
              {/* Day headers */}
              {dayNames.map((day, index) => (
                <div key={index} className="text-center font-semibold p-1 sm:p-2 text-xs sm:text-base" style={{ color: 'var(--sf-brown)' }}>
                  {day}
                </div>
              ))}

              {/* Empty cells before first day */}
              {Array.from({ length: startingDayOfWeek }).map((_, index) => (
                <div key={`empty-${index}`} className="p-1 sm:p-2 min-h-[60px] sm:min-h-[100px]"></div>
              ))}

              {/* Calendar days */}
              {Array.from({ length: daysInMonth }).map((_, index) => {
                const day = index + 1;
                const date = new Date(year, month, day);
                const dateString = date.toDateString();
                const isToday = dateString === today;
                const dayJobs = jobsByDate[dateString] || [];

                return (
                  <div
                    key={day}
                    className={`p-1 sm:p-2 min-h-[60px] sm:min-h-[100px] border rounded ${
                      isToday ? 'bg-sky-50 border-sky-500' : 'border-gray-200 hover:bg-gray-50'
                    } transition`}
                  >
                    <div className={`font-medium mb-0.5 sm:mb-1 text-xs sm:text-base ${isToday ? 'text-sky-600' : 'text-gray-700'}`}>
                      {day}
                    </div>
                    <div className="space-y-0.5 sm:space-y-1">
                      {dayJobs.slice(0, 3).map((job) => (
                        <Link
                          key={job.jobId}
                          href={`/${locale}/jobs/${job.jobId}`}
                          className="block text-[10px] sm:text-xs bg-primary-100 text-primary-800 rounded px-1 sm:px-2 py-0.5 sm:py-1 hover:bg-primary-200 transition truncate"
                        >
                          {job.jobNumber && `Job #${String(job.jobNumber).padStart(5, '0')} - `}{job.customerName}
                        </Link>
                      ))}
                      {dayJobs.length > 3 && (
                        <div className="text-[10px] sm:text-xs text-gray-500 px-1 sm:px-2">
                          +{dayJobs.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md flex items-center justify-between">
            <span>{tCommon('error')}: {error.message || 'Failed to load jobs'}</span>
            <button
              onClick={refresh}
              className="ml-4 px-3 py-1 bg-yellow-100 hover:bg-yellow-200 rounded transition text-sm font-medium"
            >
              Retry
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
