<script lang="ts">
  import { tr, i18n } from '../i18n.svelte';
  import {
    ArrowLeft,
    Bell,
    Bot,
    CalendarClock,
    CalendarDays,
    Check,
    ChevronLeft,
    ChevronRight,
    CircleAlert,
    Clock3,
    CloudOff,
    Globe,
    ListChecks,
    MapPin,
    PanelLeftOpen,
    Pencil,
    Plus,
    RefreshCw,
    Repeat2,
    Trash2,
    X,
  } from '@lucide/svelte';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { ApiError } from '../http';
  import { app } from '../app.svelte';
  import {
    addCalendarDays,
    allDayBarsForDate,
    allDayBarsForWeek,
    calendarApi,
    dateInTimezone,
    formatDateKey,
    isCalendarView,
    isDateKey,
    itemOccursOnDate,
    monthGrid,
    requestRange,
    startOfWeek,
    todayInTimezone,
    timedSegmentsForDate,
    visibleDateRange,
    weekdayOf,
    zonedDateBounds,
    zonedHourLabels,
    zonedDateParts,
    zonedTime,
    type AllDayBar,
    type CalendarEditScope,
    type CalendarEvent,
    type CalendarEventSpec,
    type CalendarContext,
    type CalendarItem,
    type CalendarPermissions,
    type CalendarRangeResponse,
    type CalendarRecurrence,
    type CalendarView,
    type CalendarWeekStart,
  } from '../calendar';
  import { uuid } from '../id';
  import Modal from './dialogs/Modal.svelte';
  import ScheduleSettings from './ScheduleSettings.svelte';
  import {
    RUN_LABELS,
    deviceTimezone,
    schedulesApi,
    timezones,
    type Schedule,
    type ScheduleRun,
  } from '../schedules';
  import { watch } from '../watch.svelte';

  interface Props {
    /** Desktop: the sidebar is hidden, so the page offers the button to show it. */
    sidebarCollapsed?: boolean;
    onexpand?: () => void;
    onopenchat: (sessionId: string) => void;
  }

  type ItemFilter = 'all' | 'event' | 'schedule';
  type RecurrenceFrequency = CalendarRecurrence['frequency'] | '';
  type RecurrenceEndMode = 'never' | 'until' | 'count';
  interface EventForm {
    id?: string;
    revision?: number;
    idempotencyKey?: string;
    sourceEvent?: CalendarEvent;
    occurrence?: string;
    occurrenceStart?: string;
    occurrenceEnd?: string;
    occurrenceTimezone?: string;
    occurrenceAllDay?: boolean;
    scope: CalendarEditScope;
    title: string;
    description: string;
    location: string;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    timezone: string;
    allDay: boolean;
    frequency: RecurrenceFrequency;
    interval: number;
    weekdays: number[];
    endMode: RecurrenceEndMode;
    until: string;
    count: string;
    reminderMinutes: number[];
    moveNotice?: string;
  }
  interface EntryGesture {
    pointerId: number;
    item: CalendarItem;
    mode: 'move' | 'resize';
    date: string;
    columnTop: number;
    startY: number;
    startX: number;
    pointerOffsetY: number;
  }

  let { sidebarCollapsed = false, onexpand, onopenchat }: Props = $props();

  const PREF_PREFIX = 'pirc.calendar.preferences.v1:';
  const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 1440];
  const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
  const HOUR_HEIGHT = 56;
  let accountKey = $state<string>();
  const locale = $derived(i18n.language === 'zh-TW' ? 'zh-TW' : 'en');
  const zones = timezones();

  function validTimezone(value: string): boolean {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }

  function validStartAt(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      Math.abs(value) <= 8_640_000_000_000_000
    );
  }

  function readPrefs(ownerKey = accountKey): {
    view?: CalendarView;
    timezone?: string;
    weekStart?: CalendarWeekStart;
  } {
    try {
      if (!ownerKey) return {};
      const raw = localStorage.getItem(`${PREF_PREFIX}${encodeURIComponent(ownerKey)}`) ?? '{}';
      const value = JSON.parse(raw) as Record<string, unknown>;
      return {
        ...(isCalendarView(value.view) ? { view: value.view } : {}),
        ...(typeof value.timezone === 'string' && validTimezone(value.timezone)
          ? { timezone: value.timezone }
          : {}),
        ...(value.weekStart === 'monday' || value.weekStart === 'sunday'
          ? { weekStart: value.weekStart }
          : {}),
      };
    } catch {
      return {};
    }
  }

  function readRoute() {
    const query = new URLSearchParams(location.search);
    const prefs = readPrefs();
    const timezone = prefs.timezone ?? deviceTimezone();
    const startAtText = query.get('startAt');
    const parsedStartAt =
      startAtText && /^-?\d+$/.test(startAtText) ? Number(startAtText) : undefined;
    const startAt = validStartAt(app.calendarFocus?.startAt)
      ? app.calendarFocus.startAt
      : validStartAt(parsedStartAt)
        ? parsedStartAt
        : undefined;
    return {
      view: isCalendarView(query.get('view'))
        ? (query.get('view') as CalendarView)
        : (prefs.view ?? 'month'),
      date:
        startAt !== undefined
          ? dateInTimezone(startAt, timezone)
          : isDateKey(query.get('date'))
            ? query.get('date')!
            : isDateKey(app.calendarFocus?.date)
              ? app.calendarFocus.date!
              : isDateKey(query.get('occurrence')?.slice(0, 10))
                ? query.get('occurrence')!.slice(0, 10)
                : todayInTimezone(timezone),
      timezone,
      weekStart: prefs.weekStart ?? 'sunday',
      item:
        query.get('item') ??
        (query.get('event') && query.get('occurrence')
          ? `event:${query.get('event')}:${query.get('occurrence')}`
          : undefined),
      manage: query.get('manage') === 'schedules' || !!query.get('schedule'),
      scheduleId: query.get('schedule') ?? app.scheduleFocus,
      createSchedule: query.get('newSchedule') === '1',
    };
  }

  const initial = readRoute();
  let view = $state<CalendarView>(initial.view);
  let anchorDate = $state(initial.date);
  let selectedDate = $state(initial.date);
  let timezone = $state(initial.timezone);
  let weekStart = $state<CalendarWeekStart>(initial.weekStart);
  let filter = $state<ItemFilter>('all');
  let selectedItemId = $state(initial.item);
  let agendaDate = $state<string>();
  let scheduleManagement = $state(initial.manage);
  let scheduleInitialId = $state(initial.scheduleId);
  let createScheduleOnMount = $state(initial.createSchedule);
  let createType = $state<'event' | 'schedule'>('event');
  let editor = $state<EventForm | null>(null);
  let editorOpen = $state(false);
  let editorBusy = $state(false);
  let editorError = $state('');
  let editorConflict = $state<CalendarEvent>();
  let editorConflictLoading = $state(false);
  let detailEvent = $state<CalendarEvent>();
  let detailSchedule = $state<Schedule>();
  let detailRuns = $state<ScheduleRun[]>([]);
  let detailLoading = $state(false);
  let detailError = $state('');
  let detailConflict = $state<CalendarEvent>();
  let detailConflictLoading = $state(false);
  let detailScope = $state<CalendarEditScope>('series');
  let confirmDelete = $state(false);
  let detailBusy = $state(false);
  let detailBusyAction = $state('');
  let permissionsOpen = $state(false);
  let permissionsLoading = $state(false);
  let permissionsSaving = $state(false);
  let permissionsError = $state('');
  let permissions = $state<CalendarPermissions>({ allowRead: false, allowPropose: false });
  let reminderDeliveryAvailable = $state(false);
  let calendarContextReady = $state(false);
  let contextSequence = 0;
  let contextController: AbortController | undefined;
  let entryGesture: EntryGesture | undefined;
  let suppressEntryClickUntil = 0;
  let loading = $state(true);
  let loadingMore = $state(false);
  let loadError = $state('');
  let historyLimited = $state(true);
  let limited = $state(false);
  let nextCursor = $state<string | null>(null);
  let items = $state<CalendarItem[]>([]);
  let refreshRevision = $state(0);
  let loadSequence = 0;
  let detailSequence = 0;
  let permissionsSequence = 0;
  let handledCalendarNavigationRevision = 0;
  let loadController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let activeRangeKey = '';
  let loadedRangeKey = '';

  const visibleRange = $derived(visibleDateRange(view, anchorDate, weekStart));
  const request = $derived(requestRange(view, anchorDate, weekStart, timezone));
  const today = $derived(todayInTimezone(timezone));
  const monthWeeks = $derived(monthGrid(anchorDate, weekStart));
  const visibleItems = $derived(items.filter((item) => filter === 'all' || item.type === filter));
  const selectedItem = $derived(items.find((item) => item.id === selectedItemId));
  const periodTitle = $derived.by(() => {
    if (view === 'month' || view === 'list')
      return formatDateKey(`${anchorDate.slice(0, 7)}-15`, locale, {
        month: 'long',
        year: 'numeric',
      });
    if (view === 'week') {
      const start = startOfWeek(anchorDate, weekStart);
      const end = addCalendarDays(start, 6);
      const left = formatDateKey(start, locale, { month: 'short', day: 'numeric' });
      const right = formatDateKey(end, locale, {
        month: 'short',
        day: 'numeric',
        ...(start.slice(0, 4) !== end.slice(0, 4) ? { year: 'numeric' as const } : {}),
      });
      return `${left} – ${right}`;
    }
    return formatDateKey(anchorDate, locale, { month: 'long', day: 'numeric', year: 'numeric' });
  });
  const weekdayLabels = $derived.by(() => {
    const sunday = '2026-02-01';
    const offset = weekStart === 'monday' ? 1 : 0;
    return Array.from({ length: 7 }, (_, index) =>
      formatDateKey(addCalendarDays(sunday, (index + offset) % 7), locale, { weekday: 'short' }),
    );
  });
  const timeDates = $derived.by(() => {
    const first = view === 'week' ? startOfWeek(anchorDate, weekStart) : anchorDate;
    return Array.from({ length: view === 'week' ? 7 : 1 }, (_, index) =>
      addCalendarDays(first, index),
    );
  });
  const listDates = $derived.by(() => {
    const length = Math.round(
      (Date.parse(`${visibleRange.endDate}T00:00:00Z`) -
        Date.parse(`${visibleRange.startDate}T00:00:00Z`)) /
        86_400_000,
    );
    return Array.from({ length: Math.max(0, length) }, (_, index) =>
      addCalendarDays(visibleRange.startDate, index),
    );
  });
  const visibleTimeBounds = $derived(timeDates.map((date) => zonedDateBounds(date, timezone)));
  const maxTimelineHours = $derived(
    Math.max(24, ...visibleTimeBounds.map(({ start, end }) => (end - start) / 3_600_000)),
  );
  const historyMessage = $derived(
    tr('Past schedule entries show recorded runs only; forecasts never start a task.'),
  );

  function persistPrefs() {
    try {
      if (!calendarContextReady || !accountKey) return;
      localStorage.setItem(
        `${PREF_PREFIX}${encodeURIComponent(accountKey)}`,
        JSON.stringify({ view, timezone, weekStart }),
      );
    } catch {
      /* Display preferences are optional when local storage is unavailable. */
    }
  }

  function applyAccountPrefs(ownerKey: string, force = false) {
    const params = new URLSearchParams(location.search);
    const prefs = readPrefs(ownerKey);
    if ((force || !isCalendarView(params.get('view'))) && prefs.view) view = prefs.view;
    if ((force || !params.has('timezone')) && prefs.timezone) timezone = prefs.timezone;
    if ((force || !params.has('weekStart')) && prefs.weekStart) weekStart = prefs.weekStart;
    if (force || (!isDateKey(params.get('date')) && !params.has('startAt'))) {
      anchorDate = todayInTimezone(timezone);
      selectedDate = anchorDate;
    }
  }

  function writeRoute(mode: 'push' | 'replace' = 'push') {
    const query = new URLSearchParams();
    query.set('open', 'calendar');
    query.set('view', view);
    query.set('date', anchorDate);
    if (selectedItemId) query.set('item', selectedItemId);
    if (scheduleManagement) query.set('manage', 'schedules');
    if (scheduleManagement && scheduleInitialId) query.set('schedule', scheduleInitialId);
    if (scheduleManagement && createScheduleOnMount) query.set('newSchedule', '1');
    const url = new URL(location.href);
    url.search = query.toString();
    history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', url);
  }

  function applyCalendarNavigation() {
    const revision = app.calendarNavigationRevision;
    if (!calendarContextReady || revision === handledCalendarNavigationRevision) return;
    handledCalendarNavigationRevision = revision;
    const focus = app.calendarFocus;
    app.calendarFocus = undefined;
    scheduleManagement = false;
    createScheduleOnMount = false;
    scheduleInitialId = undefined;
    editorOpen = false;
    editor = null;
    editorConflict = undefined;
    confirmDelete = false;
    selectedItemId = undefined;
    agendaDate = undefined;
    if (focus) {
      const focusDate = validStartAt(focus.startAt)
        ? dateInTimezone(focus.startAt, timezone)
        : isDateKey(focus.date)
          ? focus.date
          : focus.occurrenceStart && isDateKey(focus.occurrenceStart.slice(0, 10))
            ? focus.occurrenceStart.slice(0, 10)
            : undefined;
      if (focusDate) {
        anchorDate = focusDate;
        selectedDate = anchorDate;
        view = 'day';
      }
      selectedItemId = focus.occurrenceStart
        ? `event:${focus.eventId}:${focus.occurrenceStart}`
        : undefined;
    }
    writeRoute('replace');
  }

  $effect(() => {
    const revision = app.calendarNavigationRevision;
    const contextReady = calendarContextReady;
    if (contextReady && revision !== handledCalendarNavigationRevision)
      untrack(() => applyCalendarNavigation());
  });

  function applyRoute() {
    const route = readRoute();
    view = route.view;
    anchorDate = route.date;
    selectedDate = route.date;
    timezone = route.timezone;
    weekStart = route.weekStart;
    selectedItemId = route.item;
    scheduleManagement = route.manage;
    scheduleInitialId = route.scheduleId;
    createScheduleOnMount = route.createSchedule;
    agendaDate = undefined;
  }

  function message(cause: unknown) {
    return cause instanceof ApiError
      ? cause.message
      : tr('Unable to reach the gateway. Your changes are still here; retry when it is available.');
  }

  async function loadCalendarContext() {
    if (app.usingDemo) return;
    contextController?.abort();
    const controller = new AbortController();
    contextController = controller;
    const sequence = ++contextSequence;
    calendarContextReady = false;
    loading = true;
    try {
      const context: CalendarContext = await calendarApi.context(controller.signal);
      if (sequence !== contextSequence || controller.signal.aborted) return;
      if (
        typeof context.accountKey !== 'string' ||
        !context.accountKey ||
        context.accountKey.length > 256
      )
        throw new Error('Calendar account context was invalid.');
      const changedAccount = accountKey !== context.accountKey;
      const switchedAccount = !!accountKey && changedAccount;
      if (switchedAccount) {
        loadController?.abort();
        detailController?.abort();
        activeRangeKey = '';
        loadedRangeKey = '';
        loadSequence++;
        detailSequence++;
        items = [];
        nextCursor = null;
        limited = false;
        detailEvent = undefined;
        detailSchedule = undefined;
        detailRuns = [];
        editor = null;
        editorOpen = false;
        selectedItemId = undefined;
      }
      accountKey = context.accountKey;
      reminderDeliveryAvailable = context.reminderDeliveryAvailable === true;
      if (changedAccount) applyAccountPrefs(context.accountKey, switchedAccount);
      calendarContextReady = true;
      loadError = '';
    } catch (cause) {
      if (sequence !== contextSequence || controller.signal.aborted) return;
      calendarContextReady = false;
      loadError = message(cause);
    } finally {
      if (sequence === contextSequence) loading = false;
    }
  }

  async function loadRange(
    queryKey: string,
    range: { from: number; to: number },
    zone: string,
    cursor?: string,
  ) {
    const append = !!cursor;
    const dataRangeKey = `${range.from}/${range.to}/${zone}`;
    if (!append) {
      loadController?.abort();
      loadController = new AbortController();
      activeRangeKey = queryKey;
      if (loadedRangeKey !== dataRangeKey) {
        // Keep the last successful result visible during a same-range refresh
        // so a temporary outage does not erase the calendar from view.
        items = [];
        loadedRangeKey = '';
        nextCursor = null;
        limited = false;
        historyLimited = true;
      }
      loadError = '';
      loading = true;
    } else {
      loadingMore = true;
    }
    const controller = loadController;
    const sequence = ++loadSequence;
    try {
      const result = await calendarApi.range(
        { ...range, timezone: zone, ...(cursor ? { cursor } : {}) },
        controller?.signal,
      );
      if (sequence !== loadSequence || queryKey !== activeRangeKey) return;
      if (result.accountKey !== accountKey) {
        loadController?.abort();
        activeRangeKey = '';
        loadedRangeKey = '';
        loadSequence++;
        items = [];
        nextCursor = null;
        calendarContextReady = false;
        void loadCalendarContext();
        return;
      }
      items = append
        ? [
            ...items.filter((item) => !result.items.some((fresh) => fresh.id === item.id)),
            ...result.items,
          ]
        : result.items;
      loadedRangeKey = dataRangeKey;
      limited = result.limited;
      nextCursor = result.nextCursor;
      historyLimited = result.historyLimited;
    } catch (cause) {
      if (sequence !== loadSequence || controller?.signal.aborted) return;
      loadError = message(cause);
    } finally {
      if (sequence === loadSequence) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  $effect(() => {
    const range = request;
    const zone = timezone;
    const key = `${range.from}/${range.to}/${zone}/${refreshRevision}/${app.scheduleRevision}`;
    if (app.usingDemo) {
      untrack(() => {
        loadController?.abort();
        activeRangeKey = '';
        loadSequence++;
        loading = false;
        items = [];
        loadedRangeKey = '';
      });
      return;
    }
    if (app.loading) {
      untrack(() => {
        loadController?.abort();
        contextController?.abort();
        contextSequence++;
        calendarContextReady = false;
        detailController?.abort();
        activeRangeKey = '';
        loadSequence++;
        detailSequence++;
        permissionsSequence++;
        items = [];
        loadedRangeKey = '';
        detailEvent = undefined;
        detailSchedule = undefined;
        detailRuns = [];
        loading = true;
      });
      return;
    }
    if (!calendarContextReady) return;
    untrack(() => void loadRange(key, range, zone));
  });

  $effect(() => {
    const busy = app.loading;
    const enabled = permissionsOpen && !app.usingDemo;
    if (busy) {
      untrack(() => {
        permissionsSequence++;
        permissionsLoading = false;
        permissions = { allowRead: false, allowPropose: false };
      });
      return;
    }
    if (enabled) untrack(() => void loadPermissions());
  });

  onMount(() => {
    let active = true;
    const onPopState = () => applyRoute();
    window.addEventListener('popstate', onPopState);
    if (!app.usingDemo && !app.loading) {
      void loadCalendarContext().then(() => {
        if (!active || !calendarContextReady) return;
        applyCalendarNavigation();
        const requestedSchedule = app.scheduleFocus;
        if (requestedSchedule && !scheduleManagement) {
          scheduleManagement = true;
          scheduleInitialId = requestedSchedule;
          view = 'list';
          app.scheduleFocus = undefined;
        }
        writeRoute('replace');
      });
    }
    return () => {
      active = false;
      window.removeEventListener('popstate', onPopState);
    };
  });

  onDestroy(() => {
    loadController?.abort();
    contextController?.abort();
    detailController?.abort();
    loadSequence++;
    contextSequence++;
    detailSequence++;
    permissionsSequence++;
  });

  watch(
    () => app.loading,
    (busy, previous) => {
      if (previous && !busy && !app.usingDemo) void loadCalendarContext();
    },
  );

  watch(
    () => app.scheduleRevision,
    () => {
      if (!app.usingDemo && !app.loading) refreshRevision++;
    },
  );

  $effect(() => persistPrefs());

  function itemsForDate(date: string): CalendarItem[] {
    return visibleItems
      .filter((item) => itemOccursOnDate(item, date, timezone))
      .sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          a.startAt - b.startAt ||
          a.title.localeCompare(b.title),
      );
  }

  function dayHeading(date: string) {
    return formatDateKey(date, locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function localDateTime(at: number, zone = timezone) {
    const parts = zonedDateParts(at, zone);
    return `${parts.date}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  }

  function eventDateTime(value: string) {
    return value.length > 10 ? value : `${value}T00:00`;
  }

  function wallMillis(value: string) {
    return Date.parse(`${eventDateTime(value)}:00Z`);
  }

  function shiftWall(value: string, delta: number) {
    const moved = new Date(wallMillis(value) + delta).toISOString();
    return value.length > 10 ? moved.slice(0, 16) : moved.slice(0, 10);
  }

  function setFormFromSpec(form: EventForm, event: CalendarEventSpec) {
    if (event.allDay) {
      form.startDate = event.start.slice(0, 10);
      form.endDate = addCalendarDays(event.end.slice(0, 10), -1);
      form.startTime = '09:00';
      form.endTime = '10:00';
    } else {
      const [startDate, startTime] = event.start.split('T');
      const [endDate, endTime] = event.end.split('T');
      form.startDate = startDate ?? today;
      form.startTime = startTime ?? '09:00';
      form.endDate = endDate ?? form.startDate;
      form.endTime = endTime ?? '10:00';
    }
    form.title = event.title;
    form.description = event.description;
    form.location = event.location;
    form.timezone = event.timezone;
    form.allDay = event.allDay;
    form.frequency = event.recurrence?.frequency ?? '';
    form.interval = event.recurrence?.interval ?? 1;
    form.weekdays = [...(event.recurrence?.weekdays ?? [])];
    form.endMode = event.recurrence?.count ? 'count' : event.recurrence?.until ? 'until' : 'never';
    form.until = event.recurrence?.until ?? '';
    form.count = event.recurrence?.count ? String(event.recurrence.count) : '';
    form.reminderMinutes = [...event.reminderMinutes];
  }

  function blankEventForm(date = selectedDate, startAt?: number): EventForm {
    const start = startAt === undefined ? `${date}T10:00` : localDateTime(startAt);
    const end = startAt === undefined ? `${date}T11:00` : localDateTime(startAt + 3_600_000);
    const [startDate, startTime] = start.split('T');
    const [endDate, endTime] = end.split('T');
    return {
      scope: 'series',
      title: '',
      description: '',
      location: '',
      startDate: startDate ?? date,
      startTime: startTime ?? '10:00',
      endDate: endDate ?? date,
      endTime: endTime ?? '11:00',
      timezone,
      allDay: false,
      frequency: '',
      interval: 1,
      weekdays: [weekdayOf(date)],
      endMode: 'never',
      until: '',
      count: '',
      reminderMinutes: [10],
    };
  }

  function openNewEvent(date = selectedDate, startAt?: number) {
    editor = { ...blankEventForm(date, startAt), idempotencyKey: uuid() };
    createType = 'event';
    editorError = '';
    editorConflict = undefined;
    editorOpen = true;
  }

  function openEditEvent(item: CalendarItem, event: CalendarEvent) {
    const form = blankEventForm(item.startDate ?? dateInTimezone(item.startAt, timezone));
    setFormFromSpec(form, event);
    form.id = event.id;
    // The detail request may be newer than the revision shown in the range.
    // Keep the projected revision until the user explicitly adopts a conflict's
    // current version, so stale occurrence boundaries cannot overwrite a move.
    form.revision = item.revision ?? event.revision;
    form.sourceEvent = event;
    form.occurrence = item.originalStart;
    form.occurrenceStart = item.allDay
      ? (item.startDate ?? dateInTimezone(item.startAt, item.timezone))
      : localDateTime(item.startAt, item.timezone);
    form.occurrenceEnd = item.allDay
      ? (item.endDate ?? addCalendarDays(form.occurrenceStart, 1))
      : localDateTime(item.endAt, item.timezone);
    form.occurrenceTimezone = item.timezone;
    form.occurrenceAllDay = item.allDay;
    form.scope = 'series';
    editor = form;
    createType = 'event';
    editorError = '';
    editorConflict = undefined;
    editorOpen = true;
  }

  function changeScope(scope: CalendarEditScope) {
    if (!editor) return;
    const source = editor.sourceEvent;
    if (source && editor.occurrence && scope !== editor.scope) {
      if (scope === 'series') {
        setFormFromSpec(editor, source);
      } else {
        const start = editor.occurrenceStart ?? editor.occurrence;
        const delta = wallMillis(editor.occurrence) - wallMillis(source.start);
        const shifted = {
          ...source,
          start: start ?? shiftWall(source.start, delta),
          end: editor.occurrenceEnd ?? shiftWall(source.end, delta),
          timezone: editor.occurrenceTimezone ?? source.timezone,
          allDay: editor.occurrenceAllDay ?? source.allDay,
        };
        setFormFromSpec(editor, shifted);
      }
    }
    editor.scope = scope;
  }

  function toggleNumber(list: number[], value: number, checked: boolean): number[] {
    return checked
      ? [...new Set([...list, value])].sort((a, b) => a - b)
      : list.filter((item) => item !== value);
  }

  function recurrenceFromForm(form: EventForm): CalendarRecurrence | null {
    if (!form.frequency) return null;
    const recurrence: CalendarRecurrence = {
      frequency: form.frequency,
      interval: Math.max(1, Math.floor(Number(form.interval) || 1)),
      ...(form.frequency === 'weekly'
        ? { weekdays: [...form.weekdays].sort((a, b) => a - b) }
        : {}),
      ...(form.endMode === 'until' && form.until ? { until: form.until } : {}),
      ...(form.endMode === 'count' && form.count
        ? { count: Math.max(1, Math.floor(Number(form.count))) }
        : {}),
    };
    return recurrence;
  }

  function setRecurrenceEndMode(mode: RecurrenceEndMode) {
    if (!editor) return;
    editor.endMode = mode;
    editor.until = mode === 'until' ? editor.until || editor.startDate : '';
    editor.count = mode === 'count' ? editor.count || '1' : '';
  }

  function eventSpec(form: EventForm): CalendarEventSpec | undefined {
    if (!form.title.trim()) {
      editorError = tr('Enter a title for this event.');
      return undefined;
    }
    if (!validTimezone(form.timezone.trim())) {
      editorError = tr('Choose a valid IANA time zone.');
      return undefined;
    }
    if (!isDateKey(form.startDate) || !isDateKey(form.endDate)) {
      editorError = tr('Choose valid start and end dates.');
      return undefined;
    }
    if (form.frequency === 'weekly' && !form.weekdays.length) {
      editorError = tr('Choose at least one weekday.');
      return undefined;
    }
    const start = form.allDay ? form.startDate : `${form.startDate}T${form.startTime}`;
    const end = form.allDay ? addCalendarDays(form.endDate, 1) : `${form.endDate}T${form.endTime}`;
    if (end <= start) {
      editorError = tr('The end must be later than the start.');
      return undefined;
    }
    return {
      title: form.title.trim(),
      description: form.description,
      location: form.location.trim(),
      start,
      end,
      timezone: form.timezone.trim(),
      allDay: form.allDay,
      recurrence: recurrenceFromForm(form),
      reminderMinutes: [...form.reminderMinutes].sort((a, b) => a - b),
    };
  }

  async function reloadConflict(id: string, intoEditor: boolean) {
    if (intoEditor) editorConflictLoading = true;
    else detailConflictLoading = true;
    try {
      const current = (await calendarApi.event(id)).event;
      if (intoEditor) editorConflict = current;
      else detailConflict = current;
    } catch {
      if (intoEditor) editorConflict = undefined;
      else detailConflict = undefined;
    } finally {
      if (intoEditor) editorConflictLoading = false;
      else detailConflictLoading = false;
    }
  }

  async function loadPermissions() {
    if (app.loading || app.usingDemo) return;
    const sequence = ++permissionsSequence;
    permissionsLoading = true;
    permissionsError = '';
    try {
      const current = await calendarApi.permissions();
      if (sequence === permissionsSequence && !app.loading) permissions = current;
    } catch (cause) {
      if (sequence === permissionsSequence && !app.loading) permissionsError = message(cause);
    } finally {
      if (sequence === permissionsSequence) permissionsLoading = false;
    }
  }

  async function savePermissions() {
    if (permissionsSaving || permissionsLoading || app.usingDemo) return;
    const sequence = ++permissionsSequence;
    const draft = { ...permissions };
    permissionsSaving = true;
    permissionsError = '';
    try {
      await calendarApi.setPermissions(draft);
      if (sequence !== permissionsSequence || app.loading) return;
      const fresh = await calendarApi.permissions();
      if (sequence === permissionsSequence && !app.loading) {
        permissions = fresh;
        permissionsError = '';
      }
    } catch (cause) {
      if (sequence === permissionsSequence && !app.loading) permissionsError = message(cause);
    } finally {
      if (sequence === permissionsSequence) permissionsSaving = false;
    }
  }

  function openPermissions() {
    permissionsOpen = true;
  }

  async function saveEvent() {
    if (!editor || editorBusy) return;
    editorError = '';
    editorConflict = undefined;
    const form = editor;
    const spec = eventSpec(form);
    if (!spec) return;
    if (spec.recurrence?.frequency === 'weekly' && !spec.recurrence.weekdays?.length) {
      editorError = tr('Choose at least one weekday.');
      return;
    }
    editorBusy = true;
    try {
      let saved: CalendarEvent;
      if (form.id) {
        saved = await calendarApi.update(form.id, {
          revision: form.revision ?? form.sourceEvent?.revision ?? 0,
          event: spec,
          scope: form.scope,
          ...(form.scope === 'series' || !form.occurrence ? {} : { occurrence: form.occurrence }),
        });
      } else {
        const key = form.idempotencyKey ?? (form.idempotencyKey = uuid());
        saved = await calendarApi.create(key, spec);
      }
      editorOpen = false;
      editor = null;
      editorConflict = undefined;
      selectedItemId = undefined;
      agendaDate = undefined;
      refreshRevision++;
      writeRoute('push');
      if (saved.id) {
        detailEvent = saved;
        detailError = '';
      }
    } catch (cause) {
      editorError =
        cause instanceof ApiError && cause.status === 409
          ? tr(
              'This event changed on another device. Your draft is kept below the current version.',
            )
          : form.id
            ? message(cause)
            : tr(
                'The save could not be confirmed. Your draft and request key are kept; retry this save to reconcile it safely.',
              );
      if (cause instanceof ApiError && cause.status === 409 && form.id)
        await reloadConflict(form.id, true);
    } finally {
      editorBusy = false;
    }
  }

  function openItem(item: CalendarItem, route = true) {
    agendaDate = undefined;
    selectedItemId = item.id;
    detailScope = 'series';
    confirmDelete = false;
    detailConflict = undefined;
    if (route) writeRoute('push');
  }

  function beginEntryGesture(event: PointerEvent, item: CalendarItem, date: string) {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    entryGesture = {
      pointerId: event.pointerId,
      item,
      mode: (event.target as Element).closest('.resize-handle') ? 'resize' : 'move',
      date,
      columnTop: element.closest<HTMLElement>('.time-day-column')?.getBoundingClientRect().top ?? 0,
      startY: event.clientY,
      startX: event.clientX,
      pointerOffsetY: Math.max(0, event.clientY - rect.top),
    };
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer capture is optional. */
    }
  }

  function finishEntryGesture(event: PointerEvent) {
    const gesture = entryGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    entryGesture = undefined;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

    event.preventDefault();
    event.stopPropagation();
    suppressEntryClickUntil = performance.now() + 500;
    if (gesture.item.type === 'schedule') {
      beginScheduleManagement(false, gesture.item.sourceId);
      return;
    }

    let startAt = gesture.item.startAt;
    let endAt = gesture.item.endAt;
    if (gesture.mode === 'resize') {
      const deltaMinutes = Math.round(((dy / HOUR_HEIGHT) * 60) / 15) * 15;
      endAt = Math.max(startAt + 15 * 60_000, endAt + deltaMinutes * 60_000);
    } else {
      let targetDate = gesture.date;
      let targetColumn: HTMLElement | null = null;
      if (view === 'week' && typeof document.elementFromPoint === 'function') {
        targetColumn =
          document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>('.time-day-column') ?? null;
        if (targetColumn?.dataset.date) targetDate = targetColumn.dataset.date;
      }
      const columnRect = targetColumn?.getBoundingClientRect();
      const columnTop = columnRect?.top ?? gesture.columnTop;
      const dayBounds = zonedDateBounds(targetDate, timezone);
      const pointerMinutes =
        ((event.clientY - columnTop - gesture.pointerOffsetY) / HOUR_HEIGHT) * 60;
      const snapped = Math.round(pointerMinutes / 15) * 15;
      const maxMinutes = Math.max(0, (dayBounds.end - dayBounds.start) / 60_000 - 15);
      startAt = dayBounds.start + Math.max(0, Math.min(maxMinutes, snapped)) * 60_000;
      endAt = startAt + (gesture.item.endAt - gesture.item.startAt);
    }
    void (async () => {
      try {
        const eventData = (await calendarApi.event(gesture.item.sourceId)).event;
        openEditEvent(gesture.item, eventData);
        if (editor?.sourceEvent?.recurrence) changeScope('occurrence');
        if (!editor) return;
        const editZone = editor.occurrenceTimezone ?? editor.timezone;
        const start = localDateTime(startAt, editZone);
        const end = localDateTime(endAt, editZone);
        [editor.startDate, editor.startTime] = start.split('T') as [string, string];
        [editor.endDate, editor.endTime] = end.split('T') as [string, string];
        editor.timezone = editZone;
        editor.moveNotice =
          gesture.mode === 'resize'
            ? editor.sourceEvent?.recurrence
              ? tr('The resized time is a draft. Choose the recurrence scope and save to apply it.')
              : tr('The resized time is a draft. Save changes to apply it.')
            : editor.sourceEvent?.recurrence
              ? tr('The moved time is a draft. Choose the recurrence scope and save to apply it.')
              : tr('The moved time is a draft. Save changes to apply it.');
      } catch (cause) {
        loadError = message(cause);
      }
    })();
  }

  function handleEntryClick(event: MouseEvent, item: CalendarItem) {
    if (performance.now() < suppressEntryClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressEntryClickUntil = 0;
      return;
    }
    event.stopPropagation();
    openItem(item);
  }

  function openAgenda(date: string) {
    selectedDate = date;
    agendaDate = date;
    selectedItemId = undefined;
    writeRoute('push');
  }

  function closeDetail() {
    selectedItemId = undefined;
    agendaDate = undefined;
    confirmDelete = false;
    writeRoute('push');
  }

  async function loadSelectedDetail(item: CalendarItem | undefined) {
    detailController?.abort();
    const sequence = ++detailSequence;
    detailConflict = undefined;
    detailError = '';
    confirmDelete = false;
    if (!item) {
      detailEvent = undefined;
      detailSchedule = undefined;
      detailRuns = [];
      detailLoading = false;
      return;
    }
    const controller = new AbortController();
    detailController = controller;
    detailLoading = true;
    detailEvent = item.event;
    detailSchedule = item.schedule;
    detailRuns = item.run ? [item.run] : [];
    try {
      if (item.type === 'event') {
        const current = (await calendarApi.event(item.sourceId, controller.signal)).event;
        if (sequence === detailSequence) detailEvent = current;
      } else {
        const current = await schedulesApi.get(item.sourceId);
        if (sequence === detailSequence) {
          detailSchedule = current.schedule;
          detailRuns = current.runs;
        }
      }
    } catch (cause) {
      if (sequence === detailSequence && !controller.signal.aborted) detailError = message(cause);
    } finally {
      if (sequence === detailSequence) detailLoading = false;
    }
  }

  $effect(() => {
    const id = selectedItemId;
    const item = items.find((candidate) => candidate.id === id);
    untrack(() => void loadSelectedDetail(item));
  });

  function beginScheduleManagement(create = false, scheduleId?: string) {
    view = 'list';
    scheduleManagement = true;
    createScheduleOnMount = create;
    scheduleInitialId = scheduleId;
    editorOpen = false;
    editor = null;
    selectedItemId = undefined;
    agendaDate = undefined;
    writeRoute('push');
  }

  function returnToCalendar() {
    scheduleManagement = false;
    createScheduleOnMount = false;
    scheduleInitialId = undefined;
    view = 'list';
    writeRoute('push');
  }

  function setView(next: CalendarView) {
    view = next;
    scheduleManagement = false;
    createScheduleOnMount = false;
    selectedDate = anchorDate;
    selectedItemId = undefined;
    agendaDate = undefined;
    writeRoute('push');
  }

  function navigate(amount: number) {
    if (view === 'month' || view === 'list') {
      const nextMonth = new Date(
        Date.UTC(Number(anchorDate.slice(0, 4)), Number(anchorDate.slice(5, 7)) - 1 + amount, 1),
      );
      anchorDate = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`;
    } else {
      anchorDate = addCalendarDays(anchorDate, amount * (view === 'week' ? 7 : 1));
    }
    selectedDate = anchorDate;
    selectedItemId = undefined;
    agendaDate = undefined;
    writeRoute('push');
  }

  function goToday() {
    anchorDate = todayInTimezone(timezone);
    selectedDate = anchorDate;
    selectedItemId = undefined;
    agendaDate = undefined;
    writeRoute('push');
  }

  function applyTimezone(value: string) {
    if (!validTimezone(value)) return;
    timezone = value;
    if (!selectedItemId) selectedDate = todayInTimezone(timezone);
    refreshRevision++;
    writeRoute('push');
  }

  function displayEventTime(item: CalendarItem) {
    if (item.allDay) return tr('All day');
    if (item.type === 'schedule') return zonedTime(item.startAt, timezone);
    return `${zonedTime(item.startAt, timezone)}–${zonedTime(item.endAt, timezone)}`;
  }

  function itemSubtitle(item: CalendarItem) {
    if (item.type === 'schedule') {
      const status = item.run ? tr(RUN_LABELS[item.run.status]) : tr('Scheduled');
      return `${tr('Agent task')} · ${status}`;
    }
    const parts = [
      item.allDay ? tr('All day event') : displayEventTime(item),
      item.event?.location,
    ].filter(Boolean);
    return parts.join(' · ');
  }

  function entriesAtDate(date: string) {
    return itemsForDate(date).filter((item) => !item.allDay);
  }

  function visibleDateItems(date: string) {
    return itemsForDate(date);
  }

  function spanBarsForWeek(startDate: string): AllDayBar[] {
    return allDayBarsForWeek(visibleItems, startDate);
  }

  function maxSpanLanes(bars: AllDayBar[]) {
    return Math.max(0, ...bars.map((bar) => bar.lane + 1));
  }

  function timeLabelsForDate(date: string) {
    return zonedHourLabels(date, timezone, HOUR_HEIGHT);
  }

  function openAtPointer(event: MouseEvent, date: string) {
    if ((event.target as Element).closest('button')) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const bounds = zonedDateBounds(date, timezone);
    const elapsedMinutes = Math.max(0, ((event.clientY - rect.top) / HOUR_HEIGHT) * 60);
    const snappedMinutes = Math.max(0, Math.round(elapsedMinutes / 30) * 30);
    const at = Math.min(bounds.end - 30_000, bounds.start + snappedMinutes * 60_000);
    openNewEvent(dateInTimezone(at, timezone), at);
  }

  function detailLocalStart(item: CalendarItem, event: CalendarEvent) {
    if (event.allDay) return formatDateKey(event.start.slice(0, 10), locale, { dateStyle: 'full' });
    return `${formatDateKey(dateInTimezone(item.startAt, timezone), locale, { dateStyle: 'full' })} · ${zonedTime(item.startAt, timezone)}`;
  }

  function dateRangeText(item: CalendarItem) {
    if (
      item.allDay &&
      item.startDate &&
      item.endDate &&
      item.endDate !== addCalendarDays(item.startDate, 1)
    )
      return `${formatDateKey(item.startDate, locale, { dateStyle: 'medium' })} – ${formatDateKey(addCalendarDays(item.endDate, -1), locale, { dateStyle: 'medium' })}`;
    return displayEventTime(item);
  }

  function recurrenceText(recurrence: CalendarRecurrence | null) {
    if (!recurrence) return tr('Does not repeat');
    const names: Record<CalendarRecurrence['frequency'], string> = {
      daily: tr('Daily'),
      weekly: tr('Weekly'),
      monthly: tr('Monthly'),
      yearly: tr('Yearly'),
    };
    const unit = names[recurrence.frequency];
    return recurrence.interval === 1
      ? unit
      : tr('Every {0} {1}', [recurrence.interval, unit.toLowerCase()]);
  }

  function reminderText(minutes: number[]) {
    if (!minutes.length) return tr('No reminder');
    return minutes
      .map((value) =>
        value === 0
          ? tr('At event time')
          : value === 1440
            ? tr('1 day before')
            : tr('{0} minutes before', [value]),
      )
      .join(', ');
  }

  async function runScheduleAction(
    item: CalendarItem,
    action: 'run' | 'pause' | 'resume' | 'dismiss',
  ) {
    const schedule = detailSchedule ?? item.schedule;
    if (!schedule || detailBusy) return;
    detailBusy = true;
    detailError = '';
    detailBusyAction = action;
    try {
      if (action === 'run') {
        await schedulesApi.run(
          schedule.id,
          item.run?.status === 'missed' ? item.run.id : undefined,
        );
      } else if (action === 'dismiss' && item.run) {
        await schedulesApi.dismiss(schedule.id, item.run.id);
      } else if (action === 'pause') {
        await schedulesApi.update(schedule.id, { status: 'paused' });
      } else if (action === 'resume') {
        await schedulesApi.update(schedule.id, { status: 'active' });
      }
      refreshRevision++;
      void app.refreshSchedules();
    } catch (cause) {
      detailError = message(cause);
    } finally {
      detailBusy = false;
      detailBusyAction = '';
    }
  }

  async function deleteSchedule(item: CalendarItem) {
    const schedule = detailSchedule ?? item.schedule;
    if (!schedule || detailBusy) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    detailBusy = true;
    detailBusyAction = 'delete';
    detailError = '';
    try {
      await schedulesApi.remove(schedule.id);
      selectedItemId = undefined;
      confirmDelete = false;
      refreshRevision++;
      void app.refreshSchedules();
      writeRoute('push');
    } catch (cause) {
      detailError = message(cause);
    } finally {
      detailBusy = false;
      detailBusyAction = '';
    }
  }

  async function deleteEvent(item: CalendarItem) {
    if (!detailEvent || detailBusy) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    detailBusy = true;
    detailError = '';
    detailBusyAction = 'delete';
    try {
      const scope = detailEvent.recurrence ? detailScope : 'series';
      await calendarApi.remove(
        detailEvent.id,
        detailEvent.revision,
        scope,
        scope === 'series' ? undefined : item.originalStart,
      );
      selectedItemId = undefined;
      confirmDelete = false;
      refreshRevision++;
      writeRoute('push');
    } catch (cause) {
      detailError =
        cause instanceof ApiError && cause.status === 409
          ? tr('This event changed on another device. Review the current version before deleting.')
          : message(cause);
      if (cause instanceof ApiError && cause.status === 409)
        await reloadConflict(detailEvent.id, false);
    } finally {
      detailBusy = false;
      detailBusyAction = '';
    }
  }

  function editSelectedEvent(item: CalendarItem) {
    const event = detailEvent ?? item.event;
    if (!event) return;
    openEditEvent(item, event);
  }

  function detailZone(item: CalendarItem, event?: CalendarEvent) {
    const zone = event?.timezone ?? item.timezone;
    return zone === timezone ? zone : tr('{0} · display time: {1}', [zone, timezone]);
  }

  function humanCount(count: number) {
    return tr('{0} items', [count]);
  }

  function allDayCount(items: CalendarItem[]) {
    return items.filter((item) => item.allDay).length;
  }
</script>

<section class="calendar-page" aria-labelledby="calendar-title">
  <header class="page-bar">
    {#if sidebarCollapsed}
      <button
        class="icon-button"
        type="button"
        aria-label={tr('Show sidebar')}
        title={tr('Show sidebar')}
        onclick={onexpand}><PanelLeftOpen size={19} /></button
      >
    {/if}
    <CalendarClock size={18} />
    <h1 id="calendar-title">{tr('Calendar')}</h1>
    <label class="header-zone">
      <Globe size={15} />
      <span>{tr('Display time zone')}</span>
      <input
        aria-label={tr('Display time zone')}
        list="calendar-timezones"
        value={timezone}
        onblur={(event) => applyTimezone(event.currentTarget.value.trim())}
        onkeydown={(event) =>
          event.key === 'Enter' && applyTimezone(event.currentTarget.value.trim())}
      />
      <datalist id="calendar-timezones">
        {#each zones as zone (zone)}<option value={zone}></option>{/each}
      </datalist>
    </label>
  </header>

  <div class="calendar-toolbar">
    {#if scheduleManagement}
      <button class="button ghost small back-calendar" type="button" onclick={returnToCalendar}
        ><ArrowLeft size={15} />{tr('Back to calendar')}</button
      >
      <div class="period-title">{tr('Schedules')}</div>
    {:else}
      <div class="period-title">{periodTitle}</div>
      <div class="period-navigation" aria-label={tr('Calendar date navigation')}>
        <button
          class="icon-button"
          type="button"
          aria-label={tr('Previous period')}
          onclick={() => navigate(-1)}><ChevronLeft size={17} /></button
        >
        <button class="button ghost small today-button" type="button" onclick={goToday}
          >{tr('Today')}</button
        >
        <button
          class="icon-button"
          type="button"
          aria-label={tr('Next period')}
          onclick={() => navigate(1)}><ChevronRight size={17} /></button
        >
      </div>
      <div class="view-tabs" role="group" aria-label={tr('Calendar view')}>
        {#each [['month', 'Month'], ['week', 'Week'], ['day', 'Day'], ['list', 'List']] as [key, label]}
          <button
            type="button"
            aria-pressed={view === key}
            onclick={() => setView(key as CalendarView)}>{tr(label)}</button
          >
        {/each}
      </div>
      <button
        class="button primary new-event-button"
        type="button"
        disabled={app.usingDemo}
        onclick={() => openNewEvent(selectedDate)}
        ><Plus size={16} /><span>{tr('New event')}</span></button
      >
      <button
        class="button ghost manage-schedules-button"
        type="button"
        onclick={() => beginScheduleManagement()}
        ><ListChecks size={16} /><span>{tr('Manage schedules')}</span></button
      >
      <button
        class="button ghost permission-button"
        type="button"
        disabled={app.usingDemo}
        onclick={openPermissions}><Bot size={15} /><span>{tr('Agent access')}</span></button
      >
    {/if}
  </div>

  {#if !scheduleManagement}
    <div class="calendar-filters">
      <div class="type-filters" role="group" aria-label={tr('Calendar filters')}>
        <button
          class:chosen={filter === 'all'}
          type="button"
          aria-pressed={filter === 'all'}
          onclick={() => (filter = 'all')}>{tr('All')}</button
        >
        <button
          class:chosen={filter === 'event'}
          type="button"
          aria-pressed={filter === 'event'}
          onclick={() => (filter = 'event')}
          ><span class="filter-dot personal-dot"></span>{tr('Personal events')}</button
        >
        <button
          class:chosen={filter === 'schedule'}
          type="button"
          aria-pressed={filter === 'schedule'}
          onclick={() => (filter = 'schedule')}><Bot size={14} />{tr('Agent tasks')}</button
        >
      </div>
      <label class="week-start-control">
        <span>{tr('Week starts')}</span>
        <select bind:value={weekStart} aria-label={tr('Week starts')}>
          <option value="sunday">{tr('Sunday')}</option>
          <option value="monday">{tr('Monday')}</option>
        </select>
      </label>
      <span class="sync-state" role="status">
        {#if app.usingDemo}
          <CircleAlert size={14} />{tr('Calendar is unavailable in demo mode.')}
        {:else if app.connection === 'offline'}
          <CloudOff size={14} />{tr('Offline')}
        {:else if loading || loadingMore}
          <RefreshCw size={14} class="spin" />{tr('Syncing…')}
        {:else if loadError}
          <CircleAlert size={14} />{tr('Unable to sync')}
        {:else}
          <Check size={14} />{tr('Synced')}
        {/if}
      </span>
    </div>
  {/if}

  <div class="calendar-content">
    {#if scheduleManagement}
      <div class="schedule-management page-scroll">
        <div class="page-body">
          <ScheduleSettings
            disabled={app.usingDemo}
            onopenchat={(sessionId) => onopenchat(sessionId)}
            createOnMount={createScheduleOnMount}
            initialScheduleId={scheduleInitialId}
          />
        </div>
      </div>
    {:else}
      <main class="calendar-view" aria-label={periodTitle}>
        {#if app.usingDemo}
          <p class="calendar-notice" role="status">
            <CircleAlert size={16} />{tr('Calendar is unavailable in demo mode.')}
          </p>
        {:else if loadError}
          <p class="calendar-notice error-notice" role="alert">
            <CircleAlert size={16} />{loadError}
            <button
              class="button ghost small"
              type="button"
              onclick={() =>
                calendarContextReady ? refreshRevision++ : void loadCalendarContext()}
              >{tr('Retry')}</button
            >
          </p>
        {/if}

        {#if historyLimited && !scheduleManagement}
          <p class="history-note">{historyMessage}</p>
        {/if}

        {#if view === 'month'}
          <div class="month-view">
            <div class="weekday-row" aria-hidden="true">
              {#each weekdayLabels as label}<span>{label}</span>{/each}
            </div>
            {#each monthWeeks as week (week[0])}
              {@const bars = spanBarsForWeek(week[0]!)}
              {@const spanLanes = maxSpanLanes(bars)}
              <div class="month-week" style={`--span-lanes:${spanLanes}`}>
                {#each week as date (date)}
                  {@const entries = visibleDateItems(date)}
                  {@const timed = entries.filter((item) => !item.allDay)}
                  {@const hidden = Math.max(0, timed.length - 2)}
                  <div
                    class="month-day"
                    data-date={date}
                    class:outside-month={date.slice(0, 7) !== anchorDate.slice(0, 7)}
                    class:date-selected={selectedDate === date}
                  >
                    <button
                      type="button"
                      class="date-number"
                      class:today={today === date}
                      class:selected={selectedDate === date}
                      aria-label={tr('{0}, {1}', [dayHeading(date), humanCount(entries.length)])}
                      aria-pressed={selectedDate === date}
                      onclick={() => openAgenda(date)}>{Number(date.slice(8, 10))}</button
                    >
                    <div class="month-events" style={`--span-lanes:${spanLanes}`}>
                      {#each timed.slice(0, 2) as item (item.id)}
                        <button
                          type="button"
                          class="month-item"
                          class:agent-item={item.type === 'schedule'}
                          title={`${displayEventTime(item)} ${item.title}`}
                          onclick={() => openItem(item)}
                        >
                          {#if item.type === 'schedule'}<Bot size={12} />{/if}
                          <span class="item-time">{displayEventTime(item)}</span>
                          <span class="item-title">{item.title}</span>
                        </button>
                      {/each}
                      {#if hidden}
                        <button class="more-items" type="button" onclick={() => openAgenda(date)}
                          >{tr('+{0} more', [hidden])}</button
                        >
                      {/if}
                    </div>
                    <div class="mobile-event-marks" aria-label={humanCount(entries.length)}>
                      {#each entries.slice(0, 3) as item (item.id)}<span
                          class:agent-mark={item.type === 'schedule'}
                        ></span>{/each}
                      {#if entries.length > 3}<small>+{entries.length - 3}</small>{/if}
                    </div>
                  </div>
                {/each}
                {#each bars as bar (bar.item.id)}
                  <button
                    type="button"
                    class="month-span"
                    class:agent-item={bar.item.type === 'schedule'}
                    style={`left:calc(${(bar.startColumn / 7) * 100}% + 4px);right:calc(${((7 - bar.endColumn) / 7) * 100}% + 4px);top:${37 + bar.lane * 22}px`}
                    title={bar.item.title}
                    onclick={() => openItem(bar.item)}>{bar.item.title}</button
                  >
                {/each}
              </div>
            {/each}
            <div class="month-agenda">
              <div class="agenda-heading">
                <span>{dayHeading(selectedDate)}</span><small
                  >{humanCount(itemsForDate(selectedDate).length)}</small
                >
              </div>
              {#if itemsForDate(selectedDate).length}
                {#each itemsForDate(selectedDate) as item (item.id)}
                  <button class="agenda-item" type="button" onclick={() => openItem(item)}>
                    <span class="agenda-time">{displayEventTime(item)}</span>
                    <span class="agenda-glyph" class:agent-glyph={item.type === 'schedule'}
                      >{#if item.type === 'schedule'}<Bot size={17} />{:else}<CalendarDays
                          size={17}
                        />{/if}</span
                    >
                    <span class="agenda-copy"
                      ><strong>{item.title}</strong><small>{itemSubtitle(item)}</small></span
                    >
                    <ChevronRight size={16} />
                  </button>
                {/each}
              {:else}
                <p class="empty-day">{tr('Nothing on this day.')}</p>
              {/if}
            </div>
          </div>
        {:else if view === 'week' || view === 'day'}
          {@const weekStartDate = startOfWeek(anchorDate, weekStart)}
          {@const bars = spanBarsForWeek(weekStartDate)}
          {@const visibleBars =
            view === 'week' ? bars : allDayBarsForDate(visibleItems, weekStartDate, timeDates[0]!)}
          {@const spanLanes = maxSpanLanes(visibleBars)}
          <div class="time-scroll" class:week-scroll={view === 'week'}>
            <div
              class="time-surface"
              class:week-surface={view === 'week'}
              class:day-surface={view === 'day'}
              style={`--day-count:${timeDates.length};--hour-height:${HOUR_HEIGHT}px;--timeline-height:${maxTimelineHours * HOUR_HEIGHT}px`}
            >
              <div class="time-header">
                <div class="time-corner">{timezone}</div>
                {#each timeDates as date (date)}
                  <button
                    type="button"
                    class="time-day-heading"
                    class:today={date === today}
                    onclick={() => openAgenda(date)}
                  >
                    <span>{formatDateKey(date, locale, { weekday: 'short' })}</span>
                    <strong>{Number(date.slice(8, 10))}</strong>
                  </button>
                {/each}
              </div>
              <div class="all-day-row" style={`--span-lanes:${spanLanes}`}>
                <div class="time-corner all-day-label">{tr('All day')}</div>
                {#each timeDates as date, index (date)}
                  <div
                    class="all-day-cell"
                    data-date={date}
                    style={`grid-column:${index + 2}`}
                  ></div>
                {/each}
                {#each visibleBars as bar (bar.item.id)}
                  {@const visibleEndColumn = Math.min(bar.endColumn, timeDates.length)}
                  {@const leadingDays = bar.startColumn / timeDates.length}
                  {@const trailingDays = (timeDates.length - visibleEndColumn) / timeDates.length}
                  <button
                    type="button"
                    class="all-day-span"
                    class:agent-item={bar.item.type === 'schedule'}
                    style={`left:calc(${leadingDays * 100}% + ${44 * (1 - leadingDays)}px + 4px);right:calc(${trailingDays * 100}% - ${44 * trailingDays}px + 4px);top:${4 + bar.lane * 25}px`}
                    onclick={() => openItem(bar.item)}
                  >
                    {bar.item.type === 'schedule' ? `${tr('Agent task')} · ` : ''}{bar.item.title}
                  </button>
                {/each}
                {#if !visibleBars.length}<span class="all-day-empty">{tr('No all-day events')}</span
                  >{/if}
              </div>
              <div class="time-grid-body">
                <div class="hours-column" style={`height:${maxTimelineHours * HOUR_HEIGHT}px`}>
                  {#each timeLabelsForDate(timeDates[0]!) as label (label.top)}
                    <span style={`top:${label.top}px`}>{label.text}</span>
                  {/each}
                </div>
                {#each timeDates as date, index (date)}
                  {@const bounds = zonedDateBounds(date, timezone)}
                  {@const duration = (bounds.end - bounds.start) / 60_000}
                  {@const segments = timedSegmentsForDate(visibleItems, date, timezone)}
                  <div
                    class="time-day-column"
                    class:today={date === today}
                    data-date={date}
                    role="gridcell"
                    tabindex="0"
                    aria-label={dayHeading(date)}
                    style={`grid-column:${index + 2};height:${(duration * HOUR_HEIGHT) / 60}px`}
                    onclick={(event) => openAtPointer(event, date)}
                    onkeydown={(event) => {
                      if (
                        (event.key === 'Enter' || event.key === ' ') &&
                        event.target === event.currentTarget
                      ) {
                        event.preventDefault();
                        openNewEvent(date);
                      }
                    }}
                  >
                    {#each segments as segment (`${segment.item.id}:${date}`)}
                      {@const top =
                        (((segment.startAt - bounds.start) / 60_000) * HOUR_HEIGHT) / 60}
                      {@const height =
                        segment.item.type === 'schedule'
                          ? 28
                          : Math.max(
                              32,
                              (((segment.endAt - segment.startAt) / 60_000) * HOUR_HEIGHT) / 60,
                            )}
                      <button
                        type="button"
                        class="time-entry"
                        class:agent-entry={segment.item.type === 'schedule'}
                        style={`top:${top}px;height:${height}px;left:calc(${(segment.lane / segment.laneCount) * 100}% + 4px);width:calc(${100 / segment.laneCount}% - 8px)`}
                        title={`${zonedTime(segment.startAt, timezone)} ${segment.item.title} · ${segment.item.type === 'event' ? tr('Drag to move; resize from the bottom edge.') : tr('Drag to edit this schedule.')}`}
                        aria-label={segment.item.type === 'schedule'
                          ? `${zonedTime(segment.startAt, timezone)} · ${segment.item.title} · ${segment.item.run ? tr(RUN_LABELS[segment.item.run.status]) : tr('Agent task')}`
                          : undefined}
                        onpointerdown={(event) => beginEntryGesture(event, segment.item, date)}
                        onpointerup={finishEntryGesture}
                        onpointercancel={() => (entryGesture = undefined)}
                        onclick={(event) => handleEntryClick(event, segment.item)}
                      >
                        {#if segment.item.type === 'schedule'}
                          <strong
                            ><Bot size={12} />{zonedTime(segment.startAt, timezone)} · {segment.item
                              .title}</strong
                          >
                        {:else}
                          <strong>{segment.item.title}</strong>
                          <small
                            >{zonedTime(segment.startAt, timezone)}–{zonedTime(
                              segment.endAt,
                              timezone,
                            )}</small
                          >
                        {/if}
                        {#if segment.item.type === 'event'}<span
                            class="resize-handle"
                            aria-hidden="true"
                          ></span>{/if}
                      </button>
                    {/each}
                    {#if date === today}
                      {@const nowTop = (((Date.now() - bounds.start) / 60_000) * HOUR_HEIGHT) / 60}
                      {#if nowTop >= 0 && nowTop <= (duration * HOUR_HEIGHT) / 60}<div
                          class="now-line"
                          style={`top:${nowTop}px`}
                          aria-label={tr('Current time')}
                        ></div>{/if}
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {:else}
          <div class="list-view">
            {#each listDates as date (date)}
              {@const entries = itemsForDate(date)}
              {#if entries.length}
                <div class="list-day-heading">
                  {dayHeading(date)}<small>{humanCount(entries.length)}</small>
                </div>
                {#each entries as item (item.id)}
                  <button class="agenda-item" type="button" onclick={() => openItem(item)}>
                    <span class="agenda-time">{displayEventTime(item)}</span>
                    <span class="agenda-glyph" class:agent-glyph={item.type === 'schedule'}
                      >{#if item.type === 'schedule'}<Bot size={17} />{:else}<CalendarDays
                          size={17}
                        />{/if}</span
                    >
                    <span class="agenda-copy"
                      ><strong>{item.title}</strong><small>{itemSubtitle(item)}</small></span
                    >
                    <ChevronRight size={16} />
                  </button>
                {/each}
              {/if}
            {/each}
            {#if !loading && !visibleItems.length && !loadError}<p class="calendar-empty">
                {tr('No events or agent tasks in this period.')}
              </p>{/if}
          </div>
        {/if}

        {#if loading && !items.length}
          <div class="loading-overlay" role="status">
            <RefreshCw size={17} class="spin" />{tr('Loading calendar…')}
          </div>
        {/if}

        {#if limited || nextCursor}
          <div class="pagination-note" role="status">
            {#if nextCursor}
              <span>{tr('More calendar entries are available.')}</span>
              <button
                class="button ghost small"
                type="button"
                disabled={loadingMore}
                onclick={() => void loadRange(activeRangeKey, request, timezone, nextCursor!)}
              >
                {#if loadingMore}<RefreshCw size={14} class="spin" />{/if}{tr('Load more')}
              </button>
            {:else}<span
                >{tr(
                  'The gateway limited this result. Narrow the date range to see more entries.',
                )}</span
              >{/if}
          </div>
        {/if}
      </main>

      {#if agendaDate || selectedItem}
        <aside
          class="calendar-details"
          aria-label={agendaDate ? tr('Day agenda') : tr('Calendar item details')}
        >
          <header class="details-header">
            <h2>{agendaDate ? tr('Day agenda') : tr('Details')}</h2>
            <button
              class="icon-button"
              type="button"
              aria-label={tr('Close details')}
              onclick={closeDetail}><X size={17} /></button
            >
          </header>
          {#if agendaDate}
            <div class="details-body agenda-details-body">
              <h3>{dayHeading(agendaDate)}</h3>
              {#if itemsForDate(agendaDate).length}
                {#each itemsForDate(agendaDate) as item (item.id)}
                  <button class="agenda-item" type="button" onclick={() => openItem(item)}>
                    <span class="agenda-time">{displayEventTime(item)}</span>
                    <span class="agenda-glyph" class:agent-glyph={item.type === 'schedule'}
                      >{#if item.type === 'schedule'}<Bot size={17} />{:else}<CalendarDays
                          size={17}
                        />{/if}</span
                    >
                    <span class="agenda-copy"
                      ><strong>{item.title}</strong><small>{itemSubtitle(item)}</small></span
                    >
                    <ChevronRight size={16} />
                  </button>
                {/each}
              {:else}<p class="empty-day">{tr('Nothing on this day.')}</p>{/if}
            </div>
            <footer class="details-footer">
              <button
                class="button primary"
                type="button"
                disabled={app.usingDemo}
                onclick={() => openNewEvent(agendaDate!)}
                ><Plus size={15} />{tr('New event')}</button
              >
            </footer>
          {:else if selectedItem}
            <div class="details-body">
              <h3 class="detail-title">
                {detailEvent?.title ?? detailSchedule?.title ?? selectedItem.title}
              </h3>
              <div class="item-kind" class:agent-kind={selectedItem.type === 'schedule'}>
                {#if selectedItem.type === 'schedule'}<Bot size={14} />{tr(
                    'Agent task',
                  )}{:else}<CalendarDays size={14} />{tr('Personal event')}{/if}
              </div>
              {#if detailLoading}<p class="detail-loading" role="status">
                  <RefreshCw size={14} class="spin" />{tr('Loading details…')}
                </p>{/if}
              {#if detailError}<p class="inline-error" role="alert">{detailError}</p>{/if}
              {#if selectedItem.type === 'event'}
                {#if detailEvent}
                  <div class="detail-row">
                    <Clock3 size={16} /><span
                      >{detailLocalStart(selectedItem, detailEvent)}<small
                        >{dateRangeText(selectedItem)} · {detailZone(
                          selectedItem,
                          detailEvent,
                        )}</small
                      ></span
                    >
                  </div>
                  <div class="detail-row">
                    <Repeat2 size={16} /><span>{recurrenceText(detailEvent.recurrence)}</span>
                  </div>
                  {#if detailEvent.location}<div class="detail-row">
                      <MapPin size={16} /><span>{detailEvent.location}</span>
                    </div>{/if}
                  {#if detailEvent.reminderMinutes.length}<div class="detail-row">
                      <Bell size={16} /><span
                        >{reminderText(detailEvent.reminderMinutes)}<small
                          >{reminderDeliveryAvailable
                            ? tr('Reminder delivery is managed by the gateway.')
                            : tr(
                                'This gateway cannot deliver calendar reminders yet; reminder choices will be saved without a delivery guarantee.',
                              )}</small
                        ></span
                      >
                    </div>
                  {:else}<div class="detail-row">
                      <Bell size={16} /><span>{tr('No reminder')}</span>
                    </div>{/if}
                  {#if detailEvent.description}<p class="detail-description">
                      {detailEvent.description}
                    </p>{/if}
                  {#if detailConflict}<section class="conflict-card">
                      <strong>{tr('Current version')}</strong>
                      <p>{detailConflict.title}</p>
                      <small
                        >{detailConflict.start} – {detailConflict.end} · {detailConflict.timezone}</small
                      >
                    </section>{/if}
                  {#if detailEvent.recurrence}
                    <label class="detail-scope"
                      ><span>{tr('Apply to')}</span><select bind:value={detailScope}
                        ><option value="occurrence">{tr('This occurrence')}</option><option
                          value="following">{tr('This and following')}</option
                        ><option value="series">{tr('Whole series')}</option></select
                      ></label
                    >
                  {/if}
                {/if}
              {:else if detailSchedule}
                <div class="detail-row">
                  <Clock3 size={16} /><span
                    >{displayEventTime(selectedItem)}<small>{detailZone(selectedItem)}</small></span
                  >
                </div>
                <div class="detail-row">
                  <Repeat2 size={16} /><span
                    >{detailSchedule.cron
                      ? tr('Repeating agent task')
                      : tr('One-time agent task')}<small>{detailSchedule.timezone}</small></span
                  >
                </div>
                <div class="detail-row">
                  <ListChecks size={16} /><span
                    >{detailSchedule.workspace.name}<small
                      >{detailSchedule.status === 'paused'
                        ? tr('Paused')
                        : detailSchedule.status === 'done'
                          ? tr('Done')
                          : tr('Active')}</small
                    ></span
                  >
                </div>
                <p class="detail-description">{detailSchedule.prompt}</p>
                {#if selectedItem.run?.result}<div class="run-result">
                    <strong>{tr(RUN_LABELS[selectedItem.run.status])}</strong>
                    <p>{selectedItem.run.result}</p>
                  </div>{/if}
                {#if detailRuns.length}
                  <section class="recent-runs">
                    <h4>{tr('Recent runs')}</h4>
                    {#each detailRuns.slice(0, 5) as run (run.id)}
                      <div class="recent-run">
                        <span>{tr(RUN_LABELS[run.status])}</span><small
                          >{zonedTime(run.createdAt, detailSchedule.timezone)} · {formatDateKey(
                            dateInTimezone(run.createdAt, detailSchedule.timezone),
                            locale,
                            { dateStyle: 'medium' },
                          )}</small
                        >
                        {#if run.sessionId && run.session}<button
                            class="button ghost small"
                            type="button"
                            onclick={() => onopenchat(run.sessionId!)}>{tr('Open session')}</button
                          >{/if}
                      </div>
                    {/each}
                    <small>{historyMessage}</small>
                  </section>
                {/if}
              {/if}
            </div>
            {#if selectedItem.type === 'event' && detailEvent}
              <footer class="details-footer">
                <button
                  class="button ghost danger"
                  type="button"
                  disabled={detailBusy}
                  onclick={() => void deleteEvent(selectedItem)}
                  >{confirmDelete ? tr('Delete for good') : tr('Delete')}</button
                >
                <button
                  class="button primary"
                  type="button"
                  disabled={detailBusy}
                  onclick={() => editSelectedEvent(selectedItem)}
                  ><Pencil size={14} />{tr('Edit')}</button
                >
              </footer>
            {:else if selectedItem.type === 'schedule' && detailSchedule}
              <footer class="details-footer schedule-detail-actions">
                {#if selectedItem.run?.status === 'missed'}
                  <button
                    class="button primary"
                    type="button"
                    disabled={detailBusy}
                    onclick={() => void runScheduleAction(selectedItem, 'run')}
                    >{tr('Allow and run now')}</button
                  >
                  <button
                    class="button ghost"
                    type="button"
                    disabled={detailBusy}
                    onclick={() => void runScheduleAction(selectedItem, 'dismiss')}
                    >{tr('Dismiss')}</button
                  >
                {:else}
                  <button
                    class="button primary"
                    type="button"
                    disabled={detailBusy || !detailSchedule.workspace.online}
                    onclick={() => void runScheduleAction(selectedItem, 'run')}
                    >{tr('Run now')}</button
                  >
                  {#if detailSchedule.status === 'active'}
                    <button
                      class="button ghost"
                      type="button"
                      disabled={detailBusy}
                      onclick={() => void runScheduleAction(selectedItem, 'pause')}
                      >{tr('Pause')}</button
                    >
                  {:else if detailSchedule.status === 'paused'}
                    <button
                      class="button ghost"
                      type="button"
                      disabled={detailBusy}
                      onclick={() => void runScheduleAction(selectedItem, 'resume')}
                      >{tr('Resume')}</button
                    >
                  {/if}
                {/if}
                <button
                  class="button ghost"
                  type="button"
                  disabled={detailBusy}
                  onclick={() => beginScheduleManagement(false, selectedItem.sourceId)}
                  ><Pencil size={14} />{tr('Edit')}</button
                >
                <button
                  class="button ghost danger"
                  type="button"
                  disabled={detailBusy}
                  onclick={() => void deleteSchedule(selectedItem)}
                  >{confirmDelete ? tr('Delete for good') : tr('Delete')}</button
                >
              </footer>
            {/if}
          {/if}
        </aside>
        <button
          class="detail-scrim"
          type="button"
          aria-label={tr('Close details')}
          onclick={closeDetail}
        ></button>
      {/if}
    {/if}
  </div>

  <Modal bind:open={editorOpen} labelledby="calendar-editor-title" class="calendar-editor">
    {#if editor}
      <form
        class="event-editor-form"
        onsubmit={(event) => {
          event.preventDefault();
          if (createType === 'event') void saveEvent();
          else beginScheduleManagement(true);
        }}
      >
        <header class="editor-heading">
          <div>
            <h2 id="calendar-editor-title">{editor.id ? tr('Edit event') : tr('New event')}</h2>
            <p>{tr('Choose whether this creates a personal event or starts an agent task.')}</p>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label={tr('Close')}
            onclick={() => {
              editorOpen = false;
              editor = null;
            }}><X size={17} /></button
          >
        </header>
        {#if editor.moveNotice}<p class="move-notice" role="status">{editor.moveNotice}</p>{/if}
        <div class="editor-scroll">
          <div class="create-type-tabs" role="group" aria-label={tr('Item type')}>
            <button
              type="button"
              aria-pressed={createType === 'event'}
              onclick={() => (createType = 'event')}
              ><CalendarDays size={15} />{tr('Personal event')}</button
            >
            {#if !editor.id}<button
                type="button"
                aria-pressed={createType === 'schedule'}
                onclick={() => (createType = 'schedule')}
                ><Bot size={15} />{tr('Agent task')}</button
              >{/if}
          </div>
          {#if createType === 'schedule'}
            <div class="agent-create-note">
              <Bot size={20} />
              <div>
                <strong>{tr('Agent tasks start a new session at their scheduled time.')}</strong>
                <p>
                  {tr(
                    'They use the existing workspace, prompt, recurrence and notification settings. Calendar browsing never starts a task.',
                  )}
                </p>
              </div>
            </div>
            <button class="button primary continue-agent" type="submit"
              ><Plus size={15} />{tr('Continue to agent task')}</button
            >
          {:else}
            {#if editor.id && editor.sourceEvent?.recurrence}
              <label class="field"
                ><span>{tr('Apply to')}</span><select
                  value={editor.scope}
                  onchange={(event) => changeScope(event.currentTarget.value as CalendarEditScope)}
                  ><option value="series">{tr('Whole series')}</option><option value="occurrence"
                    >{tr('This occurrence')}</option
                  ><option value="following">{tr('This and following')}</option></select
                ></label
              >
            {/if}
            <label class="field"
              ><span>{tr('Title')}</span><input
                bind:value={editor.title}
                maxlength="160"
                required
                placeholder={tr('Add a title')}
              /></label
            >
            <div class="field-grid">
              <label class="field"
                ><span>{tr('Start date')}</span><input
                  type="date"
                  bind:value={editor.startDate}
                  required
                /></label
              >
              <label class="field"
                ><span>{editor.allDay ? tr('Last day') : tr('End date')}</span><input
                  type="date"
                  bind:value={editor.endDate}
                  min={editor.startDate}
                  required
                /></label
              >
            </div>
            {#if !editor.allDay}
              <div class="field-grid">
                <label class="field"
                  ><span>{tr('Start time')}</span><input
                    type="time"
                    bind:value={editor.startTime}
                    required
                  /></label
                >
                <label class="field"
                  ><span>{tr('End time')}</span><input
                    type="time"
                    bind:value={editor.endTime}
                    required
                  /></label
                >
              </div>
            {/if}
            <label class="check-field"
              ><input type="checkbox" bind:checked={editor.allDay} /><span>{tr('All day')}</span
              ></label
            >
            {#if editor.allDay}<small class="field-help"
                >{tr('The last day is included; the saved end date is exclusive.')}</small
              >{/if}
            <label class="field"
              ><span>{tr('Time zone')}</span><input
                bind:value={editor.timezone}
                list="calendar-timezones"
                required
                spellcheck="false"
              /></label
            >
            <label class="field"
              ><span>{tr('Repeat')}</span><select bind:value={editor.frequency}
                ><option value="">{tr('Does not repeat')}</option><option value="daily"
                  >{tr('Daily')}</option
                ><option value="weekly">{tr('Weekly')}</option><option value="monthly"
                  >{tr('Monthly')}</option
                ><option value="yearly">{tr('Yearly')}</option></select
              ></label
            >
            {#if editor.frequency}
              <div class="field-grid recurrence-fields">
                <label class="field"
                  ><span>{tr('Repeat every')}</span><input
                    type="number"
                    min="1"
                    max="99"
                    bind:value={editor.interval}
                  /></label
                >
                <label class="field"
                  ><span>{tr('End repeat')}</span><select
                    value={editor.endMode}
                    onchange={(event) =>
                      setRecurrenceEndMode(event.currentTarget.value as RecurrenceEndMode)}
                    ><option value="never">{tr('Never')}</option><option value="until"
                      >{tr('On a date')}</option
                    ><option value="count">{tr('After a number of events')}</option></select
                  ></label
                >
              </div>
              {#if editor.frequency === 'weekly'}
                <fieldset class="weekday-picker">
                  <legend>{tr('Repeat on')}</legend>{#each WEEKDAYS as day}<label
                      ><input
                        type="checkbox"
                        checked={editor.weekdays.includes(day)}
                        onchange={(event) =>
                          (editor!.weekdays = toggleNumber(
                            editor!.weekdays,
                            day,
                            event.currentTarget.checked,
                          ))}
                      /><span
                        >{formatDateKey(addCalendarDays('2026-02-01', day), locale, {
                          weekday: 'short',
                        })}</span
                      ></label
                    >{/each}
                </fieldset>
              {/if}
              {#if editor.endMode === 'until'}<label class="field"
                  ><span>{tr('Repeat until')}</span><input
                    type="date"
                    bind:value={editor.until}
                    required
                  /></label
                >{/if}
              {#if editor.endMode === 'count'}<label class="field"
                  ><span>{tr('Number of occurrences')}</span><input
                    type="number"
                    min="1"
                    max="999"
                    bind:value={editor.count}
                    required
                  /></label
                >{/if}
            {/if}
            <fieldset class="reminder-picker">
              <legend>{tr('Reminders')}</legend>
              <div class="reminder-options">
                {#each REMINDER_OPTIONS as minutes}<label
                    ><input
                      type="checkbox"
                      checked={editor.reminderMinutes.includes(minutes)}
                      onchange={(event) =>
                        (editor!.reminderMinutes = toggleNumber(
                          editor!.reminderMinutes,
                          minutes,
                          event.currentTarget.checked,
                        ))}
                    /><span
                      >{minutes === 0
                        ? tr('At event time')
                        : minutes === 1440
                          ? tr('1 day before')
                          : tr('{0} minutes before', [minutes])}</span
                    ></label
                  >{/each}
              </div>
              <small
                >{reminderDeliveryAvailable
                  ? tr('Reminder delivery is managed by the gateway.')
                  : tr(
                      'This gateway cannot deliver calendar reminders yet; reminder choices will be saved without a delivery guarantee.',
                    )}</small
              >
            </fieldset>
            <label class="field"
              ><span>{tr('Location')}</span><input
                bind:value={editor.location}
                maxlength="240"
                placeholder={tr('Add a place or meeting link')}
              /></label
            >
            <label class="field"
              ><span>{tr('Description')}</span><textarea
                bind:value={editor.description}
                rows="4"
                maxlength="4000"
              ></textarea></label
            >
            {#if editorError}<p class="inline-error" role="alert">{editorError}</p>{/if}
            {#if editorConflictLoading}<p class="detail-loading" role="status">
                <RefreshCw size={14} class="spin" />{tr('Loading current version…')}
              </p>{/if}
            {#if editorConflict}<section class="conflict-card">
                <strong>{tr('Current version')}</strong>
                <p>{editorConflict.title}</p>
                <small
                  >{editorConflict.start} – {editorConflict.end} · {editorConflict.timezone}</small
                ><button
                  class="button ghost small"
                  type="button"
                  onclick={() => {
                    if (!editor) return;
                    const draft = editor;
                    setFormFromSpec(draft, editorConflict!);
                    draft.revision = editorConflict!.revision;
                    draft.sourceEvent = editorConflict;
                    editor = draft;
                    editorConflict = undefined;
                    editorError = '';
                  }}>{tr('Use current version as draft')}</button
                >
              </section>{/if}
          {/if}
        </div>
        <footer class="editor-actions">
          <button
            class="button ghost"
            type="button"
            onclick={() => {
              editorOpen = false;
              editor = null;
            }}>{tr('Cancel')}</button
          >
          {#if createType === 'event'}<button
              class="button primary"
              type="submit"
              disabled={editorBusy || app.usingDemo}
              >{#if editorBusy}<RefreshCw size={14} class="spin" />{/if}{editor.id
                ? tr('Save changes')
                : tr('Save event')}</button
            >{/if}
        </footer>
      </form>
    {/if}
  </Modal>

  <Modal
    bind:open={permissionsOpen}
    labelledby="calendar-permissions-title"
    class="calendar-permissions"
  >
    <form
      class="permissions-form"
      onsubmit={(event) => {
        event.preventDefault();
        void savePermissions();
      }}
    >
      <header>
        <div>
          <h2 id="calendar-permissions-title">{tr('Agent calendar access')}</h2>
          <p>
            {tr(
              'These permissions apply to agent tools only. They do not change your personal calendar view.',
            )}
          </p>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label={tr('Close')}
          onclick={() => (permissionsOpen = false)}><X size={17} /></button
        >
      </header>
      {#if permissionsLoading}<p class="detail-loading" role="status">
          <RefreshCw size={14} class="spin" />{tr('Loading permissions…')}
        </p>{/if}
      <label class="permission-toggle">
        <input
          type="checkbox"
          bind:checked={permissions.allowRead}
          disabled={permissionsLoading || permissionsSaving}
        />
        <span
          ><strong>{tr('Allow calendar reads')}</strong><small
            >{tr('Agents can read event and schedule details you request.')}</small
          ></span
        >
      </label>
      <label class="permission-toggle">
        <input
          type="checkbox"
          bind:checked={permissions.allowPropose}
          disabled={permissionsLoading || permissionsSaving}
        />
        <span
          ><strong>{tr('Allow change proposals')}</strong><small
            >{tr('Agents can propose event changes. You must confirm each proposal.')}</small
          ></span
        >
      </label>
      {#if permissionsError}<p class="inline-error" role="alert">{permissionsError}</p>{/if}
      <footer class="permissions-actions">
        <button
          class="button ghost"
          type="button"
          disabled={permissionsLoading || permissionsSaving}
          onclick={() => void loadPermissions()}>{tr('Retry')}</button
        >
        <button
          class="button primary"
          type="submit"
          disabled={permissionsLoading || permissionsSaving}
        >
          {#if permissionsSaving}<RefreshCw size={14} class="spin" />{/if}{tr('Save permissions')}
        </button>
      </footer>
    </form>
  </Modal>
</section>

<style>
  .calendar-page {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .page-bar {
    flex: 0 0 calc(56px + env(safe-area-inset-top));
    display: flex;
    align-items: center;
    gap: 10px;
    padding: env(safe-area-inset-top) 20px 0;
    color: var(--muted);
  }
  .page-bar h1 {
    margin: 0;
    color: var(--ink);
    font-size: 15px;
    font-weight: 600;
  }
  .header-zone {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 12px;
  }
  .header-zone input {
    width: 184px;
    height: 32px;
    border: 0;
    border-radius: var(--radius-sm);
    padding: 0 9px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 12px;
  }
  .calendar-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 22px 12px;
  }
  .period-title {
    color: var(--ink);
    font-size: 20px;
    line-height: 1.3;
    font-weight: 600;
    letter-spacing: -0.02em;
    white-space: nowrap;
    margin-right: 4px;
  }
  .period-navigation {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .period-navigation .icon-button {
    width: 32px;
    height: 32px;
  }
  .view-tabs,
  .create-type-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 999px;
    padding: 3px;
    background: var(--bg-subtle);
  }
  .view-tabs {
    margin-left: auto;
  }
  .view-tabs button,
  .create-type-tabs button {
    min-height: 30px;
    border: 0;
    border-radius: 999px;
    padding: 5px 12px;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
    white-space: nowrap;
  }
  .view-tabs button[aria-pressed='true'],
  .create-type-tabs button[aria-pressed='true'] {
    color: var(--ink);
    background: var(--bg);
    box-shadow: 0 1px 3px var(--line-dark);
    font-weight: 500;
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--ink);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
  .button:hover:not(:disabled) {
    background: var(--bg-hover-strong);
  }
  .button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .button.primary {
    background: var(--ink);
    color: var(--bg);
  }
  .button.primary:hover:not(:disabled) {
    opacity: 0.88;
  }
  .button.ghost {
    background: transparent;
  }
  .button.danger {
    color: var(--danger);
  }
  .button.small {
    min-height: 31px;
    padding: 0 11px;
    font-size: 12px;
  }
  .calendar-filters {
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 22px 10px;
    flex-wrap: wrap;
  }
  .type-filters {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .type-filters button {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    border-radius: 999px;
    padding: 0 9px;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
    white-space: nowrap;
  }
  .type-filters button.chosen {
    color: var(--ink);
    background: var(--bg-subtle);
  }
  .filter-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .week-start-control {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    color: var(--muted);
    font-size: 11px;
  }
  .week-start-control select {
    height: 28px;
    border: 0;
    border-radius: var(--radius-sm);
    padding: 0 7px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 11px;
  }
  .sync-state {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .calendar-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
    overflow: hidden;
    border-top: 1px solid var(--line);
  }
  .calendar-view {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .history-note {
    flex: 0 0 auto;
    margin: 0;
    padding: 7px 20px;
    color: var(--muted);
    font-size: 11px;
    border-bottom: 1px solid var(--line);
  }
  .calendar-notice {
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 9px 20px;
    color: var(--text-2);
    background: var(--bg-subtle);
    font-size: 12px;
  }
  .error-notice {
    color: var(--danger);
  }
  .error-notice .button {
    margin-left: auto;
    color: var(--ink);
  }
  .month-view {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 0 18px;
  }
  .weekday-row,
  .month-week {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
  .weekday-row {
    position: sticky;
    top: 0;
    z-index: 2;
    align-items: center;
    height: 32px;
    flex: 0 0 32px;
    color: var(--muted);
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    text-align: right;
  }
  .weekday-row span {
    padding-right: 12px;
  }
  .month-week {
    position: relative;
    flex: 0 0 auto;
    min-height: max(112px, calc(102px + var(--span-lanes, 0) * 21px));
    border-bottom: 1px solid var(--line);
  }
  .month-day {
    position: relative;
    min-width: 0;
    min-height: 112px;
    padding: 6px 4px 8px;
    border-right: 1px solid var(--line);
  }
  .month-day:last-of-type {
    border-right: 0;
  }
  .month-day.outside-month {
    background: var(--bg-hover);
    color: var(--muted);
  }
  .month-day.date-selected {
    background: color-mix(in srgb, var(--accent-soft) 32%, var(--bg));
  }
  .date-number {
    display: flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: inherit;
    background: transparent;
    font-size: 12px;
  }
  .date-number.today {
    color: var(--on-accent);
    background: var(--accent);
  }
  .date-number.selected:not(.today) {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .month-events {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: calc(4px + var(--span-lanes, 0) * 21px);
  }
  .month-item {
    display: flex;
    width: 100%;
    height: 22px;
    min-width: 0;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
    overflow: hidden;
    border: 0;
    border-radius: 4px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    text-align: left;
    font-size: 11px;
    white-space: nowrap;
  }
  .month-item.agent-item {
    color: var(--text-2);
    background: transparent;
  }
  .month-item .item-time {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
  .month-item .item-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .more-items {
    align-self: flex-start;
    border: 0;
    padding: 1px 4px;
    color: var(--muted);
    background: transparent;
    font-size: 11px;
  }
  .month-span {
    position: absolute;
    z-index: 1;
    min-width: 0;
    height: 20px;
    margin: 0;
    padding: 0 7px;
    overflow: hidden;
    border: 0;
    border-radius: 5px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .month-span.agent-item {
    color: var(--text-2);
    background: var(--bg-subtle);
  }
  .mobile-event-marks {
    display: none;
  }
  .month-agenda {
    display: none;
  }
  .agenda-heading,
  .list-day-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px 8px;
    color: var(--ink);
    font-size: 14px;
    font-weight: 500;
  }
  .agenda-heading small,
  .list-day-heading small {
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
  }
  .agenda-item {
    display: flex;
    width: 100%;
    align-items: flex-start;
    gap: 12px;
    padding: 11px 18px;
    border: 0;
    color: var(--ink);
    background: transparent;
    text-align: left;
  }
  .agenda-item:hover {
    background: var(--bg-hover);
  }
  .agenda-time {
    flex: 0 0 48px;
    padding-top: 2px;
    color: var(--text-2);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .agenda-glyph {
    flex: 0 0 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .agenda-glyph.agent-glyph {
    color: var(--muted);
    background: var(--bg-subtle);
  }
  .agenda-copy {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
  .agenda-copy strong {
    display: block;
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agenda-copy small {
    display: block;
    margin-top: 3px;
    color: var(--muted);
    font-size: 11px;
  }
  .agenda-item > :last-child {
    margin-top: 5px;
    color: var(--muted);
  }
  .empty-day,
  .calendar-empty {
    padding: 32px 18px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }
  .time-scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    border-top: 1px solid var(--line);
  }
  .time-surface {
    --day-width: 120px;
    position: relative;
    min-width: 100%;
    width: max-content;
  }
  .time-surface.week-surface {
    min-width: max(100%, calc(44px + 7 * 116px));
  }
  .time-surface.day-surface {
    width: 100%;
  }
  .time-header,
  .all-day-row {
    display: grid;
    grid-template-columns: 44px repeat(var(--day-count), minmax(var(--day-width), 1fr));
  }
  .time-header {
    position: sticky;
    z-index: 6;
    top: 0;
    min-height: 64px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  .time-corner {
    position: sticky;
    left: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 2px;
    border-right: 1px solid var(--line);
    color: var(--muted);
    background: var(--bg);
    font-size: 9px;
    text-align: center;
  }
  .time-day-heading {
    height: 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border: 0;
    border-right: 1px solid var(--line);
    color: var(--muted);
    background: var(--bg);
    font-size: 11px;
  }
  .time-day-heading strong {
    display: flex;
    width: 30px;
    height: 30px;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: var(--ink);
    font-size: 17px;
    font-weight: 500;
  }
  .time-day-heading.today strong {
    color: var(--on-accent);
    background: var(--accent);
  }
  .all-day-row {
    position: sticky;
    z-index: 5;
    top: 64px;
    min-height: calc(35px + var(--span-lanes, 0) * 25px);
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  .all-day-label {
    grid-column: 1;
    grid-row: 1;
  }
  .all-day-cell {
    grid-row: 1;
    min-height: 35px;
    border-right: 1px solid var(--line);
  }
  .all-day-span {
    position: absolute;
    z-index: 1;
    height: 22px;
    min-width: 0;
    margin: 0;
    padding: 2px 7px;
    overflow: hidden;
    border: 0;
    border-radius: 4px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .all-day-span.agent-item {
    color: var(--text-2);
    background: var(--bg-subtle);
  }
  .all-day-empty {
    grid-column: 2 / -1;
    align-self: center;
    padding-left: 8px;
    color: var(--muted);
    font-size: 10px;
  }
  .time-grid-body {
    display: grid;
    grid-template-columns: 44px repeat(var(--day-count), minmax(var(--day-width), 1fr));
    align-items: start;
    position: relative;
  }
  .hours-column {
    position: sticky;
    z-index: 3;
    left: 0;
    border-right: 1px solid var(--line);
    background: var(--bg);
  }
  .hours-column span {
    position: absolute;
    right: 6px;
    transform: translateY(-50%);
    color: var(--muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .time-day-column {
    position: relative;
    min-width: var(--day-width);
    background-image: linear-gradient(to bottom, var(--line) 1px, transparent 1px);
    background-size: 100% var(--hour-height);
    border-right: 1px solid var(--line);
  }
  .time-day-column.today {
    background-color: color-mix(in srgb, var(--accent-soft) 15%, var(--bg));
  }
  .time-entry {
    position: absolute;
    z-index: 2;
    display: block;
    overflow: hidden;
    min-width: 0;
    padding: 4px 6px;
    border: 0;
    border-left: 2px solid var(--accent);
    border-radius: 6px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    text-align: left;
    font-size: 11px;
    line-height: 16px;
  }
  .time-entry {
    cursor: grab;
    user-select: none;
  }
  .time-entry:active {
    cursor: grabbing;
  }
  .resize-handle {
    position: absolute;
    right: 28%;
    bottom: 0;
    left: 28%;
    height: 4px;
    border-radius: 4px 4px 0 0;
    background: color-mix(in srgb, currentColor 42%, transparent);
    cursor: ns-resize;
  }
  .time-entry.agent-entry {
    height: 28px !important;
    border: 1px solid var(--line-dark);
    color: var(--text-2);
    background: var(--bg-layer);
  }
  .time-entry strong {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time-entry small {
    display: block;
    overflow: hidden;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .now-line {
    position: absolute;
    z-index: 4;
    right: 0;
    left: 0;
    height: 1px;
    background: var(--accent);
    pointer-events: none;
  }
  .now-line::before {
    content: '';
    position: absolute;
    top: -2px;
    left: -2px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .list-view {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-bottom: 24px;
  }
  .list-day-heading {
    justify-content: flex-start;
    gap: 10px;
    padding-top: 18px;
  }
  .list-day-heading small {
    margin-left: auto;
  }
  .loading-overlay {
    position: absolute;
    z-index: 3;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 8px;
    transform: translate(-50%, -50%);
    color: var(--muted);
    background: var(--bg);
    font-size: 13px;
  }
  .pagination-note {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 42px;
    padding: 5px 12px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    background: var(--bg);
    font-size: 11px;
  }
  .schedule-management {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .page-body {
    width: min(780px, 100%);
    margin: 0 auto;
    padding: 8px 32px 48px;
  }
  .page-body :global(label) {
    display: grid;
    gap: 6px;
    margin: 12px 0;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
  }
  .page-body :global(input:not([type='checkbox']):not([type='radio'])),
  .page-body :global(select) {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-md);
    outline: 0;
    background: var(--bg-subtle);
    font-size: 14px;
  }
  .page-body :global(input:focus),
  .page-body :global(select:focus) {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .page-body :global(.settings-section h3) {
    margin: 0 0 8px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .page-body :global(p) {
    color: var(--muted);
    font-size: 13px;
  }
  .calendar-details {
    z-index: 10;
    position: relative;
    flex: 0 0 min(360px, 36vw);
    min-width: 300px;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--bg);
  }
  .details-header {
    flex: 0 0 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--line);
  }
  .details-header h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .details-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px;
  }
  .details-body h3 {
    margin: 0 0 10px;
    color: var(--ink);
    font-size: 19px;
    line-height: 1.35;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .details-body h3.detail-title {
    margin-bottom: 10px;
  }
  .item-kind {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 19px;
    padding: 4px 8px;
    border-radius: 999px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    font-size: 11px;
  }
  .item-kind.agent-kind {
    color: var(--text-2);
    background: var(--bg-subtle);
  }
  .detail-row {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    margin: 16px 0;
    color: var(--text-2);
    font-size: 13px;
  }
  .detail-row :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
    color: var(--muted);
  }
  .detail-row small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 11px;
  }
  .detail-description {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 18px 0;
    padding: 13px;
    border-radius: var(--radius-md);
    color: var(--text-2);
    background: var(--bg-subtle);
    font-size: 13px;
    line-height: 1.55;
  }
  .detail-loading {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 12px;
  }
  .inline-error {
    color: var(--danger) !important;
    font-size: 12px !important;
    line-height: 1.4;
  }
  .detail-scope {
    display: grid;
    gap: 6px;
    margin-top: 20px;
    color: var(--text-2);
    font-size: 12px;
  }
  .detail-scope select {
    height: 38px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: var(--bg-subtle);
  }
  .details-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    padding: 11px 14px;
    border-top: 1px solid var(--line);
    background: var(--bg);
  }
  .details-footer .danger {
    margin-right: auto;
  }
  .schedule-detail-actions {
    flex-wrap: wrap;
  }
  .schedule-detail-actions .button {
    min-height: 31px;
    padding: 0 9px;
    font-size: 11px;
  }
  .detail-scrim {
    display: none;
  }
  .conflict-card {
    margin-top: 16px;
    padding: 12px;
    border: 1px solid var(--warning);
    border-radius: var(--radius-md);
    color: var(--text-2);
    background: var(--warning-soft);
    font-size: 12px;
  }
  .conflict-card p {
    margin: 6px 0;
    color: var(--ink);
  }
  .conflict-card small {
    display: block;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .conflict-card .button {
    margin-top: 10px;
  }
  .recent-runs {
    margin-top: 20px;
    border-top: 1px solid var(--line);
    padding-top: 14px;
  }
  .recent-runs h4 {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .recent-runs > small {
    display: block;
    margin-top: 10px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.4;
  }
  .recent-run {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .recent-run small {
    color: var(--muted);
    font-size: 10px;
  }
  .recent-run .button {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .run-result {
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .run-result p {
    margin: 6px 0 0;
    color: var(--text-2);
    font-size: 12px;
  }
  :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .event-editor-form {
    display: flex;
    flex-direction: column;
    max-height: min(760px, calc(100dvh - 40px));
  }
  .editor-heading {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line);
  }
  .editor-heading h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  .editor-heading p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }
  .move-notice {
    margin: 10px 0 0;
    padding: 9px 11px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: var(--accent-soft);
    font-size: 11px;
    line-height: 1.45;
  }
  .editor-scroll {
    min-height: 0;
    overflow: auto;
    padding: 4px 2px 14px;
  }
  .create-type-tabs {
    width: max-content;
    margin: 12px 0 18px;
  }
  .create-type-tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .field {
    display: grid;
    gap: 6px;
    margin: 13px 0;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
  }
  .field input,
  .field select,
  .field textarea {
    width: 100%;
    min-width: 0;
    height: 40px;
    padding: 0 11px;
    border: 0;
    border-radius: var(--radius-sm);
    outline: 0;
    color: var(--ink);
    background: var(--bg-subtle);
    font-size: 13px;
  }
  .field textarea {
    height: auto;
    min-height: 84px;
    padding: 10px 11px;
    resize: vertical;
    line-height: 1.5;
  }
  .field input:focus,
  .field select:focus,
  .field textarea:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .field-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .check-field {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    color: var(--text-2);
    font-size: 12px;
  }
  .check-field input,
  .weekday-picker input,
  .reminder-picker input {
    accent-color: var(--accent);
  }
  .field-help {
    display: block;
    margin-top: 5px;
    color: var(--muted);
    font-size: 10px;
  }
  .weekday-picker,
  .reminder-picker {
    min-width: 0;
    margin: 13px 0;
    padding: 10px 12px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-md);
  }
  .weekday-picker legend,
  .reminder-picker legend {
    padding: 0 4px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
  }
  .weekday-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .weekday-picker label,
  .reminder-options label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-2);
    font-size: 11px;
  }
  .weekday-picker label {
    min-width: 34px;
  }
  .reminder-options {
    display: flex;
    flex-wrap: wrap;
    gap: 9px 14px;
  }
  .reminder-picker > small {
    display: block;
    margin-top: 8px;
    color: var(--muted);
    font-size: 10px;
  }
  .editor-actions {
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .agent-create-note {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    margin: 20px 0;
    padding: 15px;
    border-radius: var(--radius-md);
    color: var(--text-2);
    background: var(--bg-subtle);
    font-size: 13px;
  }
  .agent-create-note :global(svg) {
    flex: 0 0 auto;
    color: var(--muted);
  }
  .agent-create-note strong {
    color: var(--ink);
    font-weight: 500;
  }
  .agent-create-note p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .continue-agent {
    width: 100%;
  }
  .permission-button {
    min-height: 31px;
    padding: 0 10px;
    font-size: 12px;
  }
  .permissions-form > header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .permissions-form h2 {
    margin: 0;
    font-size: 17px;
  }
  .permissions-form p {
    margin: 6px 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .permission-toggle {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: start;
    gap: 11px;
    margin: 18px 0;
  }
  .permission-toggle input {
    width: 16px;
    height: 16px;
    margin: 2px 0 0;
    accent-color: var(--accent);
  }
  .permission-toggle span {
    display: grid;
    gap: 4px;
    color: var(--text-2);
  }
  .permission-toggle strong {
    color: var(--ink);
    font-size: 13px;
    font-weight: 600;
  }
  .permission-toggle small {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.45;
  }
  .permissions-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }

  @media (max-width: 900px) {
    .header-zone span {
      display: none;
    }
    .header-zone input {
      width: 155px;
    }
    .calendar-toolbar {
      padding-left: 16px;
      padding-right: 16px;
    }
    .calendar-filters {
      padding-left: 16px;
      padding-right: 16px;
    }
    .calendar-details {
      flex-basis: 320px;
    }
  }
  @media (max-width: 650px) {
    .page-bar {
      padding-left: 14px;
      padding-right: 12px;
    }
    .header-zone {
      gap: 4px;
    }
    .header-zone input {
      width: 137px;
      height: 30px;
      font-size: 11px;
    }
    .calendar-toolbar {
      gap: 5px;
      padding: 5px 12px 9px;
    }
    .period-title {
      flex: 1 1 auto;
      min-width: calc(100% - 160px);
      margin: 0;
      font-size: 19px;
    }
    .period-navigation {
      flex: 0 0 auto;
    }
    .period-navigation .icon-button {
      width: 28px;
      height: 30px;
    }
    .period-navigation .today-button {
      min-height: 29px;
      padding: 0 9px;
      font-size: 11px;
    }
    .view-tabs {
      order: 4;
      flex: 1 0 100%;
      margin: 4px 0 0;
    }
    .view-tabs button {
      flex: 1;
      padding: 5px 8px;
    }
    .new-event-button {
      width: 34px;
      min-width: 34px;
      height: 34px;
      padding: 0;
    }
    .new-event-button span,
    .manage-schedules-button span {
      display: none;
    }
    .manage-schedules-button {
      width: 34px;
      min-width: 34px;
      height: 34px;
      padding: 0;
    }
    .permission-button {
      width: 34px;
      min-width: 34px;
      height: 34px;
      padding: 0;
    }
    .permission-button span {
      display: none;
    }
    .calendar-filters {
      gap: 4px;
      padding: 0 10px 8px;
    }
    .type-filters {
      flex: 1 0 100%;
      justify-content: center;
      gap: 2px;
    }
    .type-filters button {
      padding: 0 7px;
      font-size: 11px;
    }
    .week-start-control {
      margin-left: auto;
    }
    .sync-state {
      margin-left: 5px;
    }
    .calendar-content {
      overflow: hidden;
    }
    .month-view {
      flex: 1 0 auto;
      overflow: visible;
      padding: 0 10px;
    }
    .weekday-row {
      height: 28px;
      flex-basis: 28px;
      justify-items: center;
      text-align: center;
    }
    .weekday-row span {
      padding: 0;
    }
    .month-week {
      min-height: 54px;
      border: 0;
    }
    .month-day {
      display: flex;
      min-height: 54px;
      flex-direction: column;
      align-items: center;
      padding: 3px 0;
      border: 0;
    }
    .month-day.outside-month,
    .month-day.date-selected {
      background: transparent;
    }
    .date-number {
      width: 31px;
      height: 31px;
      margin: 0 auto;
      font-size: 13px;
    }
    .month-events,
    .month-span {
      display: none;
    }
    .mobile-event-marks {
      min-height: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      margin-top: 2px;
    }
    .mobile-event-marks span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--accent);
    }
    .mobile-event-marks .agent-mark {
      background: var(--muted);
    }
    .mobile-event-marks small {
      color: var(--muted);
      font-size: 8px;
      line-height: 9px;
    }
    .month-agenda {
      display: block;
      flex: 1 0 180px;
      min-height: 180px;
      margin: 12px -10px 0;
      padding-bottom: calc(72px + env(safe-area-inset-bottom));
      overflow: auto;
      border-top: 1px solid var(--line);
    }
    .month-agenda .agenda-heading {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 12px 14px 7px;
      background: var(--bg);
      font-size: 13px;
    }
    .month-agenda .agenda-item {
      padding: 9px 14px;
      gap: 9px;
    }
    .agenda-item {
      padding: 10px 12px;
      gap: 9px;
    }
    .agenda-time {
      flex-basis: 45px;
      font-size: 10px;
    }
    .time-scroll {
      min-width: 0;
    }
    .time-surface.week-surface {
      width: max-content;
      min-width: 844px;
    }
    .time-surface.week-surface .time-header,
    .time-surface.week-surface .all-day-row,
    .time-surface.week-surface .time-grid-body {
      grid-template-columns: 44px repeat(7, 114px);
    }
    .time-surface.day-surface {
      min-width: 100%;
    }
    .time-surface.day-surface .time-header,
    .time-surface.day-surface .all-day-row,
    .time-surface.day-surface .time-grid-body {
      grid-template-columns: 44px minmax(260px, 1fr);
    }
    .time-surface.day-surface {
      width: max(100%, 304px);
    }
    .time-header {
      min-height: 58px;
    }
    .time-day-heading {
      height: 58px;
    }
    .all-day-row {
      top: 58px;
    }
    .time-surface.week-surface .time-header {
      top: 0;
    }
    .time-surface.week-surface .all-day-row {
      top: 58px;
    }
    .time-day-column {
      min-width: 0;
    }
    .hours-column span {
      right: 4px;
      font-size: 9px;
    }
    .time-entry {
      padding: 3px 4px;
      font-size: 10px;
    }
    .list-view {
      padding-bottom: calc(72px + env(safe-area-inset-bottom));
    }
    .list-day-heading {
      padding-left: 14px;
      padding-right: 14px;
      font-size: 13px;
    }
    .page-body {
      padding: 4px 14px calc(72px + env(safe-area-inset-bottom));
    }
    .calendar-details {
      position: fixed;
      z-index: 45;
      right: 0;
      bottom: 0;
      left: 0;
      width: 100%;
      max-width: none;
      min-width: 0;
      max-height: min(78dvh, 680px);
      border: 1px solid var(--line-dark);
      border-bottom: 0;
      border-radius: 18px 18px 0 0;
      box-shadow: var(--shadow-pop);
    }
    .details-header {
      flex-basis: 46px;
      padding-left: 16px;
    }
    .details-body {
      padding: 14px 16px;
    }
    .details-body h3 {
      font-size: 17px;
    }
    .details-footer {
      padding-bottom: calc(12px + env(safe-area-inset-bottom));
    }
    .detail-scrim {
      display: block;
      position: fixed;
      z-index: 40;
      inset: 0;
      border: 0;
      background: rgb(0 0 0 / 24%);
    }
    :global(.modal-dialog.calendar-editor) {
      width: 100% !important;
      max-width: 100% !important;
      max-height: 100dvh !important;
      height: 100dvh;
      margin: 0;
    }
    :global(.modal-dialog.calendar-editor::backdrop) {
      background: var(--bg);
    }
    :global(.modal-dialog.calendar-editor .modal.calendar-editor) {
      height: 100%;
      max-height: 100%;
      padding: max(14px, env(safe-area-inset-top)) 16px calc(12px + env(safe-area-inset-bottom));
      border-radius: 0;
    }
    .event-editor-form {
      max-height: none;
      height: 100%;
    }
    .field-grid {
      gap: 9px;
    }
    .reminder-options {
      gap: 9px 11px;
    }
  }
</style>
